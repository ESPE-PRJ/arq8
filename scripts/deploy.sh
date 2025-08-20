#!/bin/bash

# CloudMarket Deployment Script
# Automated deployment with health checks and rollback capability

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
COMPOSE_FILE="docker-compose.yml"
PROJECT_NAME="cloudmarket"
HEALTH_CHECK_TIMEOUT=60
HEALTH_CHECK_INTERVAL=5

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_prerequisites() {
    log_info "Checking prerequisites..."
    
    # Check if Docker is installed and running
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed"
        exit 1
    fi
    
    if ! docker info &> /dev/null; then
        log_error "Docker is not running"
        exit 1
    fi
    
    # Check if Docker Compose is available
    if ! docker compose version &> /dev/null; then
        log_error "Docker Compose is not available"
        exit 1
    fi
    
    # Check if docker-compose.yml exists
    if [[ ! -f "$COMPOSE_FILE" ]]; then
        log_error "docker-compose.yml not found"
        exit 1
    fi
    
    log_success "Prerequisites check passed"
}

build_services() {
    log_info "Building Docker images..."
    
    # Build all services
    docker compose build --no-cache
    
    if [[ $? -eq 0 ]]; then
        log_success "All services built successfully"
    else
        log_error "Failed to build services"
        exit 1
    fi
}

start_infrastructure() {
    log_info "Starting infrastructure services..."
    
    # Start databases and Redis first
    docker compose up -d redis postgres-user postgres-product postgres-order postgres-events
    
    # Wait for databases to be ready
    log_info "Waiting for databases to be ready..."
    sleep 20
    
    # Check database health
    for db in postgres-user postgres-product postgres-order postgres-events; do
        if docker compose exec -T $db pg_isready &> /dev/null; then
            log_success "$db is ready"
        else
            log_warning "$db is not ready yet, continuing anyway..."
        fi
    done
    
    # Check Redis health
    if docker compose exec -T redis redis-cli ping &> /dev/null; then
        log_success "Redis is ready"
    else
        log_warning "Redis is not ready yet, continuing anyway..."
    fi
}

start_services() {
    log_info "Starting application services..."
    
    # Start services in dependency order
    docker compose up -d user-service product-service
    sleep 10
    
    docker compose up -d order-service notification-service event-store
    sleep 10
    
    docker compose up -d api-gateway
    sleep 5
    
    # Start monitoring services
    docker compose up -d prometheus grafana
    
    log_success "All services started"
}

health_check() {
    log_info "Performing health checks..."
    
    local services=("user-service:3001" "product-service:3002" "order-service:3003" "notification-service:3004" "event-store:3005")
    local gateway_url="http://localhost:8080"
    
    # Wait for API Gateway to be ready
    local attempts=0
    local max_attempts=$((HEALTH_CHECK_TIMEOUT / HEALTH_CHECK_INTERVAL))
    
    while [[ $attempts -lt $max_attempts ]]; do
        if curl -f -s "$gateway_url/health" > /dev/null 2>&1; then
            log_success "API Gateway is healthy"
            break
        fi
        
        log_info "Waiting for API Gateway... (attempt $((attempts + 1))/$max_attempts)"
        sleep $HEALTH_CHECK_INTERVAL
        attempts=$((attempts + 1))
    done
    
    if [[ $attempts -eq $max_attempts ]]; then
        log_error "API Gateway health check failed"
        return 1
    fi
    
    # Check individual services through the gateway
    for endpoint in "users" "products" "orders" "notifications" "events"; do
        local url="$gateway_url/api/$endpoint"
        
        # For endpoints that require specific paths, adjust accordingly
        case $endpoint in
            "users") url="$gateway_url/api/auth/login" ;;
            "products") url="$gateway_url/api/products" ;;
            "orders") url="$gateway_url/api/orders" ;;
            "notifications") url="$gateway_url/api/notifications/queue/status" ;;
            "events") url="$gateway_url/api/events" ;;
        esac
        
        if curl -f -s "$url" > /dev/null 2>&1 || [[ $? -eq 22 ]]; then
            log_success "$endpoint service is accessible"
        else
            log_warning "$endpoint service may not be fully ready"
        fi
    done
    
    return 0
}

run_smoke_tests() {
    log_info "Running smoke tests..."
    
    local gateway_url="http://localhost:8080"
    local test_failed=false
    
    # Test 1: Get products
    log_info "Test 1: Get products list"
    if curl -f -s "$gateway_url/api/products" | jq . > /dev/null 2>&1; then
        log_success "✓ Products API is working"
    else
        log_error "✗ Products API failed"
        test_failed=true
    fi
    
    # Test 2: Health endpoints
    log_info "Test 2: Health endpoints"
    for service in user-service product-service order-service notification-service event-store; do
        local port=""
        case $service in
            "user-service") port="3001" ;;
            "product-service") port="3002" ;;
            "order-service") port="3003" ;;
            "notification-service") port="3004" ;;
            "event-store") port="3005" ;;
        esac
        
        if docker compose exec -T $service curl -f -s "http://localhost:$port/health" > /dev/null 2>&1; then
            log_success "✓ $service health check passed"
        else
            log_error "✗ $service health check failed"
            test_failed=true
        fi
    done
    
    # Test 3: Redis connectivity
    log_info "Test 3: Redis connectivity"
    if docker compose exec -T redis redis-cli ping > /dev/null 2>&1; then
        log_success "✓ Redis is responding"
    else
        log_error "✗ Redis connectivity failed"
        test_failed=true
    fi
    
    # Test 4: Database connectivity
    log_info "Test 4: Database connectivity"
    for db in postgres-user postgres-product postgres-order postgres-events; do
        if docker compose exec -T $db pg_isready > /dev/null 2>&1; then
            log_success "✓ $db is ready"
        else
            log_error "✗ $db connectivity failed"
            test_failed=true
        fi
    done
    
    if [[ "$test_failed" == "true" ]]; then
        log_error "Some smoke tests failed"
        return 1
    else
        log_success "All smoke tests passed"
        return 0
    fi
}

show_status() {
    log_info "Current deployment status:"
    echo ""
    docker compose ps
    echo ""
    
    log_info "Service URLs:"
    echo "• API Gateway: http://localhost:8080"
    echo "• Prometheus: http://localhost:9090"
    echo "• Grafana: http://localhost:3000 (admin/admin)"
    echo ""
    
    log_info "API Endpoints:"
    echo "• Products: http://localhost:8080/api/products"
    echo "• Auth: http://localhost:8080/api/auth/login"
    echo "• Orders: http://localhost:8080/api/orders"
    echo "• Events: http://localhost:8080/api/events"
    echo "• Notifications: http://localhost:8080/api/notifications/queue/status"
}

rollback() {
    log_warning "Rolling back deployment..."
    docker compose down
    log_info "Rollback completed"
}

cleanup() {
    log_info "Cleaning up..."
    docker compose down --volumes --remove-orphans
    docker system prune -f
    log_success "Cleanup completed"
}

# Main deployment function
deploy() {
    log_info "Starting CloudMarket deployment..."
    
    # Check prerequisites
    check_prerequisites
    
    # Build services
    build_services
    
    # Start infrastructure
    start_infrastructure
    
    # Start application services
    start_services
    
    # Perform health checks
    if ! health_check; then
        log_error "Health checks failed, rolling back..."
        rollback
        exit 1
    fi
    
    # Run smoke tests
    if ! run_smoke_tests; then
        log_warning "Smoke tests failed, but deployment will continue"
    fi
    
    # Show final status
    show_status
    
    log_success "CloudMarket deployment completed successfully!"
}

# Script execution
case "${1:-deploy}" in
    deploy)
        deploy
        ;;
    status)
        show_status
        ;;
    health)
        health_check
        ;;
    test)
        run_smoke_tests
        ;;
    rollback)
        rollback
        ;;
    cleanup)
        cleanup
        ;;
    *)
        echo "Usage: $0 {deploy|status|health|test|rollback|cleanup}"
        echo ""
        echo "Commands:"
        echo "  deploy   - Full deployment (default)"
        echo "  status   - Show current status"
        echo "  health   - Run health checks"
        echo "  test     - Run smoke tests"
        echo "  rollback - Stop all services"
        echo "  cleanup  - Stop services and clean up"
        exit 1
        ;;
esac