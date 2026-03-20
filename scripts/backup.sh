#!/bin/bash
# DNS Vision AI - Backup Script
# Backs up PostgreSQL database, config files, and optionally MinIO data

set -e

BACKUP_DIR="./backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="dns-vision-ai_${TIMESTAMP}"

echo "DNS Vision AI - Backup"
echo "======================"

# Load env vars
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

mkdir -p "${BACKUP_DIR}"

# Backup PostgreSQL
echo "Backing up PostgreSQL..."
docker compose exec -T postgres pg_dump -U vision visionai | gzip > "${BACKUP_DIR}/${BACKUP_NAME}_db.sql.gz"
echo "  -> ${BACKUP_DIR}/${BACKUP_NAME}_db.sql.gz"

# Backup config files
echo "Backing up config files..."
tar czf "${BACKUP_DIR}/${BACKUP_NAME}_config.tar.gz" config/ .env scripts/
echo "  -> ${BACKUP_DIR}/${BACKUP_NAME}_config.tar.gz"

# Optionally backup MinIO data (can be large)
if [ "$1" = "--full" ]; then
    echo "Backing up MinIO data (this may take a while)..."
    tar czf "${BACKUP_DIR}/${BACKUP_NAME}_minio.tar.gz" data/clips/
    echo "  -> ${BACKUP_DIR}/${BACKUP_NAME}_minio.tar.gz"
fi

# Cleanup old backups (keep last 7)
echo "Cleaning up old backups (keeping last 7)..."
ls -t "${BACKUP_DIR}"/*_db.sql.gz 2>/dev/null | tail -n +8 | xargs -r rm
ls -t "${BACKUP_DIR}"/*_config.tar.gz 2>/dev/null | tail -n +8 | xargs -r rm

echo ""
echo "Backup complete: ${BACKUP_NAME}"
echo "To restore: gunzip -c ${BACKUP_DIR}/${BACKUP_NAME}_db.sql.gz | docker compose exec -T postgres psql -U vision visionai"
