"""Face Recognition — Detect faces, compute embeddings, compare with DB."""

import io
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

import asyncpg
import cv2
import numpy as np
import structlog
from minio import Minio

log = structlog.get_logger()

# Threshold for face match (lower = stricter)
# 0.6 = too permissive (confuses different people)
# 0.45 = strict (fewer false positives, may miss some matches)
FACE_MATCH_THRESHOLD = 0.45


@dataclass
class FaceMatch:
    person_id: str
    person_name: str
    distance: float  # lower = better match
    confidence: float  # 1 - distance


class FaceRecognizer:
    """Recognizes faces by comparing face_recognition embeddings against pgvector DB."""

    def __init__(self, db_pool: asyncpg.Pool, minio_client: Minio | None = None):
        self.db = db_pool
        self.minio = minio_client
        self._fr = None  # lazy import face_recognition
        self._known_cache: list[tuple[str, str, np.ndarray]] = []  # (person_id, name, embedding)
        self._cache_time: float = 0
        self._cache_ttl: float = 60.0  # refresh cache every 60s
        self._available = False
        self._recent_saves: list[tuple[np.ndarray, float]] = []  # [(embedding, timestamp)] for short-term dedup
        self._recent_save_ttl: float = 10.0  # seconds to keep recent saves in memory
        self._init_library()
        self._ensure_bucket()

    def _init_library(self):
        """Try to import face_recognition. If not available, face recognition is disabled."""
        try:
            import face_recognition
            self._fr = face_recognition
            self._available = True
            log.info("face_recognizer.ready", library="face_recognition")
        except ImportError:
            log.warning("face_recognizer.disabled", reason="face_recognition library not installed")
            self._available = False

    def _ensure_bucket(self):
        """Ensure the 'faces' bucket exists in MinIO."""
        if self.minio:
            try:
                if not self.minio.bucket_exists("faces"):
                    self.minio.make_bucket("faces")
            except Exception as e:
                log.warning("face_recognizer.bucket_error", error=str(e))

    @property
    def available(self) -> bool:
        return self._available

    async def _refresh_cache(self):
        """Load known face embeddings from DB into memory."""
        now = time.monotonic()
        if now - self._cache_time < self._cache_ttl:
            return

        try:
            async with self.db.acquire() as conn:
                rows = await conn.fetch("""
                    SELECT fe.embedding::text, p.id, p.name
                    FROM face_embeddings fe
                    JOIN persons p ON p.id = fe.person_id
                    WHERE p.is_active = true
                """)

            cache = []
            for row in rows:
                try:
                    # Parse pgvector text format "[0.1,0.2,...]" to numpy array
                    emb_str = row["embedding"]
                    emb_array = np.fromstring(emb_str.strip("[]"), sep=",", dtype=np.float64)
                    if len(emb_array) == 128:
                        cache.append((str(row["id"]), row["name"], emb_array))
                except Exception as e:
                    log.warning("face_recognizer.parse_embedding_error", error=str(e))

            self._known_cache = cache
            self._cache_time = now
            log.debug("face_recognizer.cache_refreshed", known_faces=len(cache))

        except Exception as e:
            log.warning("face_recognizer.cache_refresh_failed", error=str(e))

    def detect_and_encode(self, frame: np.ndarray, person_bbox: tuple) -> tuple[list, list] | None:
        """Detect faces within a person bounding box and return encodings.

        Strategy:
        1. For large person bboxes (>200px wide): crop upper half + upscale, use HOG
        2. For small bboxes: run face detection on a wide region of the original
           frame (no upscaling) to preserve native resolution, then use CNN model
           for better small-face detection

        Args:
            frame: Full BGR frame from camera
            person_bbox: (x1, y1, x2, y2) of the detected person

        Returns:
            (face_locations, face_encodings) or None if no face found
        """
        if not self._available:
            return None

        x1, y1, x2, y2 = [int(c) for c in person_bbox]
        h, w = frame.shape[:2]
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w, x2), min(h, y2)

        if x2 <= x1 or y2 <= y1:
            return None

        person_w = x2 - x1
        person_h = y2 - y1

        if person_w >= 200:
            # Large bbox: original crop strategy works fine
            return self._detect_face_crop(frame, x1, y1, x2, y2, h, w)
        else:
            # Small bbox: use wide native-resolution region
            return self._detect_face_wide(frame, x1, y1, x2, y2, h, w, person_w, person_h)

    def _detect_face_crop(self, frame, x1, y1, x2, y2, h, w):
        """Face detection for large person bboxes using upper-half crop."""
        person_h = y2 - y1
        head_y2 = y1 + int(person_h * 0.5)
        head_crop = frame[y1:head_y2, x1:x2]

        crop_h, crop_w = head_crop.shape[:2]
        if crop_h < 10 or crop_w < 10:
            return None

        if crop_w < 300:
            scale = 300 / crop_w
            head_crop = cv2.resize(head_crop, (int(crop_w * scale), int(crop_h * scale)), interpolation=cv2.INTER_CUBIC)

        rgb_crop = np.ascontiguousarray(head_crop[:, :, ::-1])

        try:
            face_locations = self._fr.face_locations(rgb_crop, number_of_times_to_upsample=1, model="hog")
            if not face_locations:
                return None

            # Validate face size: reject faces that are too small or have
            # unrealistic proportions (likely false positives)
            valid_faces = []
            for (top, right, bottom, left) in face_locations:
                fw = right - left
                fh = bottom - top
                aspect = fh / fw if fw > 0 else 0
                if fw >= 30 and fh >= 30 and 0.8 < aspect < 2.0:
                    valid_faces.append((top, right, bottom, left))
                else:
                    log.debug("face_recognizer.face_rejected", size=f"{fw}x{fh}", aspect=f"{aspect:.2f}")

            if not valid_faces:
                return None

            face_encodings = self._fr.face_encodings(rgb_crop, known_face_locations=valid_faces)
            if not face_encodings:
                return None
            log.info("face_recognizer.face_detected", faces=len(valid_faces), method="crop")
            return valid_faces, face_encodings
        except Exception as e:
            log.warning("face_recognizer.detect_error", error=str(e))
            return None

    def _detect_face_wide(self, frame, x1, y1, x2, y2, h, w, person_w, person_h):
        """Face detection for small person bboxes using a wide native-res region.

        Instead of upscaling a tiny crop (which blurs the face), we take a large
        region of the original frame centered on the person. This preserves the
        native camera resolution and gives the face detector more context.
        """
        # Take a region 4x wider and 2x taller than the person bbox (capped at frame)
        cx = (x1 + x2) // 2
        cy = y1 + int(person_h * 0.3)  # bias toward head
        region_w = max(person_w * 4, 400)
        region_h = max(person_h * 2, 300)

        rx1 = max(0, cx - region_w // 2)
        rx2 = min(w, cx + region_w // 2)
        ry1 = max(0, cy - region_h // 2)
        ry2 = min(h, cy + region_h // 2)

        region = frame[ry1:ry2, rx1:rx2]
        region_h_actual, region_w_actual = region.shape[:2]
        if region_h_actual < 20 or region_w_actual < 20:
            return None

        rgb_region = np.ascontiguousarray(region[:, :, ::-1])

        try:
            # Use CNN model for better small-face detection (uses GPU if available)
            try:
                face_locations = self._fr.face_locations(rgb_region, number_of_times_to_upsample=1, model="cnn")
            except Exception:
                # CNN not available (no GPU dlib), fall back to HOG with more upsamples
                face_locations = self._fr.face_locations(rgb_region, number_of_times_to_upsample=2, model="hog")

            if not face_locations:
                log.debug("face_recognizer.no_face_in_region",
                          region_size=f"{region_w_actual}x{region_h_actual}",
                          person_size=f"{person_w}x{person_h}")
                return None

            # Filter: only keep faces that overlap with the person bbox
            # Convert person bbox to region-relative coordinates
            rel_x1 = x1 - rx1
            rel_y1 = y1 - ry1
            rel_x2 = x2 - rx1
            rel_y2 = y2 - ry1

            matched_faces = []
            for (top, right, bottom, left) in face_locations:
                face_cx = (left + right) // 2
                face_cy = (top + bottom) // 2
                # Check if face center is within or near the person bbox
                if (rel_x1 - 20 <= face_cx <= rel_x2 + 20 and
                        rel_y1 - 20 <= face_cy <= rel_y2 + 20):
                    matched_faces.append((top, right, bottom, left))

            if not matched_faces:
                log.debug("face_recognizer.face_outside_bbox", faces_found=len(face_locations))
                return None

            face_encodings = self._fr.face_encodings(rgb_region, known_face_locations=matched_faces)
            if not face_encodings:
                return None

            log.info("face_recognizer.face_detected", faces=len(matched_faces),
                     method="wide_region", region_size=f"{region_w_actual}x{region_h_actual}")
            return matched_faces, face_encodings

        except Exception as e:
            log.warning("face_recognizer.detect_error", error=str(e))
            return None

    async def recognize(self, frame: np.ndarray, person_bbox: tuple) -> FaceMatch | None:
        """Detect face in person crop, compare with known faces.

        Returns FaceMatch if known person found, None otherwise.
        """
        if not self._available:
            return None

        await self._refresh_cache()

        if not self._known_cache:
            return None

        result = self.detect_and_encode(frame, person_bbox)
        if not result:
            return None

        face_locations, face_encodings = result

        # Compare each detected face against known faces
        for encoding in face_encodings:
            best_match = None
            best_distance = FACE_MATCH_THRESHOLD

            for person_id, name, known_encoding in self._known_cache:
                # Compute euclidean distance
                distance = np.linalg.norm(encoding - known_encoding)

                if distance < best_distance:
                    best_distance = distance
                    best_match = FaceMatch(
                        person_id=person_id,
                        person_name=name,
                        distance=distance,
                        confidence=max(0, 1.0 - distance),
                    )

            if best_match:
                log.info(
                    "face_recognizer.match",
                    person=best_match.person_name,
                    distance=f"{best_match.distance:.3f}",
                    confidence=f"{best_match.confidence:.1%}",
                )
                return best_match

        return None

    async def get_encoding(self, frame: np.ndarray) -> np.ndarray | None:
        """Get face encoding from a photo (for registration)."""
        if not self._available:
            return None

        rgb = frame[:, :, ::-1]
        try:
            locations = self._fr.face_locations(rgb, model="hog")
            if not locations:
                return None
            encodings = self._fr.face_encodings(rgb, locations)
            return encodings[0] if encodings else None
        except Exception as e:
            log.warning("face_recognizer.encoding_error", error=str(e))
            return None

    def _save_face_thumbnail(
        self, frame: np.ndarray, person_bbox: tuple, face_location: tuple | None = None
    ) -> str | None:
        """Crop and save face thumbnail to MinIO.  Returns object path or None."""
        if not self.minio:
            return None
        try:
            x1, y1, x2, y2 = [int(c) for c in person_bbox]
            h, w = frame.shape[:2]
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(w, x2), min(h, y2)

            if face_location:
                # face_location is (top, right, bottom, left) WITHIN the crop
                ft, fr, fb, fl = face_location
                # Add padding around face (30%)
                fh = fb - ft
                fw = fr - fl
                pad_h = int(fh * 0.3)
                pad_w = int(fw * 0.3)
                crop = frame[
                    max(0, y1 + ft - pad_h): min(h, y1 + fb + pad_h),
                    max(0, x1 + fl - pad_w): min(w, x1 + fr + pad_w),
                ]
            else:
                # Use upper 40% of person bbox (head area)
                head_h = int((y2 - y1) * 0.4)
                crop = frame[y1: y1 + head_h, x1: x2]

            if crop.size == 0:
                return None

            # Resize to 150x150 for consistent thumbnails
            crop = cv2.resize(crop, (150, 150))

            _, buffer = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 85])
            data = buffer.tobytes()

            now = datetime.now(timezone.utc)
            object_name = f"unknown/{now.strftime('%Y%m%d')}/{uuid.uuid4().hex[:12]}.jpg"
            self.minio.put_object(
                "faces", object_name, io.BytesIO(data), len(data),
                content_type="image/jpeg",
            )
            return f"faces/{object_name}"
        except Exception as e:
            log.warning("face_recognizer.save_thumbnail_failed", error=str(e))
            return None

    async def save_unknown_face(
        self,
        encoding: np.ndarray,
        camera_id: str,
        frame: np.ndarray | None = None,
        person_bbox: tuple | None = None,
        face_location: tuple | None = None,
    ) -> None:
        """Save an unknown face to the DB for later identification.

        Now also saves a cropped face thumbnail to MinIO.
        Includes cooldown per camera to avoid flooding with saves.
        """
        try:
            # Short-term dedup: skip if we just saved a very similar face recently
            now = time.monotonic()
            # Clean expired entries
            self._recent_saves = [(emb, t) for emb, t in self._recent_saves if now - t < self._recent_save_ttl]
            # Check if this encoding was recently saved
            for saved_emb, saved_time in self._recent_saves:
                dist = np.linalg.norm(encoding - saved_emb)
                if dist < 0.5:
                    log.debug("face_recognizer.save_debounced", distance=f"{dist:.3f}")
                    return

            # Save thumbnail image
            thumbnail_path = ""
            if frame is not None and person_bbox is not None:
                path = self._save_face_thumbnail(frame, person_bbox, face_location)
                if path:
                    thumbnail_path = path

            emb_str = "[" + ",".join(f"{v:.6f}" for v in encoding) + "]"
            async with self.db.acquire() as conn:
                # Check if this face was already dismissed/deleted by user
                dismissed = await conn.fetchval("""
                    SELECT id FROM dismissed_faces
                    WHERE embedding <-> $1::vector < 0.55
                    LIMIT 1
                """, emb_str)
                if dismissed:
                    log.debug("face_recognizer.dismissed_face_skipped", camera_id=camera_id)
                    return

                # Check if already assigned to a known person
                known = await conn.fetchval("""
                    SELECT id FROM face_embeddings
                    WHERE embedding <-> $1::vector < 0.55
                    LIMIT 1
                """, emb_str)
                if known:
                    log.debug("face_recognizer.known_face_skipped", camera_id=camera_id)
                    return

                # Check if similar unknown face already exists (distance < 0.65)
                existing = await conn.fetchval("""
                    SELECT id FROM unknown_faces
                    WHERE embedding <-> $1::vector < 0.55
                    LIMIT 1
                """, emb_str)

                if existing:
                    # Update existing — also update thumbnail if we have a better one
                    if thumbnail_path:
                        await conn.execute("""
                            UPDATE unknown_faces
                            SET last_seen = NOW(), detection_count = detection_count + 1,
                                thumbnail_path = COALESCE(NULLIF($2, ''), thumbnail_path)
                            WHERE id = $1
                        """, existing, thumbnail_path)
                    else:
                        await conn.execute("""
                            UPDATE unknown_faces
                            SET last_seen = NOW(), detection_count = detection_count + 1
                            WHERE id = $1
                        """, existing)
                else:
                    # Insert new
                    await conn.execute("""
                        INSERT INTO unknown_faces (embedding, thumbnail_path, camera_id)
                        VALUES ($1::vector, $2, $3)
                    """, emb_str, thumbnail_path, uuid.UUID(camera_id) if camera_id else None)

            self._recent_saves.append((encoding, now))
            log.info("face_recognizer.unknown_saved", camera_id=camera_id, thumbnail=thumbnail_path, is_new=not existing)
        except Exception as e:
            log.warning("face_recognizer.save_unknown_failed", error=str(e))
