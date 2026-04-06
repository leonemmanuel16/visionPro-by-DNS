"""DNS Vision AI - AI Detection Service (Mosaic Architecture)

Fetches frames from go2rtc sub-streams, builds 3x3 mosaics,
runs batched YOLO inference (2 mosaics = 18 cameras), remaps
detections back to per-camera coordinates, then runs tracking,
face recognition, and event publishing per camera.

Architecture:
- Single mosaic detection loop processes ALL cameras together
- go2rtc serves JPEG snapshots (no direct RTSP connections to NVR)
- 2 YOLO inferences per cycle (batch=2) instead of 18
- Per-camera ByteTrack, zones, attributes, face recognition
- 15 fps achievable on NVIDIA T1000 (30 fps capacity vs 30 fps demand)
"""

import asyncio
import json
import os
import signal
import time
import uuid as _uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import asyncpg
import numpy as np
import redis.asyncio as aioredis
import structlog

from detector import YOLODetector
from go2rtc_grabber import Go2rtcGrabber
from mosaic import build_mosaics, remap_detections
from tracker import ObjectTracker
from zone_manager import ZoneManager
from event_publisher import EventPublisher
from face_recognizer import FaceRecognizer
from person_attributes import extract_person_attributes
from vehicle_attributes import extract_vehicle_attributes
from best_shot import BestShotSelector
from ring_buffer import RingBuffer, create_clip, save_clip_to_minio
from event_validator import EventValidator
from processing_queue import ProcessingQueue, QueueItem

structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.add_log_level,
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.BoundLogger,
    context_class=dict,
    logger_factory=structlog.PrintLoggerFactory(),
)

log = structlog.get_logger()


class DetectorService:
    def __init__(self):
        self.redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
        self.postgres_url = os.environ.get(
            "POSTGRES_URL", "postgresql://vision:changeme@localhost:5432/visionai"
        )
        self.minio_endpoint = os.environ.get("MINIO_ENDPOINT", "localhost:9000")
        self.minio_access_key = os.environ.get("MINIO_ACCESS_KEY", "minioadmin")
        self.minio_secret_key = os.environ.get("MINIO_SECRET_KEY", "minioadmin")
        self.model_name = os.environ.get("MODEL_NAME", "yolo26s")
        self.detection_fps = int(os.environ.get("DETECTION_FPS", "15"))
        self.confidence_threshold = float(os.environ.get("CONFIDENCE_THRESHOLD", "0.05"))
        self.go2rtc_url = os.environ.get("GO2RTC_URL", "http://localhost:1984")
        self.device = os.environ.get("DEVICE", "auto")
        self.ring_buffer_seconds = int(os.environ.get("RING_BUFFER_SECONDS", "15"))

        self.db_pool: asyncpg.Pool | None = None
        self.redis: aioredis.Redis | None = None
        self.running = True
        self.thread_pool = ThreadPoolExecutor(max_workers=8)

        # Shared components
        self._detector: YOLODetector | None = None
        self._grabber: Go2rtcGrabber | None = None
        self._publisher: EventPublisher | None = None
        self._zone_manager: ZoneManager | None = None
        self._face_recognizer: FaceRecognizer | None = None
        self._event_validator: EventValidator | None = None
        self._processing_queue: ProcessingQueue | None = None

        # Per-camera state (managed by _sync_cameras)
        self.cam_streams: dict[str, str] = {}       # cam_id -> go2rtc sub-stream name
        self.cam_main_streams: dict[str, str] = {}  # cam_id -> go2rtc main-stream name (4MP)
        self.cam_names: dict[str, str] = {}          # cam_id -> display name
        self.cam_trackers: dict[str, ObjectTracker] = {}
        self.cam_best_shots: dict[str, BestShotSelector] = {}
        self.cam_ring_buffers: dict[str, RingBuffer] = {}
        self.cam_zones: dict[str, list] = {}
        self.cam_detect_classes: dict[str, list | None] = {}
        self.cam_line_crossing: dict[str, dict] = {}

    # ── YOLO label -> UI detection class mapping ──
    YOLO_TO_CLASS = {
        "person": "person",
        "car": "vehicle", "truck": "vehicle", "bus": "vehicle",
        "motorcycle": "vehicle", "bicycle": "vehicle",
        "cat": "animal", "dog": "animal", "horse": "animal",
        "bird": "animal", "sheep": "animal", "cow": "animal",
        "bear": "animal", "elephant": "animal", "zebra": "animal", "giraffe": "animal",
    }

    async def start(self):
        log.info("detector.starting", model=self.model_name, fps=self.detection_fps,
                 architecture="mosaic_3x3")

        # Connect to databases
        self.db_pool = await asyncpg.create_pool(
            self.postgres_url, min_size=2, max_size=10
        )
        self.redis = aioredis.from_url(self.redis_url, decode_responses=True)

        async with self.db_pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        await self.redis.ping()
        log.info("detector.connected", postgres=True, redis=True)

        # Initialize YOLO detector
        self._detector = YOLODetector(
            model_name=self.model_name,
            confidence=self.confidence_threshold,
            device=self.device,
        )

        # Initialize go2rtc frame grabber (replaces per-camera RTSP connections)
        self._grabber = Go2rtcGrabber(self.go2rtc_url, width=640)
        await self._grabber.start()

        # Initialize event validator
        self._event_validator = EventValidator(
            detector=self._detector,
            db_pool=self.db_pool,
        )
        await self._event_validator.start()

        # Initialize event publisher
        self._publisher = EventPublisher(
            db_pool=self.db_pool,
            redis=self.redis,
            minio_endpoint=self.minio_endpoint,
            minio_access_key=self.minio_access_key,
            minio_secret_key=self.minio_secret_key,
        )

        # Initialize zone manager
        self._zone_manager = ZoneManager(self.db_pool)

        # Initialize face recognizer
        from minio import Minio
        minio_client = Minio(
            self.minio_endpoint,
            access_key=self.minio_access_key,
            secret_key=self.minio_secret_key,
            secure=False,
        )
        self._face_recognizer = FaceRecognizer(self.db_pool, minio_client=minio_client)
        self._face_recognizer.set_hires_source(self._grabber)

        # Initialize processing queue (deep analysis on 4MP frames)
        self._processing_queue = ProcessingQueue(
            db_pool=self.db_pool,
            face_recognizer=self._face_recognizer,
        )
        await self._processing_queue.start()

        # Load cameras from DB
        await self._sync_cameras()

        # Start main detection loop
        detection_task = asyncio.create_task(self._mosaic_detection_loop())

        # Background tasks
        listener_task = asyncio.create_task(self._listen_camera_events())
        refresh_task = asyncio.create_task(self._refresh_loop())
        cleanup_task = asyncio.create_task(self._cleanup_loop())

        log.info("detector.started", cameras=len(self.cam_streams))

        try:
            await asyncio.gather(detection_task, listener_task, refresh_task, cleanup_task)
        except asyncio.CancelledError:
            log.info("detector.shutting_down")

    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    # Camera Management
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    async def _sync_cameras(self):
        """Sync per-camera state with database. Add new cameras, remove disabled ones."""
        try:
            async with self.db_pool.acquire() as conn:
                cameras = await conn.fetch(
                    "SELECT id, name, camera_type, config "
                    "FROM cameras WHERE is_enabled = true AND is_online = true"
                )
        except Exception as e:
            log.warning("detector.sync_cameras_error", error=str(e))
            return

        enabled_ids = set()

        for cam in cameras:
            cam_id = str(cam["id"])
            enabled_ids.add(cam_id)

            if cam_id in self.cam_streams:
                continue  # already tracked

            cam_id_short = cam_id.replace("-", "")[:12]
            stream_name = f"cam_{cam_id_short}_sub"

            # Parse per-camera config
            cam_config = cam.get("config") or {}
            if isinstance(cam_config, str):
                try:
                    cam_config = json.loads(cam_config)
                except Exception:
                    cam_config = {}

            self.cam_streams[cam_id] = stream_name
            self.cam_main_streams[cam_id] = f"cam_{cam_id_short}"  # main 4MP stream
            self.cam_names[cam_id] = cam["name"] or "unknown"
            self.cam_trackers[cam_id] = ObjectTracker(frame_rate=self.detection_fps)
            self.cam_best_shots[cam_id] = BestShotSelector(
                min_bbox_area=2000,
                min_person_height=40,
                max_hold_time=8.0,
                gone_frames=self.detection_fps * 2,  # 2 seconds
                confidence_threshold=0.05,
            )
            self.cam_ring_buffers[cam_id] = RingBuffer(
                max_seconds=self.ring_buffer_seconds,
                fps=self.detection_fps,
            )
            self.cam_zones[cam_id] = await self._zone_manager.get_zones(cam_id)
            self.cam_detect_classes[cam_id] = cam_config.get("detect_classes", None)
            self.cam_line_crossing[cam_id] = {}

            log.info("detector.camera_added", camera_id=cam_id,
                     name=cam["name"], stream=stream_name)

        # Remove cameras no longer enabled/online
        to_remove = [cid for cid in self.cam_streams if cid not in enabled_ids]
        for cid in to_remove:
            log.info("detector.camera_removed", camera_id=cid,
                     name=self.cam_names.get(cid))
            self.cam_streams.pop(cid, None)
            self.cam_main_streams.pop(cid, None)
            self.cam_names.pop(cid, None)
            self.cam_trackers.pop(cid, None)
            self.cam_best_shots.pop(cid, None)
            self.cam_ring_buffers.pop(cid, None)
            self.cam_zones.pop(cid, None)
            self.cam_detect_classes.pop(cid, None)
            self.cam_line_crossing.pop(cid, None)

    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    # Main Mosaic Detection Loop
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    async def _mosaic_detection_loop(self):
        """Single loop that processes ALL cameras via 3x3 mosaics."""
        loop = asyncio.get_event_loop()
        detector = self._detector
        grabber = self._grabber
        frame_interval = 1.0 / self.detection_fps
        frame_count = 0
        face_every_n = 3
        config_reload_every = self.detection_fps * 30   # every ~30s
        diag_every = self.detection_fps * 10             # every ~10s

        log.info("mosaic_loop.started", fps=self.detection_fps,
                 interval_ms=f"{frame_interval * 1000:.0f}")

        while self.running:
            try:
                t0 = time.monotonic()

                # Reload camera list & zones periodically
                if frame_count > 0 and frame_count % config_reload_every == 0:
                    await self._sync_cameras()
                    # Refresh zones for all cameras
                    for cid in list(self.cam_streams):
                        try:
                            self.cam_zones[cid] = await self._zone_manager.refresh_zones(cid)
                        except Exception:
                            pass

                if not self.cam_streams:
                    await asyncio.sleep(2)
                    continue

                # ── Step 1: Fetch all frames from go2rtc (parallel HTTP) ──
                frames = await grabber.fetch_all(self.cam_streams)
                t_fetch = time.monotonic()

                if not frames:
                    await asyncio.sleep(0.5)
                    continue

                # ── Step 2: Build mosaics (CPU, fast) ──
                mosaics, tile_map = build_mosaics(frames)
                t_mosaic = time.monotonic()

                # ── Step 3: YOLO inference on mosaics (GPU) ──
                yolo_results = await loop.run_in_executor(
                    self.thread_pool, detector.detect_batch, mosaics
                )
                t_yolo = time.monotonic()

                # ── Step 4: Remap detections to per-camera coordinates ──
                cam_detections = remap_detections(yolo_results, tile_map)

                frame_count += 1
                run_face = (frame_count % face_every_n == 0) and self._face_recognizer.available

                # ── Step 5: Per-camera processing ──
                for cam_id in list(self.cam_streams):
                    frame = frames.get(cam_id)
                    if frame is None:
                        continue

                    detections = cam_detections.get(cam_id, [])

                    await self._process_camera(
                        cam_id=cam_id,
                        frame=frame,
                        detections=detections,
                        frame_count=frame_count,
                        run_face=run_face,
                        show_diag=(frame_count % diag_every == 1),
                    )

                # ── Timing ──
                t_end = time.monotonic()
                elapsed = t_end - t0
                sleep_time = max(0, frame_interval - elapsed)
                if sleep_time > 0:
                    await asyncio.sleep(sleep_time)

                # Periodic timing log
                if frame_count % diag_every == 0:
                    total_dets = sum(len(d) for d in cam_detections.values())
                    log.info("mosaic_loop.timing",
                             cameras=len(frames),
                             mosaics=len(mosaics),
                             detections=total_dets,
                             fetch_ms=f"{(t_fetch - t0) * 1000:.0f}",
                             mosaic_ms=f"{(t_mosaic - t_fetch) * 1000:.0f}",
                             yolo_ms=f"{(t_yolo - t_mosaic) * 1000:.0f}",
                             process_ms=f"{(t_end - t_yolo) * 1000:.0f}",
                             total_ms=f"{elapsed * 1000:.0f}",
                             target_ms=f"{frame_interval * 1000:.0f}")

            except Exception as e:
                log.error("mosaic_loop.error", error=str(e))
                await asyncio.sleep(1)

    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    # Per-Camera Processing
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    async def _process_camera(
        self, cam_id: str, frame: np.ndarray, detections: list,
        frame_count: int, run_face: bool, show_diag: bool,
    ):
        """Process detections for a single camera within one mosaic cycle."""
        cam_name = self.cam_names.get(cam_id, "unknown")
        tracker = self.cam_trackers.get(cam_id)
        best_shot = self.cam_best_shots.get(cam_id)
        ring_buffer = self.cam_ring_buffers.get(cam_id)
        zones = self.cam_zones.get(cam_id, [])
        detect_classes = self.cam_detect_classes.get(cam_id)

        if not tracker or not best_shot or not ring_buffer:
            return

        # Push frame to ring buffer (for video clips)
        ring_buffer.push(frame)

        # ── Class filtering ──
        pre_filter_count = len(detections)
        if detect_classes and detections:
            allowed = set(detect_classes)
            PERSON_FLAGS = {"face_recognition", "face_unknown", "person_count", "loitering", "line_crossing"}
            if allowed & PERSON_FLAGS:
                allowed.add("person")
            if "abandoned_object" in allowed:
                allowed.update({"person", "vehicle"})
            if "intrusion" in allowed:
                allowed.update({"person", "vehicle", "animal"})
            detections = [
                d for d in detections
                if self.YOLO_TO_CLASS.get(d.label.split(":")[0], d.label.split(":")[0]) in allowed
            ]

        # ── Track objects (ByteTrack always runs, even with 0 detections) ──
        tracked = tracker.update(detections, frame)

        # ── Zone filtering (affects alerts only, not live overlay) ──
        filtered = self._zone_manager.filter_detections(tracked, zones, frame_shape=frame.shape)

        if tracked and not filtered and frame_count % 50 == 0:
            labels = [d.label for d in tracked[:5]]
            log.warning("pipeline.zone_filter_drop_all",
                        camera=cam_name, tracked=len(tracked),
                        filtered=0, zones=len(zones), labels=labels)

        # ── Diagnostic log ──
        if show_diag:
            active_bufs = len([k for k in best_shot._buffers if k.startswith(cam_id)])
            published_count = len([k for k in best_shot._published if k.startswith(cam_id)])
            log.info("pipeline.diag", camera=cam_name,
                     raw_dets=pre_filter_count,
                     after_class_filter=len(detections),
                     tracked=len(tracked),
                     after_zone_filter=len(filtered),
                     zones_configured=len(zones),
                     best_shot_buffers=active_bufs,
                     best_shot_published=published_count)

        # ── Attribute extraction ──
        for det in tracked:
            base_label = det.label.split(":")[0]

            if base_label == "person":
                try:
                    crop_quality = EventValidator.check_frame_quality(frame, det.bbox)
                    if crop_quality["is_valid"] and crop_quality.get("variance", 0) >= 400:
                        attrs = extract_person_attributes(frame, det.bbox)
                        if det.metadata is None:
                            det.metadata = {}
                        det.metadata["upper_color"] = attrs["upper_color"]
                        det.metadata["lower_color"] = attrs["lower_color"]
                        det.metadata["headgear"] = attrs["headgear"]
                except Exception:
                    pass

            if base_label in ("car", "truck", "bus", "motorcycle", "bicycle"):
                try:
                    crop_quality = EventValidator.check_frame_quality(frame, det.bbox)
                    if crop_quality["is_valid"]:
                        vattrs = extract_vehicle_attributes(frame, det.bbox, yolo_label=base_label)
                        if det.metadata is None:
                            det.metadata = {}
                        det.metadata["vehicle_color"] = vattrs["vehicle_color"]
                        det.metadata["vehicle_rgb"] = vattrs["vehicle_rgb"]
                        det.metadata["vehicle_type"] = vattrs["vehicle_type"]
                        if vattrs.get("license_plate"):
                            det.metadata["license_plate"] = vattrs["license_plate"]
                except Exception:
                    pass

        # ── Face recognition (on original 640x360 frame, not 213px tile) ──
        if run_face and any(d.label.split(":")[0] == "person" for d in tracked):
            person_dets = [d for d in tracked if d.label.split(":")[0] == "person"]
            try:
                face_results = await self._face_recognizer.recognize_all_faces(
                    frame, cam_id, person_dets
                )
                for result in face_results:
                    for det in tracked:
                        if det.tracker_id == result["tracker_id"]:
                            if det.metadata is None:
                                det.metadata = {}
                            if result.get("person_id"):
                                det.metadata["person_id"] = result["person_id"]
                                det.metadata["person_name"] = result["person_name"]
                                det.metadata["face_confidence"] = result["face_confidence"]
                                det.label = f"person:{result['person_name']}"
                            if result.get("face_detected"):
                                det.metadata["face_detected"] = True
                            if result.get("face_bbox"):
                                det.metadata["face_bbox"] = result["face_bbox"]
                            break
            except Exception as e:
                log.debug("face_recognition.error", error=str(e))

        # ── Person count (periodic, every ~30s) ──
        person_count_interval = self.detection_fps * 30
        if (detect_classes and "person_count" in detect_classes
                and frame_count % person_count_interval == 0):
            person_dets_count = [d for d in filtered if d.label.split(":")[0] == "person"]
            if person_dets_count:
                details = []
                for pd in person_dets_count:
                    detail = {
                        "tracker_id": pd.tracker_id,
                        "bbox": list(pd.bbox),
                        "confidence": round(pd.confidence, 2),
                    }
                    if pd.metadata and pd.metadata.get("person_name"):
                        detail["person_name"] = pd.metadata["person_name"]
                    details.append(detail)
                try:
                    await self._publisher.publish_person_count(
                        cam_id, cam_name, len(person_dets_count), details, frame,
                    )
                except Exception as e:
                    log.debug("person_count.error", error=str(e))

        # ── Line crossing (tripwire zones) ──
        if detect_classes and "line_crossing" in detect_classes and zones:
            lc_state = self.cam_line_crossing.setdefault(cam_id, {})
            tripwires = [z for z in zones if z.get("zone_type") == "tripwire"]
            for tw in tripwires:
                tw_id = str(tw.get("id", ""))
                if tw_id not in lc_state:
                    lc_state[tw_id] = {}
                points = tw.get("points", [])
                if len(points) >= 2:
                    p1, p2 = points[0], points[1]
                    lx1, ly1 = p1.get("x", 0), p1.get("y", 0)
                    lx2, ly2 = p2.get("x", 0), p2.get("y", 0)
                    dx, dy = lx2 - lx1, ly2 - ly1
                    for det in filtered:
                        h_f, w_f = frame.shape[:2]
                        cx = ((det.bbox[0] + det.bbox[2]) / 2) / w_f
                        cy = ((det.bbox[1] + det.bbox[3]) / 2) / h_f
                        cross = (cx - lx1) * dy - (cy - ly1) * dx
                        side = "A" if cross > 0 else "B"
                        prev_side = lc_state[tw_id].get(det.tracker_id)
                        if prev_side and prev_side != side:
                            direction = f"{prev_side}\u2192{side}"
                            if det.metadata is None:
                                det.metadata = {}
                            det.metadata["line_crossing"] = True
                            det.metadata["crossing_direction"] = direction
                            det.metadata["tripwire_id"] = tw_id
                            log.info("line_crossing.detected",
                                     camera=cam_name, tracker_id=det.tracker_id,
                                     label=det.label, direction=direction)
                        lc_state[tw_id][det.tracker_id] = side

        # ── Publish real-time tracking (ALL tracked, not zone-filtered) ──
        h, w = frame.shape[:2]
        tracks = []
        for d in tracked:
            x1, y1, x2, y2 = d.bbox
            track = {
                "id": f"t{d.tracker_id}",
                "label": d.label.split(":")[0],
                "confidence": round(d.confidence, 2),
                "bbox": {
                    "x": round(x1 / w * 100, 1),
                    "y": round(y1 / h * 100, 1),
                    "w": round((x2 - x1) / w * 100, 1),
                    "h": round((y2 - y1) / h * 100, 1),
                },
                "trackId": d.tracker_id,
            }
            if hasattr(d, "metadata") and d.metadata:
                pname = d.metadata.get("person_name")
                if pname:
                    track["personName"] = pname
                if d.metadata.get("face_bbox"):
                    track["faceBbox"] = {
                        "x": round(x1 / w * 100, 1),
                        "y": round(y1 / h * 100, 1),
                        "w": round((x2 - x1) / w * 100, 1),
                        "h": round((y2 - y1) * 0.4 / h * 100, 1),
                    }
            if hasattr(d, "metadata") and d.metadata:
                attrs = {}
                for attr_key in ("upper_color", "lower_color", "headgear",
                                 "vehicle_color", "vehicle_rgb",
                                 "vehicle_type", "license_plate"):
                    if attr_key in d.metadata:
                        attrs[attr_key] = d.metadata[attr_key]
                if attrs:
                    track["attributes"] = attrs
            tracks.append(track)

        person_count_rt = sum(1 for d in tracked if d.label.split(":")[0] == "person")

        await self.redis.publish(
            "tracking",
            json.dumps({
                "camera_id": cam_id,
                "tracks": tracks,
                "person_count": person_count_rt,
            }),
        )

        # ── Best-shot: feed zone-filtered detections ──
        best_shot.cleanup()
        current_tracker_ids = set()

        for det in filtered:
            current_tracker_ids.add(det.tracker_id)
            best_shot.update(
                camera_id=cam_id,
                tracker_id=det.tracker_id,
                label=det.label,
                class_id=det.class_id,
                frame=frame,
                bbox=det.bbox,
                confidence=det.confidence,
                metadata=det.metadata or {},
            )

        # Collect ready events
        from tracker import TrackedDetection as TD
        ready_events = best_shot.collect(cam_id, current_tracker_ids, current_frame=frame)

        loop = asyncio.get_event_loop()
        for buf, candidate in ready_events:
            # Pre-publish quality gate (on sub-stream frame)
            quality = EventValidator.check_frame_quality(candidate.frame, candidate.bbox)
            if not quality["is_valid"]:
                log.info("event.pre_publish_rejected",
                         camera=cam_name, label=buf.label,
                         reason=quality["reason"], tracker_id=buf.tracker_id)
                continue

            # ── Fetch 4MP frame from main-stream for high-quality snapshot ──
            snapshot_frame = candidate.frame
            snapshot_bbox = candidate.bbox
            main_stream = self.cam_main_streams.get(cam_id)
            if main_stream:
                hires = await loop.run_in_executor(
                    self.thread_pool, self._grabber.fetch_hires_frame, main_stream
                )
                if hires is not None:
                    # Scale bbox from sub-stream coords to 4MP coords
                    hi_h, hi_w = hires.shape[:2]
                    lo_h, lo_w = candidate.frame.shape[:2]
                    sx, sy = hi_w / lo_w, hi_h / lo_h
                    ox1, oy1, ox2, oy2 = candidate.bbox
                    snapshot_bbox = (ox1 * sx, oy1 * sy, ox2 * sx, oy2 * sy)
                    snapshot_frame = hires
                    log.info("alert.hires_snapshot", camera=cam_name,
                             sub=f"{lo_w}x{lo_h}", main=f"{hi_w}x{hi_h}",
                             label=buf.label, tracker_id=buf.tracker_id)

            best_det = TD(
                bbox=snapshot_bbox,
                label=buf.label,
                confidence=candidate.confidence,
                class_id=buf.class_id,
                tracker_id=buf.tracker_id,
                is_new=True,
                metadata=candidate.metadata,
            )

            # Skip low-quality clothing colors
            base_label_pub = buf.label.split(":")[0]
            if base_label_pub == "person" and quality.get("variance", 9999) < 400:
                if best_det.metadata:
                    for key in ("upper_color", "lower_color", "headgear"):
                        best_det.metadata.pop(key, None)

            # Create video clip from ring buffer (up to 15s, actual fps)
            clip_path = None
            try:
                pre_frames = ring_buffer.get_pre_event_frames(seconds=15)
                actual_fps = max(1, int(round(ring_buffer.get_actual_fps())))
                if len(pre_frames) >= 5:
                    clip_bytes = await loop.run_in_executor(
                        self.thread_pool,
                        create_clip, pre_frames, [], actual_fps
                    )
                    if clip_bytes:
                        ts_str = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
                        clip_path = await save_clip_to_minio(
                            self._publisher.minio, clip_bytes,
                            _uuid.uuid4().hex, ts_str,
                        )
            except Exception as e:
                log.debug("ring_buffer.clip_error", error=str(e))

            event_id = await self._publisher.publish(
                camera_id=cam_id,
                camera_name=cam_name,
                detection=best_det,
                frame=snapshot_frame,
                clip_path=clip_path,
            )

            # Post-publish validation
            if event_id and self._event_validator:
                await self._event_validator.submit(
                    event_id=event_id,
                    frame=snapshot_frame,
                    bbox=snapshot_bbox,
                    label=buf.label,
                    confidence=candidate.confidence,
                )

            # Enqueue 4MP frame for deep processing (face recog, attributes)
            if event_id and self._processing_queue and snapshot_frame is not None:
                await self._processing_queue.enqueue(QueueItem(
                    event_id=event_id,
                    camera_id=cam_id,
                    frame=snapshot_frame,
                    bbox=snapshot_bbox,
                    label=buf.label,
                    tracker_id=buf.tracker_id,
                    metadata=candidate.metadata or {},
                ))

    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    # Background Tasks
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    async def _listen_camera_events(self):
        """Listen for camera add/remove events on Redis Stream."""
        last_id = "$"
        while self.running:
            try:
                messages = await self.redis.xread(
                    {"camera_events": last_id}, count=10, block=5000
                )
                for stream, entries in messages:
                    for entry_id, data in entries:
                        last_id = entry_id
                        event_type = data.get("type")
                        if event_type in ("camera_discovered", "camera_online", "camera_offline"):
                            await self._sync_cameras()
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.warning("detector.event_listener_error", error=str(e))
                await asyncio.sleep(5)

    async def _refresh_loop(self):
        """Periodically refresh camera list."""
        while self.running:
            await asyncio.sleep(30)
            try:
                await self._sync_cameras()
                log.debug("detector.refresh", active_cameras=len(self.cam_streams))
            except Exception as e:
                log.warning("detector.refresh_error", error=str(e))

    async def _cleanup_loop(self):
        """Periodically clean up old events and expired face data."""
        while self.running:
            await asyncio.sleep(3600)
            try:
                async with self.db_pool.acquire() as conn:
                    deleted_old = await conn.execute(
                        "DELETE FROM events WHERE occurred_at < NOW() - INTERVAL '90 days'"
                    )
                    total = await conn.fetchval("SELECT COUNT(*) FROM events")
                    deleted_excess = 0
                    if total and total > 10000:
                        await conn.execute("""
                            DELETE FROM events WHERE id IN (
                                SELECT id FROM events
                                ORDER BY occurred_at DESC
                                OFFSET 10000
                            )
                        """)
                        deleted_excess = total - 10000
                    deleted_unknown = await conn.execute(
                        "DELETE FROM unknown_faces WHERE expires_at < NOW()"
                    )
                    deleted_dismissed = await conn.execute(
                        "DELETE FROM dismissed_faces WHERE expires_at < NOW()"
                    )
                    log.info(
                        "detector.cleanup_done",
                        events_old=str(deleted_old).split()[-1] if deleted_old else "0",
                        events_excess=deleted_excess,
                        unknown_faces=str(deleted_unknown).split()[-1] if deleted_unknown else "0",
                        dismissed_faces=str(deleted_dismissed).split()[-1] if deleted_dismissed else "0",
                    )
            except Exception as e:
                log.warning("detector.cleanup_error", error=str(e))

    async def stop(self):
        self.running = False
        if self._processing_queue:
            await self._processing_queue.stop()
        if self._event_validator:
            await self._event_validator.stop()
        if self._grabber:
            await self._grabber.stop()
        if self.db_pool:
            await self.db_pool.close()
        if self.redis:
            await self.redis.close()
        self.thread_pool.shutdown(wait=False)
        log.info("detector.stopped")


async def main():
    service = DetectorService()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: asyncio.create_task(service.stop()))

    try:
        await service.start()
    except KeyboardInterrupt:
        await service.stop()


if __name__ == "__main__":
    asyncio.run(main())
