"""System routes - updates, health, version info, DDNS."""

import json
import subprocess
import os
import urllib.request

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

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
