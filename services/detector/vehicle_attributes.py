"""Vehicle Attribute Recognition — color, type classification, and license plate OCR.

Analyzes vehicle bounding box to extract:
- Dominant body color (Spanish names)
- Vehicle type classification based on bbox proportions
- License plate text via EasyOCR (if readable)
"""

import cv2
import numpy as np
import structlog

log = structlog.get_logger()

# ── Color detection ──────────────────────────────────────────────────

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
    hsv = cv2.cvtColor(np.array([[bgr]], dtype=np.uint8), cv2.COLOR_BGR2HSV)[0][0]
    h, s, v = int(hsv[0]), int(hsv[1]), int(hsv[2])
    if v < 40:
        return "negro"
    if s < 40 and v > 160:  # Relaxed: catches white cars in shadows/overcast
        return "blanco"
    if s < 35:
        return "gris"
    for name, h_low, h_high, s_min, v_min in COLOR_RANGES:
        if h_low <= h < h_high and s >= s_min and v >= v_min:
            return name
    return "gris"


def _dominant_color(region: np.ndarray) -> tuple[str, tuple[int, int, int]]:
    """Extract dominant color using HSV histogram (~10x faster than K-means)."""
    if region.size == 0 or region.shape[0] < 5 or region.shape[1] < 5:
        return "desconocido", (128, 128, 128)
    small = cv2.resize(region, (50, 50))
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)

    h_channel = hsv[:, :, 0].flatten()
    s_channel = hsv[:, :, 1].flatten()
    v_channel = hsv[:, :, 2].flatten()

    n_pixels = len(h_channel)
    is_black = v_channel < 40
    is_white = (s_channel < 40) & (v_channel > 160)  # Relaxed for real-world lighting
    is_gray = (s_channel < 35) & (~is_white) & (~is_black)
    is_chromatic = ~is_black & ~is_white & ~is_gray

    n_black = np.count_nonzero(is_black)
    n_white = np.count_nonzero(is_white)
    n_gray = np.count_nonzero(is_gray)
    n_chromatic = np.count_nonzero(is_chromatic)

    achromatic_max = max(n_black, n_white, n_gray)
    if achromatic_max > n_chromatic and achromatic_max > n_pixels * 0.3:
        avg_bgr = small.reshape(-1, 3).mean(axis=0).astype(np.uint8)
        if n_black >= n_white and n_black >= n_gray:
            return "negro", tuple(avg_bgr.tolist())
        elif n_white >= n_gray:
            return "blanco", tuple(avg_bgr.tolist())
        else:
            return "gris", tuple(avg_bgr.tolist())

    if n_chromatic > 0:
        chromatic_h = h_channel[is_chromatic]
        hist = np.bincount(chromatic_h, minlength=181)
        dominant_h = int(hist.argmax())

        hue_mask = is_chromatic & (np.abs(h_channel.astype(int) - dominant_h) < 10)
        if np.any(hue_mask):
            pixels_bgr = small.reshape(-1, 3)[hue_mask]
            avg_bgr = pixels_bgr.mean(axis=0).astype(np.uint8)
        else:
            avg_bgr = small.reshape(-1, 3).mean(axis=0).astype(np.uint8)
        return _bgr_to_name(avg_bgr), tuple(avg_bgr.tolist())

    avg_bgr = small.reshape(-1, 3).mean(axis=0).astype(np.uint8)
    return _bgr_to_name(avg_bgr), tuple(avg_bgr.tolist())


# ── Vehicle type classification ──────────────────────────────────────

def _classify_vehicle_type(bbox: tuple, yolo_label: str) -> str:
    """Classify vehicle type based on YOLO label and bbox proportions.

    Uses aspect ratio and relative size to distinguish between:
    - Motocicleta (motorcycle from YOLO)
    - Bicicleta (bicycle from YOLO)
    - Camión (truck from YOLO)
    - Autobús (bus from YOLO)
    - Pickup/SUV (wide, tall cars)
    - Sedán (medium aspect ratio)
    - Compacto (small cars)
    - Camioneta (van-like proportions)
    """
    # Direct mappings from YOLO classes
    if yolo_label == "motorcycle":
        return "Motocicleta"
    if yolo_label == "bicycle":
        return "Bicicleta"
    if yolo_label == "truck":
        return "Camión"
    if yolo_label == "bus":
        return "Autobús"

    # For "car" label: classify by bbox proportions
    x1, y1, x2, y2 = bbox
    w = x2 - x1
    h = y2 - y1
    if w == 0 or h == 0:
        return "Vehículo"

    aspect = w / h  # wider = higher aspect ratio
    area = w * h

    # Tall and wide → SUV/Pickup
    if h > 120 and aspect < 1.6:
        return "SUV/Pickup"

    # Very wide → Van/Camioneta
    if aspect > 2.0:
        return "Camioneta"

    # Medium → Sedán
    if area > 20000:
        return "Sedán"

    # Small → Compacto
    return "Compacto"


# ── License plate OCR ────────────────────────────────────────────────

# Lazy-loaded EasyOCR reader (heavy initialization, do it once)
_ocr_reader = None
_ocr_available = None


def _get_ocr_reader():
    """Lazy-initialize EasyOCR reader. Returns None if not available."""
    global _ocr_reader, _ocr_available
    if _ocr_available is False:
        return None
    if _ocr_reader is not None:
        return _ocr_reader
    try:
        import easyocr
        _ocr_reader = easyocr.Reader(
            ["en"],  # License plates use Latin characters
            gpu=True,
            verbose=False,
        )
        _ocr_available = True
        log.info("vehicle_ocr.initialized", gpu=True)
        return _ocr_reader
    except Exception as e:
        log.warning("vehicle_ocr.init_failed", error=str(e))
        _ocr_available = False
        return None


def _read_license_plate(frame: np.ndarray, bbox: tuple) -> str | None:
    """Try to read a license plate from the lower portion of a vehicle bbox.

    Returns plate text if found, None otherwise.
    """
    reader = _get_ocr_reader()
    if reader is None:
        return None

    x1, y1, x2, y2 = [int(c) for c in bbox]
    h, w = frame.shape[:2]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, x2), min(h, y2)

    veh_h = y2 - y1
    veh_w = x2 - x1

    if veh_h < 60 or veh_w < 80:
        return None  # Too small to read plates

    # License plates are typically in the lower 40% of the vehicle
    plate_y1 = y1 + int(veh_h * 0.55)
    plate_y2 = y2
    # And center 80% horizontally
    pad_x = int(veh_w * 0.1)
    plate_x1 = x1 + pad_x
    plate_x2 = x2 - pad_x

    plate_region = frame[plate_y1:plate_y2, plate_x1:plate_x2]

    if plate_region.size == 0 or plate_region.shape[0] < 20 or plate_region.shape[1] < 40:
        return None

    try:
        # Preprocess for better OCR
        gray = cv2.cvtColor(plate_region, cv2.COLOR_BGR2GRAY)
        # Increase contrast
        gray = cv2.equalizeHist(gray)
        # Upscale if too small
        if gray.shape[1] < 200:
            scale = 200 / gray.shape[1]
            gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

        results = reader.readtext(gray, detail=1, paragraph=False)

        if not results:
            return None

        # Filter results: license plates are typically 5-8 characters, alphanumeric
        best_plate = None
        best_conf = 0.0

        for (bbox_pts, text, conf) in results:
            # Clean text: uppercase, remove spaces
            clean = text.upper().strip().replace(" ", "").replace("-", "")

            # Mexican plates: 3 letters + 3-4 numbers, or newer formats
            # US plates: various formats 2-8 chars
            # General: 4-8 alphanumeric characters
            if len(clean) >= 4 and len(clean) <= 10 and conf > 0.3:
                # Check if mostly alphanumeric
                alnum_ratio = sum(c.isalnum() for c in clean) / len(clean)
                if alnum_ratio >= 0.7 and conf > best_conf:
                    best_plate = clean
                    best_conf = conf

        if best_plate and best_conf > 0.3:
            log.info("vehicle_ocr.plate_read", plate=best_plate, confidence=f"{best_conf:.2f}")
            return best_plate

    except Exception as e:
        log.debug("vehicle_ocr.error", error=str(e))

    return None


# ── Main extraction function ─────────────────────────────────────────

def extract_vehicle_attributes(frame: np.ndarray, bbox: tuple, yolo_label: str = "car") -> dict:
    """Extract visual attributes from a vehicle detection.

    Args:
        frame: Full BGR frame
        bbox: (x1, y1, x2, y2) vehicle bounding box
        yolo_label: YOLO detection label (car, truck, bus, motorcycle, bicycle)

    Returns:
        {
            "vehicle_color": "blanco",
            "vehicle_rgb": [255, 255, 255],
            "vehicle_type": "Sedán",
            "license_plate": "ABC1234" or None,
        }
    """
    x1, y1, x2, y2 = [int(c) for c in bbox]
    h, w = frame.shape[:2]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, x2), min(h, y2)

    result = {
        "vehicle_color": "desconocido",
        "vehicle_rgb": [128, 128, 128],
        "vehicle_type": "Vehículo",
        "license_plate": None,
    }

    if x2 <= x1 or y2 <= y1:
        return result

    veh_h = y2 - y1
    veh_w = x2 - x1

    # ── Color ──
    # Take center 60% of the bbox to avoid edges (shadows, road, background)
    pad_x = int(veh_w * 0.20)
    pad_y = int(veh_h * 0.20)
    body_y1 = y1 + pad_y
    body_y2 = y2 - pad_y
    body_x1 = x1 + pad_x
    body_x2 = x2 - pad_x
    body_region = frame[body_y1:body_y2, body_x1:body_x2]
    color_name, color_bgr = _dominant_color(body_region)
    result["vehicle_color"] = color_name
    result["vehicle_rgb"] = [int(color_bgr[2]), int(color_bgr[1]), int(color_bgr[0])]

    # ── Type classification ──
    result["vehicle_type"] = _classify_vehicle_type(bbox, yolo_label)

    # ── License plate OCR (disabled — easyocr too heavy for this server) ──
    # plate = _read_license_plate(frame, bbox)
    # if plate:
    #     result["license_plate"] = plate

    return result
