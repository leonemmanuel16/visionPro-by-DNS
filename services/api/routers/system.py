"""System routes - updates, health, version info."""

import subprocess
import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/system", tags=["system"])


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
