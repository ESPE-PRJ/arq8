const express = require('express');
const Joi = require('joi');
const { Client } = require('pg');
const redis = require('redis');
const BaseService = require('../../shared/base-service');
const CircuitBreaker = require('../../shared/circuit-breaker');

class ProductService extends BaseService {
    constructor() {
        super('product-service', 3002);
        this.db = null;
        this.cache = null;
        this.circuitBreaker = null;
        this.setupRoutes();
        this.connectToDatabase();
        this.connectToCache();
        this.setupCircuitBreaker();
    }

    async connectToDatabase() {
        this.db = new Client({
            host: process.env.POSTGRES_HOST || 'postgres-product',
            port: process.env.POSTGRES_PORT || 5432,
            database: process.env.POSTGRES_DB || 'productdb',
            user: process.env.POSTGRES_USER || 'postgres',
            password: process.env.POSTGRES_PASSWORD || 'password'
        });

        try {
            await this.db.connect();
            await this.createTables();
            await this.seedData();
            console.log('[ProductService] Connected to PostgreSQL');
        } catch (error) {
            console.error('[ProductService] Database connection failed:', error);
        }
    }

    async connectToCache() {
        try {
            this.cache = redis.createClient({
                host: process.env.REDIS_HOST || 'redis',
                port: process.env.REDIS_PORT || 6379
            });
            await this.cache.connect();
            console.log('[ProductService] Connected to Redis cache');
        } catch (error) {
            console.error('[ProductService] Cache connection failed:', error);
        }
    }

    setupCircuitBreaker() {
        this.circuitBreaker = new CircuitBreaker(
            async (query, params) => {
                return await this.db.query(query, params);
            },
            {
                failureThreshold: 5,
                successThreshold: 2,
                timeout: 10000,
                onStateChange: (state) => {
                    console.log(`[ProductService] Circuit breaker state changed to: ${state}`);
                }
            }
        );
    }

    async createTables() {
        const query = `
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                price DECIMAL(10,2) NOT NULL,
                category VARCHAR(100) NOT NULL,
                stock_quantity INTEGER DEFAULT 0,
                sku VARCHAR(100) UNIQUE NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
            CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
        `;
        await this.db.query(query);
    }

    async seedData() {
        const count = await this.db.query('SELECT COUNT(*) FROM products');
        if (parseInt(count.rows[0].count) === 0) {
            const products = [
                ['Laptop Gaming Pro', 'High-performance gaming laptop', 1299.99, 'Electronics', 25, 'LAP-001'],
                ['Smartphone Ultra', 'Latest generation smartphone', 899.99, 'Electronics', 50, 'PHN-001'],
                ['Wireless Headphones', 'Noise-cancelling headphones', 199.99, 'Electronics', 100, 'HDP-001'],
                ['Coffee Maker Deluxe', 'Premium coffee maker', 149.99, 'Home', 30, 'COF-001'],
                ['Running Shoes Sport', 'Professional running shoes', 129.99, 'Sports', 75, 'SHO-001']
            ];

            for (const product of products) {
                await this.db.query(
                    'INSERT INTO products (name, description, price, category, stock_quantity, sku) VALUES ($1, $2, $3, $4, $5, $6)',
                    product
                );
            }
            console.log('[ProductService] Sample data seeded');
        }
    }

    setupRoutes() {
        const router = express.Router();

        // Get all products with pagination and caching - stateless
        router.get('/products', async (req, res) => {
            try {
                const page = parseInt(req.query.page) || 1;
                const limit = parseInt(req.query.limit) || 10;
                const category = req.query.category;
                const offset = (page - 1) * limit;

                // Create cache key
                const cacheKey = `products:${page}:${limit}:${category || 'all'}`;

                // Try to get from cache first
                if (this.cache) {
                    try {
                        const cachedData = await this.cache.get(cacheKey);
                        if (cachedData) {
                            console.log('[ProductService] Cache hit for products');
                            return res.json(JSON.parse(cachedData));
                        }
                    } catch (cacheError) {
                        console.error('[ProductService] Cache read error:', cacheError);
                    }
                }

                // Build query
                let query = 'SELECT * FROM products';
                let countQuery = 'SELECT COUNT(*) FROM products';
                const params = [];
                
                if (category) {
                    query += ' WHERE category = $1';
                    countQuery += ' WHERE category = $1';
                    params.push(category);
                }

                query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
                params.push(limit, offset);

                // Execute with circuit breaker
                const [productsResult, countResult] = await Promise.all([
                    this.circuitBreaker.call(query, params),
                    this.circuitBreaker.call(countQuery, category ? [category] : [])
                ]);

                const totalProducts = parseInt(countResult.rows[0].count);
                const totalPages = Math.ceil(totalProducts / limit);

                const response = {
                    products: productsResult.rows,
                    pagination: {
                        currentPage: page,
                        totalPages,
                        totalProducts,
                        hasNext: page < totalPages,
                        hasPrev: page > 1
                    }
                };

                // Cache the response
                if (this.cache) {
                    try {
                        await this.cache.setEx(cacheKey, 300, JSON.stringify(response)); // 5 minutes TTL
                    } catch (cacheError) {
                        console.error('[ProductService] Cache write error:', cacheError);
                    }
                }

                res.json(response);
            } catch (error) {
                console.error('[ProductService] Get products error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Get product by ID - stateless with caching
        router.get('/products/:id', async (req, res) => {
            try {
                const productId = parseInt(req.params.id);
                if (isNaN(productId)) {
                    return res.status(400).json({ error: 'Invalid product ID' });
                }

                const cacheKey = `product:${productId}`;

                // Try cache first
                if (this.cache) {
                    try {
                        const cachedProduct = await this.cache.get(cacheKey);
                        if (cachedProduct) {
                            console.log('[ProductService] Cache hit for product:', productId);
                            return res.json(JSON.parse(cachedProduct));
                        }
                    } catch (cacheError) {
                        console.error('[ProductService] Cache read error:', cacheError);
                    }
                }

                const result = await this.circuitBreaker.call(
                    'SELECT * FROM products WHERE id = $1',
                    [productId]
                );

                if (result.rows.length === 0) {
                    return res.status(404).json({ error: 'Product not found' });
                }

                const product = result.rows[0];

                // Cache the product
                if (this.cache) {
                    try {
                        await this.cache.setEx(cacheKey, 600, JSON.stringify({ product })); // 10 minutes TTL
                    } catch (cacheError) {
                        console.error('[ProductService] Cache write error:', cacheError);
                    }
                }

                res.json({ product });
            } catch (error) {
                console.error('[ProductService] Get product error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Search products - stateless
        router.get('/products/search/:term', async (req, res) => {
            try {
                const searchTerm = req.params.term;
                const page = parseInt(req.query.page) || 1;
                const limit = parseInt(req.query.limit) || 10;
                const offset = (page - 1) * limit;

                const query = `
                    SELECT * FROM products 
                    WHERE name ILIKE $1 OR description ILIKE $1 
                    ORDER BY name 
                    LIMIT $2 OFFSET $3
                `;

                const result = await this.circuitBreaker.call(
                    query,
                    [`%${searchTerm}%`, limit, offset]
                );

                res.json({
                    products: result.rows,
                    searchTerm,
                    page,
                    limit
                });
            } catch (error) {
                console.error('[ProductService] Search error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Update product stock - stateless operation
        router.patch('/products/:id/stock', async (req, res) => {
            try {
                const productId = parseInt(req.params.id);
                const { quantity, operation } = req.body;

                const schema = Joi.object({
                    quantity: Joi.number().integer().min(1).required(),
                    operation: Joi.string().valid('add', 'subtract', 'set').required()
                });

                const { error } = schema.validate({ quantity, operation });
                if (error) {
                    return res.status(400).json({ error: error.details[0].message });
                }

                let updateQuery;
                let params;

                switch (operation) {
                    case 'add':
                        updateQuery = 'UPDATE products SET stock_quantity = stock_quantity + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *';
                        params = [quantity, productId];
                        break;
                    case 'subtract':
                        updateQuery = 'UPDATE products SET stock_quantity = GREATEST(stock_quantity - $1, 0), updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *';
                        params = [quantity, productId];
                        break;
                    case 'set':
                        updateQuery = 'UPDATE products SET stock_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *';
                        params = [quantity, productId];
                        break;
                }

                const result = await this.circuitBreaker.call(updateQuery, params);

                if (result.rows.length === 0) {
                    return res.status(404).json({ error: 'Product not found' });
                }

                const updatedProduct = result.rows[0];

                // Invalidate cache
                if (this.cache) {
                    try {
                        await this.cache.del(`product:${productId}`);
                        // Also invalidate product list caches (simplified approach)
                        const keys = await this.cache.keys('products:*');
                        if (keys.length > 0) {
                            await this.cache.del(keys);
                        }
                    } catch (cacheError) {
                        console.error('[ProductService] Cache invalidation error:', cacheError);
                    }
                }

                res.json({
                    message: 'Stock updated successfully',
                    product: updatedProduct
                });
            } catch (error) {
                console.error('[ProductService] Update stock error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Health check with circuit breaker status
        router.get('/circuit-breaker/status', (req, res) => {
            res.json({
                circuitBreaker: this.circuitBreaker.getStats(),
                cache: this.cache ? 'connected' : 'disconnected'
            });
        });

        this.addRoutes(router);
    }
}

// Start the service
const productService = new ProductService();
productService.start();