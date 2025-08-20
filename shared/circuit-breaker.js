class CircuitBreaker {
    constructor(request, options = {}) {
        this.request = request;
        this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
        this.failureCount = 0;
        this.successCount = 0;
        this.nextAttempt = Date.now();
        
        // Configuration
        this.failureThreshold = options.failureThreshold || 5;
        this.successThreshold = options.successThreshold || 2;
        this.timeout = options.timeout || 60000; // 1 minute
        this.monitoringPeriod = options.monitoringPeriod || 10000; // 10 seconds
        
        this.onStateChange = options.onStateChange || (() => {});
    }

    async call(...args) {
        if (this.state === 'OPEN') {
            if (Date.now() < this.nextAttempt) {
                throw new Error(`Circuit breaker is OPEN. Next attempt in ${this.nextAttempt - Date.now()}ms`);
            } else {
                this.state = 'HALF_OPEN';
                this.successCount = 0;
                this.onStateChange('HALF_OPEN');
            }
        }

        try {
            const result = await this.request(...args);
            return this.onSuccess(result);
        } catch (error) {
            return this.onFailure(error);
        }
    }

    onSuccess(result) {
        this.failureCount = 0;
        
        if (this.state === 'HALF_OPEN') {
            this.successCount++;
            if (this.successCount >= this.successThreshold) {
                this.state = 'CLOSED';
                this.successCount = 0;
                this.onStateChange('CLOSED');
            }
        }
        
        return result;
    }

    onFailure(error) {
        this.failureCount++;
        
        if (this.state === 'HALF_OPEN' || this.failureCount >= this.failureThreshold) {
            this.state = 'OPEN';
            this.nextAttempt = Date.now() + this.timeout;
            this.onStateChange('OPEN');
        }
        
        throw error;
    }

    getStats() {
        return {
            state: this.state,
            failureCount: this.failureCount,
            successCount: this.successCount,
            nextAttempt: this.nextAttempt
        };
    }

    reset() {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        this.nextAttempt = Date.now();
        this.onStateChange('CLOSED');
    }
}

module.exports = CircuitBreaker;