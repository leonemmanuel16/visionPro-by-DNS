"""System routes - updates, health, version info, DDNS, health monitoring."""

import json
import subprocess
import os
import urllib.request
import time
from datetime import datetime, timezone
from typing import Optional

import psutil
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/system", tags=["system"])

DDNS_CONFIG_PATH = os.environ.get("DDNS_CONFIG_PATH", "/config/ddns.json")


class VersionInfo(BaseModel):
    current_version: str
    current_commit: str
    branch: str


class UpdateCheck(BaseModel):
    has_update: bool
    current_commit: str
    latest_commit: str
    changelog: str
    commits_behind: int


class UpdateResult(BaseModel):
    success: bool
    message: str
    new_commit: str


def _run_git(args: list[str], cwd: str = "/app") -> str:
    """Run a git command and return output."""
    # In Docker, the app is at /app. In dev, use the repo root.
    repo_dir = os.environ.get("REPO_DIR", cwd)
    try:
        result = subprocess.run(
            ["git"] + args,
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return result.stdout.strip()
    except Exception as e:
        return f"Error: {str(e)}"


@router.get("/version", response_model=VersionInfo)
async def get_version():
    """Get current version info."""
    commit = _run_git(["rev-parse", "--short", "HEAD"])
    branch = _run_git(["rev-parse", "--abbrev-ref", "HEAD"])

    # Try to get version from a tag, fallback to 1.0.0
    version = _run_git(["describe", "--tags", "--always"])
    if not version or "Error" in version:
        version = "1.0.0"

    return VersionInfo(
        current_version=version,
        current_commit=commit,
        branch=branch,
    )


@router.get("/check-update", response_model=UpdateCheck)
async def check_update():
    """Check if there are updates available on GitHub."""
    # Fetch latest from remote
    _run_git(["fetch", "origin", "main"])

    current = _run_git(["rev-parse", "--short", "HEAD"])
    latest = _run_git(["rev-parse", "--short", "origin/main"])

    if current == latest:
        return UpdateCheck(
            has_update=False,
            current_commit=current,
            latest_commit=latest,
            changelog="",
            commits_behind=0,
        )

    # Get changelog
    log = _run_git(["log", "--oneline", f"HEAD..origin/main"])

    # Count commits behind
    count_str = _run_git(["rev-list", "--count", f"HEAD..origin/main"])
    try:
        commits_behind = int(count_str)
    except ValueError:
        commits_behind = 0

    return UpdateCheck(
        has_update=True,
        current_commit=current,
        latest_commit=latest,
        changelog=log,
        commits_behind=commits_behind,
    )


@router.post("/apply-update", response_model=UpdateResult)
async def apply_update():
    """Pull latest changes from GitHub."""
    # Git pull
    result = _run_git(["pull", "origin", "main"])

    if "Error" in result or "fatal" in result:
        raise HTTPException(status_code=500, detail=f"Update failed: {result}")

    new_commit = _run_git(["rev-parse", "--short", "HEAD"])

    return UpdateResult(
        success=True,
        message=result,
        new_commit=new_commit,
    )


# --- DDNS ---

class DdnsConfig(BaseModel):
    enabled: bool = False
    provider: str = "noip"
    hostname: str = ""
    username: str = ""
    password: str = ""
    token: str = ""
    updateInterval: int = 300
    lastUpdate: str = ""
    lastIp: str = ""


def _get_public_ip() -> str:
    """Get the server's public IP address."""
    try:
        req = urllib.request.urlopen("https://api.ipify.org", timeout=10)
        return req.read().decode("utf-8").strip()
    except Exception:
        try:
            req = urllib.request.urlopen("https://ifconfig.me/ip", timeout=10)
            return req.read().decode("utf-8").strip()
        except Exception:
            return ""


def _update_ddns(config: DdnsConfig, ip: str) -> str:
    """Send DDNS update to provider. Returns status message."""
    provider = config.provider
    hostname = config.hostname

    try:
        if provider == "duckdns":
            # DuckDNS: https://www.duckdns.org/update?domains=XXXX&token=YYYY&ip=ZZZZ
            domain = hostname.replace(".duckdns.org", "")
            url = f"https://www.duckdns.org/update?domains={domain}&token={config.token}&ip={ip}"
            req = urllib.request.urlopen(url, timeout=15)
            resp = req.read().decode("utf-8").strip()
            if resp == "OK":
                return "OK"
            return f"DuckDNS respondió: {resp}"

        elif provider == "noip":
            # No-IP: HTTP Basic Auth to nic/update
            url = f"https://dynupdate.no-ip.com/nic/update?hostname={hostname}&myip={ip}"
            req = urllib.request.Request(url)
            import base64
            creds = base64.b64encode(f"{config.username}:{config.password}".encode()).decode()
            req.add_header("Authorization", f"Basic {creds}")
            req.add_header("User-Agent", "DNS-VisionPro/1.0 admin@dnsit.com.mx")
            resp = urllib.request.urlopen(req, timeout=15).read().decode("utf-8").strip()
            if resp.startswith("good") or resp.startswith("nochg"):
                return "OK"
            return f"No-IP respondió: {resp}"

        elif provider == "dynu":
            url = f"https://api.dynu.com/nic/update?hostname={hostname}&myip={ip}&username={config.username}&password={config.password}"
            req = urllib.request.urlopen(url, timeout=15)
            resp = req.read().decode("utf-8").strip()
            if "good" in resp or "nochg" in resp:
                return "OK"
            return f"Dynu respondió: {resp}"

        elif provider == "cloudflare":
            # Cloudflare requires zone_id and record_id — simplified version using token
            return "Cloudflare requiere configuración avanzada via API"

        elif provider == "freedns":
            url = f"https://freedns.afraid.org/dynamic/update.php?{config.token}&address={ip}"
            req = urllib.request.urlopen(url, timeout=15)
            resp = req.read().decode("utf-8").strip()
            if "Updated" in resp or "has not changed" in resp:
                return "OK"
            return f"FreeDNS respondió: {resp}"

        elif provider == "custom":
            url = config.token.replace("{IP}", ip).replace("{HOST}", hostname)
            req = urllib.request.urlopen(url, timeout=15)
            return "OK"

        return f"Proveedor desconocido: {provider}"

    except Exception as e:
        return f"Error: {str(e)}"


@router.post("/ddns")
async def save_ddns_config(config: DdnsConfig):
    """Save DDNS configuration."""
    try:
        os.makedirs(os.path.dirname(DDNS_CONFIG_PATH), exist_ok=True)
        with open(DDNS_CONFIG_PATH, "w") as f:
            json.dump(config.dict(), f, indent=2)
        return {"status": "saved"}
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/ddns")
async def get_ddns_config():
    """Get current DDNS configuration."""
    try:
        if os.path.exists(DDNS_CONFIG_PATH):
            with open(DDNS_CONFIG_PATH) as f:
                return json.load(f)
        return DdnsConfig().dict()
    except Exception:
        return DdnsConfig().dict()


@router.post("/ddns/test")
async def test_ddns(config: DdnsConfig):
    """Test DDNS update — gets public IP and sends update to provider."""
    ip = _get_public_ip()
    if not ip:
        raise HTTPException(500, "No se pudo obtener la IP pública")

    result = _update_ddns(config, ip)

    if result == "OK":
        # Save updated IP to config
        config.lastIp = ip
        config.lastUpdate = __import__("datetime").datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        try:
            os.makedirs(os.path.dirname(DDNS_CONFIG_PATH), exist_ok=True)
            with open(DDNS_CONFIG_PATH, "w") as f:
                json.dump(config.dict(), f, indent=2)
        except Exception:
            pass
        return {"status": "ok", "ip": ip, "message": f"DDNS actualizado correctamente a {ip}"}
    else:
        raise HTTPException(400, result)


# ── Health Monitoring ──────────────────────────────────────────────────────

HEALTH_CONFIG_PATH = os.environ.get("HEALTH_CONFIG_PATH", "/config/health_thresholds.json")

# Default thresholds (can be overridden via env or API)
DEFAULT_THRESHOLDS = {
    "cpu_percent": int(os.environ.get("HEALTH_ALERT_CPU_THRESHOLD", "90")),
    "ram_percent": int(os.environ.get("HEALTH_ALERT_RAM_THRESHOLD", "90")),
    "gpu_percent": int(os.environ.get("HEALTH_ALERT_GPU_THRESHOLD", "95")),
    "gpu_temp_c": int(os.environ.get("HEALTH_ALERT_GPU_TEMP_THRESHOLD", "85")),
    "disk_percent": int(os.environ.get("HEALTH_ALERT_DISK_THRESHOLD", "90")),
    "gpu_mem_percent": 90,
}

# In-memory alert cooldown to avoid spam (alert_key -> last_alert_time)
_alert_cooldowns: dict[str, float] = {}
ALERT_COOLDOWN_SECONDS = 300  # 5 minutes between repeated alerts


class GpuInfo(BaseModel):
    name: str = ""
    gpu_util: float = 0
    mem_used_mb: float = 0
    mem_total_mb: float = 0
    mem_percent: float = 0
    temperature: float = 0
    fan_speed: float = 0
    power_draw_w: float = 0
    power_limit_w: float = 0
    available: bool = False


class DiskInfo(BaseModel):
    device: str
    mountpoint: str
    total_gb: float
    used_gb: float
    free_gb: float
    percent: float


class HealthMetrics(BaseModel):
    timestamp: str
    # CPU
    cpu_percent: float
    cpu_count: int
    cpu_count_logical: int
    cpu_freq_mhz: float
    cpu_per_core: list[float]
    # RAM
    ram_total_gb: float
    ram_used_gb: float
    ram_available_gb: float
    ram_percent: float
    # Swap
    swap_total_gb: float
    swap_used_gb: float
    swap_percent: float
    # GPU
    gpu: GpuInfo
    # Disk
    disks: list[DiskInfo]
    # System
    uptime_seconds: float
    load_avg: list[float]
    # Alerts triggered
    alerts: list[dict]


class HealthThresholds(BaseModel):
    cpu_percent: int = 90
    ram_percent: int = 90
    gpu_percent: int = 95
    gpu_temp_c: int = 85
    gpu_mem_percent: int = 90
    disk_percent: int = 90


def _get_thresholds() -> dict:
    """Load thresholds from config file or return defaults."""
    try:
        if os.path.exists(HEALTH_CONFIG_PATH):
            with open(HEALTH_CONFIG_PATH) as f:
                return {**DEFAULT_THRESHOLDS, **json.load(f)}
    except Exception:
        pass
    return DEFAULT_THRESHOLDS.copy()


def _get_gpu_info() -> GpuInfo:
    """Query nvidia-smi for GPU metrics."""
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,fan.speed,power.draw,power.limit",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return GpuInfo()

        line = result.stdout.strip().split("\n")[0]
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 8:
            return GpuInfo()

        mem_used = float(parts[2])
        mem_total = float(parts[3])
        mem_pct = (mem_used / mem_total * 100) if mem_total > 0 else 0

        # Fan speed may be "[N/A]" for some GPUs
        try:
            fan = float(parts[5])
        except (ValueError, IndexError):
            fan = 0

        # Power draw may be "[N/A]"
        try:
            power_draw = float(parts[6])
        except (ValueError, IndexError):
            power_draw = 0

        try:
            power_limit = float(parts[7])
        except (ValueError, IndexError):
            power_limit = 0

        return GpuInfo(
            name=parts[0],
            gpu_util=float(parts[1]),
            mem_used_mb=mem_used,
            mem_total_mb=mem_total,
            mem_percent=round(mem_pct, 1),
            temperature=float(parts[4]),
            fan_speed=fan,
            power_draw_w=power_draw,
            power_limit_w=power_limit,
            available=True,
        )
    except FileNotFoundError:
        return GpuInfo()
    except Exception:
        return GpuInfo()


def _get_disk_info() -> list[DiskInfo]:
    """Get disk usage for all mounted partitions."""
    disks = []
    seen_devices = set()
    for part in psutil.disk_partitions(all=False):
        if part.device in seen_devices:
            continue
        if part.fstype in ("squashfs", "tmpfs", "devtmpfs", "overlay"):
            continue
        seen_devices.add(part.device)
        try:
            usage = psutil.disk_usage(part.mountpoint)
            disks.append(DiskInfo(
                device=part.device,
                mountpoint=part.mountpoint,
                total_gb=round(usage.total / (1024**3), 1),
                used_gb=round(usage.used / (1024**3), 1),
                free_gb=round(usage.free / (1024**3), 1),
                percent=usage.percent,
            ))
        except PermissionError:
            continue
    return disks


def _check_alerts(metrics: HealthMetrics, thresholds: dict) -> list[dict]:
    """Check if any metrics exceed thresholds and return alert list."""
    alerts = []
    now = time.time()

    def _maybe_alert(key: str, label: str, value: float, threshold: float, unit: str, severity: str = "warning"):
        if value >= threshold:
            # Check cooldown
            if key in _alert_cooldowns and (now - _alert_cooldowns[key]) < ALERT_COOLDOWN_SECONDS:
                return
            _alert_cooldowns[key] = now
            alerts.append({
                "key": key,
                "label": label,
                "value": round(value, 1),
                "threshold": threshold,
                "unit": unit,
                "severity": severity,
                "message": f"{label}: {round(value, 1)}{unit} (umbral: {threshold}{unit})",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

    _maybe_alert("cpu", "CPU", metrics.cpu_percent, thresholds["cpu_percent"], "%")
    _maybe_alert("ram", "Memoria RAM", metrics.ram_percent, thresholds["ram_percent"], "%")
    _maybe_alert("disk", "Disco", max((d.percent for d in metrics.disks), default=0), thresholds["disk_percent"], "%")

    if metrics.gpu.available:
        _maybe_alert("gpu_util", "GPU Utilizacion", metrics.gpu.gpu_util, thresholds["gpu_percent"], "%", "critical")
        _maybe_alert("gpu_temp", "GPU Temperatura", metrics.gpu.temperature, thresholds["gpu_temp_c"], "°C", "critical")
        _maybe_alert("gpu_mem", "GPU Memoria", metrics.gpu.mem_percent, thresholds["gpu_mem_percent"], "%")

    return alerts


# Store alert history in memory (last 100 alerts)
_alert_history: list[dict] = []
# Active alerts by key (auto-resolve when metric drops below threshold)
_active_alerts: dict[str, dict] = {}
MAX_ALERT_HISTORY = 100


@router.get("/health-metrics", response_model=HealthMetrics)
async def get_health_metrics():
    """Collect real-time system health metrics (CPU, RAM, GPU, Disk)."""
    # CPU
    cpu_percent = psutil.cpu_percent(interval=0.5)
    cpu_per_core = psutil.cpu_percent(interval=0, percpu=True)
    cpu_freq = psutil.cpu_freq()
    cpu_count = psutil.cpu_count(logical=False) or 1
    cpu_count_logical = psutil.cpu_count(logical=True) or 1

    # RAM
    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()

    # GPU
    gpu = _get_gpu_info()

    # Disk
    disks = _get_disk_info()

    # System
    boot_time = psutil.boot_time()
    uptime = time.time() - boot_time
    load_avg = list(os.getloadavg()) if hasattr(os, "getloadavg") else [0, 0, 0]

    metrics = HealthMetrics(
        timestamp=datetime.now(timezone.utc).isoformat(),
        cpu_percent=cpu_percent,
        cpu_count=cpu_count,
        cpu_count_logical=cpu_count_logical,
        cpu_freq_mhz=round(cpu_freq.current, 0) if cpu_freq else 0,
        cpu_per_core=cpu_per_core,
        ram_total_gb=round(mem.total / (1024**3), 1),
        ram_used_gb=round(mem.used / (1024**3), 1),
        ram_available_gb=round(mem.available / (1024**3), 1),
        ram_percent=mem.percent,
        swap_total_gb=round(swap.total / (1024**3), 1),
        swap_used_gb=round(swap.used / (1024**3), 1),
        swap_percent=swap.percent,
        gpu=gpu,
        disks=disks,
        uptime_seconds=uptime,
        load_avg=[round(l, 2) for l in load_avg],
        alerts=[],
    )

    # Check thresholds and generate alerts
    thresholds = _get_thresholds()
    alerts = _check_alerts(metrics, thresholds)
    metrics.alerts = alerts

    # Track active alerts and auto-resolve
    now_iso = datetime.now(timezone.utc).isoformat()
    current_alert_keys = {a["key"] for a in alerts}

    # New alerts → add to active and history
    for alert in alerts:
        if alert["key"] not in _active_alerts:
            alert["status"] = "active"
            _active_alerts[alert["key"]] = alert
            _alert_history.append(alert)
            if len(_alert_history) > MAX_ALERT_HISTORY:
                _alert_history.pop(0)
        else:
            # Update value on existing active alert
            _active_alerts[alert["key"]]["value"] = alert["value"]
            _active_alerts[alert["key"]]["timestamp"] = alert["timestamp"]

    # Auto-resolve: alert was active but metric is now below threshold
    resolved_keys = [k for k in _active_alerts if k not in current_alert_keys]
    for key in resolved_keys:
        resolved = _active_alerts.pop(key)
        resolved["status"] = "resolved"
        resolved["resolved_at"] = now_iso
        _alert_history.append(resolved)
        if len(_alert_history) > MAX_ALERT_HISTORY:
            _alert_history.pop(0)

    return metrics


@router.get("/health-alerts")
async def get_health_alerts():
    """Get health alert history. Active alerts first, then resolved."""
    active = [a for a in _active_alerts.values()]
    resolved = [a for a in _alert_history if a.get("status") == "resolved"]
    # Return active first, then last 20 resolved
    all_alerts = active + list(reversed(resolved))[:20]
    return {
        "alerts": all_alerts,
        "active_count": len(active),
        "total_count": len(_alert_history),
    }


@router.post("/health-alerts/clear")
async def clear_health_alerts():
    """Clear all health alerts."""
    _alert_history.clear()
    _alert_cooldowns.clear()
    _active_alerts.clear()
    return {"status": "cleared"}


@router.get("/health-thresholds", response_model=HealthThresholds)
async def get_health_thresholds():
    """Get current health alert thresholds."""
    t = _get_thresholds()
    return HealthThresholds(**t)


@router.post("/health-thresholds")
async def save_health_thresholds(thresholds: HealthThresholds):
    """Save health alert thresholds."""
    try:
        os.makedirs(os.path.dirname(HEALTH_CONFIG_PATH), exist_ok=True)
        with open(HEALTH_CONFIG_PATH, "w") as f:
            json.dump(thresholds.dict(), f, indent=2)
        return {"status": "saved"}
    except Exception as e:
        raise HTTPException(500, str(e))
