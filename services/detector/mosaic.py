"""Mosaic Builder — Packs multiple camera frames into 3x3 grid images for batched YOLO.

Instead of running YOLO on 18 individual frames (270 fps at 15fps = impossible on T1000),
we pack 9 cameras per 640x640 mosaic -> 2 mosaics x 15fps = 30fps (achievable).

Flow:
  1. build_mosaics(): 18 frames -> 2 mosaics of 640x640 (9 cameras each)
  2. YOLO runs on the 2 mosaics (batch=2)
  3. remap_detections(): maps YOLO bboxes back to per-camera original coordinates
"""

from dataclasses import dataclass

import cv2
import numpy as np

MOSAIC_SIZE = 640
GRID = 3  # 3x3
TILE_SIZE = MOSAIC_SIZE // GRID  # 213 pixels per tile


@dataclass
class TileInfo:
    """Maps a camera to its position in a mosaic."""
    camera_id: str
    mosaic_idx: int
    row: int
    col: int
    orig_h: int
    orig_w: int


def build_mosaics(
    frames: dict[str, np.ndarray],
) -> tuple[list[np.ndarray], list[TileInfo]]:
    """Build 3x3 mosaic images from camera frames.

    Args:
        frames: dict mapping camera_id -> BGR frame (any resolution)

    Returns:
        (mosaics, tile_map):
            mosaics: list of 640x640 BGR numpy arrays
            tile_map: list of TileInfo for every camera placed in a mosaic
    """
    camera_ids = list(frames.keys())
    cams_per_mosaic = GRID * GRID  # 9
    tile_map: list[TileInfo] = []
    mosaics: list[np.ndarray] = []

    for batch_start in range(0, len(camera_ids), cams_per_mosaic):
        batch_ids = camera_ids[batch_start : batch_start + cams_per_mosaic]
        mosaic = np.zeros((MOSAIC_SIZE, MOSAIC_SIZE, 3), dtype=np.uint8)

        for i, cam_id in enumerate(batch_ids):
            row = i // GRID
            col = i % GRID
            frame = frames[cam_id]
            orig_h, orig_w = frame.shape[:2]

            # Resize to tile — squash is fine, YOLO handles aspect distortion
            tile = cv2.resize(frame, (TILE_SIZE, TILE_SIZE), interpolation=cv2.INTER_LINEAR)

            y0 = row * TILE_SIZE
            x0 = col * TILE_SIZE
            mosaic[y0 : y0 + TILE_SIZE, x0 : x0 + TILE_SIZE] = tile

            tile_map.append(TileInfo(
                camera_id=cam_id,
                mosaic_idx=len(mosaics),
                row=row,
                col=col,
                orig_h=orig_h,
                orig_w=orig_w,
            ))

        mosaics.append(mosaic)

    return mosaics, tile_map


def remap_detections(
    yolo_results: list[list],
    tile_map: list[TileInfo],
) -> dict[str, list]:
    """Remap YOLO detections from mosaic coordinates to per-camera original coordinates.

    Args:
        yolo_results: list of detection lists, one per mosaic image
        tile_map: tile position info from build_mosaics()

    Returns:
        dict mapping camera_id -> list[Detection] with bbox in original frame coords
    """
    from detector import Detection

    # Build lookup: (mosaic_idx, row, col) -> TileInfo
    tile_lookup: dict[tuple[int, int, int], TileInfo] = {}
    for info in tile_map:
        tile_lookup[(info.mosaic_idx, info.row, info.col)] = info

    cam_detections: dict[str, list[Detection]] = {}

    for mosaic_idx, detections in enumerate(yolo_results):
        for det in detections:
            x1, y1, x2, y2 = det.bbox

            # Determine which tile this detection belongs to (by bbox center)
            cx = (x1 + x2) / 2
            cy = (y1 + y2) / 2
            col = min(int(cx // TILE_SIZE), GRID - 1)
            row = min(int(cy // TILE_SIZE), GRID - 1)

            info = tile_lookup.get((mosaic_idx, row, col))
            if info is None:
                continue  # empty tile slot

            # Convert mosaic coords -> tile-local coords
            local_x1 = x1 - col * TILE_SIZE
            local_y1 = y1 - row * TILE_SIZE
            local_x2 = x2 - col * TILE_SIZE
            local_y2 = y2 - row * TILE_SIZE

            # Clamp to tile bounds
            local_x1 = max(0.0, min(local_x1, TILE_SIZE))
            local_y1 = max(0.0, min(local_y1, TILE_SIZE))
            local_x2 = max(0.0, min(local_x2, TILE_SIZE))
            local_y2 = max(0.0, min(local_y2, TILE_SIZE))

            # Skip tiny fragments (bbox spanning tile border)
            if (local_x2 - local_x1) < 4 or (local_y2 - local_y1) < 4:
                continue

            # Scale tile coords -> original frame coords
            sx = info.orig_w / TILE_SIZE
            sy = info.orig_h / TILE_SIZE

            remapped = Detection(
                bbox=(local_x1 * sx, local_y1 * sy, local_x2 * sx, local_y2 * sy),
                label=det.label,
                confidence=det.confidence,
                class_id=det.class_id,
            )

            cam_detections.setdefault(info.camera_id, []).append(remapped)

    return cam_detections
