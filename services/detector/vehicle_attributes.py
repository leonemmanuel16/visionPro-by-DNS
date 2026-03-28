"""Vehicle Attribute Recognition — color extraction for detected vehicles.

Analyzes vehicle bounding box to extract:
- Dominant body color
"""

import cv2
import numpy as np
import structlog

log = structlog.get_logger()

# HSV color ranges mapped to Spanish names
COLOR_RANGES = [
    ("rojo",      0,   10,  50,  50),
    ("naranja",  10,   25,  50,  50),
    ("amarillo", 25,   35,  50,  50),
    ("verde",    35,   85,  50,  50),
    ("cyan",     85,  100,  50,  50),
    ("azul",    100,  130,  50,  50),
    ("morado",  130,  155,  50,  50),
    ("rosa",    155,  175,  50,  50),
    ("rojo",    175,  180,  50,  50),
]


def _bgr_to_name(bgr: np.ndarray) -> str:
    """Convert a BGR color to Spanish name."""
    hsv = cv2.cvtColor(np.array([[bgr]], dtype=np.uint8), cv2.COLOR_BGR2HSV)[0][0]
    h, s, v = int(hsv[0]), int(hsv[1]), int(hsv[2])

    if v < 50:
        return "negro"
    if s < 30 and v > 200:
        return "blanco"
    if s < 30:
        return "gris"

    for name, h_low, h_high, s_min, v_min in COLOR_RANGES:
        if h_low <= h < h_high and s >= s_min and v >= v_min:
            return name

    return "gris"


def _dominant_color(region: np.ndarray) -> tuple[str, tuple[int, int, int]]:
    """Extract dominant color from a BGR region using K-means."""
    if region.size == 0 or region.shape[0] < 5 or region.shape[1] < 5:
        return "desconocido", (128, 128, 128)

    small = cv2.resize(region, (50, 50))
    pixels = small.reshape(-1, 3).astype(np.float32)

    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 10, 1.0)
    try:
        _, labels, centers = cv2.kmeans(pixels, 3, None, criteria, 3, cv2.KMEANS_PP_CENTERS)
    except cv2.error:
        avg = pixels.mean(axis=0).astype(np.uint8)
        return _bgr_to_name(avg), tuple(avg.tolist())

    counts = np.bincount(labels.flatten(), minlength=3)
    dominant_idx = counts.argmax()
    dominant_bgr = centers[dominant_idx].astype(np.uint8)

    return _bgr_to_name(dominant_bgr), tuple(dominant_bgr.tolist())


def extract_vehicle_attributes(frame: np.ndarray, bbox: tuple) -> dict:
    """Extract visual attributes from a vehicle detection.

    Args:
        frame: Full BGR frame
        bbox: (x1, y1, x2, y2) vehicle bounding box

    Returns:
        {
            "vehicle_color": "blanco",
            "vehicle_rgb": [255, 255, 255],
        }
    """
    x1, y1, x2, y2 = [int(c) for c in bbox]
    h, w = frame.shape[:2]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, x2), min(h, y2)

    if x2 <= x1 or y2 <= y1:
        return {"vehicle_color": "desconocido", "vehicle_rgb": [128, 128, 128]}

    veh_h = y2 - y1
    veh_w = x2 - x1

    # Focus on the center body of the vehicle (avoid windows, wheels, ground reflections)
    # Horizontally: center 70%
    # Vertically: 20%-70% (skip roof/ground)
    pad_x = int(veh_w * 0.15)
    body_y1 = y1 + int(veh_h * 0.20)
    body_y2 = y1 + int(veh_h * 0.70)
    body_x1 = x1 + pad_x
    body_x2 = x2 - pad_x

    body_region = frame[body_y1:body_y2, body_x1:body_x2]

    color_name, color_bgr = _dominant_color(body_region)
    color_rgb = [int(color_bgr[2]), int(color_bgr[1]), int(color_bgr[0])]

    return {
        "vehicle_color": color_name,
        "vehicle_rgb": color_rgb,
    }
