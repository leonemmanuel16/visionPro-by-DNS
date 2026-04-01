"""Person Attribute Recognition — clothing colors and headgear detection.

Analyzes person bounding box to extract:
- Upper body dominant color (shirt/jacket)
- Lower body dominant color (pants/skirt)
- Headgear type (none, gorra, sombrero, casco)
"""

import cv2
import numpy as np
import structlog

log = structlog.get_logger()

# HSV color ranges mapped to Spanish names
# Format: (name, H_low, H_high, S_min, V_min)
COLOR_RANGES = [
    ("rojo",      0,   10,  50,  50),
    ("naranja",  10,   25,  50,  50),
    ("amarillo", 25,   35,  50,  50),
    ("verde",    35,   85,  50,  50),
    ("cyan",     85,  100,  50,  50),
    ("azul",    100,  130,  50,  50),
    ("morado",  130,  155,  50,  50),
    ("rosa",    155,  175,  50,  50),
    ("rojo",    175,  180,  50,  50),  # red wraps around
]

# Special cases handled by S/V thresholds
# black: V < 50
# white: S < 30, V > 200
# gray:  S < 30, V 50-200


def _dominant_color_name(region: np.ndarray) -> tuple[str, tuple[int, int, int]]:
    """Extract dominant color name from a BGR image region using HSV histogram.

    ~10x faster than K-means with equivalent quality.
    Returns (color_name, (B, G, R) average color).
    """
    if region.size == 0 or region.shape[0] < 5 or region.shape[1] < 5:
        return "desconocido", (128, 128, 128)

    # Resize for speed
    small = cv2.resize(region, (40, 40))
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)

    # Build hue histogram (18 bins × 10° each) weighted by saturation
    h_channel = hsv[:, :, 0].flatten()
    s_channel = hsv[:, :, 1].flatten()
    v_channel = hsv[:, :, 2].flatten()

    # Classify pixels as black/white/gray/chromatic
    n_pixels = len(h_channel)
    is_black = v_channel < 50
    is_white = (s_channel < 30) & (v_channel > 200)
    is_gray = (s_channel < 30) & (~is_white) & (~is_black)
    is_chromatic = ~is_black & ~is_white & ~is_gray

    n_black = np.count_nonzero(is_black)
    n_white = np.count_nonzero(is_white)
    n_gray = np.count_nonzero(is_gray)
    n_chromatic = np.count_nonzero(is_chromatic)

    # If majority is achromatic, return that
    achromatic_max = max(n_black, n_white, n_gray)
    if achromatic_max > n_chromatic and achromatic_max > n_pixels * 0.3:
        avg_bgr = small.reshape(-1, 3).mean(axis=0).astype(np.uint8)
        if n_black >= n_white and n_black >= n_gray:
            return "negro", tuple(avg_bgr.tolist())
        elif n_white >= n_gray:
            return "blanco", tuple(avg_bgr.tolist())
        else:
            return "gris", tuple(avg_bgr.tolist())

    # For chromatic pixels, find dominant hue via histogram
    if n_chromatic > 0:
        chromatic_h = h_channel[is_chromatic]
        hist = np.bincount(chromatic_h, minlength=181)
        dominant_h = int(hist.argmax())

        # Get average BGR of pixels near dominant hue (±10)
        hue_mask = is_chromatic & (np.abs(h_channel.astype(int) - dominant_h) < 10)
        if np.any(hue_mask):
            pixels_bgr = small.reshape(-1, 3)[hue_mask]
            avg_bgr = pixels_bgr.mean(axis=0).astype(np.uint8)
        else:
            avg_bgr = small.reshape(-1, 3).mean(axis=0).astype(np.uint8)

        return _bgr_to_name(avg_bgr), tuple(avg_bgr.tolist())

    # Fallback
    avg_bgr = small.reshape(-1, 3).mean(axis=0).astype(np.uint8)
    return _bgr_to_name(avg_bgr), tuple(avg_bgr.tolist())


def _bgr_to_name(bgr: np.ndarray) -> str:
    """Convert a BGR color to Spanish name."""
    # Convert to HSV
    hsv = cv2.cvtColor(np.array([[bgr]], dtype=np.uint8), cv2.COLOR_BGR2HSV)[0][0]
    h, s, v = int(hsv[0]), int(hsv[1]), int(hsv[2])

    # Special cases
    if v < 50:
        return "negro"
    if s < 30 and v > 200:
        return "blanco"
    if s < 30:
        return "gris"

    # Check color ranges
    for name, h_low, h_high, s_min, v_min in COLOR_RANGES:
        if h_low <= h < h_high and s >= s_min and v >= v_min:
            return name

    return "gris"


def _detect_headgear(head_region: np.ndarray) -> str:
    """Analyze head region to detect headgear type.

    Uses shape and color analysis:
    - Helmet (casco): hard edges, rounded top, usually white/yellow/orange
    - Cap (gorra): visor protrusion, flatter profile
    - Hat (sombrero): wide brim, extends beyond head width
    - None: natural hair/head shape

    Returns: "ninguno", "gorra", "sombrero", "casco"
    """
    if head_region.size == 0 or head_region.shape[0] < 10 or head_region.shape[1] < 10:
        return "ninguno"

    h, w = head_region.shape[:2]

    # Convert to grayscale for edge analysis
    gray = cv2.cvtColor(head_region, cv2.COLOR_BGR2GRAY)

    # Edge detection
    edges = cv2.Canny(gray, 50, 150)

    # Analyze top portion (where headgear would be)
    top_quarter = edges[:h // 4, :]
    edge_density_top = np.count_nonzero(top_quarter) / max(top_quarter.size, 1)

    # Analyze color of top region
    top_region = head_region[:h // 3, :]
    hsv_top = cv2.cvtColor(top_region, cv2.COLOR_BGR2HSV)
    avg_s = hsv_top[:, :, 1].mean()
    avg_v = hsv_top[:, :, 2].mean()

    # Check for helmet-like colors (high saturation yellows, oranges, whites)
    h_channel = hsv_top[:, :, 0].mean()

    # High edge density at top + uniform color = likely headgear
    if edge_density_top > 0.15:
        # Check if it's a safety helmet (bright, saturated color)
        if avg_s > 100 and ((15 < h_channel < 35) or (0 < h_channel < 15)):
            return "casco"  # Safety helmet (yellow/orange)
        if avg_s < 40 and avg_v > 200:
            return "casco"  # White helmet

        # Check for cap/hat (visor extends to one side)
        left_edges = np.count_nonzero(edges[:h // 3, :w // 3])
        right_edges = np.count_nonzero(edges[:h // 3, 2 * w // 3:])
        asymmetry = abs(left_edges - right_edges) / max(left_edges + right_edges, 1)

        if asymmetry > 0.4:
            return "gorra"

        # Wide brim detection (edges extend full width)
        brim_row = edges[h // 4:h // 3, :]
        brim_coverage = np.count_nonzero(brim_row) / max(brim_row.size, 1)
        if brim_coverage > 0.2:
            return "sombrero"

    return "ninguno"


def extract_person_attributes(frame: np.ndarray, bbox: tuple) -> dict:
    """Extract visual attributes from a person detection.

    Args:
        frame: Full BGR frame
        bbox: (x1, y1, x2, y2) person bounding box

    Returns:
        {
            "upper_color": "azul",
            "upper_rgb": [0, 0, 255],
            "lower_color": "negro",
            "lower_rgb": [0, 0, 0],
            "headgear": "ninguno" | "gorra" | "sombrero" | "casco",
        }
    """
    x1, y1, x2, y2 = [int(c) for c in bbox]
    h, w = frame.shape[:2]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, x2), min(h, y2)

    if x2 <= x1 or y2 <= y1:
        return {
            "upper_color": "desconocido", "upper_rgb": [128, 128, 128],
            "lower_color": "desconocido", "lower_rgb": [128, 128, 128],
            "headgear": "ninguno",
        }

    person_h = y2 - y1
    person_w = x2 - x1

    # Divide person into regions (proportions of total height)
    # Head:       0% - 15%
    # Upper body: 20% - 50% (shirt/jacket area, skip neck)
    # Lower body: 55% - 85% (pants/skirt area, skip transition)

    head_y1 = y1
    head_y2 = y1 + int(person_h * 0.15)

    upper_y1 = y1 + int(person_h * 0.20)
    upper_y2 = y1 + int(person_h * 0.50)

    lower_y1 = y1 + int(person_h * 0.55)
    lower_y2 = y1 + int(person_h * 0.85)

    # Narrow horizontally to avoid background (center 70%)
    pad_x = int(person_w * 0.15)
    cx1 = x1 + pad_x
    cx2 = x2 - pad_x

    head_region = frame[head_y1:head_y2, x1:x2]
    upper_region = frame[upper_y1:upper_y2, cx1:cx2]
    lower_region = frame[lower_y1:lower_y2, cx1:cx2]

    # Extract colors
    upper_color, upper_bgr = _dominant_color_name(upper_region)
    lower_color, lower_bgr = _dominant_color_name(lower_region)

    # Detect headgear
    headgear = _detect_headgear(head_region)

    # Convert BGR to RGB for frontend
    upper_rgb = [int(upper_bgr[2]), int(upper_bgr[1]), int(upper_bgr[0])]
    lower_rgb = [int(lower_bgr[2]), int(lower_bgr[1]), int(lower_bgr[0])]

    return {
        "upper_color": upper_color,
        "upper_rgb": upper_rgb,
        "lower_color": lower_color,
        "lower_rgb": lower_rgb,
        "headgear": headgear,
    }
