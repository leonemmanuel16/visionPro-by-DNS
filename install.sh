#!/bin/bash
# ============================================
# DNS VisionPro - Automated Installation
# ============================================
# Usage:
#   git clone https://github.com/leonemmanuel16/visionPro-by-DNS.git
#   cd visionPro-by-DNS
#   chmod +x install.sh
#   ./install.sh
#
# Requirements: Docker, Docker Compose v2

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════╗"
echo "║       DNS VisionPro - Instalador v1.0        ║"
echo "║     AI Video Analytics by DNS Integradores    ║"
echo "╚══════════════════════════════════════════════╝"
echo -e "${NC}"

# 1. Check Docker
echo -e "${YELLOW}[1/6] Verificando Docker...${NC}"
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Docker no está instalado. Instálalo primero:${NC}"
    echo "  curl -fsSL https://get.docker.com | sh"
    echo "  sudo usermod -aG docker \$USER"
    exit 1
fi

if ! docker compose version &> /dev/null; then
    echo -e "${RED}Docker Compose v2 no está disponible.${NC}"
    echo "  Actualiza Docker o instala docker-compose-plugin"
    exit 1
fi
echo -e "${GREEN}  Docker $(docker --version | grep -oP '\d+\.\d+\.\d+') ✓${NC}"
echo -e "${GREEN}  Docker Compose $(docker compose version --short) ✓${NC}"

# 2. Create .env if not exists
echo -e "${YELLOW}[2/6] Configurando variables de entorno...${NC}"
if [ ! -f .env ]; then
    cp .env.example .env
    echo -e "${GREEN}  .env creado desde .env.example ✓${NC}"
    echo -e "${YELLOW}  (Puedes editar .env para cambiar contraseñas)${NC}"
else
    echo -e "${GREEN}  .env ya existe, se conserva ✓${NC}"
fi

# 3. Create data directories
echo -e "${YELLOW}[3/6] Creando directorios de datos...${NC}"
mkdir -p data/db data/redis data/clips config
echo -e "${GREEN}  data/db, data/redis, data/clips, config ✓${NC}"

# 4. Ensure go2rtc config exists
if [ ! -f config/go2rtc.yaml ]; then
    cat > config/go2rtc.yaml << 'YAML'
api:
  listen: ":1984"
webrtc:
  listen: ":8555"
streams: {}
YAML
    echo -e "${GREEN}  config/go2rtc.yaml creado ✓${NC}"
fi

# 5. Build and start
echo -e "${YELLOW}[4/6] Descargando imágenes base...${NC}"
docker compose pull go2rtc postgres redis minio 2>/dev/null || true

echo -e "${YELLOW}[5/6] Construyendo servicios (esto tarda 5-15 min la primera vez)...${NC}"
docker compose build --parallel

echo -e "${YELLOW}[6/6] Iniciando servicios...${NC}"
docker compose up -d

# Wait for services to be healthy
echo -e "${YELLOW}Esperando que los servicios estén listos...${NC}"
sleep 10

# Check all services are running
RUNNING=$(docker compose ps --format json 2>/dev/null | grep -c '"running"' || docker compose ps | grep -c "Up" || echo "0")
TOTAL=$(docker compose ps -q | wc -l)

echo ""
echo -e "${BLUE}══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  DNS VisionPro instalado correctamente!${NC}"
echo -e "${BLUE}══════════════════════════════════════════════${NC}"
echo ""

# Get server IP
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

echo -e "  ${GREEN}Dashboard:${NC}    http://${SERVER_IP}:3000"
echo -e "  ${GREEN}API:${NC}          http://${SERVER_IP}:8000/docs"
echo -e "  ${GREEN}go2rtc:${NC}       http://${SERVER_IP}:1984"
echo -e "  ${GREEN}MinIO:${NC}        http://${SERVER_IP}:9001"
echo ""
echo -e "  ${YELLOW}Login:${NC}  admin / admin"
echo ""
echo -e "  ${BLUE}Servicios corriendo: ${RUNNING}/${TOTAL}${NC}"
echo ""
echo -e "  ${YELLOW}Siguiente paso:${NC}"
echo -e "  1. Abre http://${SERVER_IP}:3000 en tu navegador"
echo -e "  2. Inicia sesión con admin/admin"
echo -e "  3. Ve a Cámaras > Descubrir para encontrar cámaras ONVIF"
echo -e "  4. O agrega cámaras manualmente con IP/usuario/contraseña"
echo ""
echo -e "  ${BLUE}Comandos útiles:${NC}"
echo -e "  docker compose logs -f detector    # Ver detecciones en vivo"
echo -e "  docker compose restart detector    # Reiniciar detector"
echo -e "  docker compose down                # Detener todo"
echo -e "  docker compose up -d               # Iniciar todo"
echo -e "  git pull && docker compose up -d --build  # Actualizar"
echo ""
