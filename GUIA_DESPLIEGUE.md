# GUÍA DE DESPLIEGUE - CloudMarket

## Requisitos del Sistema

### Software Requerido
- Docker Engine 20.10+
- Docker Compose 2.0+
- Git
- Curl (para testing)
- jq (para parsing JSON - opcional)

### Hardware Mínimo
- RAM: 4GB mínimo, 8GB recomendado
- CPU: 2 cores mínimo, 4 cores recomendado
- Disco: 5GB espacio libre
- Red: Conexión a internet para descargar imágenes

## Instalación Rápida

### 1. Clonar y Preparar
```bash
git clone <repository-url> cloudmarket
cd cloudmarket
chmod +x scripts/*.sh
```

### 2. Despliegue Automático
```bash
./scripts/deploy.sh
```

### 3. Verificar Instalación
```bash
./scripts/test-apis.sh
```

### 4. Monitorear Sistema
```bash
./scripts/monitor.sh
```

## Acceso a la Aplicación

Una vez desplegado, el sistema estará disponible en:

- **API Gateway**: http://localhost:8080
- **Prometheus**: http://localhost:9090
- **Grafana**: http://localhost:3000 (admin/admin)

### Endpoints Principales
- **Productos**: http://localhost:8080/api/products
- **Health Check**: http://localhost:8080/health
- **Notificaciones**: http://localhost:8080/api/notifications/queue/status
- **Eventos**: http://localhost:8080/api/events/stats

## Comandos Útiles

### Gestión de Servicios
```bash
# Ver estado
docker compose ps

# Ver logs
docker compose logs -f user-service

# Reiniciar servicio
docker compose restart product-service

# Escalar servicio
docker compose up -d --scale user-service=3

# Parar todo
docker compose down

# Limpiar todo
docker compose down --volumes --remove-orphans
```

### Testing y Monitoreo
```bash
# Test completo
./scripts/test-apis.sh all

# Test específico
./scripts/test-apis.sh product

# Monitor continuo
./scripts/monitor.sh monitor

# Check de salud
./scripts/monitor.sh health
```

## Troubleshooting

### Problemas Comunes

1. **Puerto 8080 ocupado**
   ```bash
   # Cambiar puerto en docker-compose.yml
   ports:
     - "8081:80"  # Usar 8081 en lugar de 8080
   ```

2. **Memoria insuficiente**
   ```bash
   # Reducir réplicas
   # Comentar servicios de monitoring si es necesario
   ```

3. **Servicios no responden**
   ```bash
   # Verificar logs
   docker compose logs service-name
   
   # Reiniciar
   docker compose restart service-name
   ```

## Personalización

### Variables de Entorno
Crear archivo `.env`:
```env
POSTGRES_PASSWORD=your-secure-password
JWT_SECRET=your-jwt-secret
REDIS_PASSWORD=your-redis-password
```

### Escalado de Servicios
Modificar `docker-compose.yml`:
```yaml
services:
  user-service:
    deploy:
      replicas: 3  # Aumentar réplicas
```

¡El sistema CloudMarket está listo para demostrar patrones arquitectónicos cloud-native en acción!