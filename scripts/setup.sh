#!/bin/bash
# DNS Vision AI - First-time Setup Script
# Run this script on a fresh Ubuntu Server 24.04 LTS installation

set -e

echo "======================================"
echo "  DNS Vision AI - Setup Script"
echo "  Data Network Solutions"
echo "======================================"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    error "Do not run this script as root. Use a regular user with sudo access."
fi

# Check Ubuntu version
if [ -f /etc/os-release ]; then
    . /etc/os-release
    log "Detected OS: $PRETTY_NAME"
else
    warn "Could not detect OS version"
fi

# Install Docker if not present
if ! command -v docker &> /dev/null; then
    log "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker "$USER"
    log "Docker installed. You may need to log out and back in for group changes."
else
    log "Docker already installed: $(docker --version)"
fi

# Install Docker Compose plugin if not present
if ! docker compose version &> /dev/null; then
    log "Installing Docker Compose plugin..."
    sudo apt-get update
    sudo apt-get install -y docker-compose-plugin
else
    log "Docker Compose already installed: $(docker compose version)"
fi

# Check for NVIDIA GPU and install nvidia-container-toolkit
if lspci | grep -i nvidia &> /dev/null; then
    log "NVIDIA GPU detected"
    if ! command -v nvidia-smi &> /dev/null; then
        log "Installing NVIDIA drivers..."
        sudo apt-get update
        sudo apt-get install -y nvidia-driver-535
    fi
    if ! dpkg -l | grep -q nvidia-container-toolkit; then
        log "Installing NVIDIA Container Toolkit..."
        distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
        curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
        curl -s -L "https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list" | \
            sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
            sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
        sudo apt-get update
        sudo apt-get install -y nvidia-container-toolkit
        sudo nvidia-ctk runtime configure --runtime=docker
        sudo systemctl restart docker
    fi
    log "NVIDIA Container Toolkit ready"
else
    warn "No NVIDIA GPU detected. Detection service will run on CPU (slower)."
fi

# Create .env from .env.example if it doesn't exist
if [ ! -f .env ]; then
    log "Creating .env from .env.example..."
    cp .env.example .env

    # Generate random passwords
    DB_PASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
    JWT_SEC=$(openssl rand -base64 48 | tr -dc 'a-zA-Z0-9' | head -c 64)
    MINIO_PASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)

    sed -i "s/changeme_secure_password/$DB_PASS/" .env
    sed -i "s/changeme_random_64_char_string/$JWT_SEC/" .env
    sed -i "s/changeme_minio_password/$MINIO_PASS/" .env

    log "Generated secure passwords in .env"
    warn "Edit .env to set your ONVIF camera credentials and webhook URLs"
else
    log ".env file already exists"
fi

# Create data directories
mkdir -p data/{db,redis,clips}

# Create default go2rtc config if not exists
if [ ! -f config/go2rtc.yaml ]; then
    mkdir -p config
    cat > config/go2rtc.yaml << 'EOF'
api:
  listen: ":1984"
webrtc:
  listen: ":8555"
streams: {}
EOF
    log "Created default go2rtc config"
fi

log ""
log "======================================"
log "  Setup complete!"
log "======================================"
log ""
log "Next steps:"
log "  1. Edit .env with your camera credentials"
log "  2. Run: docker compose up -d"
log "  3. Open: http://$(hostname -I | awk '{print $1}'):3000"
log "  4. Login: admin / admin123"
log "  5. CHANGE THE DEFAULT PASSWORD!"
log ""
