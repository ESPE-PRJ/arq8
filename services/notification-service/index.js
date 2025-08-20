const express = require('express');
const BaseService = require('../../shared/base-service');
const MessageBroker = require('../../shared/message-broker');

class NotificationService extends BaseService {
    constructor() {
        super('notification-service', 3004);
        this.messageBroker = new MessageBroker();
        this.notificationQueue = [];
        this.setupRoutes();
        this.connectToMessageBroker();
    }

    async connectToMessageBroker() {
        try {
            await this.messageBroker.connect();
            this.setupEventHandlers();
            console.log('[NotificationService] Connected to message broker');
        } catch (error) {
            console.error('[NotificationService] MessageBroker connection failed:', error);
        }
    }

    setupEventHandlers() {
        // Handle user creation events
        this.messageBroker.subscribe('user.created', (data) => {
            this.sendWelcomeNotification(data);
        });

        // Handle user login events
        this.messageBroker.subscribe('user.login', (data) => {
            this.sendLoginNotification(data);
        });

        // Handle order creation events
        this.messageBroker.subscribe('order.created', (data) => {
            this.sendOrderConfirmationNotification(data);
        });

        // Handle order status changes
        this.messageBroker.subscribe('order.status_changed', (data) => {
            this.sendOrderStatusNotification(data);
        });

        // Handle order cancellation events
        this.messageBroker.subscribe('order.cancelled', (data) => {
            this.sendOrderCancellationNotification(data);
        });

        // Handle payment confirmation events
        this.messageBroker.subscribe('payment.confirmed', (data) => {
            this.sendPaymentConfirmationNotification(data);
        });

        // Handle payment failure events
        this.messageBroker.subscribe('payment.failed', (data) => {
            this.sendPaymentFailureNotification(data);
        });

        // Handle inventory events (for low stock alerts)
        this.messageBroker.subscribe('inventory.low_stock', (data) => {
            this.sendLowStockAlert(data);
        });
    }

    async sendWelcomeNotification(userData) {
        const notification = {
            id: this.generateNotificationId(),
            type: 'welcome',
            userId: userData.userId,
            email: userData.email,
            subject: 'Welcome to CloudMarket!',
            message: `Hello ${userData.firstName}, welcome to our platform! We're excited to have you on board.`,
            channels: ['email', 'push'],
            priority: 'normal',
            timestamp: new Date().toISOString(),
            status: 'pending'
        };

        await this.processNotification(notification);
    }

    async sendLoginNotification(userData) {
        const notification = {
            id: this.generateNotificationId(),
            type: 'security',
            userId: userData.userId,
            email: userData.email,
            subject: 'Login detected',
            message: `Hello! We detected a login to your account at ${userData.timestamp}.`,
            channels: ['email'],
            priority: 'low',
            timestamp: new Date().toISOString(),
            status: 'pending'
        };

        await this.processNotification(notification);
    }

    async sendOrderConfirmationNotification(orderData) {
        const notification = {
            id: this.generateNotificationId(),
            type: 'order_confirmation',
            userId: orderData.userId,
            orderId: orderData.orderId,
            subject: 'Order Confirmation',
            message: `Your order #${orderData.orderId} has been received! Total: $${orderData.totalAmount}`,
            channels: ['email', 'sms', 'push'],
            priority: 'high',
            timestamp: new Date().toISOString(),
            status: 'pending'
        };

        await this.processNotification(notification);
    }

    async sendOrderStatusNotification(statusData) {
        const statusMessages = {
            confirmed: 'Your order has been confirmed and is being prepared.',
            shipped: 'Your order has been shipped and is on its way!',
            delivered: 'Your order has been delivered. Enjoy your purchase!',
            payment_failed: 'Payment for your order failed. Please try again.'
        };

        const notification = {
            id: this.generateNotificationId(),
            type: 'order_status',
            orderId: statusData.orderId,
            subject: 'Order Status Update',
            message: statusMessages[statusData.status] || `Order status updated to: ${statusData.status}`,
            channels: ['email', 'push'],
            priority: statusData.status === 'payment_failed' ? 'high' : 'normal',
            timestamp: new Date().toISOString(),
            status: 'pending'
        };

        await this.processNotification(notification);
    }

    async sendOrderCancellationNotification(cancelData) {
        const notification = {
            id: this.generateNotificationId(),
            type: 'order_cancellation',
            userId: cancelData.userId,
            orderId: cancelData.orderId,
            subject: 'Order Cancelled',
            message: `Your order #${cancelData.orderId} has been cancelled successfully. Any charges will be refunded.`,
            channels: ['email', 'push'],
            priority: 'normal',
            timestamp: new Date().toISOString(),
            status: 'pending'
        };

        await this.processNotification(notification);
    }

    async sendPaymentConfirmationNotification(paymentData) {
        const notification = {
            id: this.generateNotificationId(),
            type: 'payment_confirmation',
            userId: paymentData.userId,
            orderId: paymentData.orderId,
            subject: 'Payment Confirmed',
            message: `Payment of $${paymentData.amount} for order #${paymentData.orderId} has been processed successfully.`,
            channels: ['email', 'sms'],
            priority: 'high',
            timestamp: new Date().toISOString(),
            status: 'pending'
        };

        await this.processNotification(notification);
    }

    async sendPaymentFailureNotification(paymentData) {
        const notification = {
            id: this.generateNotificationId(),
            type: 'payment_failure',
            userId: paymentData.userId,
            orderId: paymentData.orderId,
            subject: 'Payment Failed',
            message: `Payment for order #${paymentData.orderId} failed. Please update your payment method and try again.`,
            channels: ['email', 'push'],
            priority: 'urgent',
            timestamp: new Date().toISOString(),
            status: 'pending'
        };

        await this.processNotification(notification);
    }

    async sendLowStockAlert(stockData) {
        const notification = {
            id: this.generateNotificationId(),
            type: 'admin_alert',
            productId: stockData.productId,
            subject: 'Low Stock Alert',
            message: `Product ${stockData.productName} is running low on stock. Current quantity: ${stockData.quantity}`,
            channels: ['email'],
            priority: 'normal',
            timestamp: new Date().toISOString(),
            status: 'pending',
            recipients: ['admin@cloudmarket.com', 'inventory@cloudmarket.com']
        };

        await this.processNotification(notification);
    }

    async processNotification(notification) {
        try {
            console.log(`[NotificationService] Processing notification: ${notification.type} - ${notification.id}`);
            
            // Add to queue for processing
            this.notificationQueue.push(notification);
            
            // Simulate different delivery mechanisms
            for (const channel of notification.channels) {
                await this.deliverNotification(notification, channel);
            }

            notification.status = 'sent';
            console.log(`[NotificationService] Notification sent successfully: ${notification.id}`);

            // Publish notification sent event
            await this.messageBroker.publish('notification.sent', {
                notificationId: notification.id,
                type: notification.type,
                channels: notification.channels,
                userId: notification.userId,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            console.error(`[NotificationService] Error processing notification:`, error);
            notification.status = 'failed';
            notification.error = error.message;

            // Publish notification failed event
            await this.messageBroker.publish('notification.failed', {
                notificationId: notification.id,
                type: notification.type,
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
    }

    async deliverNotification(notification, channel) {
        // Simulate delivery times for different channels
        const deliveryTimes = {
            email: 1000,
            sms: 500,
            push: 200
        };

        return new Promise((resolve) => {
            setTimeout(() => {
                console.log(`[NotificationService] ${channel.toUpperCase()} sent: ${notification.subject}`);
                
                // Simulate delivery details
                const deliveryDetails = {
                    channel,
                    notificationId: notification.id,
                    deliveredAt: new Date().toISOString(),
                    success: Math.random() > 0.05 // 95% success rate
                };

                if (deliveryDetails.success) {
                    console.log(`[NotificationService] ${channel} delivery successful`);
                } else {
                    console.log(`[NotificationService] ${channel} delivery failed`);
                }

                resolve(deliveryDetails);
            }, deliveryTimes[channel] || 1000);
        });
    }

    setupRoutes() {
        const router = express.Router();

        // Get notification queue status - for monitoring
        router.get('/notifications/queue/status', (req, res) => {
            const queueStatus = {
                totalNotifications: this.notificationQueue.length,
                pending: this.notificationQueue.filter(n => n.status === 'pending').length,
                sent: this.notificationQueue.filter(n => n.status === 'sent').length,
                failed: this.notificationQueue.filter(n => n.status === 'failed').length,
                byType: this.getNotificationsByType(),
                byChannel: this.getNotificationsByChannel()
            };

            res.json(queueStatus);
        });

        // Get recent notifications - for debugging
        router.get('/notifications/recent', (req, res) => {
            const limit = parseInt(req.query.limit) || 10;
            const recentNotifications = this.notificationQueue
                .slice(-limit)
                .reverse();

            res.json({
                notifications: recentNotifications,
                total: this.notificationQueue.length
            });
        });

        // Send custom notification - for testing
        router.post('/notifications/send', async (req, res) => {
            try {
                const { type, userId, subject, message, channels, priority } = req.body;

                const notification = {
                    id: this.generateNotificationId(),
                    type: type || 'custom',
                    userId,
                    subject,
                    message,
                    channels: channels || ['email'],
                    priority: priority || 'normal',
                    timestamp: new Date().toISOString(),
                    status: 'pending'
                };

                await this.processNotification(notification);

                res.status(201).json({
                    message: 'Notification sent successfully',
                    notificationId: notification.id
                });
            } catch (error) {
                console.error('[NotificationService] Custom notification error:', error);
                res.status(500).json({ error: 'Failed to send notification' });
            }
        });

        // Clear notification queue - for maintenance
        router.delete('/notifications/queue', (req, res) => {
            const clearedCount = this.notificationQueue.length;
            this.notificationQueue = [];
            
            res.json({
                message: `Cleared ${clearedCount} notifications from queue`
            });
        });

        this.addRoutes(router);
    }

    getNotificationsByType() {
        const types = {};
        this.notificationQueue.forEach(notification => {
            types[notification.type] = (types[notification.type] || 0) + 1;
        });
        return types;
    }

    getNotificationsByChannel() {
        const channels = {};
        this.notificationQueue.forEach(notification => {
            notification.channels.forEach(channel => {
                channels[channel] = (channels[channel] || 0) + 1;
            });
        });
        return channels;
    }

    generateNotificationId() {
        return 'notif_' + Math.random().toString(36).substr(2, 9);
    }
}

// Start the service
const notificationService = new NotificationService();
notificationService.start();