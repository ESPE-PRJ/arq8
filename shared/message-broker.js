const redis = require('redis');

class MessageBroker {
    constructor() {
        this.publisher = null;
        this.subscriber = null;
        this.eventHandlers = new Map();
        this.isConnected = false;
    }

    async connect() {
        try {
            const redisOptions = {
                host: process.env.REDIS_HOST || 'redis',
                port: process.env.REDIS_PORT || 6379,
                retry_strategy: (options) => {
                    if (options.error && options.error.code === 'ECONNREFUSED') {
                        return new Error('The server refused the connection');
                    }
                    if (options.total_retry_time > 1000 * 60 * 60) {
                        return new Error('Retry time exhausted');
                    }
                    if (options.attempt > 10) {
                        return undefined;
                    }
                    return Math.min(options.attempt * 100, 3000);
                }
            };

            this.publisher = redis.createClient(redisOptions);
            this.subscriber = redis.createClient(redisOptions);

            await this.publisher.connect();
            await this.subscriber.connect();

            this.subscriber.on('message', (channel, message) => {
                this.handleMessage(channel, message);
            });

            this.isConnected = true;
            console.log('[MessageBroker] Connected to Redis');
        } catch (error) {
            console.error('[MessageBroker] Connection failed:', error);
            throw error;
        }
    }

    async publish(channel, data) {
        if (!this.isConnected) {
            throw new Error('MessageBroker not connected');
        }

        const message = {
            id: this.generateId(),
            timestamp: new Date().toISOString(),
            data: data
        };

        try {
            await this.publisher.publish(channel, JSON.stringify(message));
            console.log(`[MessageBroker] Published to ${channel}:`, message.id);
        } catch (error) {
            console.error(`[MessageBroker] Publish failed for ${channel}:`, error);
            throw error;
        }
    }

    async subscribe(channel, handler) {
        if (!this.isConnected) {
            throw new Error('MessageBroker not connected');
        }

        if (!this.eventHandlers.has(channel)) {
            this.eventHandlers.set(channel, []);
            await this.subscriber.subscribe(channel);
            console.log(`[MessageBroker] Subscribed to ${channel}`);
        }

        this.eventHandlers.get(channel).push(handler);
    }

    async unsubscribe(channel, handler) {
        if (!this.eventHandlers.has(channel)) {
            return;
        }

        const handlers = this.eventHandlers.get(channel);
        const index = handlers.indexOf(handler);
        
        if (index > -1) {
            handlers.splice(index, 1);
        }

        if (handlers.length === 0) {
            await this.subscriber.unsubscribe(channel);
            this.eventHandlers.delete(channel);
            console.log(`[MessageBroker] Unsubscribed from ${channel}`);
        }
    }

    handleMessage(channel, message) {
        try {
            const parsedMessage = JSON.parse(message);
            const handlers = this.eventHandlers.get(channel) || [];

            handlers.forEach(handler => {
                try {
                    handler(parsedMessage.data, parsedMessage);
                } catch (error) {
                    console.error(`[MessageBroker] Handler error for ${channel}:`, error);
                }
            });
        } catch (error) {
            console.error(`[MessageBroker] Message parsing error for ${channel}:`, error);
        }
    }

    generateId() {
        return Math.random().toString(36).substr(2, 9);
    }

    async disconnect() {
        if (this.publisher) {
            await this.publisher.quit();
        }
        if (this.subscriber) {
            await this.subscriber.quit();
        }
        this.isConnected = false;
        console.log('[MessageBroker] Disconnected');
    }

    // Health check method
    async isHealthy() {
        try {
            if (!this.isConnected) return false;
            await this.publisher.ping();
            return true;
        } catch (error) {
            return false;
        }
    }
}

module.exports = MessageBroker;