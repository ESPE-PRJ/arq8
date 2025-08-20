const express = require('express');
const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');
const { Client } = require('pg');
const BaseService = require('../../shared/base-service');
const MessageBroker = require('../../shared/message-broker');

class EventStore extends BaseService {
    constructor() {
        super('event-store', 3005);
        this.db = null;
        this.messageBroker = new MessageBroker();
        this.eventHandlers = new Map();
        this.projections = new Map();
        this.setupRoutes();
        this.connectToDatabase();
        this.connectToMessageBroker();
        this.setupProjections();
    }

    async connectToDatabase() {
        this.db = new Client({
            host: process.env.POSTGRES_HOST || 'postgres-events',
            port: process.env.POSTGRES_PORT || 5432,
            database: process.env.POSTGRES_DB || 'eventsdb',
            user: process.env.POSTGRES_USER || 'postgres',
            password: process.env.POSTGRES_PASSWORD || 'password'
        });

        try {
            await this.db.connect();
            await this.createTables();
            console.log('[EventStore] Connected to PostgreSQL');
        } catch (error) {
            console.error('[EventStore] Database connection failed:', error);
        }
    }

    async connectToMessageBroker() {
        try {
            await this.messageBroker.connect();
            this.setupEventListeners();
        } catch (error) {
            console.error('[EventStore] MessageBroker connection failed:', error);
        }
    }

    async createTables() {
        const query = `
            -- Events table - immutable event log
            CREATE TABLE IF NOT EXISTS events (
                id UUID PRIMARY KEY,
                aggregate_id VARCHAR(255) NOT NULL,
                aggregate_type VARCHAR(100) NOT NULL,
                event_type VARCHAR(100) NOT NULL,
                event_version INTEGER NOT NULL,
                event_data JSONB NOT NULL,
                metadata JSONB DEFAULT '{}',
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                sequence_number SERIAL
            );

            -- Snapshots table - for performance optimization
            CREATE TABLE IF NOT EXISTS snapshots (
                aggregate_id VARCHAR(255) PRIMARY KEY,
                aggregate_type VARCHAR(100) NOT NULL,
                version INTEGER NOT NULL,
                data JSONB NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Projections table - read models
            CREATE TABLE IF NOT EXISTS projections (
                id UUID PRIMARY KEY,
                projection_name VARCHAR(100) NOT NULL,
                aggregate_id VARCHAR(255) NOT NULL,
                data JSONB NOT NULL,
                version INTEGER NOT NULL,
                last_event_id UUID,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Indexes for performance
            CREATE INDEX IF NOT EXISTS idx_events_aggregate ON events(aggregate_id, aggregate_type);
            CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
            CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
            CREATE INDEX IF NOT EXISTS idx_events_sequence ON events(sequence_number);
            CREATE INDEX IF NOT EXISTS idx_projections_name_aggregate ON projections(projection_name, aggregate_id);
        `;
        await this.db.query(query);
    }

    setupEventListeners() {
        // Listen to all domain events for storage
        const eventTypes = [
            'user.created', 'user.login',
            'order.created', 'order.status_changed', 'order.cancelled',
            'payment.confirmed', 'payment.failed',
            'inventory.reserve', 'inventory.restore',
            'notification.sent', 'notification.failed'
        ];

        eventTypes.forEach(eventType => {
            this.messageBroker.subscribe(eventType, async (data, metadata) => {
                await this.storeEvent(eventType, data, metadata);
            });
        });
    }

    async storeEvent(eventType, eventData, metadata = {}) {
        try {
            const eventId = uuidv4();
            const aggregateId = this.extractAggregateId(eventType, eventData);
            const aggregateType = this.extractAggregateType(eventType);
            
            // Get current version for this aggregate
            const versionResult = await this.db.query(
                'SELECT COALESCE(MAX(event_version), 0) as version FROM events WHERE aggregate_id = $1 AND aggregate_type = $2',
                [aggregateId, aggregateType]
            );
            
            const nextVersion = versionResult.rows[0].version + 1;

            // Store the event
            await this.db.query(
                `INSERT INTO events (id, aggregate_id, aggregate_type, event_type, event_version, event_data, metadata) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    eventId,
                    aggregateId,
                    aggregateType,
                    eventType,
                    nextVersion,
                    JSON.stringify(eventData),
                    JSON.stringify({
                        ...metadata,
                        source: 'message-broker',
                        correlationId: metadata.id
                    })
                ]
            );

            console.log(`[EventStore] Stored event: ${eventType} for ${aggregateType}:${aggregateId}`);

            // Update projections
            await this.updateProjections(eventType, eventData, eventId, aggregateId, aggregateType);

            // Publish event stored notification
            await this.messageBroker.publish('event.stored', {
                eventId,
                eventType,
                aggregateId,
                aggregateType,
                version: nextVersion
            });

        } catch (error) {
            console.error('[EventStore] Store event error:', error);
        }
    }

    extractAggregateId(eventType, eventData) {
        // Extract the aggregate ID based on event type
        const extractors = {
            'user.created': (data) => `user-${data.userId}`,
            'user.login': (data) => `user-${data.userId}`,
            'order.created': (data) => `order-${data.orderId}`,
            'order.status_changed': (data) => `order-${data.orderId}`,
            'order.cancelled': (data) => `order-${data.orderId}`,
            'payment.confirmed': (data) => `payment-${data.orderId}`,
            'payment.failed': (data) => `payment-${data.orderId}`,
            'inventory.reserve': (data) => `product-${data.productId}`,
            'inventory.restore': (data) => `product-${data.productId}`,
            'notification.sent': (data) => `notification-${data.notificationId}`,
            'notification.failed': (data) => `notification-${data.notificationId}`
        };

        return extractors[eventType] ? extractors[eventType](eventData) : 'unknown';
    }

    extractAggregateType(eventType) {
        const typeMap = {
            'user.created': 'User',
            'user.login': 'User',
            'order.created': 'Order',
            'order.status_changed': 'Order',
            'order.cancelled': 'Order',
            'payment.confirmed': 'Payment',
            'payment.failed': 'Payment',
            'inventory.reserve': 'Product',
            'inventory.restore': 'Product',
            'notification.sent': 'Notification',
            'notification.failed': 'Notification'
        };

        return typeMap[eventType] || 'Unknown';
    }

    setupProjections() {
        // User projection
        this.projections.set('user-summary', {
            name: 'user-summary',
            eventTypes: ['user.created', 'user.login'],
            project: async (eventType, eventData, aggregateId) => {
                const existing = await this.getProjection('user-summary', aggregateId);
                
                switch (eventType) {
                    case 'user.created':
                        return {
                            userId: eventData.userId,
                            email: eventData.email,
                            firstName: eventData.firstName,
                            lastName: eventData.lastName,
                            createdAt: eventData.timestamp || new Date().toISOString(),
                            lastLogin: null,
                            loginCount: 0
                        };
                    
                    case 'user.login':
                        return {
                            ...existing,
                            lastLogin: eventData.timestamp,
                            loginCount: (existing?.loginCount || 0) + 1
                        };
                }
            }
        });

        // Order projection
        this.projections.set('order-summary', {
            name: 'order-summary',
            eventTypes: ['order.created', 'order.status_changed', 'order.cancelled'],
            project: async (eventType, eventData, aggregateId) => {
                const existing = await this.getProjection('order-summary', aggregateId);

                switch (eventType) {
                    case 'order.created':
                        return {
                            orderId: eventData.orderId,
                            userId: eventData.userId,
                            totalAmount: eventData.totalAmount,
                            status: 'pending',
                            items: eventData.items,
                            createdAt: eventData.timestamp,
                            statusHistory: [{
                                status: 'pending',
                                timestamp: eventData.timestamp
                            }]
                        };
                    
                    case 'order.status_changed':
                        return {
                            ...existing,
                            status: eventData.status,
                            statusHistory: [
                                ...(existing?.statusHistory || []),
                                {
                                    status: eventData.status,
                                    timestamp: eventData.timestamp
                                }
                            ]
                        };
                    
                    case 'order.cancelled':
                        return {
                            ...existing,
                            status: 'cancelled',
                            cancelledAt: eventData.timestamp,
                            statusHistory: [
                                ...(existing?.statusHistory || []),
                                {
                                    status: 'cancelled',
                                    timestamp: eventData.timestamp
                                }
                            ]
                        };
                }
            }
        });

        // Analytics projection
        this.projections.set('analytics', {
            name: 'analytics',
            eventTypes: ['order.created', 'payment.confirmed', 'user.created'],
            project: async (eventType, eventData) => {
                const existing = await this.getProjection('analytics', 'global') || {
                    totalUsers: 0,
                    totalOrders: 0,
                    totalRevenue: 0,
                    ordersToday: 0,
                    revenueToday: 0,
                    lastUpdated: new Date().toISOString()
                };

                const today = new Date().toDateString();
                const isToday = new Date(eventData.timestamp).toDateString() === today;

                switch (eventType) {
                    case 'user.created':
                        return {
                            ...existing,
                            totalUsers: existing.totalUsers + 1,
                            lastUpdated: new Date().toISOString()
                        };
                    
                    case 'order.created':
                        return {
                            ...existing,
                            totalOrders: existing.totalOrders + 1,
                            ordersToday: isToday ? existing.ordersToday + 1 : existing.ordersToday,
                            lastUpdated: new Date().toISOString()
                        };
                    
                    case 'payment.confirmed':
                        return {
                            ...existing,
                            totalRevenue: existing.totalRevenue + eventData.amount,
                            revenueToday: isToday ? existing.revenueToday + eventData.amount : existing.revenueToday,
                            lastUpdated: new Date().toISOString()
                        };
                }
            }
        });
    }

    async updateProjections(eventType, eventData, eventId, aggregateId, aggregateType) {
        for (const [projectionName, projection] of this.projections) {
            if (projection.eventTypes.includes(eventType)) {
                try {
                    const projectedData = await projection.project(eventType, eventData, aggregateId);
                    if (projectedData) {
                        await this.saveProjection(projectionName, aggregateId, projectedData, eventId);
                    }
                } catch (error) {
                    console.error(`[EventStore] Projection ${projectionName} error:`, error);
                }
            }
        }
    }

    async getProjection(projectionName, aggregateId) {
        try {
            const result = await this.db.query(
                'SELECT data FROM projections WHERE projection_name = $1 AND aggregate_id = $2',
                [projectionName, aggregateId]
            );
            return result.rows.length > 0 ? result.rows[0].data : null;
        } catch (error) {
            console.error('[EventStore] Get projection error:', error);
            return null;
        }
    }

    async saveProjection(projectionName, aggregateId, data, eventId) {
        try {
            const projectionId = uuidv4();
            await this.db.query(
                `INSERT INTO projections (id, projection_name, aggregate_id, data, version, last_event_id) 
                 VALUES ($1, $2, $3, $4, 1, $5)
                 ON CONFLICT (projection_name, aggregate_id) 
                 DO UPDATE SET 
                    data = $4, 
                    version = projections.version + 1, 
                    last_event_id = $5, 
                    updated_at = CURRENT_TIMESTAMP`,
                [projectionId, projectionName, aggregateId, JSON.stringify(data), eventId]
            );
        } catch (error) {
            console.error('[EventStore] Save projection error:', error);
        }
    }

    setupRoutes() {
        const router = express.Router();

        // Get events for an aggregate
        router.get('/events/:aggregateType/:aggregateId', async (req, res) => {
            try {
                const { aggregateType, aggregateId } = req.params;
                const fromVersion = parseInt(req.query.fromVersion) || 1;

                const result = await this.db.query(
                    `SELECT * FROM events 
                     WHERE aggregate_type = $1 AND aggregate_id = $2 AND event_version >= $3
                     ORDER BY event_version ASC`,
                    [aggregateType, aggregateId, fromVersion]
                );

                res.json({
                    aggregateId,
                    aggregateType,
                    events: result.rows.map(event => ({
                        ...event,
                        event_data: event.event_data,
                        metadata: event.metadata
                    }))
                });
            } catch (error) {
                console.error('[EventStore] Get events error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Get all events with pagination
        router.get('/events', async (req, res) => {
            try {
                const page = parseInt(req.query.page) || 1;
                const limit = parseInt(req.query.limit) || 50;
                const eventType = req.query.eventType;
                const offset = (page - 1) * limit;

                let query = 'SELECT * FROM events';
                let countQuery = 'SELECT COUNT(*) FROM events';
                const params = [];

                if (eventType) {
                    query += ' WHERE event_type = $1';
                    countQuery += ' WHERE event_type = $1';
                    params.push(eventType);
                }

                query += ` ORDER BY sequence_number DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
                params.push(limit, offset);

                const [eventsResult, countResult] = await Promise.all([
                    this.db.query(query, params),
                    this.db.query(countQuery, eventType ? [eventType] : [])
                ]);

                const totalEvents = parseInt(countResult.rows[0].count);
                const totalPages = Math.ceil(totalEvents / limit);

                res.json({
                    events: eventsResult.rows,
                    pagination: {
                        currentPage: page,
                        totalPages,
                        totalEvents,
                        hasNext: page < totalPages,
                        hasPrev: page > 1
                    }
                });
            } catch (error) {
                console.error('[EventStore] Get all events error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Get projection
        router.get('/projections/:projectionName/:aggregateId', async (req, res) => {
            try {
                const { projectionName, aggregateId } = req.params;
                const projection = await this.getProjection(projectionName, aggregateId);

                if (!projection) {
                    return res.status(404).json({ error: 'Projection not found' });
                }

                res.json({
                    projectionName,
                    aggregateId,
                    data: projection
                });
            } catch (error) {
                console.error('[EventStore] Get projection error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Get all projections of a type
        router.get('/projections/:projectionName', async (req, res) => {
            try {
                const { projectionName } = req.params;
                
                const result = await this.db.query(
                    'SELECT aggregate_id, data, version, updated_at FROM projections WHERE projection_name = $1',
                    [projectionName]
                );

                res.json({
                    projectionName,
                    projections: result.rows
                });
            } catch (error) {
                console.error('[EventStore] Get projections error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Replay events to rebuild projections
        router.post('/projections/:projectionName/replay', async (req, res) => {
            try {
                const { projectionName } = req.params;
                const fromSequence = parseInt(req.body.fromSequence) || 1;

                const projection = this.projections.get(projectionName);
                if (!projection) {
                    return res.status(404).json({ error: 'Projection not found' });
                }

                // Get events to replay
                const eventsResult = await this.db.query(
                    `SELECT * FROM events 
                     WHERE sequence_number >= $1 AND event_type = ANY($2)
                     ORDER BY sequence_number ASC`,
                    [fromSequence, projection.eventTypes]
                );

                let replayedCount = 0;
                for (const event of eventsResult.rows) {
                    const projectedData = await projection.project(
                        event.event_type, 
                        event.event_data, 
                        event.aggregate_id
                    );
                    
                    if (projectedData) {
                        await this.saveProjection(
                            projectionName, 
                            event.aggregate_id, 
                            projectedData, 
                            event.id
                        );
                        replayedCount++;
                    }
                }

                res.json({
                    message: 'Projection replay completed',
                    projectionName,
                    eventsReplayed: replayedCount
                });
            } catch (error) {
                console.error('[EventStore] Replay projection error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Event store statistics
        router.get('/stats', async (req, res) => {
            try {
                const [eventsStats, projectionsStats] = await Promise.all([
                    this.db.query(`
                        SELECT 
                            COUNT(*) as total_events,
                            COUNT(DISTINCT aggregate_type) as aggregate_types,
                            COUNT(DISTINCT event_type) as event_types,
                            MAX(sequence_number) as latest_sequence
                        FROM events
                    `),
                    this.db.query(`
                        SELECT 
                            projection_name,
                            COUNT(*) as projection_count,
                            MAX(updated_at) as last_updated
                        FROM projections 
                        GROUP BY projection_name
                    `)
                ]);

                res.json({
                    events: eventsStats.rows[0],
                    projections: projectionsStats.rows,
                    availableProjections: Array.from(this.projections.keys())
                });
            } catch (error) {
                console.error('[EventStore] Get stats error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        this.addRoutes(router);
    }
}

// Start the service
const eventStore = new EventStore();
eventStore.start();