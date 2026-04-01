"""Face Recognition — InsightFace (ONNX + GPU) for detection, embedding, and comparison.

Replaces dlib/face_recognition with InsightFace which:
- Uses ONNX Runtime with CUDA for GPU-accelerated inference
- Produces 512-dim embeddings (more discriminative than dlib's 128-dim)
- Uses cosine similarity instead of euclidean distance
- Has better accuracy for surveillance (ArcFace model)

DB MIGRATION REQUIRED:
  ALTER TABLE face_embeddings ALTER COLUMN embedding TYPE vector(512);
  ALTER TABLE unknown_faces ALTER COLUMN embedding TYPE vector(512);
  ALTER TABLE dismissed_faces ALTER COLUMN embedding TYPE vector(512);
  -- Then re-generate all existing embeddings (old 128-dim won't work with new 512-dim)
"""

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

# Cosine similarity threshold for face match (higher = stricter)
# InsightFace embeddings are normalized, so cosine similarity ranges [0, 1]
# 0.35 = good balance for surveillance: catches matches without excessive false positives
# 0.25 = too permissive (confuses different people)
# 0.45 = too strict (misses valid matches with angle/lighting variation)
FACE_MATCH_THRESHOLD = 0.35

# Embedding dimension for InsightFace (buffalo_l model)
EMBEDDING_DIM = 512


@dataclass
class FaceMatch:
    person_id: str
    person_name: str
    distance: float  # cosine similarity (higher = better match)
    confidence: float  # same as distance for cosine similarity


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two vectors. Returns value in [-1, 1]."""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


class FaceRecognizer:
    """Recognizes faces using InsightFace (ONNX + GPU) with pgvector DB."""

    def __init__(self, db_pool: asyncpg.Pool, minio_client: Minio | None = None):
        self.db = db_pool
        self.minio = minio_client
        self._app = None  # InsightFace FaceAnalysis app
        self._known_cache: list[tuple[str, str, np.ndarray]] = []  # (person_id, name, embedding)
        self._cache_time: float = 0
        self._cache_ttl: float = 60.0  # refresh cache every 60s
        self._available = False
        self._recent_saves: list[tuple[np.ndarray, float]] = []  # [(embedding, timestamp)]
        self._recent_save_ttl: float = 10.0  # seconds to keep recent saves in memory
        self._init_library()
        self._ensure_bucket()

    def _init_library(self):
        """Try to import and initialize InsightFace. Falls back gracefully."""
        try:
            from insightface.app import FaceAnalysis
            self._app = FaceAnalysis(
                name="buffalo_l",
                providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
            )
            self._app.prepare(ctx_id=0, det_size=(640, 640))
            self._available = True
            log.info("face_recognizer.ready", library="insightface", model="buffalo_l",
                     embedding_dim=EMBEDDING_DIM)
        except ImportError:
            log.warning("face_recognizer.disabled", reason="insightface library not installed")
            self._available = False
        except Exception as e:
            log.warning("face_recognizer.init_failed", error=str(e))
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
                    emb_str = row["embedding"]
                    emb_array = np.fromstring(emb_str.strip("[]"), sep=",", dtype=np.float64)
                    if len(emb_array) == EMBEDDING_DIM:
                        cache.append((str(row["id"]), row["name"], emb_array))
                    elif len(emb_array) == 128:
                        # Legacy dlib embeddings — skip with warning
                        log.warning("face_recognizer.legacy_embedding",
                                    person_id=str(row["id"]),
                                    msg="128-dim embedding found, needs re-generation with InsightFace")
                except Exception as e:
                    log.warning("face_recognizer.parse_embedding_error", error=str(e))

            self._known_cache = cache
            self._cache_time = now
            log.debug("face_recognizer.cache_refreshed", known_faces=len(cache))

        except Exception as e:
            log.warning("face_recognizer.cache_refresh_failed", error=str(e))

    def detect_and_encode(self, frame: np.ndarray, person_bbox: tuple) -> tuple[list, list] | None:
        """Detect faces within a person bounding box and return embeddings.

        Uses InsightFace which does detection + alignment + embedding in one call.

        Args:
            frame: Full BGR frame from camera
            person_bbox: (x1, y1, x2, y2) of the detected person

        Returns:
            (face_bboxes, face_embeddings) or None if no face found
            face_bboxes: list of (top, right, bottom, left) tuples (dlib-compatible format)
            face_embeddings: list of 512-dim numpy arrays
        """
        if not self._available or self._app is None:
            return None

        x1, y1, x2, y2 = [int(c) for c in person_bbox]
        h, w = frame.shape[:2]
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w, x2), min(h, y2)

        if x2 <= x1 or y2 <= y1:
            return None

        person_w = x2 - x1
        person_h = y2 - y1

        # Crop upper 60% of person (head + torso area)
        head_y2 = y1 + int(person_h * 0.6)
        crop = frame[y1:head_y2, x1:x2]

        crop_h, crop_w = crop.shape[:2]
        if crop_h < 20 or crop_w < 20:
            return None

        # Upscale small crops for better detection
        if crop_w < 200:
            scale = 200 / crop_w
            crop = cv2.resize(crop, (int(crop_w * scale), int(crop_h * scale)),
                              interpolation=cv2.INTER_CUBIC)

        try:
            # InsightFace expects BGR (same as OpenCV) — no conversion needed
            faces = self._app.get(crop)

            if not faces:
                return None

            face_bboxes = []
            face_embeddings = []

            for face in faces:
                # Validate face size
                fb = face.bbox  # [x1, y1, x2, y2]
                fw = fb[2] - fb[0]
                fh = fb[3] - fb[1]
                if fw < 20 or fh < 20:
                    continue

                # Convert to (top, right, bottom, left) format for compatibility
                face_loc = (int(fb[1]), int(fb[2]), int(fb[3]), int(fb[0]))
                face_bboxes.append(face_loc)
                face_embeddings.append(face.embedding)

            if not face_bboxes:
                return None

            log.info("face_recognizer.face_detected", faces=len(face_bboxes),
                     method="insightface")
            return face_bboxes, face_embeddings

        except Exception as e:
            log.warning("face_recognizer.detect_error", error=str(e))
            return None

    async def recognize(self, frame: np.ndarray, person_bbox: tuple) -> FaceMatch | None:
        """Detect face in person crop, compare with known faces using cosine similarity.

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

        # Compare each detected face against known faces using cosine similarity
        for encoding in face_encodings:
            # Collect best similarities per person
            person_scores: dict[str, list[float]] = {}
            person_names: dict[str, str] = {}

            for person_id, name, known_encoding in self._known_cache:
                similarity = _cosine_similarity(encoding, known_encoding)
                person_names[person_id] = name
                if person_id not in person_scores:
                    person_scores[person_id] = []
                if similarity >= FACE_MATCH_THRESHOLD:
                    person_scores[person_id].append(similarity)

            # Find best candidate: most votes, then highest avg similarity
            best_match = None
            best_score = (0, 0.0)  # (vote_count, avg_similarity)

            for person_id, similarities in person_scores.items():
                if not similarities:
                    continue
                vote_count = len(similarities)
                avg_sim = sum(similarities) / len(similarities)

                if (vote_count, avg_sim) > best_score:
                    best_score = (vote_count, avg_sim)
                    best_match = FaceMatch(
                        person_id=person_id,
                        person_name=person_names[person_id],
                        distance=avg_sim,  # cosine similarity (higher = better)
                        confidence=avg_sim,
                    )

            if best_match:
                log.info(
                    "face_recognizer.match",
                    person=best_match.person_name,
                    similarity=f"{best_match.distance:.3f}",
                    confidence=f"{best_match.confidence:.1%}",
                    votes=best_score[0],
                )
                return best_match

        return None

    async def get_encoding(self, frame: np.ndarray) -> np.ndarray | None:
        """Get face encoding from a photo (for registration)."""
        if not self._available or self._app is None:
            return None

        try:
            # InsightFace expects BGR
            faces = self._app.get(frame)
            if not faces:
                return None
            # Return the first (largest) face embedding
            return faces[0].embedding
        except Exception as e:
            log.warning("face_recognizer.encoding_error", error=str(e))
            return None

    def _save_face_thumbnail(
        self, frame: np.ndarray, person_bbox: tuple, face_location: tuple | None = None
    ) -> str | None:
        """Crop and save face thumbnail to MinIO. Returns object path or None."""
        if not self.minio:
            return None
        try:
            x1, y1, x2, y2 = [int(c) for c in person_bbox]
            h, w = frame.shape[:2]
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(w, x2), min(h, y2)

            if face_location:
                # face_location is (top, right, bottom, left)
                ft, fr, fb, fl = face_location
                face_h = fb - ft
                face_w = fr - fl
                if face_h < 30 or face_w < 30:
                    log.debug("face_recognizer.face_too_small", face_h=face_h, face_w=face_w)
                    return None
                pad_h = int(face_h * 0.5)
                pad_w = int(face_w * 0.5)
                crop = frame[
                    max(0, y1 + ft - pad_h): min(h, y1 + fb + pad_h),
                    max(0, x1 + fl - pad_w): min(w, x1 + fr + pad_w),
                ]
            else:
                head_h = int((y2 - y1) * 0.4)
                crop = frame[y1: y1 + head_h, x1: x2]

            if crop.size == 0:
                return None

            crop = cv2.resize(crop, (150, 150))

            _, buffer = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 85])
            data = buffer.tobytes()

            now = datetime.now(timezone.utc)
            file_id = uuid.uuid4().hex[:12]
            object_name = f"unknown/{now.strftime('%Y%m%d')}/{file_id}.jpg"
            self.minio.put_object(
                "faces", object_name, io.BytesIO(data), len(data),
                content_type="image/jpeg",
            )

            # Also save full snapshot for context
            try:
                _, full_buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
                full_data = full_buf.tobytes()
                full_name = f"unknown/{now.strftime('%Y%m%d')}/{file_id}_full.jpg"
                self.minio.put_object(
                    "faces", full_name, io.BytesIO(full_data), len(full_data),
                    content_type="image/jpeg",
                )
            except Exception:
                pass

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

        Saves a cropped face thumbnail to MinIO.
        Includes cooldown per camera to avoid flooding with saves.
        """
        try:
            # Short-term dedup: skip if we just saved a very similar face recently
            now = time.monotonic()
            self._recent_saves = [(emb, t) for emb, t in self._recent_saves if now - t < self._recent_save_ttl]
            for saved_emb, saved_time in self._recent_saves:
                sim = _cosine_similarity(encoding, saved_emb)
                if sim > 0.5:  # very similar face
                    log.debug("face_recognizer.save_debounced", similarity=f"{sim:.3f}")
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
                # <=> is cosine distance (0 = identical, 2 = opposite)
                dismissed = await conn.fetchval("""
                    SELECT id FROM dismissed_faces
                    WHERE embedding <=> $1::vector < 0.65
                    LIMIT 1
                """, emb_str)
                if dismissed:
                    log.debug("face_recognizer.dismissed_face_skipped", camera_id=camera_id)
                    return

                # Check if already assigned to a known person
                # <=> is cosine distance (0 = identical, 2 = opposite)
                known = await conn.fetchval("""
                    SELECT id FROM face_embeddings
                    WHERE embedding <=> $1::vector < 0.65
                    LIMIT 1
                """, emb_str)
                if known:
                    log.debug("face_recognizer.known_face_skipped", camera_id=camera_id)
                    return

                # Check if similar unknown face already exists
                # <=> is cosine distance — tighter threshold to group unknowns
                existing = await conn.fetchval("""
                    SELECT id FROM unknown_faces
                    WHERE embedding <=> $1::vector < 0.60
                    LIMIT 1
                """, emb_str)

                if existing:
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
                    await conn.execute("""
                        INSERT INTO unknown_faces (embedding, thumbnail_path, camera_id)
                        VALUES ($1::vector, $2, $3)
                    """, emb_str, thumbnail_path, uuid.UUID(camera_id) if camera_id else None)

            self._recent_saves.append((encoding, now))
            log.info("face_recognizer.unknown_saved", camera_id=camera_id,
                     thumbnail=thumbnail_path, is_new=not existing)
        except Exception as e:
            log.warning("face_recognizer.save_unknown_failed", error=str(e))
