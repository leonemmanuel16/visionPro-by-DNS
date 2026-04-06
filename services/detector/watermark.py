"""Watermark — Overlay brand logo + timestamp on frames before saving.

Loads logo from ./assets/watermark.png and composites it on a dark
background panel at the bottom-right corner. Timestamp uses local
timezone (TZ env var).
"""

import os
from datetime import datetime, timezone, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import cv2
import numpy as np

# Cache the logo overlay once
_logo_cache: np.ndarray | None = None
_logo_loaded = False

ASSETS_DIR = Path(__file__).parent / "assets"
LOGO_PATH = ASSETS_DIR / "watermark.png"

# Timezone from env (default America/Monterrey)
_TZ_NAME = os.environ.get("TZ", "America/Monterrey")
try:
    LOCAL_TZ = ZoneInfo(_TZ_NAME)
except Exception:
    LOCAL_TZ = None


def _load_logo() -> np.ndarray | None:
    """Load watermark PNG as-is (BGR, no alpha tricks). Cached."""
    global _logo_cache, _logo_loaded
    if _logo_loaded:
        return _logo_cache
    _logo_loaded = True

    import structlog
    log = structlog.get_logger()

    if not LOGO_PATH.exists():
        log.info("watermark.no_logo", path=str(LOGO_PATH))
        return None

    # Load as regular BGR (no alpha needed — we place it on a dark panel)
    img = cv2.imread(str(LOGO_PATH), cv2.IMREAD_COLOR)
    if img is None:
        log.warning("watermark.logo_load_failed", path=str(LOGO_PATH))
        return None

    h, w = img.shape[:2]
    log.info("watermark.logo_loaded", path=str(LOGO_PATH), size=f"{w}x{h}")
    _logo_cache = img
    return _logo_cache


def _get_local_time(ts: datetime | None = None) -> str:
    """Get formatted timestamp in local timezone."""
    if ts is None:
        if LOCAL_TZ:
            ts = datetime.now(LOCAL_TZ)
        else:
            ts = datetime.now()
    elif ts.tzinfo is None and LOCAL_TZ:
        ts = ts.replace(tzinfo=LOCAL_TZ)
    return ts.strftime("%Y-%m-%d  %H:%M:%S")


def _draw_text_watermark(frame: np.ndarray, timestamp: str) -> None:
    """Draw text-based watermark when no logo PNG is available."""
    h, w = frame.shape[:2]

    scale = max(w / 1920, 0.5)
    thickness = max(int(scale * 2), 1)
    font = cv2.FONT_HERSHEY_SIMPLEX

    line1 = "INTELLIGENT VISION"
    line2 = "BY DNS"
    line3 = timestamp

    s1 = scale * 0.7
    s2 = scale * 0.5
    s3 = scale * 0.45

    (tw1, th1), _ = cv2.getTextSize(line1, font, s1, thickness)
    (tw2, th2), _ = cv2.getTextSize(line2, font, s2, thickness)
    (tw3, th3), _ = cv2.getTextSize(line3, font, s3, thickness)

    max_tw = max(tw1, tw2, tw3)
    padding = int(12 * scale)
    line_gap = int(8 * scale)
    total_h = th1 + th2 + th3 + line_gap * 3 + padding * 2

    x_base = w - max_tw - padding * 3
    y_base = h - total_h

    overlay = frame.copy()
    cv2.rectangle(overlay, (x_base - padding, y_base - padding),
                  (w - padding // 2, h - padding // 2), (0, 0, 0), -1)
    cv2.addWeighted(overlay, 0.5, frame, 0.5, 0, frame)

    y = y_base + th1
    for text, s in [(line1, s1), (line2, s2), (line3, s3)]:
        (tw, th), _ = cv2.getTextSize(text, font, s, thickness)
        x = w - tw - padding * 2
        cv2.putText(frame, text, (x + 1, y + 1), font, s, (0, 0, 0), thickness + 1, cv2.LINE_AA)
        cv2.putText(frame, text, (x, y), font, s, (255, 255, 255), thickness, cv2.LINE_AA)
        y += th + line_gap


def _composite_logo(frame: np.ndarray, logo: np.ndarray, timestamp: str) -> None:
    """Place logo on a dark panel at bottom-right with timestamp below."""
    h, w = frame.shape[:2]

    # Scale logo to ~15% of frame width
    target_w = int(w * 0.15)
    logo_h, logo_w = logo.shape[:2]
    logo_scale = target_w / logo_w
    new_w = target_w
    new_h = int(logo_h * logo_scale)
    resized = cv2.resize(logo, (new_w, new_h), interpolation=cv2.INTER_AREA)

    # Timestamp text metrics
    scale = max(w / 1920, 0.5)
    thickness = max(int(scale * 1.5), 1)
    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = scale * 0.45
    (tw, th), _ = cv2.getTextSize(timestamp, font, font_scale, thickness)

    gap = int(6 * scale)
    padding = int(10 * scale)
    total_h = new_h + gap + th + padding * 2
    block_w = max(new_w, tw) + padding * 2

    # Position: bottom-right corner
    panel_x1 = w - block_w - padding
    panel_y1 = h - total_h - padding
    panel_x2 = w - padding // 2
    panel_y2 = h - padding // 2

    # Dark panel background
    overlay = frame.copy()
    cv2.rectangle(overlay, (panel_x1, panel_y1), (panel_x2, panel_y2), (0, 0, 0), -1)
    cv2.addWeighted(overlay, 0.55, frame, 0.45, 0, frame)

    # Place logo centered on panel (as regular image, no alpha)
    logo_x = panel_x1 + (block_w - new_w) // 2
    logo_y = panel_y1 + padding

    # Bounds check
    if logo_y < 0 or logo_x < 0 or logo_y + new_h > h or logo_x + new_w > w:
        return

    frame[logo_y:logo_y + new_h, logo_x:logo_x + new_w] = resized

    # Timestamp centered below logo
    text_x = panel_x1 + (block_w - tw) // 2
    text_y = logo_y + new_h + gap + th
    cv2.putText(frame, timestamp, (text_x + 1, text_y + 1), font, font_scale,
                (0, 0, 0), thickness + 1, cv2.LINE_AA)
    cv2.putText(frame, timestamp, (text_x, text_y), font, font_scale,
                (255, 255, 255), thickness, cv2.LINE_AA)


def apply_watermark(frame: np.ndarray, timestamp: datetime | None = None) -> np.ndarray:
    """Apply watermark + timestamp to a frame (modifies in place and returns it).

    Args:
        frame: BGR numpy array (any resolution)
        timestamp: datetime to display. Defaults to now() in local timezone.

    Returns:
        The same frame with watermark applied.
    """
    if frame is None or frame.size == 0:
        return frame

    ts_str = _get_local_time(timestamp)

    logo = _load_logo()
    if logo is not None:
        _composite_logo(frame, logo, ts_str)
    else:
        _draw_text_watermark(frame, ts_str)

    return frame
