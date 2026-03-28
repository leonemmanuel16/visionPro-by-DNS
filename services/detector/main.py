"""DNS Vision AI - AI Detection Service

Pulls frames from go2rtc streams, runs YOLO detection,
tracks objects, and publishes detection events.
"""

import asyncio
import os
import signal
import sys
import json
from concurrent.futures import ThreadPoolExecutor

import asyncpg
import redis.asyncio as aioredis
import structlog

from detector import YOLODetector
from frame_grabber import FrameGrabber
from tracker import ObjectTracker
from zone_manager import ZoneManager
from event_publisher import EventPublisher
from face_recognizer import FaceRecognizer
from person_attributes import extract_person_attributes

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
        self.model_name = os.environ.get("MODEL_NAME", "yolov10n")
        self.detection_fps = int(os.environ.get("DETECTION_FPS", "5"))
        self.confidence_threshold = float(os.environ.get("CONFIDENCE_THRESHOLD", "0.5"))
        self.go2rtc_url = os.environ.get("GO2RTC_URL", "http://localhost:1984")
        self.device = os.environ.get("DEVICE", "auto")

        self.db_pool: asyncpg.Pool | None = None
        self.redis: aioredis.Redis | None = None
        self.running = True
        self.camera_tasks: dict[str, asyncio.Task] = {}
        self.thread_pool = ThreadPoolExecutor(max_workers=8)

    async def start(self):
        log.info("detector.starting", model=self.model_name, fps=self.detection_fps)

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

        # Initialize detector
        detector = YOLODetector(
            model_name=self.model_name,
            confidence=self.confidence_threshold,
            device=self.device,
        )

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
        await self._start_camera_detections(detector, publisher, zone_manager, face_recognizer)

        # Listen for camera events (new cameras, removed cameras)
        listener_task = asyncio.create_task(
            self._listen_camera_events(detector, publisher, zone_manager, face_recognizer)
        )

        # Periodically refresh camera list
        refresh_task = asyncio.create_task(
            self._refresh_loop(detector, publisher, zone_manager, face_recognizer)
        )

        log.info("detector.started")

        try:
            await asyncio.gather(listener_task, refresh_task)
        except asyncio.CancelledError:
            log.info("detector.shutting_down")

    async def _start_camera_detections(self, detector, publisher, zone_manager, face_recognizer):
        """Start detection tasks for all enabled cameras."""
        async with self.db_pool.acquire() as conn:
            cameras = await conn.fetch(
                "SELECT id, name, rtsp_sub_stream, rtsp_main_stream, camera_type FROM cameras WHERE is_enabled = true AND is_online = true"
            )

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
                        # Fisheye: use sub-stream (less distortion, YOLO works better)
                        stream_url = f"{rtsp_base}/cam_{cam_id_short}_sub"
                    else:
                        # Normal cameras: use main stream (1080p) for better face recognition
                        stream_url = f"{rtsp_base}/cam_{cam_id_short}"
                else:
                    if is_fisheye:
                        stream_url = cam["rtsp_sub_stream"] or cam["rtsp_main_stream"]
                    else:
                        stream_url = cam["rtsp_main_stream"] or cam["rtsp_sub_stream"]
                if stream_url:
                    task = asyncio.create_task(
                        self._detection_loop(
                            cam_id, cam["name"], stream_url, detector, publisher, zone_manager, face_recognizer
                        )
                    )
                    self.camera_tasks[cam_id] = task
                    stream_type = "sub" if is_fisheye else "main"
                    log.info("detector.camera_started", camera_id=cam_id, name=cam["name"], stream=stream_type)

    async def _detection_loop(
        self, camera_id, camera_name, stream_url, detector, publisher, zone_manager, face_recognizer
    ):
        """Main detection loop for a single camera."""
        grabber = FrameGrabber(stream_url, self.detection_fps, self.go2rtc_url)
        tracker = ObjectTracker()

        # Load zones for this camera
        zones = await zone_manager.get_zones(camera_id)

        frame_interval = 1.0 / self.detection_fps
        loop = asyncio.get_event_loop()
        frame_count = 0
        face_every_n = 3  # Run face recognition every N frames (balance speed vs detection)

        while self.running:
            try:
                # Grab frame in thread pool (blocking I/O)
                frame = await loop.run_in_executor(self.thread_pool, grabber.grab_frame)

                if frame is None:
                    log.debug("detector.frame_none", camera=camera_name)
                    await asyncio.sleep(1)
                    continue

                log.debug("detector.frame_ok", camera=camera_name, shape=f"{frame.shape[1]}x{frame.shape[0]}")

                # Run detection in thread pool (CPU/GPU bound)
                detections = await loop.run_in_executor(
                    self.thread_pool, detector.detect, frame
                )

                if not detections:
                    await asyncio.sleep(frame_interval)
                    continue

                # Track objects
                tracked = tracker.update(detections, frame)

                # Filter by zones
                filtered = zone_manager.filter_detections(tracked, zones)

                # Person attribute extraction + face recognition
                frame_count += 1
                run_face = (frame_count % face_every_n == 0) and face_recognizer.available
                for det in filtered:
                    # Extract clothing colors and headgear for all persons
                    if det.label == "person" or det.label.startswith("person:"):
                        try:
                            attrs = extract_person_attributes(frame, det.bbox)
                            if not hasattr(det, "metadata") or det.metadata is None:
                                det.metadata = {}
                            det.metadata["upper_color"] = attrs["upper_color"]
                            det.metadata["lower_color"] = attrs["lower_color"]
                            det.metadata["headgear"] = attrs["headgear"]
                        except Exception:
                            pass

                    if det.label == "person" and run_face:
                        try:
                            match = await face_recognizer.recognize(frame, det.bbox)
                            if match:
                                # Attach person info to detection metadata
                                if not hasattr(det, "metadata") or det.metadata is None:
                                    det.metadata = {}
                                det.metadata["person_id"] = match.person_id
                                det.metadata["person_name"] = match.person_name
                                det.metadata["face_confidence"] = f"{match.confidence:.2f}"
                                det.label = f"person:{match.person_name}"
                            else:
                                # Try to save unknown face with thumbnail
                                result = face_recognizer.detect_and_encode(frame, det.bbox)
                                if result:
                                    face_locations, encodings = result
                                    if encodings:
                                        # Mark that a face was detected (triggers event alert)
                                        if not hasattr(det, "metadata") or det.metadata is None:
                                            det.metadata = {}
                                        det.metadata["face_detected"] = True
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
                # (every frame, no debounce — for live bounding box overlay)
                if filtered:
                    h, w = frame.shape[:2]
                    tracks = []
                    for d in filtered:
                        x1, y1, x2, y2 = d.bbox
                        track = {
                            "id": f"t{d.tracker_id}",
                            "label": d.label.split(":")[0],  # "person" not "person:Juan"
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
                        # Extract person attributes (clothing colors, headgear)
                        if d.label.startswith("person"):
                            try:
                                attrs = extract_person_attributes(frame, d.bbox)
                                track["attributes"] = attrs
                            except Exception:
                                pass
                        tracks.append(track)

                    import json as _json
                    await self.redis.publish(
                        "tracking",
                        _json.dumps({
                            "camera_id": camera_id,
                            "tracks": tracks,
                        }),
                    )

                # Publish individual events ONLY when face was detected
                # (either recognized person or unknown face saved)
                for det in filtered:
                    has_face = (
                        hasattr(det, "metadata") and det.metadata
                        and (det.metadata.get("person_name") or det.metadata.get("face_detected"))
                    )
                    if has_face or not det.label.startswith("person"):
                        await publisher.publish(
                            camera_id=camera_id,
                            camera_name=camera_name,
                            detection=det,
                            frame=frame,
                        )

                # Publish person_count summary when multiple persons detected
                person_dets = [d for d in filtered if d.label.startswith("person")]
                if len(person_dets) >= 2:
                    person_details = []
                    for d in person_dets:
                        detail = {
                            "tracker_id": d.tracker_id,
                            "bbox": list(d.bbox),
                            "confidence": round(d.confidence, 2),
                        }
                        if hasattr(d, "metadata") and d.metadata:
                            detail["person_name"] = d.metadata.get("person_name", "Desconocido")
                            detail["person_id"] = d.metadata.get("person_id")
                        else:
                            detail["person_name"] = f"Persona {d.tracker_id}"
                        person_details.append(detail)

                    await publisher.publish_person_count(
                        camera_id=camera_id,
                        camera_name=camera_name,
                        person_count=len(person_dets),
                        person_details=person_details,
                        frame=frame,
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

    async def _listen_camera_events(self, detector, publisher, zone_manager, face_recognizer):
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
                            await self._start_camera_detections(detector, publisher, zone_manager, face_recognizer)
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

    async def _refresh_loop(self, detector, publisher, zone_manager, face_recognizer):
        """Periodically refresh camera list and zones."""
        while self.running:
            await asyncio.sleep(60)
            try:
                await self._start_camera_detections(detector, publisher, zone_manager, face_recognizer)
            except Exception as e:
                log.warning("detector.refresh_error", error=str(e))

    async def stop(self):
        self.running = False
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
