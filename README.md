# CloudMarket - Plataforma E-commerce con Patrones Cloud

## Descripción del Proyecto
Sistema de e-commerce distribuido que demuestra la implementación de múltiples patrones arquitectónicos para entornos Cloud Computing usando contenedores Docker.

## Patrones Arquitectónicos Implementados
- **Microservicios**: Separación de responsabilidades
- **API Gateway**: Punto de entrada único
- **Servicios Stateless**: APIs RESTful sin estado
- **Circuit Breaker**: Resiliencia ante fallos
- **Event Sourcing**: Trazabilidad de eventos
- **Pub/Sub Messaging**: Comunicación asíncrona

## Estructura del Proyecto
```
arq8/
├── services/
│   ├── api-gateway/
│   ├── user-service/
│   ├── product-service/
│   ├── order-service/
│   ├── notification-service/
│   └── event-store/
├── shared/
├── docker/
├── docs/
└── scripts/
```

## Tecnologías
- Docker & Docker Compose
- Node.js con Express
- Redis para caché y mensajería
- PostgreSQL como base de datos
- NGINX como API Gateway