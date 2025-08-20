#!/bin/bash

# CloudMarket Monitoring Script
# Real-time monitoring of system health and performance

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
BASE_URL="http://localhost:8080"
REFRESH_INTERVAL=5
PROMETHEUS_URL="http://localhost:9090"
GRAFANA_URL="http://localhost:3000"

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_highlight() {
    echo -e "${CYAN}$1${NC}"
}

clear_screen() {
    clear
    echo -e "${CYAN}========================================${NC}"
    echo -e "${CYAN}    CloudMarket System Monitor${NC}"
    echo -e "${CYAN}========================================${NC}"
    echo ""
}

check_service_health() {
    local service_name="$1"
    local url="$2"
    local timeout="${3:-5}"
    
    if curl -s -f --max-time "$timeout" "$url" > /dev/null 2>&1; then
        echo -e "${GREEN}●${NC} $service_name"
        return 0
    else
        echo -e "${RED}●${NC} $service_name"
        return 1
    fi
}

get_container_stats() {
    local container_name="$1"
    
    if docker ps --format "table {{.Names}}" | grep -q "$container_name"; then
        local stats=$(docker stats "$container_name" --no-stream --format "table {{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}")
        echo "$stats" | tail -n 1
    else
        echo "N/A\tN/A\tN/A"
    fi
}

show_service_status() {
    log_highlight "=== Service Health Status ==="
    
    local services=(
        "API Gateway:$BASE_URL/health"
        "User Service:$BASE_URL/api/users/1"
        "Product Service:$BASE_URL/api/products"
        "Order Service:$BASE_URL/api/orders"
        "Notification Service:$BASE_URL/api/notifications/queue/status"
        "Event Store:$BASE_URL/api/events/stats"
    )
    
    local healthy_count=0
    local total_count=${#services[@]}
    
    for service in "${services[@]}"; do
        IFS=':' read -r name url <<< "$service"
        if check_service_health "$name" "$url"; then
            healthy_count=$((healthy_count + 1))
        fi
    done
    
    echo ""
    echo "Services: $healthy_count/$total_count healthy"
    echo ""
}

show_container_stats() {
    log_highlight "=== Container Resource Usage ==="
    printf "%-20s %-10s %-20s %-15s\n" "Container" "CPU %" "Memory Usage" "Network I/O"
    printf "%-20s %-10s %-20s %-15s\n" "----------" "-----" "------------" "-----------"
    
    local containers=(
        "cloudmarket-api-gateway-1"
        "cloudmarket-user-service-1"
        "cloudmarket-product-service-1"
        "cloudmarket-order-service-1"
        "cloudmarket-notification-service-1"
        "cloudmarket-event-store-1"
        "cloudmarket-redis-1"
        "cloudmarket-postgres-user-1"
        "cloudmarket-postgres-product-1"
        "cloudmarket-postgres-order-1"
    )
    
    for container in "${containers[@]}"; do
        local short_name=$(echo "$container" | sed 's/cloudmarket-//; s/-1$//')
        local stats=$(get_container_stats "$container")
        if [[ "$stats" != "N/A"* ]]; then
            printf "%-20s %s\n" "$short_name" "$stats"
        fi
    done
    echo ""
}

show_api_metrics() {
    log_highlight "=== API Metrics ==="
    
    # Get notification queue status
    local notif_status=$(curl -s "$BASE_URL/api/notifications/queue/status" 2>/dev/null)
    if [[ $? -eq 0 ]]; then
        local total_notifs=$(echo "$notif_status" | jq -r '.totalNotifications // "N/A"')
        local pending_notifs=$(echo "$notif_status" | jq -r '.pending // "N/A"')
        local sent_notifs=$(echo "$notif_status" | jq -r '.sent // "N/A"')
        echo "Notifications: $total_notifs total, $pending_notifs pending, $sent_notifs sent"
    else
        echo "Notifications: Service unavailable"
    fi
    
    # Get event store stats
    local event_stats=$(curl -s "$BASE_URL/api/events/stats" 2>/dev/null)
    if [[ $? -eq 0 ]]; then
        local total_events=$(echo "$event_stats" | jq -r '.events.total_events // "N/A"')
        local event_types=$(echo "$event_stats" | jq -r '.events.event_types // "N/A"')
        echo "Events: $total_events total, $event_types types"
    else
        echo "Events: Service unavailable"
    fi
    
    # Get product service circuit breaker status
    local cb_status=$(curl -s "$BASE_URL/api/products/circuit-breaker/status" 2>/dev/null)
    if [[ $? -eq 0 ]]; then
        local cb_state=$(echo "$cb_status" | jq -r '.circuitBreaker.state // "N/A"')
        local failure_count=$(echo "$cb_status" | jq -r '.circuitBreaker.failureCount // "N/A"')
        echo "Circuit Breaker: $cb_state (failures: $failure_count)"
    else
        echo "Circuit Breaker: Service unavailable"
    fi
    
    echo ""
}

show_database_status() {
    log_highlight "=== Database Status ==="
    
    local databases=(
        "postgres-user:userdb"
        "postgres-product:productdb"
        "postgres-order:orderdb"
        "postgres-events:eventsdb"
    )
    
    for db_info in "${databases[@]}"; do
        IFS=':' read -r container dbname <<< "$db_info"
        local full_container="cloudmarket-$container-1"
        
        if docker ps --format "{{.Names}}" | grep -q "$full_container"; then
            if docker exec "$full_container" pg_isready -d "$dbname" > /dev/null 2>&1; then
                echo -e "${GREEN}●${NC} $container ($dbname)"
            else
                echo -e "${RED}●${NC} $container ($dbname)"
            fi
        else
            echo -e "${RED}●${NC} $container (not running)"
        fi
    done
    
    # Redis status
    if docker ps --format "{{.Names}}" | grep -q "cloudmarket-redis-1"; then
        if docker exec cloudmarket-redis-1 redis-cli ping > /dev/null 2>&1; then
            echo -e "${GREEN}●${NC} Redis"
        else
            echo -e "${RED}●${NC} Redis"
        fi
    else
        echo -e "${RED}●${NC} Redis (not running)"
    fi
    
    echo ""
}

show_recent_logs() {
    log_highlight "=== Recent Log Activity ==="
    
    local services=(
        "api-gateway"
        "user-service"
        "product-service"
        "order-service"
        "notification-service"
        "event-store"
    )
    
    for service in "${services[@]}"; do
        local container="cloudmarket-$service-1"
        if docker ps --format "{{.Names}}" | grep -q "$container"; then
            local recent_log=$(docker logs "$container" --tail 1 --since 30s 2>/dev/null | tail -1)
            if [[ -n "$recent_log" ]]; then
                echo "[$service] ${recent_log:0:80}..."
            fi
        fi
    done
    echo ""
}

show_monitoring_urls() {
    log_highlight "=== Monitoring URLs ==="
    echo "• System Status: $BASE_URL/health"
    echo "• Prometheus: $PROMETHEUS_URL"
    echo "• Grafana: $GRAFANA_URL"
    echo "• API Gateway: $BASE_URL"
    echo ""
}

show_quick_commands() {
    log_highlight "=== Quick Commands ==="
    echo "• View logs: docker compose logs -f [service-name]"
    echo "• Restart service: docker compose restart [service-name]"
    echo "• Scale service: docker compose up -d --scale [service-name]=2"
    echo "• Stop all: docker compose down"
    echo ""
}

monitor_continuous() {
    while true; do
        clear_screen
        
        show_service_status
        show_container_stats
        show_api_metrics
        show_database_status
        show_recent_logs
        show_monitoring_urls
        
        echo -e "${YELLOW}Refreshing every ${REFRESH_INTERVAL}s... (Ctrl+C to exit)${NC}"
        echo "Last updated: $(date '+%Y-%m-%d %H:%M:%S')"
        
        sleep "$REFRESH_INTERVAL"
    done
}

show_dashboard() {
    clear_screen
    
    show_service_status
    show_container_stats
    show_api_metrics
    show_database_status
    show_monitoring_urls
    show_quick_commands
}

check_alerts() {
    log_info "Checking for alerts..."
    local alerts_found=false
    
    # Check for unhealthy services
    local services=(
        "API Gateway:$BASE_URL/health"
        "User Service:$BASE_URL/api/users/1"
        "Product Service:$BASE_URL/api/products"
        "Order Service:$BASE_URL/api/orders"
        "Notification Service:$BASE_URL/api/notifications/queue/status"
        "Event Store:$BASE_URL/api/events/stats"
    )
    
    for service in "${services[@]}"; do
        IFS=':' read -r name url <<< "$service"
        if ! curl -s -f --max-time 5 "$url" > /dev/null 2>&1; then
            log_error "ALERT: $name is unhealthy"
            alerts_found=true
        fi
    done
    
    # Check circuit breaker status
    local cb_status=$(curl -s "$BASE_URL/api/products/circuit-breaker/status" 2>/dev/null)
    if [[ $? -eq 0 ]]; then
        local cb_state=$(echo "$cb_status" | jq -r '.circuitBreaker.state // "UNKNOWN"')
        if [[ "$cb_state" == "OPEN" ]]; then
            log_error "ALERT: Circuit breaker is OPEN"
            alerts_found=true
        fi
    fi
    
    # Check notification queue
    local notif_status=$(curl -s "$BASE_URL/api/notifications/queue/status" 2>/dev/null)
    if [[ $? -eq 0 ]]; then
        local pending_notifs=$(echo "$notif_status" | jq -r '.pending // 0')
        if [[ "$pending_notifs" -gt 100 ]]; then
            log_warning "ALERT: High notification queue: $pending_notifs pending"
            alerts_found=true
        fi
    fi
    
    if [[ "$alerts_found" == "false" ]]; then
        log_success "No alerts detected"
    fi
}

# Main execution
case "${1:-dashboard}" in
    dashboard)
        show_dashboard
        ;;
    monitor)
        monitor_continuous
        ;;
    health)
        show_service_status
        ;;
    stats)
        show_container_stats
        ;;
    metrics)
        show_api_metrics
        ;;
    databases)
        show_database_status
        ;;
    logs)
        show_recent_logs
        ;;
    alerts)
        check_alerts
        ;;
    *)
        echo "Usage: $0 {dashboard|monitor|health|stats|metrics|databases|logs|alerts}"
        echo ""
        echo "Commands:"
        echo "  dashboard - Show system overview (default)"
        echo "  monitor   - Continuous monitoring mode"
        echo "  health    - Service health status"
        echo "  stats     - Container resource usage"
        echo "  metrics   - API and business metrics"
        echo "  databases - Database status"
        echo "  logs      - Recent log activity"
        echo "  alerts    - Check for system alerts"
        exit 1
        ;;
esac