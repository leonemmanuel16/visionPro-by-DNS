"""DNS Vision AI - AI Detection Service

Pulls frames from go2rtc streams, runs YOLO detection,
tracks objects, and publishes detection events.

Architecture:
- Each camera has its own async detection loop (grab → detect → track → publish)
- All cameras share a single BatchDetector for GPU inference (batched YOLO)
- Frame grabbing uses GpuFrameGrabber (NVDEC) with CPU fallback
"""

import asyncio
import os
import signal
import sys
import json
import uuid as _uuid
from concurrent.futures import ThreadPoolExecutor

import asyncpg
import cv2
import redis.asyncio as aioredis
import structlog

from detector import YOLODetector
from batch_detector import BatchDetector
from frame_grabber import FrameGrabber
from gpu_frame_grabber import GpuFrameGrabber
from tracker import ObjectTracker
from zone_manager import ZoneManager
from event_publisher import EventPublisher
from face_recognizer import FaceRecognizer
from person_attributes import extract_person_attributes
from vehicle_attributes import extract_vehicle_attributes
from best_shot import BestShotSelector
from ring_buffer import RingBuffer, create_clip, save_clip_to_minio
from event_validator import EventValidator

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
        self.detection_fps = int(os.environ.get("DETECTION_FPS", "5"))
        self.confidence_threshold = float(os.environ.get("CONFIDENCE_THRESHOLD", "0.05"))
        self.go2rtc_url = os.environ.get("GO2RTC_URL", "http://localhost:1984")
        self.device = os.environ.get("DEVICE", "auto")
        self.ring_buffer_seconds = int(os.environ.get("RING_BUFFER_SECONDS", "15"))
        self.max_batch_size = int(os.environ.get("MAX_BATCH_SIZE", "16"))
        self.use_gpu_decode = os.environ.get("USE_GPU_DECODE", "true").lower() == "true"

        self.db_pool: asyncpg.Pool | None = None
        self.redis: aioredis.Redis | None = None
        self.running = True
        self.camera_tasks: dict[str, asyncio.Task] = {}
        self.thread_pool = ThreadPoolExecutor(max_workers=24)  # 18 cameras + headroom
        self.batch_detector: BatchDetector | None = None
        self.event_validator: EventValidator | None = None

    async def start(self):
        log.info("detector.starting", model=self.model_name, fps=self.detection_fps,
                 max_batch=self.max_batch_size, gpu_decode=self.use_gpu_decode)

        # Connect to databases
        self.db_pool = await asyncpg.create_pool(
            self.postgres_url, min_size=2, max_size=10
        )
        self.redis = aioredis.from_url(self.redis_url, decode_responses=True)

        # Test connections
        async with self.db_pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        await self.redis.ping()
        log.info("detector.connected", postgres=True, redis=True)

        # Initialize YOLO detector
        detector = YOLODetector(
            model_name=self.model_name,
            confidence=self.confidence_threshold,
            device=self.device,
        )

        # Initialize batch detector (centralizes GPU inference across all cameras)
        self.batch_detector = BatchDetector(
            detector,
            max_batch_size=self.max_batch_size,
            batch_timeout=0.08,  # 80ms — collect more frames per batch for GPU efficiency
        )
        await self.batch_detector.start()

        # Initialize event validator (post-publish false positive elimination)
        self.event_validator = EventValidator(
            detector=detector,
            db_pool=self.db_pool,
        )
        await self.event_validator.start()

        # Initialize event publisher
        publisher = EventPublisher(
            db_pool=self.db_pool,
            redis=self.redis,
            minio_endpoint=self.minio_endpoint,
            minio_access_key=self.minio_access_key,
            minio_secret_key=self.minio_secret_key,
        )

        # Initialize zone manager
        zone_manager = ZoneManager(self.db_pool)

        # Initialize face recognizer (with MinIO for saving face thumbnails)
        from minio import Minio
        minio_client = Minio(
            self.minio_endpoint,
            access_key=self.minio_access_key,
            secret_key=self.minio_secret_key,
            secure=False,
        )
        face_recognizer = FaceRecognizer(self.db_pool, minio_client=minio_client)

        # Start detection for existing cameras
        await self._start_camera_detections(publisher, zone_manager, face_recognizer)

        # Listen for camera events (new cameras, removed cameras)
        listener_task = asyncio.create_task(
            self._listen_camera_events(publisher, zone_manager, face_recognizer)
        )

        # Periodically refresh camera list
        refresh_task = asyncio.create_task(
            self._refresh_loop(publisher, zone_manager, face_recognizer)
        )

        # Periodic database cleanup (events, expired faces)
        cleanup_task = asyncio.create_task(self._cleanup_loop())

        log.info("detector.started")

        try:
            await asyncio.gather(listener_task, refresh_task, cleanup_task)
        except asyncio.CancelledError:
            log.info("detector.shutting_down")

    async def _start_camera_detections(self, publisher, zone_manager, face_recognizer):
        """Start detection tasks for enabled cameras, stop tasks for disabled ones."""
        async with self.db_pool.acquire() as conn:
            cameras = await conn.fetch(
                "SELECT id, name, rtsp_sub_stream, rtsp_main_stream, camera_type, config FROM cameras WHERE is_enabled = true AND is_online = true"
            )

        # Build set of camera IDs that SHOULD be running
        enabled_ids = {str(cam["id"]) for cam in cameras}

        # Stop tasks for cameras that are no longer enabled/online
        to_remove = [cid for cid in self.camera_tasks if cid not in enabled_ids]
        for cid in to_remove:
            log.info("detector.camera_stopped", camera_id=cid, reason="disabled_or_offline")
            self.camera_tasks[cid].cancel()
            del self.camera_tasks[cid]

        # Stagger camera starts to avoid overwhelming the NVR with simultaneous connections
        new_cameras = []
        for cam in cameras:
            cam_id = str(cam["id"])
            if cam_id not in self.camera_tasks:
                new_cameras.append(cam)

        for idx, cam in enumerate(new_cameras):
            cam_id = str(cam["id"])
            cam_id_short = cam_id.replace("-", "")[:12]
            cam_name_lower = (cam["name"] or "").lower()
            cam_type = (cam.get("camera_type") or "").lower()
            is_fisheye = "fisheye" in cam_name_lower or "fish" in cam_name_lower or cam_type == "fisheye"

            # Connect directly to NVR/camera RTSP (not via go2rtc)
            # go2rtc doesn't relay HEVC properly over RTSP
            # Main stream = full 4MP resolution for better detection
            stream_url = cam["rtsp_main_stream"] or cam["rtsp_sub_stream"]
            if stream_url:
                # Load per-camera detect_classes from config
                cam_config = cam.get("config") or {}
                if isinstance(cam_config, str):
                    try:
                        cam_config = json.loads(cam_config)
                    except Exception:
                        cam_config = {}
                detect_classes = cam_config.get("detect_classes", None)

                task = asyncio.create_task(
                    self._detection_loop(
                        cam_id, cam["name"], stream_url, publisher,
                        zone_manager, face_recognizer, detect_classes=detect_classes,
                        start_delay=idx * 2.0,  # 2s stagger between cameras
                    )
                )
                self.camera_tasks[cam_id] = task
                stream_type = "sub" if is_fisheye else "main"
                log.info("detector.camera_queued", camera_id=cam_id, name=cam["name"],
                         stream=stream_type, start_delay=f"{idx * 2}s",
                         detect_classes=detect_classes)

    # YOLO label → UI detection class mapping
    YOLO_TO_CLASS = {
        "person": "person",
        "car": "vehicle", "truck": "vehicle", "bus": "vehicle",
        "motorcycle": "vehicle", "bicycle": "vehicle",
        "cat": "animal", "dog": "animal", "horse": "animal",
        "bird": "animal", "sheep": "animal", "cow": "animal",
        "bear": "animal", "elephant": "animal", "zebra": "animal", "giraffe": "animal",
    }

    def _create_grabber(self, stream_url: str, camera_name: str):
        """Create frame grabber using OpenCV (CPU decode).

        GPU grabber (FFmpeg NVDEC) is disabled because the test probe + ffmpeg
        creates 2+ RTSP connections per camera, overwhelming the NVR.
        OpenCV VideoCapture handles HEVC fine and only uses 1 connection.
        """
        log.info("detector.using_cpu_grabber", camera=camera_name,
                 url=stream_url[:60])
        return FrameGrabber(stream_url, self.detection_fps, self.go2rtc_url,
                            use_cuda=False)

    async def _detection_loop(
        self, camera_id, camera_name, stream_url, publisher,
        zone_manager, face_recognizer, detect_classes=None,
        start_delay: float = 0.0,
    ):
        """Main detection loop for a single camera."""
        loop = asyncio.get_event_loop()

        # Stagger start to avoid overwhelming NVR with simultaneous RTSP connections
        if start_delay > 0:
            log.info("detector.camera_waiting", camera=camera_name, delay=f"{start_delay:.0f}s")
            await asyncio.sleep(start_delay)

        # Create frame grabber — use CPU (OpenCV) directly for NVR streams
        # GPU grabber (FFmpeg NVDEC) test probe creates extra RTSP connections
        # that overwhelm the NVR, so we skip it and go straight to OpenCV
        grabber = await loop.run_in_executor(
            self.thread_pool, self._create_grabber, stream_url, camera_name
        )

        tracker = ObjectTracker()
        best_shot = BestShotSelector(
            min_bbox_area=5000,      # ~70x70px — good for 4MP (2688x1520)
            min_person_height=120,   # ~8% of 1520px frame height
            max_hold_time=8.0,       # Publish after 8s max — gives time for best frame
            gone_frames=10,          # Publish 2s after object leaves (10 frames at 5fps)
            confidence_threshold=0.05,  # Very low threshold for indoor overhead cameras
        )
        ring_buffer = RingBuffer(
            max_seconds=self.ring_buffer_seconds,
            fps=self.detection_fps,
        )

        # Load zones for this camera
        zones = await zone_manager.get_zones(camera_id)

        frame_interval = 1.0 / self.detection_fps
        frame_count = 0
        face_every_n = 3
        enable_check_interval = self.detection_fps * 10
        # Reload config & zones every ~30 seconds
        config_reload_interval = self.detection_fps * 30
        # Person count publish interval (~every 30 seconds)
        person_count_interval = self.detection_fps * 30
        # Line crossing state: tracker_id → last_side ("A" or "B") for each tripwire zone
        line_crossing_state: dict[str, dict[int, str]] = {}

        while self.running:
            try:
                # Periodically verify camera is still enabled + reload config & zones
                if frame_count > 0 and frame_count % enable_check_interval == 0:
                    try:
                        async with self.db_pool.acquire() as conn:
                            cam_row = await conn.fetchrow(
                                "SELECT is_enabled, config FROM cameras WHERE id = $1",
                                _uuid.UUID(camera_id)
                            )
                        if not cam_row or not cam_row["is_enabled"]:
                            log.info("detector.camera_disabled", camera_id=camera_id, name=camera_name)
                            break
                        # Reload detect_classes from DB config
                        if frame_count % config_reload_interval == 0:
                            new_config = cam_row.get("config") or {}
                            if isinstance(new_config, str):
                                try:
                                    new_config = json.loads(new_config)
                                except Exception:
                                    new_config = {}
                            new_classes = new_config.get("detect_classes", None)
                            if new_classes != detect_classes:
                                log.info("detector.config_reloaded", camera=camera_name,
                                         old=detect_classes, new=new_classes)
                                detect_classes = new_classes
                            # Reload zones
                            zones = await zone_manager.refresh_zones(camera_id)
                    except Exception:
                        pass

                # Grab frame in thread pool (blocking I/O)
                frame = await loop.run_in_executor(self.thread_pool, grabber.grab_frame)

                if frame is None:
                    log.debug("detector.frame_none", camera=camera_name)
                    await asyncio.sleep(1)
                    continue

                # Process at native resolution (4MP OK — YOLO resizes internally,
                # higher res = better faces, colors, animals, snapshot quality)
                log.debug("detector.frame_ok", camera=camera_name, shape=f"{frame.shape[1]}x{frame.shape[0]}")

                # Push frame to ring buffer (for video clips)
                ring_buffer.push(frame)

                # Submit frame to batch detector (waits for batched inference)
                detections = await self.batch_detector.submit(frame)

                if not detections:
                    frame_count += 1
                    # Log zero-detection diagnostic every ~10s so we can debug indoor cameras
                    if frame_count % (self.detection_fps * 10) == 1:
                        log.info("pipeline.zero_dets", camera=camera_name,
                                 frame_shape=f"{frame.shape[1]}x{frame.shape[0]}")
                    # Publish empty tracking so frontend clears stale boxes
                    import json as _json_empty
                    await self.redis.publish("tracking", _json_empty.dumps({
                        "camera_id": camera_id, "tracks": [], "person_count": 0,
                    }))
                    await asyncio.sleep(frame_interval)
                    continue

                # Filter by per-camera detect_classes
                pre_filter_count = len(detections)
                if detect_classes:
                    allowed = set(detect_classes)
                    # Feature flags that imply "person" detection
                    PERSON_FLAGS = {"face_recognition", "face_unknown", "person_count", "loitering", "line_crossing"}
                    if allowed & PERSON_FLAGS:
                        allowed.add("person")
                    # "abandoned_object" and "intrusion" need person/vehicle detection
                    if "abandoned_object" in allowed:
                        allowed.update({"person", "vehicle"})
                    if "intrusion" in allowed:
                        allowed.update({"person", "vehicle", "animal"})
                    detections = [
                        d for d in detections
                        if self.YOLO_TO_CLASS.get(d.label.split(":")[0], d.label.split(":")[0]) in allowed
                    ]
                    if not detections:
                        if frame_count % 50 == 0:
                            log.info("pipeline.class_filter_drop", camera=camera_name,
                                     pre=pre_filter_count, allowed=list(allowed))
                        # Publish empty tracking so frontend clears stale boxes
                        import json as _json_empty2
                        await self.redis.publish("tracking", _json_empty2.dumps({
                            "camera_id": camera_id, "tracks": [], "person_count": 0,
                        }))
                        await asyncio.sleep(frame_interval)
                        continue

                # Track objects
                tracked = tracker.update(detections, frame)

                # Filter by zones
                filtered = zone_manager.filter_detections(tracked, zones, frame_shape=frame.shape)

                if tracked and not filtered and frame_count % 50 == 0:
                    labels = [d.label for d in tracked[:5]]
                    log.warning("pipeline.zone_filter_drop_all",
                                camera=camera_name,
                                tracked=len(tracked), filtered=0,
                                zones=len(zones), labels=labels)

                # Attribute extraction + face recognition
                frame_count += 1

                # ── DIAGNOSTIC: Log pipeline stages every ~10 seconds ──
                if frame_count % (self.detection_fps * 10) == 1:  # Diag every 10 seconds
                    active_bufs = len([k for k in best_shot._buffers if k.startswith(camera_id)])
                    published_count = len([k for k in best_shot._published if k.startswith(camera_id)])
                    log.info("pipeline.diag", camera=camera_name,
                             raw_dets=pre_filter_count,
                             after_class_filter=len(detections),
                             tracked=len(tracked),
                             after_zone_filter=len(filtered),
                             zones_configured=len(zones),
                             best_shot_buffers=active_bufs,
                             best_shot_published=published_count)
                run_face = (frame_count % face_every_n == 0) and face_recognizer.available
                for det in tracked:
                    base_label = det.label.split(":")[0]

                    # Extract clothing colors and headgear for persons
                    # Skip if crop region is low quality (avoids inventing colors from gray frames)
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

                    # Extract vehicle attributes (color, type, plate)
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

                # Multi-face detection: detect all faces in full frame at once
                if run_face and any(d.label.split(":")[0] == "person" for d in tracked):
                    person_dets = [d for d in tracked if d.label.split(":")[0] == "person"]
                    try:
                        face_results = await face_recognizer.recognize_all_faces(frame, camera_id, person_dets)
                        for result in face_results:
                            # Find the detection with matching tracker_id and update its metadata
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

                # ── PERSON COUNT: Publish periodic count of persons in frame ──
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
                            await publisher.publish_person_count(
                                camera_id, camera_name,
                                len(person_dets_count), details, frame,
                            )
                        except Exception as e:
                            log.debug("person_count.error", error=str(e))

                # ── LINE CROSSING: Detect when objects cross a tripwire zone ──
                if detect_classes and "line_crossing" in detect_classes and zones:
                    tripwires = [z for z in zones if z.get("zone_type") == "tripwire"]
                    for tw in tripwires:
                        tw_id = str(tw.get("id", ""))
                        if tw_id not in line_crossing_state:
                            line_crossing_state[tw_id] = {}
                        points = tw.get("points", [])
                        if len(points) >= 2:
                            p1 = points[0]
                            p2 = points[1]
                            lx1, ly1 = p1.get("x", 0), p1.get("y", 0)
                            lx2, ly2 = p2.get("x", 0), p2.get("y", 0)
                            # Line direction vector (perpendicular determines side)
                            dx, dy = lx2 - lx1, ly2 - ly1
                            for det in filtered:
                                h_f, w_f = frame.shape[:2]
                                cx = ((det.bbox[0] + det.bbox[2]) / 2) / w_f
                                cy = ((det.bbox[1] + det.bbox[3]) / 2) / h_f
                                # Cross product determines which side of the line
                                cross = (cx - lx1) * dy - (cy - ly1) * dx
                                side = "A" if cross > 0 else "B"
                                prev_side = line_crossing_state[tw_id].get(det.tracker_id)
                                if prev_side and prev_side != side:
                                    # Crossed the line!
                                    direction = f"{prev_side}→{side}"
                                    if det.metadata is None:
                                        det.metadata = {}
                                    det.metadata["line_crossing"] = True
                                    det.metadata["crossing_direction"] = direction
                                    det.metadata["tripwire_id"] = tw_id
                                    log.info("line_crossing.detected",
                                             camera=camera_name,
                                             tracker_id=det.tracker_id,
                                             label=det.label,
                                             direction=direction)
                                line_crossing_state[tw_id][det.tracker_id] = side

                # Publish real-time tracking positions via Redis pub/sub
                # Use ALL tracked detections (not zone-filtered) so overlay shows everything
                # Zones only affect ALERTS (best_shot), not the live overlay
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
                            ft, fr, fb, fl = d.metadata["face_bbox"]
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

                import json as _json
                await self.redis.publish(
                    "tracking",
                    _json.dumps({
                        "camera_id": camera_id,
                        "tracks": tracks,
                        "person_count": person_count_rt,
                    }),
                )

                # ── BEST-SHOT: Feed all detections, publish nothing yet ──
                best_shot.cleanup()
                current_tracker_ids = set()

                for det in filtered:
                    current_tracker_ids.add(det.tracker_id)
                    best_shot.update(
                        camera_id=camera_id,
                        tracker_id=det.tracker_id,
                        label=det.label,
                        class_id=det.class_id,
                        frame=frame,
                        bbox=det.bbox,
                        confidence=det.confidence,
                        metadata=det.metadata or {},
                    )

                # Step 2: Collect ready events — pass current_frame for snapshot
                from tracker import TrackedDetection as TD
                ready_events = best_shot.collect(camera_id, current_tracker_ids,
                                                  current_frame=frame)

                for buf, candidate in ready_events:
                    # ── PRE-PUBLISH QUALITY GATE ──
                    quality = EventValidator.check_frame_quality(
                        candidate.frame, candidate.bbox
                    )
                    if not quality["is_valid"]:
                        log.info("event.pre_publish_rejected",
                                 camera=camera_name,
                                 label=buf.label,
                                 reason=quality["reason"],
                                 tracker_id=buf.tracker_id)
                        continue

                    best_det = TD(
                        bbox=candidate.bbox,
                        label=buf.label,
                        confidence=candidate.confidence,
                        class_id=buf.class_id,
                        tracker_id=buf.tracker_id,
                        is_new=True,
                        metadata=candidate.metadata,
                    )

                    # Skip clothing color extraction if crop quality is poor
                    base_label_pub = buf.label.split(":")[0]
                    if base_label_pub == "person" and quality.get("variance", 9999) < 400:
                        if best_det.metadata:
                            for key in ("upper_color", "lower_color", "headgear"):
                                best_det.metadata.pop(key, None)

                    # Create video clip from ring buffer
                    clip_path = None
                    try:
                        pre_frames = ring_buffer.get_pre_event_frames(seconds=10)
                        if len(pre_frames) >= 5:
                            clip_bytes = await loop.run_in_executor(
                                self.thread_pool,
                                create_clip, pre_frames, [], self.detection_fps
                            )
                            if clip_bytes:
                                from datetime import datetime, timezone
                                ts_str = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
                                clip_path = await save_clip_to_minio(
                                    publisher.minio, clip_bytes,
                                    _uuid.uuid4().hex,
                                    ts_str,
                                )
                    except Exception as e:
                        log.debug("ring_buffer.clip_error", error=str(e))

                    event_id = await publisher.publish(
                        camera_id=camera_id,
                        camera_name=camera_name,
                        detection=best_det,
                        frame=candidate.frame,
                        clip_path=clip_path,
                    )

                    # ── POST-PUBLISH VALIDATION ──
                    if event_id and self.event_validator:
                        await self.event_validator.submit(
                            event_id=event_id,
                            frame=candidate.frame,
                            bbox=candidate.bbox,
                            label=buf.label,
                            confidence=candidate.confidence,
                        )

                await asyncio.sleep(frame_interval)

            except Exception as e:
                log.error(
                    "detector.loop_error",
                    camera_id=camera_id,
                    error=str(e),
                )
                await asyncio.sleep(5)

        grabber.release()
        if camera_id in self.camera_tasks:
            del self.camera_tasks[camera_id]
        log.info("detector.camera_loop_ended", camera_id=camera_id, name=camera_name)

    async def _listen_camera_events(self, publisher, zone_manager, face_recognizer):
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
                        if event_type in ("camera_discovered", "camera_online"):
                            await self._start_camera_detections(publisher, zone_manager, face_recognizer)
                        elif event_type == "camera_offline":
                            cam_id = data.get("camera_id")
                            if cam_id in self.camera_tasks:
                                self.camera_tasks[cam_id].cancel()
                                del self.camera_tasks[cam_id]
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.warning("detector.event_listener_error", error=str(e))
                await asyncio.sleep(5)

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

    async def _refresh_loop(self, publisher, zone_manager, face_recognizer):
        """Periodically refresh camera list — starts new, stops disabled."""
        while self.running:
            await asyncio.sleep(30)
            try:
                await self._start_camera_detections(publisher, zone_manager, face_recognizer)
                active = len(self.camera_tasks)
                log.debug("detector.refresh", active_cameras=active)
            except Exception as e:
                log.warning("detector.refresh_error", error=str(e))

    async def stop(self):
        self.running = False
        # Stop event validator
        if self.event_validator:
            await self.event_validator.stop()
        # Stop batch detector first (unblocks waiting camera loops)
        if self.batch_detector:
            await self.batch_detector.stop()
        for task in self.camera_tasks.values():
            task.cancel()
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
