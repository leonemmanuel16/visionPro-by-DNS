"""Draw detection bounding boxes and labels directly on frames.

Produces annotated JPEG snapshots so the dashboard shows video
with detections already drawn — no separate overlay needed.
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
                   target_width: int = 1920) -> bytes:
    """Draw bounding boxes on frame and return JPEG bytes.

    Args:
        frame: Original frame (4MP numpy array, BGR)
        tracked_detections: List of TrackedDetection objects with bbox, label, confidence, metadata
        target_width: Target width for output JPEG (height scaled proportionally)

    Returns:
        JPEG bytes of the annotated, resized frame
    """
    h, w = frame.shape[:2]

    # Scale factor for text/lines based on frame size
    scale = min(w, h) / 1000
    thickness = max(2, int(scale * 2))
    font_scale = max(0.5, scale * 0.6)
    font = cv2.FONT_HERSHEY_SIMPLEX

    # Draw on a copy to avoid modifying the original frame (used for alerts/clips)
    annotated = frame.copy()

    for det in tracked_detections:
        x1, y1, x2, y2 = [int(c) for c in det.bbox]
        base_label = det.label.split(":")[0]
        color = LABEL_COLORS.get(base_label, DEFAULT_COLOR)
        conf = det.confidence

        # Bounding box
        cv2.rectangle(annotated, (x1, y1), (x2, y2), color, thickness)

        # Corner markers (thicker, short lines at corners)
        corner_len = max(10, int(min(x2 - x1, y2 - y1) * 0.15))
        ct = thickness + 1
        # Top-left
        cv2.line(annotated, (x1, y1), (x1 + corner_len, y1), color, ct)
        cv2.line(annotated, (x1, y1), (x1, y1 + corner_len), color, ct)
        # Top-right
        cv2.line(annotated, (x2, y1), (x2 - corner_len, y1), color, ct)
        cv2.line(annotated, (x2, y1), (x2, y1 + corner_len), color, ct)
        # Bottom-left
        cv2.line(annotated, (x1, y2), (x1 + corner_len, y2), color, ct)
        cv2.line(annotated, (x1, y2), (x1, y2 - corner_len), color, ct)
        # Bottom-right
        cv2.line(annotated, (x2, y2), (x2 - corner_len, y2), color, ct)
        cv2.line(annotated, (x2, y2), (x2, y2 - corner_len), color, ct)

        # Label text
        meta = det.metadata or {}
        person_name = meta.get("person_name")

        if person_name:
            label_text = person_name
        else:
            label_text = f"{base_label} {int(conf * 100)}%"

        # Add tracker ID
        if hasattr(det, "tracker_id"):
            label_text += f" #{det.tracker_id}"

        # Label background
        (tw, th), baseline = cv2.getTextSize(label_text, font, font_scale, thickness)
        label_y = max(y1 - 8, th + 4)
        cv2.rectangle(annotated, (x1, label_y - th - 4), (x1 + tw + 8, label_y + 4), color, -1)
        cv2.putText(annotated, label_text, (x1 + 4, label_y), font, font_scale,
                    (255, 255, 255), thickness, cv2.LINE_AA)

        # Vehicle attributes below box
        if meta.get("vehicle_type") and meta.get("vehicle_color"):
            veh_text = f"{meta['vehicle_type']} {meta['vehicle_color']}"
            if meta.get("license_plate"):
                veh_text += f" | {meta['license_plate']}"
            (vw, vh), _ = cv2.getTextSize(veh_text, font, font_scale * 0.8, thickness)
            cv2.rectangle(annotated, (x1, y2), (x1 + vw + 8, y2 + vh + 8), (0, 0, 0), -1)
            cv2.putText(annotated, veh_text, (x1 + 4, y2 + vh + 4), font, font_scale * 0.8,
                        (200, 200, 200), max(1, thickness - 1), cv2.LINE_AA)

        # Person clothing colors below box
        if base_label == "person" and meta.get("upper_color") and meta.get("upper_color") != "desconocido":
            cloth_text = f"{meta.get('upper_color', '')} / {meta.get('lower_color', '')}"
            (cw, ch), _ = cv2.getTextSize(cloth_text, font, font_scale * 0.7, max(1, thickness - 1))
            cv2.rectangle(annotated, (x1, y2), (x1 + cw + 8, y2 + ch + 8), (0, 0, 0), -1)
            cv2.putText(annotated, cloth_text, (x1 + 4, y2 + ch + 4), font, font_scale * 0.7,
                        (200, 200, 200), max(1, thickness - 1), cv2.LINE_AA)

        # Face box (if detected)
        if meta.get("face_bbox"):
            ft, fr, fb, fl = [int(c) for c in meta["face_bbox"]]
            cv2.rectangle(annotated, (fl, ft), (fr, fb), (0, 200, 255), max(1, thickness - 1))

    # Resize to target width
    if w > target_width:
        ratio = target_width / w
        new_h = int(h * ratio)
        annotated = cv2.resize(annotated, (target_width, new_h), interpolation=cv2.INTER_AREA)

    # Encode as JPEG
    _, jpeg_buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return jpeg_buf.tobytes()
