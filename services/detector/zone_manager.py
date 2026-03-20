"""Zone Manager - Virtual zone/perimeter filtering."""

from typing import Any

import asyncpg
import numpy as np
import structlog

from tracker import TrackedDetection

log = structlog.get_logger()


class ZoneManager:
    """Manages virtual zones and filters detections."""

    def __init__(self, db_pool: asyncpg.Pool):
        self.db = db_pool
        self._zone_cache: dict[str, list[dict]] = {}

    async def get_zones(self, camera_id: str) -> list[dict]:
        """Get zones for a camera from DB (with caching)."""
        if camera_id in self._zone_cache:
            return self._zone_cache[camera_id]

        async with self.db.acquire() as conn:
            rows = await conn.fetch(
                """SELECT id, name, zone_type, points, direction, detect_classes, is_enabled
                   FROM zones WHERE camera_id = $1 AND is_enabled = true""",
                camera_id,
            )
            zones = [dict(row) for row in rows]
            self._zone_cache[camera_id] = zones
            return zones

    async def refresh_zones(self, camera_id: str) -> list[dict]:
        """Force refresh zones from DB."""
        if camera_id in self._zone_cache:
            del self._zone_cache[camera_id]
        return await self.get_zones(camera_id)

    def filter_detections(
        self,
        detections: list[TrackedDetection],
        zones: list[dict],
    ) -> list[TrackedDetection]:
        """Filter detections based on zone configuration.

        If no zones defined, all detections pass through.
        """
        if not zones:
            return detections

        filtered = []
        for det in detections:
            for zone in zones:
                if not zone.get("is_enabled", True):
                    continue

                # Check if detection class is in zone's detect_classes
                detect_classes = zone.get("detect_classes", ["person", "vehicle"])
                if detect_classes and det.label not in detect_classes:
                    continue

                zone_type = zone.get("zone_type", "roi")

                if zone_type == "roi":
                    if self._point_in_polygon(det, zone):
                        det.metadata = {"zone_id": str(zone["id"]), "zone_name": zone["name"]}
                        filtered.append(det)
                        break
                elif zone_type == "tripwire":
                    # Simplified: check if center point is near the line
                    if self._near_tripwire(det, zone):
                        det.metadata = {"zone_id": str(zone["id"]), "zone_name": zone["name"]}
                        filtered.append(det)
                        break
                elif zone_type == "perimeter":
                    if self._point_in_polygon(det, zone):
                        det.metadata = {"zone_id": str(zone["id"]), "zone_name": zone["name"]}
                        filtered.append(det)
                        break

        return filtered

    @staticmethod
    def _get_center(det: TrackedDetection) -> tuple[float, float]:
        """Get center point of detection bounding box (normalized 0-1)."""
        x1, y1, x2, y2 = det.bbox
        return ((x1 + x2) / 2, (y1 + y2) / 2)

    def _point_in_polygon(self, det: TrackedDetection, zone: dict) -> bool:
        """Check if detection center is inside a polygon zone."""
        points = zone.get("points", [])
        if len(points) < 3:
            return False

        cx, cy = self._get_center(det)

        # Ray casting algorithm
        polygon = [(p.get("x", 0), p.get("y", 0)) for p in points]
        n = len(polygon)
        inside = False

        j = n - 1
        for i in range(n):
            xi, yi = polygon[i]
            xj, yj = polygon[j]

            if ((yi > cy) != (yj > cy)) and (cx < (xj - xi) * (cy - yi) / (yj - yi) + xi):
                inside = not inside
            j = i

        return inside

    def _near_tripwire(self, det: TrackedDetection, zone: dict) -> bool:
        """Check if detection is near a tripwire line."""
        points = zone.get("points", [])
        if len(points) < 2:
            return False

        cx, cy = self._get_center(det)
        x1, y1 = points[0].get("x", 0), points[0].get("y", 0)
        x2, y2 = points[1].get("x", 0), points[1].get("y", 0)

        # Distance from point to line segment
        line_len_sq = (x2 - x1) ** 2 + (y2 - y1) ** 2
        if line_len_sq == 0:
            return False

        t = max(0, min(1, ((cx - x1) * (x2 - x1) + (cy - y1) * (y2 - y1)) / line_len_sq))
        proj_x = x1 + t * (x2 - x1)
        proj_y = y1 + t * (y2 - y1)
        dist = ((cx - proj_x) ** 2 + (cy - proj_y) ** 2) ** 0.5

        # Threshold: 5% of frame dimension
        return dist < 0.05
