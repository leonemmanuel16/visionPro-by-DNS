# DNS Vision AI — API Documentation

Base URL: `http://SERVER_IP:8000/api/v1`

Interactive docs: `http://SERVER_IP:8000/docs`

## Authentication

All endpoints (except `/auth/login`) require a JWT token in the Authorization header:

```
Authorization: Bearer <access_token>
```

### POST /auth/login

```json
// Request
{ "username": "admin", "password": "admin123" }

// Response 200
{
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "token_type": "bearer",
  "expires_in": 3600
}
```

### POST /auth/register (admin only)

```json
// Request
{ "username": "operator1", "email": "op@dnsit.com.mx", "password": "secure123", "role": "operator" }

// Response 201
{ "id": "uuid", "username": "operator1", "email": "op@dnsit.com.mx", "role": "operator" }
```

### POST /auth/refresh

```json
// Request
{ "refresh_token": "eyJ..." }

// Response 200
{ "access_token": "eyJ...", "token_type": "bearer", "expires_in": 3600 }
```

### GET /auth/me

Returns the current authenticated user.

## Cameras

### GET /cameras

List all cameras. Optional query: `?is_enabled=true&is_online=true`

### GET /cameras/{id}

Get camera details by ID.

### POST /cameras

Add a camera manually.

```json
{
  "name": "Entrada Principal",
  "ip_address": "192.168.1.100",
  "onvif_port": 80,
  "username": "admin",
  "password": "camera123",
  "location": "Entrada Principal"
}
```

### PUT /cameras/{id}

Update camera properties.

### DELETE /cameras/{id}

Delete a camera and all its events.

### POST /cameras/discover

Trigger ONVIF auto-discovery on the network.

### POST /cameras/{id}/ptz

Control PTZ camera.

```json
{ "pan": 0.5, "tilt": -0.3, "zoom": 0.1 }
```

## Events

### GET /events

List events with filters.

Query params: `camera_id`, `event_type`, `from`, `to`, `page`, `per_page`

### GET /events/{id}

Get event details including snapshot and clip URLs.

### GET /events/{id}/snapshot

Redirect to snapshot presigned URL.

### GET /events/{id}/clip

Redirect to clip presigned URL.

### GET /events/stats

Event statistics: counts by type, by camera, by hour (last 24h).

## Zones

### GET /zones

List zones. Optional: `?camera_id=uuid`

### POST /zones

Create a zone.

```json
{
  "camera_id": "uuid",
  "name": "Entrada Perimeter",
  "zone_type": "roi",
  "points": [{"x": 0.1, "y": 0.1}, {"x": 0.9, "y": 0.1}, {"x": 0.9, "y": 0.9}, {"x": 0.1, "y": 0.9}],
  "detect_classes": ["person", "vehicle"]
}
```

### PUT /zones/{id}

Update zone properties.

### DELETE /zones/{id}

Delete a zone.

## Alert Rules

### GET /alerts

List all alert rules.

### POST /alerts

Create an alert rule.

```json
{
  "name": "After Hours Person Alert",
  "camera_id": "uuid",
  "event_types": ["person"],
  "channel": "whatsapp",
  "target": "+528112345678",
  "cooldown_seconds": 120,
  "schedule": { "start": "20:00", "end": "06:00", "days": [1,2,3,4,5,6,7] }
}
```

### PUT /alerts/{id}

Update alert rule.

### DELETE /alerts/{id}

Delete alert rule.

## Dashboard

### GET /dashboard/stats

```json
{
  "total_cameras": 12,
  "online_cameras": 10,
  "events_today": 247,
  "events_this_week": 1830
}
```

### GET /dashboard/recent

Last 20 events with camera info.

## WebSocket

### WS /ws?token={access_token}

Live event stream. Receives JSON messages:

```json
{
  "type": "detection",
  "event": {
    "id": "uuid",
    "camera_id": "uuid",
    "camera_name": "Entrada Principal",
    "event_type": "person",
    "confidence": 0.92,
    "occurred_at": "2026-01-15T22:30:00Z",
    "snapshot_url": "http://..."
  }
}
```
