"""Adaptive Mosaic Builder — Variable grid sizes for optimal YOLO inference.

Strategy based on active camera count:
  ≤4  cameras: 1x 2x2 @ 960  (1 inference,  480px/tile — max detail)
  5-8 cameras: 2x 2x2 @ 960  (2 inferences, 480px/tile)
  9+  cameras: Nx 3x3 @ 640  (N inferences, 213px/tile — fast coverage)
              + 1x 2x2 @ 960 for cameras with recent motion (hi-res re-scan)

The 2x2 mosaics use 960x960 (each tile = 480px) for maximum detail on
faces, plates, and small objects. The 3x3 mosaics stay at 640x640 for speed.
"""

from dataclasses import dataclass

import cv2
import numpy as np

MOSAIC_SIZE_3x3 = 640   # 3x3 grid: 213px per tile (fast coverage)
MOSAIC_SIZE_2x2 = 960   # 2x2 grid: 480px per tile (hi-res detail)


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

        tile = cv2.resize(frame, (tile_size, tile_size), interpolation=cv2.INTER_LINEAR)

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

    if num_cams <= 8:
        # ── Use 2x2 mosaics only (320px per tile = best detail) ──
        cams_per_mosaic = 4
        for batch_start in range(0, num_cams, cams_per_mosaic):
            batch_ids = camera_ids[batch_start : batch_start + cams_per_mosaic]
            mosaic_idx = len(mosaics)
            mosaic, tiles = _build_single_mosaic(batch_ids, frames, grid=2, mosaic_idx=mosaic_idx)
            mosaics.append(mosaic)
            tile_map.extend(tiles)
    else:
        # ── Use 3x3 mosaics for full coverage (213px per tile) ──
        cams_per_mosaic = 9
        for batch_start in range(0, num_cams, cams_per_mosaic):
            batch_ids = camera_ids[batch_start : batch_start + cams_per_mosaic]
            mosaic_idx = len(mosaics)
            mosaic, tiles = _build_single_mosaic(batch_ids, frames, grid=3, mosaic_idx=mosaic_idx)
            mosaics.append(mosaic)
            tile_map.extend(tiles)

        # ── Extra 2x2 mosaic for cameras with motion (hi-res re-scan) ──
        if motion_cam_ids:
            # Pick up to 4 cameras that had detections, prioritizing motion
            motion_cams = [cid for cid in camera_ids if cid in motion_cam_ids]
            if len(motion_cams) > 4:
                motion_cams = motion_cams[:4]

            if motion_cams:
                mosaic_idx = len(mosaics)
                mosaic, tiles = _build_single_mosaic(
                    motion_cams, frames, grid=2, mosaic_idx=mosaic_idx,
                )
                mosaics.append(mosaic)
                tile_map.extend(tiles)

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

            # Scale tile coords -> original frame coords
            sx = info.orig_w / tile_size
            sy = info.orig_h / tile_size

            remapped = Detection(
                bbox=(local_x1 * sx, local_y1 * sy, local_x2 * sx, local_y2 * sy),
                label=det.label,
                confidence=det.confidence,
                class_id=det.class_id,
            )

            cam_detections.setdefault(info.camera_id, []).append(remapped)

    return cam_detections
