"""Adaptive Mosaic Builder — Variable grid sizes for optimal YOLO inference.

Strategy based on active camera count:
  1   camera:   Full frame @ 960    (1 inference, 960x540 letterbox — max detail)
  2   cameras:  Split vertical @960  (1 inference, 960x480 per cam)
  3-4 cameras:  1x 2x2 @ 960       (1 inference, 480px/tile)
  5-8 cameras:  2x 2x2 @ 960       (2 inferences, 480px/tile)
  9   cameras:  1x 3x3 @ 640       (1 inference, 213px/tile)
  10-13 cameras: 1x 3x3 + 1x 2x2  (2 inferences, mixed resolution)
  14-18 cameras: 2x 3x3 @ 640      (2 inferences, 213px/tile)

All tiles use letterboxing (aspect ratio preserved, black padding) to avoid
distortion that kills person detection from overhead camera angles.
"""

from dataclasses import dataclass

import cv2
import numpy as np

MOSAIC_SIZE_3x3 = 640   # 3x3 grid: 213px per tile (fast coverage)
MOSAIC_SIZE_2x2 = 1280  # 2x2 grid: 640px per tile (hi-res detail)


@dataclass
class TileInfo:
    """Maps a camera to its position in a mosaic."""
    camera_id: str
    mosaic_idx: int
    row: int
    col: int
    grid: int           # 2 or 3 (grid size used for this mosaic)
    mosaic_size: int     # 640 or 960 (total mosaic resolution)
    orig_h: int
    orig_w: int
    # Letterbox offsets (content area within the tile)
    lb_x_off: int = 0   # x offset of content in tile
    lb_y_off: int = 0   # y offset of content in tile
    lb_w: int = 0        # width of content in tile
    lb_h: int = 0        # height of content in tile


def _build_single_mosaic(
    cam_ids: list[str],
    frames: dict[str, np.ndarray],
    grid: int,
    mosaic_idx: int,
) -> tuple[np.ndarray, list[TileInfo]]:
    """Build one mosaic image with the given grid size.

    2x2 grids use 960x960 (480px/tile) for maximum detail.
    3x3 grids use 640x640 (213px/tile) for fast coverage.
    """
    mosaic_size = MOSAIC_SIZE_2x2 if grid == 2 else MOSAIC_SIZE_3x3
    tile_size = mosaic_size // grid
    mosaic = np.zeros((mosaic_size, mosaic_size, 3), dtype=np.uint8)
    tile_map: list[TileInfo] = []

    for i, cam_id in enumerate(cam_ids):
        if i >= grid * grid:
            break
        row = i // grid
        col = i % grid
        frame = frames.get(cam_id)
        if frame is None:
            continue
        orig_h, orig_w = frame.shape[:2]

        # Letterbox: maintain aspect ratio, pad with black (avoids distortion)
        scale = min(tile_size / orig_w, tile_size / orig_h)
        new_w = int(orig_w * scale)
        new_h = int(orig_h * scale)
        resized = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
        tile = np.zeros((tile_size, tile_size, 3), dtype=np.uint8)
        y_off = (tile_size - new_h) // 2
        x_off = (tile_size - new_w) // 2
        tile[y_off : y_off + new_h, x_off : x_off + new_w] = resized

        y0 = row * tile_size
        x0 = col * tile_size
        mosaic[y0 : y0 + tile_size, x0 : x0 + tile_size] = tile

        tile_map.append(TileInfo(
            camera_id=cam_id,
            mosaic_idx=mosaic_idx,
            row=row,
            col=col,
            grid=grid,
            mosaic_size=mosaic_size,
            orig_h=orig_h,
            orig_w=orig_w,
            lb_x_off=x_off,
            lb_y_off=y_off,
            lb_w=new_w,
            lb_h=new_h,
        ))

    return mosaic, tile_map


def build_mosaics(
    frames: dict[str, np.ndarray],
    motion_cam_ids: set[str] | None = None,
) -> tuple[list[np.ndarray], list[TileInfo]]:
    """Build adaptive mosaic images from camera frames.

    Args:
        frames: dict mapping camera_id -> BGR frame (any resolution)
        motion_cam_ids: set of camera IDs that had detections in the
                        previous cycle (prioritized for hi-res 2x2 re-scan)

    Returns:
        (mosaics, tile_map):
            mosaics: list of 640x640 BGR numpy arrays
            tile_map: list of TileInfo for every camera placed in a mosaic
    """
    camera_ids = list(frames.keys())
    num_cams = len(camera_ids)
    mosaics: list[np.ndarray] = []
    tile_map: list[TileInfo] = []

    if num_cams == 0:
        return mosaics, tile_map

    if num_cams == 1:
        # ── Single camera: send full frame at 960x960, no mosaic needed ──
        cam_id = camera_ids[0]
        frame = frames[cam_id]
        orig_h, orig_w = frame.shape[:2]
        target = MOSAIC_SIZE_2x2  # 960
        # Letterbox to 960x960
        scale = min(target / orig_w, target / orig_h)
        new_w = int(orig_w * scale)
        new_h = int(orig_h * scale)
        resized = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
        canvas = np.zeros((target, target, 3), dtype=np.uint8)
        y_off = (target - new_h) // 2
        x_off = (target - new_w) // 2
        canvas[y_off : y_off + new_h, x_off : x_off + new_w] = resized
        mosaics.append(canvas)
        tile_map.append(TileInfo(
            camera_id=cam_id, mosaic_idx=0, row=0, col=0,
            grid=1, mosaic_size=target,
            orig_h=orig_h, orig_w=orig_w,
            lb_x_off=x_off, lb_y_off=y_off,
            lb_w=new_w, lb_h=new_h,
        ))
    elif num_cams == 2:
        # ── Two cameras: split 960x960 in half (960x480 per camera) ──
        target = MOSAIC_SIZE_2x2  # 960
        half = target // 2  # 480
        canvas = np.zeros((target, target, 3), dtype=np.uint8)
        for i, cam_id in enumerate(camera_ids[:2]):
            frame = frames.get(cam_id)
            if frame is None:
                continue
            orig_h, orig_w = frame.shape[:2]
            # Letterbox into 960x480 area
            scale = min(target / orig_w, half / orig_h)
            new_w = int(orig_w * scale)
            new_h = int(orig_h * scale)
            resized = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
            x_off = (target - new_w) // 2
            y_off_local = (half - new_h) // 2
            y_off_global = i * half + y_off_local
            canvas[y_off_global : y_off_global + new_h, x_off : x_off + new_w] = resized
            tile_map.append(TileInfo(
                camera_id=cam_id, mosaic_idx=0, row=i, col=0,
                grid=2, mosaic_size=target,
                orig_h=orig_h, orig_w=orig_w,
                lb_x_off=x_off, lb_y_off=y_off_local,
                lb_w=new_w, lb_h=new_h,
            ))
        mosaics.append(canvas)
    elif num_cams <= 4:
        # ── 3-4 cameras: 1x 2x2 @960 (480px/tile, 1 inference) ──
        mosaic, tiles = _build_single_mosaic(camera_ids[:4], frames, grid=2, mosaic_idx=0)
        mosaics.append(mosaic)
        tile_map.extend(tiles)
    elif num_cams <= 8:
        # ── 5-8 cameras: 2x 2x2 @960 (480px/tile, 2 inferences) ──
        for batch_start in range(0, num_cams, 4):
            batch_ids = camera_ids[batch_start : batch_start + 4]
            mosaic_idx = len(mosaics)
            mosaic, tiles = _build_single_mosaic(batch_ids, frames, grid=2, mosaic_idx=mosaic_idx)
            mosaics.append(mosaic)
            tile_map.extend(tiles)
    elif num_cams == 9:
        # ── 9 cameras: 1x 3x3 @640 (213px/tile, 1 inference) ──
        mosaic, tiles = _build_single_mosaic(camera_ids[:9], frames, grid=3, mosaic_idx=0)
        mosaics.append(mosaic)
        tile_map.extend(tiles)
    elif num_cams <= 13:
        # ── 10-13 cameras: 1x 3x3 @640 (first 9) + 1x 2x2 @960 (remaining 1-4) ──
        mosaic_3x3, tiles_3x3 = _build_single_mosaic(camera_ids[:9], frames, grid=3, mosaic_idx=0)
        mosaics.append(mosaic_3x3)
        tile_map.extend(tiles_3x3)
        remaining = camera_ids[9:]
        if remaining:
            mosaic_2x2, tiles_2x2 = _build_single_mosaic(remaining, frames, grid=2, mosaic_idx=1)
            mosaics.append(mosaic_2x2)
            tile_map.extend(tiles_2x2)
    else:
        # ── 14-18 cameras: 2x 3x3 @640 (2 inferences) ──
        mid = (num_cams + 1) // 2  # split evenly: e.g. 18→9+9, 15→8+7, 14→7+7
        mosaic_a, tiles_a = _build_single_mosaic(camera_ids[:mid], frames, grid=3, mosaic_idx=0)
        mosaics.append(mosaic_a)
        tile_map.extend(tiles_a)
        mosaic_b, tiles_b = _build_single_mosaic(camera_ids[mid:], frames, grid=3, mosaic_idx=1)
        mosaics.append(mosaic_b)
        tile_map.extend(tiles_b)

    return mosaics, tile_map


def remap_detections(
    yolo_results: list[list],
    tile_map: list[TileInfo],
) -> dict[str, list]:
    """Remap YOLO detections from mosaic coordinates to per-camera original coordinates.

    Handles mixed grid sizes (2x2 and 3x3) using the grid info stored in TileInfo.
    When a camera appears in both a 3x3 and a 2x2 mosaic (motion re-scan),
    detections from both are merged — the 2x2 pass may catch things the 3x3 missed.

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
        # Determine grid size and mosaic resolution from any tile in this mosaic
        mosaic_grid = 3
        mosaic_size = MOSAIC_SIZE_3x3
        for info in tile_map:
            if info.mosaic_idx == mosaic_idx:
                mosaic_grid = info.grid
                mosaic_size = info.mosaic_size
                break

        tile_size = mosaic_size // mosaic_grid

        for det in detections:
            x1, y1, x2, y2 = det.bbox

            # Determine which tile this detection belongs to (by bbox center)
            cx = (x1 + x2) / 2
            cy = (y1 + y2) / 2
            col = min(int(cx // tile_size), mosaic_grid - 1)
            row = min(int(cy // tile_size), mosaic_grid - 1)

            info = tile_lookup.get((mosaic_idx, row, col))
            if info is None:
                continue  # empty tile slot

            # Convert mosaic coords -> tile-local coords
            local_x1 = x1 - col * tile_size
            local_y1 = y1 - row * tile_size
            local_x2 = x2 - col * tile_size
            local_y2 = y2 - row * tile_size

            # Clamp to tile bounds
            local_x1 = max(0.0, min(local_x1, tile_size))
            local_y1 = max(0.0, min(local_y1, tile_size))
            local_x2 = max(0.0, min(local_x2, tile_size))
            local_y2 = max(0.0, min(local_y2, tile_size))

            # Skip tiny fragments (bbox spanning tile border)
            if (local_x2 - local_x1) < 4 or (local_y2 - local_y1) < 4:
                continue

            # Undo letterbox: subtract offset, scale to original frame coords
            if info.lb_w > 0 and info.lb_h > 0:
                # Remove letterbox padding offset
                local_x1 = local_x1 - info.lb_x_off
                local_y1 = local_y1 - info.lb_y_off
                local_x2 = local_x2 - info.lb_x_off
                local_y2 = local_y2 - info.lb_y_off
                # Scale from letterbox content size to original frame size
                sx = info.orig_w / info.lb_w
                sy = info.orig_h / info.lb_h
            else:
                # Fallback (no letterbox info — old behavior)
                sx = info.orig_w / tile_size
                sy = info.orig_h / tile_size

            # Clamp after letterbox adjustment
            local_x1 = max(0.0, local_x1)
            local_y1 = max(0.0, local_y1)
            local_x2 = max(0.0, local_x2)
            local_y2 = max(0.0, local_y2)

            remapped = Detection(
                bbox=(local_x1 * sx, local_y1 * sy, local_x2 * sx, local_y2 * sy),
                label=det.label,
                confidence=det.confidence,
                class_id=det.class_id,
            )

            cam_detections.setdefault(info.camera_id, []).append(remapped)

    return cam_detections
