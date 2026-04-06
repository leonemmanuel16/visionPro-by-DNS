"""Draw detection bounding boxes and labels directly on frames.

Optimized: resizes frame FIRST (4MP → 1280px), then draws on the smaller
image. This is ~4x faster than drawing on 4MP and then resizing.
"""

import cv2
import numpy as np

# Colors per class (BGR for OpenCV)
LABEL_COLORS = {
    "person": (235, 130, 59),     # blue
    "car": (11, 158, 245),        # amber
    "truck": (22, 115, 249),      # orange
    "bus": (68, 68, 239),         # red
    "motorcycle": (72, 29, 225),  # rose
    "bicycle": (166, 184, 20),    # teal
    "dog": (247, 85, 168),        # purple
    "cat": (153, 72, 236),        # pink
    "horse": (94, 63, 244),       # rose
    "bird": (246, 92, 139),       # violet
    "cow": (239, 70, 217),        # fuchsia
    "sheep": (252, 132, 192),     # purple light
}

DEFAULT_COLOR = (128, 114, 107)  # gray


def annotate_frame(frame: np.ndarray, tracked_detections: list,
                   target_width: int = 1280) -> bytes:
    """Resize frame first, then draw bounding boxes. Returns JPEG bytes."""
    h, w = frame.shape[:2]

    # Resize FIRST — draw on smaller image for speed
    if w > target_width:
        ratio = target_width / w
        new_h = int(h * ratio)
        small = cv2.resize(frame, (target_width, new_h), interpolation=cv2.INTER_AREA)
    else:
        ratio = 1.0
        small = frame.copy()

    sh, sw = small.shape[:2]
    scale = min(sw, sh) / 800
    thickness = max(1, int(scale * 1.5))
    font_scale = max(0.4, scale * 0.5)
    font = cv2.FONT_HERSHEY_SIMPLEX

    for det in tracked_detections:
        # Scale bbox coordinates to resized frame
        x1 = int(det.bbox[0] * ratio)
        y1 = int(det.bbox[1] * ratio)
        x2 = int(det.bbox[2] * ratio)
        y2 = int(det.bbox[3] * ratio)
        base_label = det.label.split(":")[0]
        color = LABEL_COLORS.get(base_label, DEFAULT_COLOR)
        conf = det.confidence

        # Bounding box
        cv2.rectangle(small, (x1, y1), (x2, y2), color, thickness)

        # Corner markers
        corner_len = max(6, int(min(x2 - x1, y2 - y1) * 0.15))
        ct = thickness + 1
        cv2.line(small, (x1, y1), (x1 + corner_len, y1), color, ct)
        cv2.line(small, (x1, y1), (x1, y1 + corner_len), color, ct)
        cv2.line(small, (x2, y1), (x2 - corner_len, y1), color, ct)
        cv2.line(small, (x2, y1), (x2, y1 + corner_len), color, ct)
        cv2.line(small, (x1, y2), (x1 + corner_len, y2), color, ct)
        cv2.line(small, (x1, y2), (x1, y2 - corner_len), color, ct)
        cv2.line(small, (x2, y2), (x2 - corner_len, y2), color, ct)
        cv2.line(small, (x2, y2), (x2, y2 - corner_len), color, ct)

        # Label text
        meta = det.metadata or {}
        person_name = meta.get("person_name")
        label_text = person_name if person_name else f"{base_label} {int(conf * 100)}%"
        if hasattr(det, "tracker_id"):
            label_text += f" #{det.tracker_id}"

        # Label background
        (tw, th), _ = cv2.getTextSize(label_text, font, font_scale, thickness)
        label_y = max(y1 - 6, th + 2)
        cv2.rectangle(small, (x1, label_y - th - 2), (x1 + tw + 6, label_y + 2), color, -1)
        cv2.putText(small, label_text, (x1 + 3, label_y), font, font_scale,
                    (255, 255, 255), thickness, cv2.LINE_AA)

        # Vehicle attributes below box
        if meta.get("vehicle_type") and meta.get("vehicle_color"):
            veh_text = f"{meta['vehicle_type']} {meta['vehicle_color']}"
            if meta.get("license_plate"):
                veh_text += f" | {meta['license_plate']}"
            (vw, vh), _ = cv2.getTextSize(veh_text, font, font_scale * 0.8, max(1, thickness - 1))
            cv2.rectangle(small, (x1, y2), (x1 + vw + 6, y2 + vh + 6), (0, 0, 0), -1)
            cv2.putText(small, veh_text, (x1 + 3, y2 + vh + 3), font, font_scale * 0.8,
                        (200, 200, 200), max(1, thickness - 1), cv2.LINE_AA)

        # Face box
        if meta.get("face_bbox"):
            ft, fr, fb, fl = [int(c * ratio) for c in meta["face_bbox"]]
            cv2.rectangle(small, (fl, ft), (fr, fb), (0, 200, 255), max(1, thickness - 1))

    # Encode as JPEG (quality 75 for smaller size)
    _, jpeg_buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 75])
    return jpeg_buf.tobytes()
