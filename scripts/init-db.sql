-- DNS Vision AI - Database Schema
-- PostgreSQL 16 with pgvector extension

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- Users
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'viewer',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cameras
CREATE TABLE cameras (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    ip_address VARCHAR(45) NOT NULL UNIQUE,
    onvif_port INTEGER DEFAULT 80,
    username VARCHAR(100),
    password_encrypted VARCHAR(500),
    manufacturer VARCHAR(100),
    model VARCHAR(100),
    firmware VARCHAR(100),
    serial_number VARCHAR(100),
    mac_address VARCHAR(17),
    rtsp_main_stream TEXT,
    rtsp_sub_stream TEXT,
    onvif_profile_token VARCHAR(100),
    camera_type VARCHAR(50),
    has_ptz BOOLEAN DEFAULT false,
    location VARCHAR(200),
    is_enabled BOOLEAN DEFAULT true,
    is_online BOOLEAN DEFAULT true,
    last_seen_at TIMESTAMPTZ,
    config JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Virtual Zones
CREATE TABLE zones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    camera_id UUID REFERENCES cameras(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    zone_type VARCHAR(30) NOT NULL,
    points JSONB NOT NULL,
    direction VARCHAR(20),
    detect_classes TEXT[] DEFAULT '{person,vehicle}',
    is_enabled BOOLEAN DEFAULT true,
    config JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Detection Events
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    camera_id UUID REFERENCES cameras(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    label VARCHAR(100),
    confidence FLOAT,
    bbox JSONB,
    zone_id UUID REFERENCES zones(id),
    snapshot_path TEXT,
    clip_path TEXT,
    thumbnail_path TEXT,
    metadata JSONB DEFAULT '{}',
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_events_camera_time ON events(camera_id, occurred_at DESC);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_occurred ON events(occurred_at DESC);

-- Alert Rules
CREATE TABLE alert_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    camera_id UUID REFERENCES cameras(id),
    zone_id UUID REFERENCES zones(id),
    event_types TEXT[] NOT NULL,
    channel VARCHAR(30) NOT NULL,
    target VARCHAR(500) NOT NULL,
    cooldown_seconds INTEGER DEFAULT 60,
    schedule JSONB,
    is_enabled BOOLEAN DEFAULT true,
    last_triggered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Persons (Face Recognition Database)
CREATE TABLE persons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    role VARCHAR(50),
    department VARCHAR(100),
    notes TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Face Embeddings (128-dim vectors from face_recognition library)
CREATE TABLE face_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID REFERENCES persons(id) ON DELETE CASCADE,
    embedding vector(128),
    photo_path TEXT,
    source VARCHAR(20) DEFAULT 'upload',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_face_embeddings_person ON face_embeddings(person_id);

-- Unknown Faces (auto-expire after 30 days)
CREATE TABLE unknown_faces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    embedding vector(128),
    thumbnail_path TEXT,
    camera_id UUID REFERENCES cameras(id) ON DELETE SET NULL,
    first_seen TIMESTAMPTZ DEFAULT NOW(),
    last_seen TIMESTAMPTZ DEFAULT NOW(),
    detection_count INTEGER DEFAULT 1,
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days'
);

CREATE INDEX idx_unknown_faces_expires ON unknown_faces(expires_at);

-- Initial admin user (password: admin123)
-- Hash generated with bcrypt, rounds=12 — password: admin
INSERT INTO users (username, email, password_hash, role) VALUES
('admin', 'admin@dnsit.com.mx', '$2b$12$gtGMyVBZlzjcmgxzRt.IreZJikrn8HG3c0Vomwu/C7ZI3ziDXDWoe', 'admin');

-- Default cameras
INSERT INTO cameras (name, ip_address, onvif_port, username, password_encrypted, is_online, is_enabled, location) VALUES
('Cámara 1', '192.168.8.26', 80, 'dns', '', true, true, 'Oficina DNS'),
('Cámara 2 (Fisheye)', '192.168.8.64', 80, 'dns', '', true, true, 'Oficina DNS')
ON CONFLICT (ip_address) DO NOTHING;
