# DNS Vision AI

**AI-Powered Video Analytics Platform**

> Turn any ONVIF-compatible IP camera into an intelligent security system.

Built by [Data Network Solutions](https://dnsit.com.mx) — IT Infrastructure & Security, Monterrey, Mexico.

---

## Features

- **ONVIF Auto-Discovery** — Automatically find and configure IP cameras on your network
- **Real-Time AI Detection** — People, vehicles, and animals detected using YOLOv10
- **Live Multi-Camera View** — WebRTC-powered grid view with ultra-low latency
- **Smart Zones & Perimeters** — Draw virtual tripwires and ROI zones on camera views
- **Event Recording** — Automatic snapshots and video clips on detection events
- **Instant Alerts** — WhatsApp, webhook, and email notifications with attached snapshots
- **Object Tracking** — Track objects across frames with ByteTrack
- **Dark Theme Dashboard** — Modern, professional security dashboard
- **REST API** — Full API with JWT authentication for integrations
- **Self-Hosted** — Runs entirely on your own infrastructure, no cloud dependency

## Quick Start

### Prerequisites

- Ubuntu Server 24.04 LTS (recommended)
- Docker & Docker Compose
- NVIDIA GPU with drivers (optional, for faster detection)
- ONVIF-compatible IP cameras on the same network

### Installation

```bash
git clone https://github.com/leonemmanuel16/dns-vision-ai.git
cd dns-vision-ai

# Run setup script (installs Docker, NVIDIA toolkit, generates .env)
chmod +x scripts/setup.sh
./scripts/setup.sh

# Edit configuration
nano .env

# Start all services
docker compose up -d

# Open dashboard
# From server: http://localhost:3000
# From network: http://SERVER_IP:3000
```

### Default Login

- **Username:** admin
- **Password:** admin123
- **⚠️ Change the default password immediately after first login!**

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  IP Cameras  │────▶│   go2rtc      │────▶│  Dashboard   │
│  (ONVIF)     │     │  (streaming)  │     │  (Next.js)   │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                     │
       ▼                    ▼                     ▼
┌──────────────┐     ┌──────────────┐     ┌─────────────┐
│Camera Manager│     │   Detector    │     │   REST API   │
│(ONVIF disco) │     │  (YOLOv10)   │     │  (FastAPI)   │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                     │
       ▼                    ▼                     ▼
┌──────────────────────────────────────────────────────────┐
│              PostgreSQL  │  Redis  │  MinIO               │
│              (metadata)  │ (events)│ (clips/snapshots)    │
└──────────────────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology |
|---|---|
| AI Detection | Ultralytics YOLOv10 (GPU accelerated) |
| Streaming | go2rtc (WebRTC + RTSP) |
| Backend | FastAPI + Python 3.12 |
| Frontend | Next.js 14 + TailwindCSS + shadcn/ui |
| Database | PostgreSQL 16 + pgvector |
| Cache/Events | Redis 7 (Streams) |
| Object Storage | MinIO (S3-compatible) |
| ONVIF | python-onvif-zeep |
| Deployment | Docker Compose |

## API Documentation

The REST API is available at `http://SERVER_IP:8000/docs` (Swagger UI).

### Key Endpoints

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/v1/auth/login` | Authenticate and get JWT token |
| GET | `/api/v1/cameras` | List all cameras |
| POST | `/api/v1/cameras/discover` | Trigger ONVIF discovery |
| GET | `/api/v1/events` | List detection events |
| GET | `/api/v1/dashboard/stats` | Dashboard statistics |
| WS | `/ws` | Live event WebSocket |

See [API Documentation](docs/API.md) for full details.

## Services

| Service | Port | Description |
|---|---|---|
| Dashboard | 3000 | Next.js web interface |
| API | 8000 | FastAPI REST backend |
| go2rtc | 1984 | Video streaming server |
| PostgreSQL | 5432 | Main database |
| Redis | 6379 | Cache & event bus |
| MinIO | 9000/9001 | Object storage |

## Backup & Restore

```bash
# Quick backup (database + config)
./scripts/backup.sh

# Full backup (includes video clips)
./scripts/backup.sh --full

# Restore database
gunzip -c backups/BACKUP_NAME_db.sql.gz | docker compose exec -T postgres psql -U vision visionai
```

## License

**Proprietary** — © 2026 Data Network Solutions. All rights reserved.

## Contact

- **Website:** [dnsit.com.mx](https://dnsit.com.mx)
- **Sales:** ventas@dnsit.com.mx
- **Location:** Monterrey, Nuevo León, Mexico
