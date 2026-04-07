"""Recordings API — List and stream recorded video segments.

Provides endpoints to:
- List available recordings per camera and date
- Stream/download individual MP4 segments
- Get recording status and disk usage
"""

from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
import os

router = APIRouter(prefix="/recordings", tags=["recordings"])

RECORDINGS_DIR = Path(os.environ.get("RECORDINGS_DIR", "/app/data/recordings"))


@router.get("")
async def list_recordings(
    camera_id: Optional[str] = Query(None, description="Filter by camera stream name"),
    date: Optional[str] = Query(None, description="Filter by date (YYYY-MM-DD)"),
):
    """List available recordings grouped by camera and date."""
    if not RECORDINGS_DIR.exists():
        return {"cameras": {}, "total_files": 0, "total_size_gb": 0}

    result = {}
    total_files = 0
    total_bytes = 0

    for cam_dir in sorted(RECORDINGS_DIR.iterdir()):
        if not cam_dir.is_dir():
            continue
        cam_name = cam_dir.name

        if camera_id and camera_id != cam_name:
            continue

        cam_data = {}
        for date_dir in sorted(cam_dir.iterdir()):
            if not date_dir.is_dir():
                continue

            if date and date != date_dir.name:
                continue

            segments = []
            for mp4 in sorted(date_dir.glob("*.mp4")):
                try:
                    stat = mp4.stat()
                    size_mb = stat.st_size / (1024 * 1024)
                    mtime = datetime.fromtimestamp(stat.st_mtime)
                    segments.append({
                        "filename": mp4.name,
                        "time": mp4.stem.replace("-", ":"),  # "14-00-00" -> "14:00:00"
                        "size_mb": round(size_mb, 1),
                        "duration_min": 15,  # segment duration
                        "modified": mtime.isoformat(),
                    })
                    total_files += 1
                    total_bytes += stat.st_size
                except Exception:
                    pass

            if segments:
                cam_data[date_dir.name] = segments

        if cam_data:
            result[cam_name] = cam_data

    return {
        "cameras": result,
        "total_files": total_files,
        "total_size_gb": round(total_bytes / (1024**3), 2),
    }


@router.get("/status")
async def recording_status():
    """Get recording service status and disk usage."""
    if not RECORDINGS_DIR.exists():
        return {"active": False, "message": "Recordings directory not found"}

    try:
        stat = os.statvfs(str(RECORDINGS_DIR))
        total = stat.f_blocks * stat.f_frsize
        free = stat.f_bavail * stat.f_frsize
        used = total - free
        used_pct = (used / total) * 100

        # Count total recordings
        total_files = sum(1 for _ in RECORDINGS_DIR.rglob("*.mp4"))
        total_size = sum(f.stat().st_size for f in RECORDINGS_DIR.rglob("*.mp4"))

        # Count cameras
        cam_dirs = [d for d in RECORDINGS_DIR.iterdir() if d.is_dir()]

        return {
            "active": True,
            "cameras_recording": len(cam_dirs),
            "total_files": total_files,
            "total_size_gb": round(total_size / (1024**3), 2),
            "disk_total_gb": round(total / (1024**3), 1),
            "disk_free_gb": round(free / (1024**3), 1),
            "disk_used_pct": round(used_pct, 1),
            "retention_hours": int(os.environ.get("RETENTION_HOURS", "48")),
            "segment_minutes": int(os.environ.get("SEGMENT_MINUTES", "15")),
        }
    except Exception as e:
        return {"active": False, "error": str(e)}


@router.get("/{camera_name}/{date}/{filename}")
async def download_recording(camera_name: str, date: str, filename: str):
    """Download or stream a specific recording segment."""
    file_path = RECORDINGS_DIR / camera_name / date / filename

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Recording not found")

    if not file_path.suffix == ".mp4":
        raise HTTPException(status_code=400, detail="Invalid file type")

    # Security: ensure path doesn't escape recordings dir
    try:
        file_path.resolve().relative_to(RECORDINGS_DIR.resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied")

    return FileResponse(
        path=str(file_path),
        media_type="video/mp4",
        filename=f"{camera_name}_{date}_{filename}",
    )
