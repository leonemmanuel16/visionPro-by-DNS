#!/bin/bash
# ============================================================
# DNS Vision Pro — NVIDIA GPU Setup Script
# Installs NVIDIA drivers + Container Toolkit for GPU inference
# Tested on Ubuntu 22.04 / 24.04 LTS
# ============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   DNS Vision Pro — NVIDIA GPU Setup          ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
echo ""

# Check root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Este script debe ejecutarse como root (sudo)${NC}"
    exit 1
fi

# Detect GPU
echo -e "${CYAN}[1/6] Detectando GPU NVIDIA...${NC}"
if lspci | grep -i nvidia > /dev/null 2>&1; then
    GPU_NAME=$(lspci | grep -i nvidia | head -1 | sed 's/.*: //')
    echo -e "${GREEN}  ✓ GPU detectada: ${GPU_NAME}${NC}"
else
    echo -e "${RED}  ✗ No se detectó GPU NVIDIA${NC}"
    exit 1
fi

# Check if NVIDIA driver is already installed
if nvidia-smi > /dev/null 2>&1; then
    DRIVER_VER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)
    echo -e "${GREEN}  ✓ Driver NVIDIA ya instalado: v${DRIVER_VER}${NC}"
    SKIP_DRIVER=true
else
    echo -e "${YELLOW}  → Driver NVIDIA no instalado, se instalará ahora${NC}"
    SKIP_DRIVER=false
fi

# Step 2: Install NVIDIA driver
if [ "$SKIP_DRIVER" = false ]; then
    echo -e "${CYAN}[2/6] Instalando driver NVIDIA...${NC}"

    # Blacklist nouveau
    echo -e "  → Deshabilitando driver nouveau..."
    cat > /etc/modprobe.d/blacklist-nouveau.conf << 'EOF'
blacklist nouveau
options nouveau modeset=0
EOF
    update-initramfs -u 2>/dev/null || true

    # Add NVIDIA PPA and install
    apt-get update -qq
    apt-get install -y -qq ubuntu-drivers-common > /dev/null 2>&1

    echo -e "  → Detectando driver recomendado..."
    RECOMMENDED=$(ubuntu-drivers devices 2>/dev/null | grep "recommended" | awk '{print $3}' || echo "nvidia-driver-550")

    if [ -z "$RECOMMENDED" ]; then
        RECOMMENDED="nvidia-driver-550"
    fi

    echo -e "  → Instalando ${RECOMMENDED}..."
    apt-get install -y -qq ${RECOMMENDED} > /dev/null 2>&1

    echo -e "${GREEN}  ✓ Driver instalado: ${RECOMMENDED}${NC}"
    echo -e "${YELLOW}  ⚠ REINICIO REQUERIDO después de completar el setup${NC}"
    NEEDS_REBOOT=true
else
    echo -e "${CYAN}[2/6] Driver ya instalado, saltando...${NC}"
    NEEDS_REBOOT=false
fi

# Step 3: Install NVIDIA Container Toolkit
echo -e "${CYAN}[3/6] Instalando NVIDIA Container Toolkit...${NC}"

if dpkg -l | grep -q nvidia-container-toolkit 2>/dev/null; then
    echo -e "${GREEN}  ✓ NVIDIA Container Toolkit ya instalado${NC}"
else
    # Add NVIDIA container toolkit repo
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
        gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg 2>/dev/null

    curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
        sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
        tee /etc/apt/sources.list.d/nvidia-container-toolkit.list > /dev/null

    apt-get update -qq
    apt-get install -y -qq nvidia-container-toolkit > /dev/null 2>&1

    echo -e "${GREEN}  ✓ NVIDIA Container Toolkit instalado${NC}"
fi

# Step 4: Configure Docker runtime
echo -e "${CYAN}[4/6] Configurando Docker con runtime NVIDIA...${NC}"

nvidia-ctk runtime configure --runtime=docker 2>/dev/null || true

# Restart Docker to pick up new runtime
systemctl restart docker 2>/dev/null || true
echo -e "${GREEN}  ✓ Docker configurado con runtime NVIDIA${NC}"

# Step 5: Test GPU access in Docker
echo -e "${CYAN}[5/6] Verificando acceso GPU desde Docker...${NC}"

if [ "$NEEDS_REBOOT" = true ]; then
    echo -e "${YELLOW}  ⚠ Se necesita reiniciar antes de verificar GPU en Docker${NC}"
else
    if docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi > /dev/null 2>&1; then
        echo -e "${GREEN}  ✓ GPU accesible desde contenedores Docker${NC}"
        docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi 2>/dev/null | head -12
    else
        echo -e "${YELLOW}  ⚠ No se pudo verificar GPU en Docker (puede necesitar reinicio)${NC}"
    fi
fi

# Step 6: Summary
echo ""
echo -e "${CYAN}[6/6] Resumen${NC}"
echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  GPU:                ${GPU_NAME}"
if nvidia-smi > /dev/null 2>&1; then
    VRAM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)
    echo -e "  VRAM:               ${VRAM} MB"
    echo -e "  Driver:             $(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)"
fi
echo -e "  Container Toolkit:  $(dpkg -l nvidia-container-toolkit 2>/dev/null | grep ii | awk '{print $3}' || echo 'Instalado')"
echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$NEEDS_REBOOT" = true ]; then
    echo -e "${YELLOW}╔══════════════════════════════════════════════╗${NC}"
    echo -e "${YELLOW}║  ⚠  REINICIO REQUERIDO                       ║${NC}"
    echo -e "${YELLOW}║                                              ║${NC}"
    echo -e "${YELLOW}║  Ejecuta: sudo reboot                       ║${NC}"
    echo -e "${YELLOW}║                                              ║${NC}"
    echo -e "${YELLOW}║  Después del reinicio:                       ║${NC}"
    echo -e "${YELLOW}║  cd dns-vision-ai && docker compose up -d    ║${NC}"
    echo -e "${YELLOW}╚══════════════════════════════════════════════╝${NC}"
else
    echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║  ✓ GPU lista para usar                       ║${NC}"
    echo -e "${GREEN}║                                              ║${NC}"
    echo -e "${GREEN}║  Reconstruye el detector:                    ║${NC}"
    echo -e "${GREEN}║  docker compose build detector               ║${NC}"
    echo -e "${GREEN}║  docker compose up -d detector               ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
fi
