"""DNS Vision AI — Continuous Recording Service

Records main streams from go2rtc (RTSP) into 15-minute MP4 segments.
FFmpeg copies the H.265 stream without re-encoding (zero CPU).
Auto-cleans recordings older than RETENTION_HOURS (default 48).

Directory structure:
  /recordings/{camera_name}/2026-04-07/
    14-00-00.mp4
    14-15-00.mp4
    14-30-00.mp4
    ...
"""

import asyncio
import os
import signal
import subprocess
import time
from datetime import datetime, timedelta
from pathlib import Path

import yaml
import structlog

log = structlog.get_logger()

# ── Configuration ──
RECORDINGS_DIR = Path(os.environ.get("RECORDINGS_DIR", "/recordings"))
GO2RTC_CONFIG = os.environ.get("GO2RTC_CONFIG_PATH", "/config/go2rtc.yaml")
SEGMENT_MINUTES = int(os.environ.get("SEGMENT_MINUTES", "15"))
RETENTION_HOURS = int(os.environ.get("RETENTION_HOURS", "48"))
CLEANUP_INTERVAL = int(os.environ.get("CLEANUP_INTERVAL", "3600"))  # 1 hour
NVR_HOST = os.environ.get("NVR_HOST", "192.168.8.3")

# ── Globals ──
running = True
processes: dict[str, subprocess.Popen] = {}


def load_cameras() -> dict[str, str]:
    """Load camera streams from go2rtc config. Returns {cam_name: rtsp_url}."""
    try:
        with open(GO2RTC_CONFIG, "r") as f:
            config = yaml.safe_load(f)
        streams = config.get("streams", {})
        cameras = {}
        for name, sources in streams.items():
            # Only main streams (no _sub suffix)
            if name.endswith("_sub"):
                continue
            if sources and isinstance(sources, list):
                cameras[name] = sources[0]
        return cameras
    except Exception as e:
        log.error("recorder.config_load_failed", error=str(e))
        return {}


def ensure_dir(cam_name: str) -> Path:
    """Create date directory for camera recordings."""
    today = datetime.now().strftime("%Y-%m-%d")
    path = RECORDINGS_DIR / cam_name / today
    path.mkdir(parents=True, exist_ok=True)
    return path


def start_ffmpeg(cam_name: str, rtsp_url: str) -> subprocess.Popen | None:
    """Start FFmpeg to record RTSP stream into segmented MP4 files.

    Uses stream copy (no re-encoding) — near-zero CPU usage.
    Segments are 15 minutes each, named by timestamp.
    """
    out_dir = ensure_dir(cam_name)

    # FFmpeg segment muxer: creates new file every SEGMENT_MINUTES
    # -c copy = no re-encoding (just copies H.265 packets)
    # -f segment = split into files
    # -segment_time = seconds per segment
    # -segment_format = output format
    # -reset_timestamps 1 = each segment starts at 0
    # -strftime 1 = use time-based filenames
    segment_secs = SEGMENT_MINUTES * 60

    # Output pattern: /recordings/cam_xxx/2026-04-07/%H-%M-%S.mp4
    # We need strftime for the filename, but the directory might change at midnight
    # So we use a wrapper pattern and recreate dir each segment via the segment_list callback
    output_pattern = str(RECORDINGS_DIR / cam_name / "%Y-%m-%d" / "%H-%M-%S.mp4")

    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "warning",
        # Input: RTSP from go2rtc (re-streamed, more stable than direct NVR)
        "-rtsp_transport", "tcp",
        "-timeout", "10000000",  # 10s connection timeout
        "-i", rtsp_url,
        # Output: segmented MP4, stream copy (no re-encoding)
        "-c", "copy",
        "-f", "segment",
        "-segment_time", str(segment_secs),
        "-segment_format", "mp4",
        "-segment_atclocktime", "1",  # align to clock (start at :00, :15, :30, :45)
        "-reset_timestamps", "1",
        "-strftime", "1",
        "-strftime_mkdir", "1",  # auto-create date directories
        output_pattern,
    ]

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        log.info("recorder.started", camera=cam_name, pid=proc.pid,
                 segment_min=SEGMENT_MINUTES)
        return proc
    except Exception as e:
        log.error("recorder.start_failed", camera=cam_name, error=str(e))
        return None


def cleanup_old_recordings():
    """Delete recordings older than RETENTION_HOURS."""
    cutoff = datetime.now() - timedelta(hours=RETENTION_HOURS)
    deleted = 0
    freed_mb = 0

    for cam_dir in RECORDINGS_DIR.iterdir():
        if not cam_dir.is_dir():
            continue
        for date_dir in cam_dir.iterdir():
            if not date_dir.is_dir():
                continue
            for mp4 in date_dir.glob("*.mp4"):
                try:
                    mtime = datetime.fromtimestamp(mp4.stat().st_mtime)
                    if mtime < cutoff:
                        size_mb = mp4.stat().st_size / (1024 * 1024)
                        mp4.unlink()
                        deleted += 1
                        freed_mb += size_mb
                except Exception as e:
                    log.warning("recorder.cleanup_error", file=str(mp4), error=str(e))

            # Remove empty date directories
            try:
                if date_dir.is_dir() and not any(date_dir.iterdir()):
                    date_dir.rmdir()
            except Exception:
                pass

    if deleted > 0:
        log.info("recorder.cleanup", deleted=deleted, freed_mb=f"{freed_mb:.0f}",
                 retention_hours=RETENTION_HOURS)


def check_disk_space():
    """Warn if disk usage exceeds 85%."""
    try:
        stat = os.statvfs(str(RECORDINGS_DIR))
        total = stat.f_blocks * stat.f_frsize
        free = stat.f_bavail * stat.f_frsize
        used_pct = ((total - free) / total) * 100
        free_gb = free / (1024**3)

        if used_pct > 85:
            log.warning("recorder.disk_warning",
                        used_pct=f"{used_pct:.1f}%",
                        free_gb=f"{free_gb:.1f}")
            # Emergency cleanup: delete oldest recordings until below 80%
            if used_pct > 90:
                log.warning("recorder.emergency_cleanup", used_pct=f"{used_pct:.1f}%")
                emergency_cleanup()
        else:
            log.info("recorder.disk_ok", used_pct=f"{used_pct:.1f}%",
                     free_gb=f"{free_gb:.1f}")
    except Exception as e:
        log.warning("recorder.disk_check_failed", error=str(e))


def emergency_cleanup():
    """Delete oldest recordings until disk is below 80%."""
    all_files = []
    for mp4 in RECORDINGS_DIR.rglob("*.mp4"):
        try:
            all_files.append((mp4.stat().st_mtime, mp4))
        except Exception:
            pass

    # Sort oldest first
    all_files.sort()
    deleted = 0

    for mtime, mp4 in all_files:
        try:
            stat = os.statvfs(str(RECORDINGS_DIR))
            total = stat.f_blocks * stat.f_frsize
            free = stat.f_bavail * stat.f_frsize
            used_pct = ((total - free) / total) * 100
            if used_pct < 80:
                break
            mp4.unlink()
            deleted += 1
        except Exception:
            pass

    log.info("recorder.emergency_cleanup_done", deleted=deleted)


async def monitor_processes(cameras: dict[str, str]):
    """Monitor FFmpeg processes and restart if they die."""
    global running

    while running:
        for cam_name, rtsp_url in cameras.items():
            proc = processes.get(cam_name)

            if proc is None or proc.poll() is not None:
                # Process died or never started — restart
                if proc is not None:
                    exit_code = proc.poll()
                    stderr = ""
                    try:
                        stderr = proc.stderr.read().decode()[-500:] if proc.stderr else ""
                    except Exception:
                        pass
                    log.warning("recorder.process_died", camera=cam_name,
                                exit_code=exit_code, stderr=stderr)

                # Ensure directory exists (may be new day)
                ensure_dir(cam_name)
                new_proc = start_ffmpeg(cam_name, rtsp_url)
                if new_proc:
                    processes[cam_name] = new_proc
                else:
                    # Wait before retry
                    await asyncio.sleep(5)

        await asyncio.sleep(10)  # Check every 10s


async def cleanup_loop():
    """Periodic cleanup of old recordings."""
    global running

    # Initial cleanup on startup
    cleanup_old_recordings()
    check_disk_space()

    while running:
        await asyncio.sleep(CLEANUP_INTERVAL)
        if not running:
            break
        cleanup_old_recordings()
        check_disk_space()


async def main():
    global running

    log.info("recorder.starting",
             recordings_dir=str(RECORDINGS_DIR),
             segment_min=SEGMENT_MINUTES,
             retention_hours=RETENTION_HOURS)

    # Load cameras from go2rtc config
    cameras = load_cameras()
    if not cameras:
        log.error("recorder.no_cameras", msg="No cameras found in go2rtc config")
        return

    log.info("recorder.cameras_found", count=len(cameras),
             cameras=list(cameras.keys()))

    # Create base recordings directory
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)

    # Start FFmpeg for each camera
    for cam_name, rtsp_url in cameras.items():
        proc = start_ffmpeg(cam_name, rtsp_url)
        if proc:
            processes[cam_name] = proc

    log.info("recorder.all_started", active=len(processes), total=len(cameras))

    # Handle graceful shutdown
    def shutdown(sig, frame):
        global running
        running = False
        log.info("recorder.stopping", signal=sig)
        for name, proc in processes.items():
            try:
                proc.terminate()
                log.info("recorder.terminated", camera=name)
            except Exception:
                pass

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    # Run monitor and cleanup concurrently
    await asyncio.gather(
        monitor_processes(cameras),
        cleanup_loop(),
    )

    # Final cleanup of processes
    for name, proc in processes.items():
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    log.info("recorder.stopped")


if __name__ == "__main__":
    asyncio.run(main())
