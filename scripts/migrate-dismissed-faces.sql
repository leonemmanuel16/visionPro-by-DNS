-- Migration: Add dismissed_faces table
-- Run: docker compose exec postgres psql -U vision -d visionai -f /docker-entrypoint-initdb.d/migrate-dismissed-faces.sql

CREATE TABLE IF NOT EXISTS dismissed_faces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    embedding vector(128),
    dismissed_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '90 days'
);

CREATE INDEX IF NOT EXISTS idx_dismissed_faces_expires ON dismissed_faces(expires_at);
