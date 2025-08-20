const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Joi = require('joi');
const { Client } = require('pg');
const BaseService = require('../../shared/base-service');
const MessageBroker = require('../../shared/message-broker');

class UserService extends BaseService {
    constructor() {
        super('user-service', 3001);
        this.db = null;
        this.messageBroker = new MessageBroker();
        this.setupRoutes();
        this.connectToDatabase();
        this.connectToMessageBroker();
    }

    async connectToDatabase() {
        this.db = new Client({
            host: process.env.POSTGRES_HOST || 'postgres-user',
            port: process.env.POSTGRES_PORT || 5432,
            database: process.env.POSTGRES_DB || 'userdb',
            user: process.env.POSTGRES_USER || 'postgres',
            password: process.env.POSTGRES_PASSWORD || 'password'
        });

        try {
            await this.db.connect();
            await this.createTables();
            console.log('[UserService] Connected to PostgreSQL');
        } catch (error) {
            console.error('[UserService] Database connection failed:', error);
        }
    }

    async connectToMessageBroker() {
        try {
            await this.messageBroker.connect();
        } catch (error) {
            console.error('[UserService] MessageBroker connection failed:', error);
        }
    }

    async createTables() {
        const query = `
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                first_name VARCHAR(100) NOT NULL,
                last_name VARCHAR(100) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
        `;
        await this.db.query(query);
    }

    setupRoutes() {
        const router = express.Router();

        // User registration - stateless operation
        router.post('/auth/register', async (req, res) => {
            try {
                const schema = Joi.object({
                    email: Joi.string().email().required(),
                    password: Joi.string().min(8).required(),
                    firstName: Joi.string().min(2).required(),
                    lastName: Joi.string().min(2).required()
                });

                const { error, value } = schema.validate(req.body);
                if (error) {
                    return res.status(400).json({ error: error.details[0].message });
                }

                const { email, password, firstName, lastName } = value;

                // Check if user exists
                const existingUser = await this.db.query(
                    'SELECT id FROM users WHERE email = $1',
                    [email]
                );

                if (existingUser.rows.length > 0) {
                    return res.status(409).json({ error: 'User already exists' });
                }

                // Hash password
                const passwordHash = await bcrypt.hash(password, 12);

                // Create user
                const result = await this.db.query(
                    `INSERT INTO users (email, password_hash, first_name, last_name) 
                     VALUES ($1, $2, $3, $4) RETURNING id, email, first_name, last_name, created_at`,
                    [email, passwordHash, firstName, lastName]
                );

                const user = result.rows[0];

                // Publish user created event
                await this.messageBroker.publish('user.created', {
                    userId: user.id,
                    email: user.email,
                    firstName: user.first_name,
                    lastName: user.last_name
                });

                res.status(201).json({
                    message: 'User created successfully',
                    user: {
                        id: user.id,
                        email: user.email,
                        firstName: user.first_name,
                        lastName: user.last_name,
                        createdAt: user.created_at
                    }
                });
            } catch (error) {
                console.error('[UserService] Registration error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // User login - stateless operation
        router.post('/auth/login', async (req, res) => {
            try {
                const schema = Joi.object({
                    email: Joi.string().email().required(),
                    password: Joi.string().required()
                });

                const { error, value } = schema.validate(req.body);
                if (error) {
                    return res.status(400).json({ error: error.details[0].message });
                }

                const { email, password } = value;

                // Find user
                const result = await this.db.query(
                    'SELECT id, email, password_hash, first_name, last_name FROM users WHERE email = $1',
                    [email]
                );

                if (result.rows.length === 0) {
                    return res.status(401).json({ error: 'Invalid credentials' });
                }

                const user = result.rows[0];

                // Verify password
                const isValidPassword = await bcrypt.compare(password, user.password_hash);
                if (!isValidPassword) {
                    return res.status(401).json({ error: 'Invalid credentials' });
                }

                // Generate JWT token (stateless)
                const token = jwt.sign(
                    { 
                        userId: user.id, 
                        email: user.email 
                    },
                    process.env.JWT_SECRET || 'your-secret-key',
                    { expiresIn: '24h' }
                );

                // Publish login event
                await this.messageBroker.publish('user.login', {
                    userId: user.id,
                    email: user.email,
                    timestamp: new Date().toISOString()
                });

                res.json({
                    message: 'Login successful',
                    token,
                    user: {
                        id: user.id,
                        email: user.email,
                        firstName: user.first_name,
                        lastName: user.last_name
                    }
                });
            } catch (error) {
                console.error('[UserService] Login error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Get user profile - stateless operation
        router.get('/users/:id', this.authenticateToken, async (req, res) => {
            try {
                const userId = parseInt(req.params.id);
                
                // Verify user can only access their own profile
                if (req.user.userId !== userId) {
                    return res.status(403).json({ error: 'Access denied' });
                }

                const result = await this.db.query(
                    'SELECT id, email, first_name, last_name, created_at FROM users WHERE id = $1',
                    [userId]
                );

                if (result.rows.length === 0) {
                    return res.status(404).json({ error: 'User not found' });
                }

                const user = result.rows[0];
                res.json({
                    user: {
                        id: user.id,
                        email: user.email,
                        firstName: user.first_name,
                        lastName: user.last_name,
                        createdAt: user.created_at
                    }
                });
            } catch (error) {
                console.error('[UserService] Get profile error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        this.addRoutes(router);
    }

    // Middleware for token authentication - stateless
    authenticateToken(req, res, next) {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({ error: 'Access token required' });
        }

        jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
            if (err) {
                return res.status(403).json({ error: 'Invalid or expired token' });
            }
            req.user = user;
            next();
        });
    }
}

// Start the service
const userService = new UserService();
userService.start();