# DNS Vision AI — Architecture

## Overview

DNS Vision AI is a microservices-based video analytics platform. Each service runs in its own Docker container and communicates via Redis Streams (event bus), PostgreSQL (persistence), and HTTP APIs.

## Services

### Camera Manager
- **Purpose:** Discover and manage ONVIF IP cameras
- **Responsibilities:**
  - WS-Discovery multicast for ONVIF devices
  - Connect to cameras, retrieve device info and stream URIs
  - Auto-generate go2rtc streaming configuration
  - Monitor camera health (online/offline status)
- **Communication:** Writes to PostgreSQL, publishes to Redis Stream `camera_events`

### go2rtc
- **Purpose:** Video streaming relay
- **Responsibilities:**
  - Accept RTSP streams from cameras
  - Serve WebRTC and HLS to browsers
  - Handle stream transcoding/repackaging
- **Communication:** Reads config from YAML, serves streams via HTTP/WebSocket

### Detector
- **Purpose:** AI-powered object detection
- **Responsibilities:**
  - Pull frames from go2rtc RTSP sub-streams
  - Run YOLOv10 inference (GPU accelerated)
  - Track objects across frames (ByteTrack)
  - Apply virtual zone filtering
  - Save snapshots/clips to MinIO
  - Publish detection events to Redis
- **Communication:** Reads from go2rtc RTSP, writes to PostgreSQL + MinIO, publishes to Redis Stream `detection_events`

### API
- **Purpose:** REST API backend
- **Responsibilities:**
  - JWT authentication (access + refresh tokens)
  - CRUD operations for cameras, events, zones, alert rules
  - Dashboard statistics
  - WebSocket endpoint for live event streaming
  - MinIO presigned URL generation for media access
- **Communication:** Reads/writes PostgreSQL, subscribes to Redis Streams, reads from MinIO

### Dashboard
- **Purpose:** Web-based user interface
- **Responsibilities:**
  - Multi-camera live grid view (WebRTC via go2rtc)
  - Event timeline with search and filters
  - Zone/perimeter configuration
  - Alert rule management
  - Dashboard statistics and charts
- **Communication:** Calls API via HTTP, connects to go2rtc for video, WebSocket for live events

## Data Flow

```
Camera → [RTSP] → go2rtc → [RTSP] → Detector → [Detection] → Redis Stream
                      ↓                              ↓               ↓
                   [WebRTC]                      PostgreSQL      Alert Service
                      ↓                          + MinIO             ↓
                   Dashboard ← [API] ← FastAPI              WhatsApp/Webhook
```

## Event Bus (Redis Streams)

- `camera_events` — Camera discovered, updated, online, offline
- `detection_events` — Object detected, zone crossing, etc.
- Consumers: API (WebSocket relay), Alert Service

## Storage

- **PostgreSQL** — Users, cameras, events, zones, alert rules
- **Redis** — Event bus (Streams), camera cache, session data
- **MinIO** — Snapshots, video clips, thumbnails (S3-compatible)
