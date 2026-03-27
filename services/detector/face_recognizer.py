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
FACE_MATCH_THRESHOLD = 0.6


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

        # Crop person region
        person_crop = frame[y1:y2, x1:x2]

        # Upscale small crops for better face detection
        crop_h, crop_w = person_crop.shape[:2]
        if crop_h < 200 or crop_w < 100:
            scale = max(200 / max(crop_h, 1), 100 / max(crop_w, 1))
            new_w = int(crop_w * scale)
            new_h = int(crop_h * scale)
            person_crop = cv2.resize(person_crop, (new_w, new_h), interpolation=cv2.INTER_CUBIC)
            log.debug("face_recognizer.upscaled", original=f"{crop_w}x{crop_h}", scaled=f"{new_w}x{new_h}")

        # Convert BGR to RGB for face_recognition
        rgb_crop = person_crop[:, :, ::-1]

        # Detect faces in the crop (upsample=2 for smaller faces)
        try:
            face_locations = self._fr.face_locations(rgb_crop, number_of_times_to_upsample=2, model="hog")
            if not face_locations:
                log.debug("face_recognizer.no_face_in_crop", crop_size=f"{person_crop.shape[1]}x{person_crop.shape[0]}")
                return None

            face_encodings = self._fr.face_encodings(rgb_crop, face_locations)
            log.debug("face_recognizer.face_detected", faces=len(face_locations), crop_size=f"{person_crop.shape[1]}x{person_crop.shape[0]}")
            return face_locations, face_encodings

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
        """
        try:
            # Save thumbnail image
            thumbnail_path = ""
            if frame is not None and person_bbox is not None:
                path = self._save_face_thumbnail(frame, person_bbox, face_location)
                if path:
                    thumbnail_path = path

            emb_str = "[" + ",".join(f"{v:.6f}" for v in encoding) + "]"
            async with self.db.acquire() as conn:
                # Check if similar unknown face already exists (distance < 0.5)
                existing = await conn.fetchval("""
                    SELECT id FROM unknown_faces
                    WHERE embedding <-> $1::vector < 0.5
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

            log.debug("face_recognizer.unknown_saved", camera_id=camera_id, thumbnail=thumbnail_path)
        except Exception as e:
            log.warning("face_recognizer.save_unknown_failed", error=str(e))
