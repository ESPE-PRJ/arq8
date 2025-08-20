# Diagramas Arquitectónicos - CloudMarket

## 1. Arquitectura General del Sistema

```mermaid
graph TB
    Client[Cliente Web/Mobile]
    LB[Load Balancer]
    Gateway[API Gateway<br/>NGINX]
    
    subgraph "Microservicios"
        UserSvc[User Service<br/>Puerto: 3001]
        ProductSvc[Product Service<br/>Puerto: 3002]
        OrderSvc[Order Service<br/>Puerto: 3003]
        NotifSvc[Notification Service<br/>Puerto: 3004]
        EventStore[Event Store<br/>Puerto: 3005]
    end
    
    subgraph "Infraestructura"
        Redis[(Redis<br/>Cache & Message Broker)]
        PostgresUser[(PostgreSQL<br/>User DB)]
        PostgresProduct[(PostgreSQL<br/>Product DB)]
        PostgresOrder[(PostgreSQL<br/>Order DB)]
        PostgresEvents[(PostgreSQL<br/>Events DB)]
    end
    
    Client --> LB
    LB --> Gateway
    Gateway --> UserSvc
    Gateway --> ProductSvc
    Gateway --> OrderSvc
    Gateway --> NotifSvc
    
    UserSvc --> PostgresUser
    ProductSvc --> PostgresProduct
    OrderSvc --> PostgresOrder
    EventStore --> PostgresEvents
    
    UserSvc --> Redis
    ProductSvc --> Redis
    OrderSvc --> Redis
    NotifSvc --> Redis
    EventStore --> Redis
```

## 2. Patrón de Comunicación Asíncrona

```mermaid
sequenceDiagram
    participant Client
    participant Gateway
    participant OrderSvc
    participant EventStore
    participant NotifSvc
    participant Redis
    
    Client->>Gateway: POST /orders
    Gateway->>OrderSvc: Crear pedido
    OrderSvc->>EventStore: Guardar evento ORDER_CREATED
    OrderSvc->>Redis: Publicar mensaje ORDER_CREATED
    OrderSvc-->>Gateway: 201 Created (respuesta inmediata)
    Gateway-->>Client: Pedido creado
    
    Redis->>NotifSvc: Mensaje ORDER_CREATED
    NotifSvc->>Client: Notificación push/email
    
    Note over OrderSvc, NotifSvc: Procesamiento asíncrono
```

## 3. Patrón Circuit Breaker

```mermaid
stateDiagram-v2
    [*] --> Closed
    Closed --> Open: Fallos > Umbral
    Open --> HalfOpen: Timeout alcanzado
    HalfOpen --> Closed: Llamada exitosa
    HalfOpen --> Open: Llamada fallida
    
    note right of Closed
        Estado normal
        Todas las llamadas pasan
    end note
    
    note right of Open
        Bloqueo activado
        Respuesta inmediata de error
    end note
    
    note right of HalfOpen
        Prueba de recuperación
        Una llamada de test
    end note
```

## 4. Event Sourcing Pattern

```mermaid
graph LR
    subgraph "Comandos"
        CreateOrder[Create Order]
        UpdateOrder[Update Order]
        CancelOrder[Cancel Order]
    end
    
    subgraph "Event Store"
        E1[OrderCreated<br/>timestamp: t1]
        E2[OrderUpdated<br/>timestamp: t2]
        E3[OrderCancelled<br/>timestamp: t3]
    end
    
    subgraph "Proyecciones"
        OrderView[Vista Actual<br/>del Pedido]
        Analytics[Analytics<br/>Dashboard]
    end
    
    CreateOrder --> E1
    UpdateOrder --> E2
    CancelOrder --> E3
    
    E1 --> OrderView
    E2 --> OrderView
    E3 --> OrderView
    
    E1 --> Analytics
    E2 --> Analytics
    E3 --> Analytics
```

## 5. Patrón de Contenedores

```mermaid
graph TB
    subgraph "Docker Host"
        subgraph "Container Network"
            GW[API Gateway<br/>nginx:alpine]
            US[User Service<br/>node:18-alpine]
            PS[Product Service<br/>node:18-alpine]
            OS[Order Service<br/>node:18-alpine]
            NS[Notification Service<br/>node:18-alpine]
            ES[Event Store<br/>node:18-alpine]
        end
        
        subgraph "Data Layer"
            Redis[Redis Container<br/>redis:7-alpine]
            DB1[PostgreSQL<br/>postgres:15-alpine]
            DB2[PostgreSQL<br/>postgres:15-alpine]
            DB3[PostgreSQL<br/>postgres:15-alpine]
        end
        
        subgraph "Volumes"
            V1[user-data]
            V2[product-data]
            V3[order-data]
            V4[events-data]
            V5[redis-data]
        end
    end
    
    US --> DB1
    PS --> DB2
    OS --> DB3
    ES --> DB1
    
    DB1 --> V1
    DB2 --> V2
    DB3 --> V3
    DB1 --> V4
    Redis --> V5
```

## 6. Separación de Responsabilidades

```mermaid
graph TB
    subgraph "Presentation Layer"
        WebUI[Web Interface]
        MobileUI[Mobile App]
        APIGateway[API Gateway]
    end
    
    subgraph "Business Logic Layer"
        subgraph "User Domain"
            UserSvc[User Service]
            AuthSvc[Auth Module]
        end
        
        subgraph "Catalog Domain"
            ProductSvc[Product Service]
            SearchSvc[Search Module]
        end
        
        subgraph "Order Domain"
            OrderSvc[Order Service]
            PaymentSvc[Payment Module]
        end
        
        subgraph "Cross-cutting Concerns"
            NotifSvc[Notification Service]
            EventSvc[Event Store]
        end
    end
    
    subgraph "Data Layer"
        UserDB[(User Database)]
        ProductDB[(Product Database)]
        OrderDB[(Order Database)]
        EventDB[(Event Database)]
        Cache[(Redis Cache)]
    end
    
    WebUI --> APIGateway
    MobileUI --> APIGateway
    APIGateway --> UserSvc
    APIGateway --> ProductSvc
    APIGateway --> OrderSvc
    
    UserSvc --> UserDB
    ProductSvc --> ProductDB
    OrderSvc --> OrderDB
    EventSvc --> EventDB
    
    UserSvc --> Cache
    ProductSvc --> Cache
    OrderSvc --> Cache
```