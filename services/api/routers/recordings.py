"""Recordings API — List and stream recorded video segments.

Provides endpoints to:
- List available recordings per camera and date
- Stream/download individual MP4 segments
- Get recording status and disk usage
"""

import asyncio
import subprocess
import tempfile
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
async def stream_recording(camera_name: str, date: str, filename: str):
    """Stream a recording segment, transcoding H.265→H.264 on-the-fly for browser compatibility.

    Chrome/Firefox don't support H.265 (HEVC) natively. This endpoint uses FFmpeg
    to transcode to H.264 in real-time and streams the result. The transcoding is
    fast because it only happens for the segment being watched (~15 min max).
    """
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

    # Check if file is H.265 — if not, serve directly
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "quiet", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name", "-of", "csv=p=0",
             str(file_path)],
            capture_output=True, text=True, timeout=5
        )
        codec = probe.stdout.strip()
    except Exception:
        codec = "hevc"  # assume H.265 if probe fails

    if codec != "hevc":
        # H.264 or other browser-compatible codec — serve directly
        return FileResponse(
            path=str(file_path),
            media_type="video/mp4",
            filename=f"{camera_name}_{date}_{filename}",
        )

    # H.265 → transcode to H.264 on-the-fly via FFmpeg
    # -c:v libx264 -preset ultrafast -crf 23 = fast transcode, decent quality
    # -c:a copy = keep audio as-is
    # -movflags frag_keyframe+empty_moov = streamable MP4 (no seek to end)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-i", str(file_path),
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "23",
        "-c:a", "copy",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4",
        "pipe:1",
    ]

    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    def generate():
        try:
            while True:
                chunk = process.stdout.read(65536)  # 64KB chunks
                if not chunk:
                    break
                yield chunk
        finally:
            process.stdout.close()
            process.wait()

    return StreamingResponse(
        generate(),
        media_type="video/mp4",
        headers={
            "Content-Disposition": f'inline; filename="{camera_name}_{date}_{filename}"',
            "Cache-Control": "no-cache",
        },
    )


@router.get("/{camera_name}/{date}/{filename}/download")
async def download_recording(camera_name: str, date: str, filename: str):
    """Download the original H.265 recording file (no transcoding)."""
    file_path = RECORDINGS_DIR / camera_name / date / filename

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Recording not found")

    if not file_path.suffix == ".mp4":
        raise HTTPException(status_code=400, detail="Invalid file type")

    try:
        file_path.resolve().relative_to(RECORDINGS_DIR.resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied")

    return FileResponse(
        path=str(file_path),
        media_type="video/mp4",
        filename=f"{camera_name}_{date}_{filename}",
    )
