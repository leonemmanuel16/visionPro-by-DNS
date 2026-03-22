"""Face Recognition — Detect faces, compute embeddings, compare with DB."""

import time
from dataclasses import dataclass

import asyncpg
import numpy as np
import structlog

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

    def __init__(self, db_pool: asyncpg.Pool):
        self.db = db_pool
        self._fr = None  # lazy import face_recognition
        self._known_cache: list[tuple[str, str, np.ndarray]] = []  # (person_id, name, embedding)
        self._cache_time: float = 0
        self._cache_ttl: float = 60.0  # refresh cache every 60s
        self._available = False
        self._init_library()

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

        # Convert BGR to RGB for face_recognition
        rgb_crop = person_crop[:, :, ::-1]

        # Detect faces in the crop
        try:
            face_locations = self._fr.face_locations(rgb_crop, model="hog")
            if not face_locations:
                return None

            face_encodings = self._fr.face_encodings(rgb_crop, face_locations)
            return face_locations, face_encodings

        except Exception as e:
            log.debug("face_recognizer.detect_error", error=str(e))
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

    async def save_unknown_face(
        self, encoding: np.ndarray, thumbnail_path: str, camera_id: str
    ) -> None:
        """Save an unknown face to the DB for later identification."""
        try:
            emb_str = "[" + ",".join(f"{v:.6f}" for v in encoding) + "]"
            async with self.db.acquire() as conn:
                # Check if similar unknown face already exists (distance < 0.5)
                existing = await conn.fetchval("""
                    SELECT id FROM unknown_faces
                    WHERE embedding <-> $1::vector < 0.5
                    LIMIT 1
                """, emb_str)

                if existing:
                    # Update existing
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
                    """, emb_str, thumbnail_path, camera_id if camera_id else None)

            log.debug("face_recognizer.unknown_saved", camera_id=camera_id)
        except Exception as e:
            log.warning("face_recognizer.save_unknown_failed", error=str(e))
