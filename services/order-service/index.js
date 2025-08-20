const express = require('express');
const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');
const { Client } = require('pg');
const BaseService = require('../../shared/base-service');
const MessageBroker = require('../../shared/message-broker');
const CircuitBreaker = require('../../shared/circuit-breaker');

class OrderService extends BaseService {
    constructor() {
        super('order-service', 3003);
        this.db = null;
        this.messageBroker = new MessageBroker();
        this.productServiceBreaker = null;
        this.setupRoutes();
        this.connectToDatabase();
        this.connectToMessageBroker();
        this.setupCircuitBreakers();
    }

    async connectToDatabase() {
        this.db = new Client({
            host: process.env.POSTGRES_HOST || 'postgres-order',
            port: process.env.POSTGRES_PORT || 5432,
            database: process.env.POSTGRES_DB || 'orderdb',
            user: process.env.POSTGRES_USER || 'postgres',
            password: process.env.POSTGRES_PASSWORD || 'password'
        });

        try {
            await this.db.connect();
            await this.createTables();
            console.log('[OrderService] Connected to PostgreSQL');
        } catch (error) {
            console.error('[OrderService] Database connection failed:', error);
        }
    }

    async connectToMessageBroker() {
        try {
            await this.messageBroker.connect();
            this.setupEventHandlers();
        } catch (error) {
            console.error('[OrderService] MessageBroker connection failed:', error);
        }
    }

    setupCircuitBreakers() {
        // Circuit breaker for product service calls
        this.productServiceBreaker = new CircuitBreaker(
            async (productId) => {
                const response = await fetch(`http://product-service:3002/api/products/${productId}`);
                if (!response.ok) {
                    throw new Error(`Product service error: ${response.status}`);
                }
                return await response.json();
            },
            {
                failureThreshold: 3,
                successThreshold: 2,
                timeout: 30000,
                onStateChange: (state) => {
                    console.log(`[OrderService] Product service circuit breaker: ${state}`);
                }
            }
        );
    }

    async createTables() {
        const query = `
            CREATE TABLE IF NOT EXISTS orders (
                id UUID PRIMARY KEY,
                user_id INTEGER NOT NULL,
                status VARCHAR(50) DEFAULT 'pending',
                total_amount DECIMAL(10,2) NOT NULL,
                currency VARCHAR(3) DEFAULT 'USD',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS order_items (
                id SERIAL PRIMARY KEY,
                order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
                product_id INTEGER NOT NULL,
                product_name VARCHAR(255) NOT NULL,
                quantity INTEGER NOT NULL,
                unit_price DECIMAL(10,2) NOT NULL,
                total_price DECIMAL(10,2) NOT NULL
            );
            
            CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
            CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
            CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
        `;
        await this.db.query(query);
    }

    setupEventHandlers() {
        // Handle user login events for analytics
        this.messageBroker.subscribe('user.login', (data) => {
            console.log('[OrderService] User logged in:', data.userId);
            // Could trigger personalized promotions, recommendations, etc.
        });

        // Handle payment confirmation events
        this.messageBroker.subscribe('payment.confirmed', async (data) => {
            console.log('[OrderService] Payment confirmed for order:', data.orderId);
            await this.updateOrderStatus(data.orderId, 'confirmed');
        });

        // Handle payment failed events
        this.messageBroker.subscribe('payment.failed', async (data) => {
            console.log('[OrderService] Payment failed for order:', data.orderId);
            await this.updateOrderStatus(data.orderId, 'payment_failed');
        });
    }

    async updateOrderStatus(orderId, status) {
        try {
            await this.db.query(
                'UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [status, orderId]
            );

            // Publish order status change event
            await this.messageBroker.publish('order.status_changed', {
                orderId,
                status,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('[OrderService] Update status error:', error);
        }
    }

    setupRoutes() {
        const router = express.Router();

        // Create order - stateless operation with async processing
        router.post('/orders', async (req, res) => {
            try {
                const schema = Joi.object({
                    userId: Joi.number().integer().positive().required(),
                    items: Joi.array().items(Joi.object({
                        productId: Joi.number().integer().positive().required(),
                        quantity: Joi.number().integer().min(1).required()
                    })).min(1).required()
                });

                const { error, value } = schema.validate(req.body);
                if (error) {
                    return res.status(400).json({ error: error.details[0].message });
                }

                const { userId, items } = value;
                const orderId = uuidv4();

                // Validate products and calculate total (with circuit breaker)
                let totalAmount = 0;
                const orderItems = [];

                for (const item of items) {
                    try {
                        const productData = await this.productServiceBreaker.call(item.productId);
                        const product = productData.product;

                        if (!product) {
                            return res.status(400).json({ 
                                error: `Product ${item.productId} not found` 
                            });
                        }

                        if (product.stock_quantity < item.quantity) {
                            return res.status(400).json({ 
                                error: `Insufficient stock for product ${product.name}` 
                            });
                        }

                        const itemTotal = parseFloat(product.price) * item.quantity;
                        totalAmount += itemTotal;

                        orderItems.push({
                            productId: product.id,
                            productName: product.name,
                            quantity: item.quantity,
                            unitPrice: parseFloat(product.price),
                            totalPrice: itemTotal
                        });
                    } catch (error) {
                        console.error('[OrderService] Product validation error:', error);
                        return res.status(503).json({ 
                            error: 'Product service temporarily unavailable' 
                        });
                    }
                }

                // Start database transaction
                await this.db.query('BEGIN');

                try {
                    // Create order
                    await this.db.query(
                        'INSERT INTO orders (id, user_id, total_amount, status) VALUES ($1, $2, $3, $4)',
                        [orderId, userId, totalAmount, 'pending']
                    );

                    // Create order items
                    for (const orderItem of orderItems) {
                        await this.db.query(
                            `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, total_price) 
                             VALUES ($1, $2, $3, $4, $5, $6)`,
                            [orderId, orderItem.productId, orderItem.productName, orderItem.quantity, orderItem.unitPrice, orderItem.totalPrice]
                        );
                    }

                    await this.db.query('COMMIT');

                    // Publish order created event (asynchronous processing)
                    await this.messageBroker.publish('order.created', {
                        orderId,
                        userId,
                        totalAmount,
                        items: orderItems,
                        timestamp: new Date().toISOString()
                    });

                    // Publish inventory update events (asynchronous)
                    for (const item of items) {
                        await this.messageBroker.publish('inventory.reserve', {
                            productId: item.productId,
                            quantity: item.quantity,
                            orderId
                        });
                    }

                    // Return immediate response (stateless)
                    res.status(201).json({
                        message: 'Order created successfully',
                        order: {
                            id: orderId,
                            userId,
                            totalAmount,
                            status: 'pending',
                            items: orderItems
                        }
                    });

                } catch (dbError) {
                    await this.db.query('ROLLBACK');
                    throw dbError;
                }

            } catch (error) {
                console.error('[OrderService] Create order error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Get order by ID - stateless
        router.get('/orders/:id', async (req, res) => {
            try {
                const orderId = req.params.id;

                const orderResult = await this.db.query(
                    'SELECT * FROM orders WHERE id = $1',
                    [orderId]
                );

                if (orderResult.rows.length === 0) {
                    return res.status(404).json({ error: 'Order not found' });
                }

                const order = orderResult.rows[0];

                const itemsResult = await this.db.query(
                    'SELECT * FROM order_items WHERE order_id = $1',
                    [orderId]
                );

                res.json({
                    order: {
                        ...order,
                        items: itemsResult.rows
                    }
                });
            } catch (error) {
                console.error('[OrderService] Get order error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Get user orders - stateless with pagination
        router.get('/users/:userId/orders', async (req, res) => {
            try {
                const userId = parseInt(req.params.userId);
                const page = parseInt(req.query.page) || 1;
                const limit = parseInt(req.query.limit) || 10;
                const offset = (page - 1) * limit;

                const ordersResult = await this.db.query(
                    `SELECT o.*, 
                            COALESCE(
                                json_agg(
                                    json_build_object(
                                        'id', oi.id,
                                        'productId', oi.product_id,
                                        'productName', oi.product_name,
                                        'quantity', oi.quantity,
                                        'unitPrice', oi.unit_price,
                                        'totalPrice', oi.total_price
                                    )
                                ) FILTER (WHERE oi.id IS NOT NULL), 
                                '[]'
                            ) as items
                     FROM orders o 
                     LEFT JOIN order_items oi ON o.id = oi.order_id 
                     WHERE o.user_id = $1 
                     GROUP BY o.id 
                     ORDER BY o.created_at DESC 
                     LIMIT $2 OFFSET $3`,
                    [userId, limit, offset]
                );

                const countResult = await this.db.query(
                    'SELECT COUNT(*) FROM orders WHERE user_id = $1',
                    [userId]
                );

                const totalOrders = parseInt(countResult.rows[0].count);
                const totalPages = Math.ceil(totalOrders / limit);

                res.json({
                    orders: ordersResult.rows,
                    pagination: {
                        currentPage: page,
                        totalPages,
                        totalOrders,
                        hasNext: page < totalPages,
                        hasPrev: page > 1
                    }
                });
            } catch (error) {
                console.error('[OrderService] Get user orders error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Cancel order - stateless operation with async processing
        router.patch('/orders/:id/cancel', async (req, res) => {
            try {
                const orderId = req.params.id;

                const result = await this.db.query(
                    `UPDATE orders 
                     SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP 
                     WHERE id = $1 AND status IN ('pending', 'confirmed') 
                     RETURNING *`,
                    [orderId]
                );

                if (result.rows.length === 0) {
                    return res.status(400).json({ 
                        error: 'Order cannot be cancelled or not found' 
                    });
                }

                const order = result.rows[0];

                // Publish order cancelled event (async processing)
                await this.messageBroker.publish('order.cancelled', {
                    orderId,
                    userId: order.user_id,
                    timestamp: new Date().toISOString()
                });

                // Get order items for inventory restoration
                const itemsResult = await this.db.query(
                    'SELECT * FROM order_items WHERE order_id = $1',
                    [orderId]
                );

                // Publish inventory restore events
                for (const item of itemsResult.rows) {
                    await this.messageBroker.publish('inventory.restore', {
                        productId: item.product_id,
                        quantity: item.quantity,
                        orderId
                    });
                }

                res.json({
                    message: 'Order cancelled successfully',
                    order
                });
            } catch (error) {
                console.error('[OrderService] Cancel order error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Process payment (simulated) - triggers async events
        router.post('/orders/:id/payment', async (req, res) => {
            try {
                const orderId = req.params.id;
                const { paymentMethod, amount } = req.body;

                const schema = Joi.object({
                    paymentMethod: Joi.string().valid('credit_card', 'debit_card', 'paypal').required(),
                    amount: Joi.number().positive().required()
                });

                const { error } = schema.validate({ paymentMethod, amount });
                if (error) {
                    return res.status(400).json({ error: error.details[0].message });
                }

                // Verify order exists and amount matches
                const orderResult = await this.db.query(
                    'SELECT * FROM orders WHERE id = $1 AND status = $2',
                    [orderId, 'pending']
                );

                if (orderResult.rows.length === 0) {
                    return res.status(400).json({ error: 'Order not found or not pending' });
                }

                const order = orderResult.rows[0];
                if (parseFloat(order.total_amount) !== amount) {
                    return res.status(400).json({ error: 'Amount mismatch' });
                }

                // Simulate payment processing (would be external service)
                const paymentSuccess = Math.random() > 0.1; // 90% success rate

                const paymentData = {
                    orderId,
                    userId: order.user_id,
                    amount,
                    paymentMethod,
                    paymentId: uuidv4(),
                    timestamp: new Date().toISOString()
                };

                if (paymentSuccess) {
                    // Publish payment confirmed event (async)
                    await this.messageBroker.publish('payment.confirmed', paymentData);
                    
                    res.json({
                        message: 'Payment processed successfully',
                        paymentId: paymentData.paymentId,
                        status: 'confirmed'
                    });
                } else {
                    // Publish payment failed event (async)
                    await this.messageBroker.publish('payment.failed', {
                        ...paymentData,
                        error: 'Payment declined'
                    });
                    
                    res.status(400).json({
                        error: 'Payment failed',
                        paymentId: paymentData.paymentId
                    });
                }

            } catch (error) {
                console.error('[OrderService] Payment processing error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        this.addRoutes(router);
    }
}

// Start the service
const orderService = new OrderService();
orderService.start();