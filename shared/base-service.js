const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

class BaseService {
    constructor(serviceName, port) {
        this.app = express();
        this.serviceName = serviceName;
        this.port = port;
        this.setupMiddleware();
        this.setupHealthCheck();
    }

    setupMiddleware() {
        // Security middleware
        this.app.use(helmet());
        
        // CORS
        this.app.use(cors({
            origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
            credentials: true
        }));

        // Rate limiting
        const limiter = rateLimit({
            windowMs: 15 * 60 * 1000, // 15 minutes
            max: 100, // limit each IP to 100 requests per windowMs
            message: 'Too many requests from this IP'
        });
        this.app.use(limiter);

        // Logging
        this.app.use(morgan('combined'));

        // Body parsing
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true }));
    }

    setupHealthCheck() {
        this.app.get('/health', (req, res) => {
            res.status(200).json({
                service: this.serviceName,
                status: 'healthy',
                timestamp: new Date().toISOString(),
                uptime: process.uptime()
            });
        });

        this.app.get('/ready', (req, res) => {
            res.status(200).json({
                service: this.serviceName,
                status: 'ready',
                timestamp: new Date().toISOString()
            });
        });
    }

    addRoutes(router) {
        this.app.use('/api', router);
    }

    // Error handling middleware
    setupErrorHandling() {
        this.app.use((err, req, res, next) => {
            console.error(`[${this.serviceName}] Error:`, err);
            
            res.status(err.status || 500).json({
                error: {
                    message: err.message || 'Internal server error',
                    service: this.serviceName,
                    timestamp: new Date().toISOString()
                }
            });
        });

        // 404 handler
        this.app.use((req, res) => {
            res.status(404).json({
                error: {
                    message: 'Endpoint not found',
                    service: this.serviceName,
                    path: req.path
                }
            });
        });
    }

    start() {
        this.setupErrorHandling();
        
        this.app.listen(this.port, '0.0.0.0', () => {
            console.log(`[${this.serviceName}] Service running on port ${this.port}`);
        });

        // Graceful shutdown
        process.on('SIGTERM', () => {
            console.log(`[${this.serviceName}] SIGTERM received, shutting down gracefully`);
            process.exit(0);
        });

        process.on('SIGINT', () => {
            console.log(`[${this.serviceName}] SIGINT received, shutting down gracefully`);
            process.exit(0);
        });
    }
}

module.exports = BaseService;