#!/bin/bash

# CloudMarket API Testing Script
# Comprehensive testing of all microservices APIs

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
BASE_URL="http://localhost:8080"
API_BASE="$BASE_URL/api"
TEST_USER_EMAIL="test@example.com"
TEST_USER_PASSWORD="testpassword123"
AUTH_TOKEN=""

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[PASS]${NC} $1"
    TESTS_PASSED=$((TESTS_PASSED + 1))
}

log_error() {
    echo -e "${RED}[FAIL]${NC} $1"
    TESTS_FAILED=$((TESTS_FAILED + 1))
}

log_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

run_test() {
    local test_name="$1"
    local command="$2"
    local expected_status="$3"
    
    TESTS_RUN=$((TESTS_RUN + 1))
    
    log_info "Running test: $test_name"
    
    # Execute the command and capture response
    local response=$(eval "$command" 2>/dev/null)
    local status_code=$?
    
    if [[ $status_code -eq $expected_status ]]; then
        log_success "$test_name"
        if [[ -n "$response" && "$response" != "null" ]]; then
            echo "  Response: $(echo "$response" | jq -c . 2>/dev/null || echo "$response")"
        fi
    else
        log_error "$test_name (Expected status: $expected_status, Got: $status_code)"
        if [[ -n "$response" ]]; then
            echo "  Response: $response"
        fi
    fi
    
    echo ""
}

# Test API Gateway Health
test_gateway_health() {
    log_info "=== Testing API Gateway ==="
    
    run_test "Gateway Health Check" \
        "curl -s -f '$BASE_URL/health'" \
        0
}

# Test User Service
test_user_service() {
    log_info "=== Testing User Service ==="
    
    # Test user registration
    local register_response=$(curl -s -w "%{http_code}" -o /tmp/register_response \
        -X POST "$API_BASE/auth/register" \
        -H "Content-Type: application/json" \
        -d '{
            "email": "'$TEST_USER_EMAIL'",
            "password": "'$TEST_USER_PASSWORD'",
            "firstName": "Test",
            "lastName": "User"
        }')
    
    if [[ "$register_response" == "201" ]]; then
        log_success "User Registration"
        cat /tmp/register_response | jq .
    else
        if [[ "$register_response" == "409" ]]; then
            log_warning "User already exists (expected for repeated tests)"
        else
            log_error "User Registration (HTTP $register_response)"
            cat /tmp/register_response
        fi
    fi
    echo ""
    
    # Test user login
    local login_response=$(curl -s -X POST "$API_BASE/auth/login" \
        -H "Content-Type: application/json" \
        -d '{
            "email": "'$TEST_USER_EMAIL'",
            "password": "'$TEST_USER_PASSWORD'"
        }')
    
    TESTS_RUN=$((TESTS_RUN + 1))
    if echo "$login_response" | jq -e '.token' > /dev/null 2>&1; then
        log_success "User Login"
        AUTH_TOKEN=$(echo "$login_response" | jq -r '.token')
        echo "  Token: ${AUTH_TOKEN:0:20}..."
    else
        log_error "User Login"
        echo "  Response: $login_response"
    fi
    echo ""
}

# Test Product Service
test_product_service() {
    log_info "=== Testing Product Service ==="
    
    run_test "Get Products List" \
        "curl -s -f '$API_BASE/products'" \
        0
    
    run_test "Get Products with Pagination" \
        "curl -s -f '$API_BASE/products?page=1&limit=3'" \
        0
    
    run_test "Get Product by ID" \
        "curl -s -f '$API_BASE/products/1'" \
        0
    
    run_test "Search Products" \
        "curl -s -f '$API_BASE/products/search/laptop'" \
        0
    
    run_test "Get Products by Category" \
        "curl -s -f '$API_BASE/products?category=Electronics'" \
        0
    
    run_test "Circuit Breaker Status" \
        "curl -s -f '$API_BASE/products/circuit-breaker/status'" \
        0
}

# Test Order Service
test_order_service() {
    log_info "=== Testing Order Service ==="
    
    if [[ -z "$AUTH_TOKEN" ]]; then
        log_warning "No auth token available, skipping authenticated order tests"
        return
    fi
    
    # Create an order
    local order_response=$(curl -s -w "%{http_code}" -o /tmp/order_response \
        -X POST "$API_BASE/orders" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $AUTH_TOKEN" \
        -d '{
            "userId": 1,
            "items": [
                {
                    "productId": 1,
                    "quantity": 2
                },
                {
                    "productId": 2,
                    "quantity": 1
                }
            ]
        }')
    
    TESTS_RUN=$((TESTS_RUN + 1))
    if [[ "$order_response" == "201" ]]; then
        log_success "Create Order"
        local order_data=$(cat /tmp/order_response)
        echo "  Response: $(echo "$order_data" | jq -c .)"
        
        # Extract order ID for further tests
        local order_id=$(echo "$order_data" | jq -r '.order.id')
        
        if [[ "$order_id" != "null" && -n "$order_id" ]]; then
            # Test get order by ID
            run_test "Get Order by ID" \
                "curl -s -f '$API_BASE/orders/$order_id' -H 'Authorization: Bearer $AUTH_TOKEN'" \
                0
            
            # Test order payment
            run_test "Process Order Payment" \
                "curl -s -f -X POST '$API_BASE/orders/$order_id/payment' -H 'Content-Type: application/json' -H 'Authorization: Bearer $AUTH_TOKEN' -d '{\"paymentMethod\": \"credit_card\", \"amount\": 100.00}'" \
                0
            
            # Test cancel order
            run_test "Cancel Order" \
                "curl -s -f -X PATCH '$API_BASE/orders/$order_id/cancel' -H 'Authorization: Bearer $AUTH_TOKEN'" \
                0
        fi
    else
        log_error "Create Order (HTTP $order_response)"
        cat /tmp/order_response
    fi
    echo ""
    
    # Test get user orders
    run_test "Get User Orders" \
        "curl -s -f '$API_BASE/users/1/orders' -H 'Authorization: Bearer $AUTH_TOKEN'" \
        0
}

# Test Notification Service
test_notification_service() {
    log_info "=== Testing Notification Service ==="
    
    run_test "Get Notification Queue Status" \
        "curl -s -f '$API_BASE/notifications/queue/status'" \
        0
    
    run_test "Get Recent Notifications" \
        "curl -s -f '$API_BASE/notifications/recent?limit=5'" \
        0
    
    # Test sending custom notification
    run_test "Send Custom Notification" \
        "curl -s -f -X POST '$API_BASE/notifications/send' -H 'Content-Type: application/json' -d '{\"type\": \"test\", \"userId\": 1, \"subject\": \"Test Notification\", \"message\": \"This is a test message\", \"channels\": [\"email\"]}'" \
        0
}

# Test Event Store
test_event_store() {
    log_info "=== Testing Event Store ==="
    
    run_test "Get All Events" \
        "curl -s -f '$API_BASE/events?limit=10'" \
        0
    
    run_test "Get Events by Type" \
        "curl -s -f '$API_BASE/events?eventType=user.created&limit=5'" \
        0
    
    run_test "Get User Analytics Projection" \
        "curl -s -f '$API_BASE/projections/analytics/global'" \
        0
    
    run_test "Get All Analytics Projections" \
        "curl -s -f '$API_BASE/projections/analytics'" \
        0
    
    run_test "Event Store Statistics" \
        "curl -s -f '$API_BASE/events/stats'" \
        0
}

# Test Cross-Service Integration
test_integration() {
    log_info "=== Testing Cross-Service Integration ==="
    
    if [[ -z "$AUTH_TOKEN" ]]; then
        log_warning "No auth token available, skipping integration tests"
        return
    fi
    
    # Test complete user flow: register -> login -> browse products -> create order
    log_info "Testing complete user flow..."
    
    # Get products
    local products_response=$(curl -s "$API_BASE/products?limit=1")
    TESTS_RUN=$((TESTS_RUN + 1))
    
    if echo "$products_response" | jq -e '.products[0].id' > /dev/null 2>&1; then
        log_success "Product retrieval for integration test"
        local product_id=$(echo "$products_response" | jq -r '.products[0].id')
        local product_price=$(echo "$products_response" | jq -r '.products[0].price')
        
        # Create order with retrieved product
        local integration_order=$(curl -s -w "%{http_code}" -o /tmp/integration_order \
            -X POST "$API_BASE/orders" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $AUTH_TOKEN" \
            -d "{
                \"userId\": 1,
                \"items\": [
                    {
                        \"productId\": $product_id,
                        \"quantity\": 1
                    }
                ]
            }")
        
        TESTS_RUN=$((TESTS_RUN + 1))
        if [[ "$integration_order" == "201" ]]; then
            log_success "Integration test: Product to Order flow"
            
            # Check if notification was triggered (wait a bit for async processing)
            sleep 2
            local notifications=$(curl -s "$API_BASE/notifications/recent?limit=1")
            if echo "$notifications" | jq -e '.notifications[0]' > /dev/null 2>&1; then
                log_success "Integration test: Order created notification"
            else
                log_warning "Integration test: Order notification not found (may be timing issue)"
            fi
        else
            log_error "Integration test: Product to Order flow (HTTP $integration_order)"
            cat /tmp/integration_order
        fi
    else
        log_error "Product retrieval for integration test"
        echo "  Response: $products_response"
    fi
}

# Test Load and Performance
test_performance() {
    log_info "=== Testing Performance ==="
    
    # Test concurrent requests to products endpoint
    log_info "Testing concurrent product requests..."
    
    local start_time=$(date +%s.%N)
    
    for i in {1..10}; do
        curl -s "$API_BASE/products" > /dev/null &
    done
    wait
    
    local end_time=$(date +%s.%N)
    local duration=$(echo "$end_time - $start_time" | bc)
    
    TESTS_RUN=$((TESTS_RUN + 1))
    if (( $(echo "$duration < 5.0" | bc -l) )); then
        log_success "Performance test: 10 concurrent requests completed in ${duration}s"
    else
        log_error "Performance test: 10 concurrent requests took too long (${duration}s)"
    fi
    echo ""
}

# Generate test report
generate_report() {
    echo ""
    log_info "=== Test Report ==="
    echo "Tests Run: $TESTS_RUN"
    echo "Tests Passed: $TESTS_PASSED"
    echo "Tests Failed: $TESTS_FAILED"
    
    if [[ $TESTS_FAILED -eq 0 ]]; then
        log_success "All tests passed! 🎉"
        return 0
    else
        log_error "$TESTS_FAILED tests failed"
        return 1
    fi
}

# Cleanup temporary files
cleanup() {
    rm -f /tmp/register_response /tmp/order_response /tmp/integration_order
}

# Main execution
main() {
    log_info "Starting CloudMarket API Tests..."
    log_info "Base URL: $BASE_URL"
    echo ""
    
    # Check if services are running
    if ! curl -s -f "$BASE_URL/health" > /dev/null; then
        log_error "API Gateway is not responding. Make sure services are deployed."
        exit 1
    fi
    
    # Run all test suites
    test_gateway_health
    test_user_service
    test_product_service
    test_order_service
    test_notification_service
    test_event_store
    test_integration
    test_performance
    
    # Generate final report
    generate_report
    local exit_code=$?
    
    # Cleanup
    cleanup
    
    exit $exit_code
}

# Script execution
case "${1:-all}" in
    all)
        main
        ;;
    gateway)
        test_gateway_health
        ;;
    user)
        test_user_service
        ;;
    product)
        test_product_service
        ;;
    order)
        test_order_service
        ;;
    notification)
        test_notification_service
        ;;
    events)
        test_event_store
        ;;
    integration)
        test_integration
        ;;
    performance)
        test_performance
        ;;
    *)
        echo "Usage: $0 {all|gateway|user|product|order|notification|events|integration|performance}"
        echo ""
        echo "Test suites:"
        echo "  all          - Run all tests (default)"
        echo "  gateway      - Test API Gateway"
        echo "  user         - Test User Service"
        echo "  product      - Test Product Service"
        echo "  order        - Test Order Service"
        echo "  notification - Test Notification Service"
        echo "  events       - Test Event Store"
        echo "  integration  - Test cross-service integration"
        echo "  performance  - Test performance and load"
        exit 1
        ;;
esac