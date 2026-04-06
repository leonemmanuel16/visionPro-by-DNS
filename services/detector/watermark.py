"""Watermark — Overlay brand + timestamp on frames before saving.

Adds "INTELLIGENT VISION — BY DNS" text and current datetime
to the bottom-right corner of every snapshot and video frame.

If a logo PNG with alpha channel exists at ./assets/watermark.png,
it will be composited instead of text-only.
"""

import os
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

# Cache the logo overlay once
_logo_cache: np.ndarray | None = None
_logo_loaded = False

ASSETS_DIR = Path(__file__).parent / "assets"
LOGO_PATH = ASSETS_DIR / "watermark.png"


def _load_logo() -> np.ndarray | None:
    """Load watermark PNG with alpha channel (cached)."""
    global _logo_cache, _logo_loaded
    if _logo_loaded:
        return _logo_cache
    _logo_loaded = True
    if LOGO_PATH.exists():
        img = cv2.imread(str(LOGO_PATH), cv2.IMREAD_UNCHANGED)
        if img is not None and img.shape[2] == 4:
            _logo_cache = img
    return _logo_cache


def _draw_text_watermark(frame: np.ndarray, timestamp: str) -> None:
    """Draw text-based watermark when no logo PNG is available."""
    h, w = frame.shape[:2]

    # Scale font relative to frame size — bigger and bolder
    scale = max(w / 1920, 0.5)
    thickness = max(int(scale * 3), 2)
    font = cv2.FONT_HERSHEY_DUPLEX  # Cleaner, more legible font

    # Lines to draw
    line1 = "INTELLIGENT VISION"
    line2 = "— BY DNS —"
    line3 = timestamp

    # Font sizes — much larger for readability
    s1 = scale * 0.9
    s2 = scale * 0.7
    s3 = scale * 0.6

    # Calculate text sizes
    (tw1, th1), _ = cv2.getTextSize(line1, font, s1, thickness)
    (tw2, th2), _ = cv2.getTextSize(line2, font, s2, thickness)
    (tw3, th3), _ = cv2.getTextSize(line3, font, s3, thickness)

    max_tw = max(tw1, tw2, tw3)
    padding = int(15 * scale)
    line_gap = int(10 * scale)
    total_h = th1 + th2 + th3 + line_gap * 3 + padding * 2

    # Position: bottom-right
    x_base = w - max_tw - padding * 3
    y_base = h - total_h

    # Semi-transparent background — darker for better contrast
    overlay = frame.copy()
    cv2.rectangle(
        overlay,
        (x_base - padding, y_base - padding),
        (w - padding // 2, h - padding // 2),
        (0, 0, 0),
        -1,
    )
    cv2.addWeighted(overlay, 0.55, frame, 0.45, 0, frame)

    # Draw text with strong shadow for readability
    y = y_base + th1
    for text, s in [(line1, s1), (line2, s2), (line3, s3)]:
        (tw, th), _ = cv2.getTextSize(text, font, s, thickness)
        x = w - tw - padding * 2
        # Strong shadow (offset 2px)
        cv2.putText(frame, text, (x + 2, y + 2), font, s, (0, 0, 0), thickness + 2, cv2.LINE_AA)
        # White text
        cv2.putText(frame, text, (x, y), font, s, (255, 255, 255), thickness, cv2.LINE_AA)
        y += th + line_gap


def _composite_logo(frame: np.ndarray, logo: np.ndarray, timestamp: str) -> None:
    """Composite logo PNG with alpha onto frame at bottom-right."""
    h, w = frame.shape[:2]

    # Scale logo to ~20% of frame width for better visibility
    target_w = int(w * 0.20)
    logo_h, logo_w = logo.shape[:2]
    logo_scale = target_w / logo_w
    new_w = target_w
    new_h = int(logo_h * logo_scale)
    resized = cv2.resize(logo, (new_w, new_h), interpolation=cv2.INTER_AREA)

    # Add timestamp text below logo — larger font
    scale = max(w / 1920, 0.5)
    thickness = max(int(scale * 2.5), 2)
    font = cv2.FONT_HERSHEY_DUPLEX
    font_scale = scale * 0.55
    (tw, th), _ = cv2.getTextSize(timestamp, font, font_scale, thickness)

    total_h = new_h + th + int(8 * scale)
    block_w = max(new_w, tw) + int(20 * scale)

    padding = int(10 * scale)
    x_off = w - block_w - padding
    y_off = h - total_h - padding

    # Semi-transparent background
    overlay = frame.copy()
    cv2.rectangle(
        overlay,
        (x_off - padding, y_off - padding),
        (w - padding // 2, h - padding // 2),
        (0, 0, 0),
        -1,
    )
    cv2.addWeighted(overlay, 0.35, frame, 0.65, 0, frame)

    # Composite logo with alpha blending
    logo_x = x_off + (block_w - new_w) // 2
    logo_y = y_off

    # Ensure bounds
    if logo_y < 0 or logo_x < 0 or logo_y + new_h > h or logo_x + new_w > w:
        return

    roi = frame[logo_y:logo_y + new_h, logo_x:logo_x + new_w]
    alpha = resized[:, :, 3:4] / 255.0
    bgr = resized[:, :, :3]
    frame[logo_y:logo_y + new_h, logo_x:logo_x + new_w] = (
        bgr * alpha + roi * (1 - alpha)
    ).astype(np.uint8)

    # Timestamp text centered below logo
    text_x = x_off + (block_w - tw) // 2
    text_y = logo_y + new_h + th + int(4 * scale)
    cv2.putText(frame, timestamp, (text_x + 1, text_y + 1), font, font_scale, (0, 0, 0), thickness + 1, cv2.LINE_AA)
    cv2.putText(frame, timestamp, (text_x, text_y), font, font_scale, (255, 255, 255), thickness, cv2.LINE_AA)


def apply_watermark(frame: np.ndarray, timestamp: datetime | None = None) -> np.ndarray:
    """Apply watermark + timestamp to a frame (modifies in place and returns it).

    Args:
        frame: BGR numpy array (any resolution)
        timestamp: datetime to display. Defaults to now().

    Returns:
        The same frame with watermark applied.
    """
    if frame is None or frame.size == 0:
        return frame

    if timestamp is None:
        timestamp = datetime.now()

    ts_str = timestamp.strftime("%Y-%m-%d  %H:%M:%S")

    logo = _load_logo()
    if logo is not None:
        _composite_logo(frame, logo, ts_str)
    else:
        _draw_text_watermark(frame, ts_str)

    return frame
