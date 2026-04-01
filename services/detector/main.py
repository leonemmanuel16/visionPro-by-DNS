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
        self.confidence_threshold = float(os.environ.get("CONFIDENCE_THRESHOLD", "0.5"))
        self.go2rtc_url = os.environ.get("GO2RTC_URL", "http://localhost:1984")
        self.device = os.environ.get("DEVICE", "auto")
        self.ring_buffer_seconds = int(os.environ.get("RING_BUFFER_SECONDS", "15"))
        self.max_batch_size = int(os.environ.get("MAX_BATCH_SIZE", "8"))
        self.use_gpu_decode = os.environ.get("USE_GPU_DECODE", "true").lower() == "true"

        self.db_pool: asyncpg.Pool | None = None
        self.redis: aioredis.Redis | None = None
        self.running = True
        self.camera_tasks: dict[str, asyncio.Task] = {}
        self.thread_pool = ThreadPoolExecutor(max_workers=8)
        self.batch_detector: BatchDetector | None = None

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
            batch_timeout=0.05,
        )
        await self.batch_detector.start()

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

        for cam in cameras:
            cam_id = str(cam["id"])
            if cam_id not in self.camera_tasks:
                cam_id_short = cam_id.replace("-", "")[:12]
                cam_name_lower = (cam["name"] or "").lower()
                cam_type = (cam.get("camera_type") or "").lower()
                is_fisheye = "fisheye" in cam_name_lower or "fish" in cam_name_lower or cam_type == "fisheye"

                if self.go2rtc_url:
                    rtsp_base = self.go2rtc_url.replace("http://", "rtsp://").replace(":1984", ":8554")
                    if is_fisheye:
                        stream_url = f"{rtsp_base}/cam_{cam_id_short}_sub"
                    else:
                        stream_url = f"{rtsp_base}/cam_{cam_id_short}"
                else:
                    if is_fisheye:
                        stream_url = cam["rtsp_sub_stream"] or cam["rtsp_main_stream"]
                    else:
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
                            zone_manager, face_recognizer, detect_classes=detect_classes
                        )
                    )
                    self.camera_tasks[cam_id] = task
                    stream_type = "sub" if is_fisheye else "main"
                    log.info("detector.camera_started", camera_id=cam_id, name=cam["name"],
                             stream=stream_type, detect_classes=detect_classes)

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
        """Create frame grabber: GPU (NVDEC) with CPU fallback."""
        if self.use_gpu_decode and self.device != "cpu":
            try:
                grabber = GpuFrameGrabber(stream_url, self.detection_fps)
                # Test connection
                test_frame = grabber.grab_frame()
                if test_frame is not None:
                    log.info("detector.using_gpu_grabber", camera=camera_name)
                    return grabber
                else:
                    raise RuntimeError("GPU grabber test frame was None")
            except Exception as e:
                log.warning("detector.gpu_grabber_failed", camera=camera_name,
                            error=str(e), msg="Falling back to CPU frame grabber")
                # Clean up failed grabber
                try:
                    grabber.release()
                except Exception:
                    pass

        # CPU fallback
        log.info("detector.using_cpu_grabber", camera=camera_name)
        return FrameGrabber(stream_url, self.detection_fps, self.go2rtc_url,
                            use_cuda=False)

    async def _detection_loop(
        self, camera_id, camera_name, stream_url, publisher,
        zone_manager, face_recognizer, detect_classes=None
    ):
        """Main detection loop for a single camera."""
        loop = asyncio.get_event_loop()

        # Create frame grabber (GPU NVDEC with CPU fallback)
        grabber = await loop.run_in_executor(
            self.thread_pool, self._create_grabber, stream_url, camera_name
        )

        tracker = ObjectTracker()
        best_shot = BestShotSelector(
            min_bbox_area=12000,
            min_person_height=120,
            max_hold_time=8.0,
            gone_frames=15,
            confidence_threshold=0.5,
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

        while self.running:
            try:
                # Periodically verify camera is still enabled in DB
                if frame_count > 0 and frame_count % enable_check_interval == 0:
                    try:
                        async with self.db_pool.acquire() as conn:
                            still_enabled = await conn.fetchval(
                                "SELECT is_enabled FROM cameras WHERE id = $1",
                                _uuid.UUID(camera_id)
                            )
                        if not still_enabled:
                            log.info("detector.camera_disabled", camera_id=camera_id, name=camera_name)
                            break
                    except Exception:
                        pass

                # Grab frame in thread pool (blocking I/O)
                frame = await loop.run_in_executor(self.thread_pool, grabber.grab_frame)

                if frame is None:
                    log.debug("detector.frame_none", camera=camera_name)
                    await asyncio.sleep(1)
                    continue

                log.debug("detector.frame_ok", camera=camera_name, shape=f"{frame.shape[1]}x{frame.shape[0]}")

                # Push frame to ring buffer (for video clips)
                ring_buffer.push(frame)

                # Submit frame to batch detector (waits for batched inference)
                detections = await self.batch_detector.submit(frame)

                if not detections:
                    await asyncio.sleep(frame_interval)
                    continue

                # Filter by per-camera detect_classes
                if detect_classes:
                    allowed = set(detect_classes)
                    detections = [
                        d for d in detections
                        if self.YOLO_TO_CLASS.get(d.label.split(":")[0], d.label.split(":")[0]) in allowed
                    ]
                    if not detections:
                        await asyncio.sleep(frame_interval)
                        continue

                # Track objects
                tracked = tracker.update(detections, frame)

                # Filter by zones
                filtered = zone_manager.filter_detections(tracked, zones)

                # Attribute extraction + face recognition
                frame_count += 1
                run_face = (frame_count % face_every_n == 0) and face_recognizer.available
                for det in filtered:
                    base_label = det.label.split(":")[0]

                    # Extract clothing colors and headgear for persons
                    if base_label == "person":
                        try:
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

                    if det.label == "person" and run_face:
                        bw = det.bbox[2] - det.bbox[0]
                        bh = det.bbox[3] - det.bbox[1]
                        if bw < 40 or bh < 80 or (bw * bh) < 5000:
                            continue
                        try:
                            match = await face_recognizer.recognize(frame, det.bbox)
                            if match:
                                if det.metadata is None:
                                    det.metadata = {}
                                det.metadata["person_id"] = match.person_id
                                det.metadata["person_name"] = match.person_name
                                det.metadata["face_confidence"] = f"{match.confidence:.2f}"
                                det.label = f"person:{match.person_name}"
                                face_result = face_recognizer.detect_and_encode(frame, det.bbox)
                                if face_result:
                                    face_locs, _ = face_result
                                    if face_locs:
                                        det.metadata["face_bbox"] = face_locs[0]
                                        det.metadata["face_detected"] = True
                            else:
                                result = face_recognizer.detect_and_encode(frame, det.bbox)
                                if result:
                                    face_locations, encodings = result
                                    if encodings:
                                        if det.metadata is None:
                                            det.metadata = {}
                                        det.metadata["face_detected"] = True
                                        if face_locations:
                                            det.metadata["face_bbox"] = face_locations[0]
                                        face_loc = face_locations[0] if face_locations else None
                                        await face_recognizer.save_unknown_face(
                                            encoding=encodings[0],
                                            camera_id=camera_id,
                                            frame=frame,
                                            person_bbox=det.bbox,
                                            face_location=face_loc,
                                        )
                        except Exception as e:
                            log.debug("face_recognition.error", error=str(e))

                # Publish real-time tracking positions via Redis pub/sub
                if filtered:
                    h, w = frame.shape[:2]
                    tracks = []
                    for d in filtered:
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

                    import json as _json
                    await self.redis.publish(
                        "tracking",
                        _json.dumps({
                            "camera_id": camera_id,
                            "tracks": tracks,
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
                    best_det = TD(
                        bbox=candidate.bbox,
                        label=buf.label,
                        confidence=candidate.confidence,
                        class_id=buf.class_id,
                        tracker_id=buf.tracker_id,
                        is_new=True,
                        metadata=candidate.metadata,
                    )

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

                    await publisher.publish(
                        camera_id=camera_id,
                        camera_name=camera_name,
                        detection=best_det,
                        frame=candidate.frame,
                        clip_path=clip_path,
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
