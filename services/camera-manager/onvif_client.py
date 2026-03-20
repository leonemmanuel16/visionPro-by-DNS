"""ONVIF Client - Connect to cameras and retrieve device info."""

import asyncio
from typing import Any

import structlog
from cryptography.fernet import Fernet
import os
import base64
import hashlib

log = structlog.get_logger()

# Derive a Fernet key from a secret (or generate one)
_SECRET = os.environ.get("ENCRYPTION_KEY", "dns-vision-ai-default-key-change-me")
_KEY = base64.urlsafe_b64encode(hashlib.sha256(_SECRET.encode()).digest())
_FERNET = Fernet(_KEY)


def encrypt_password(password: str) -> str:
    """Encrypt a password for storage."""
    return _FERNET.encrypt(password.encode()).decode()


def decrypt_password(encrypted: str) -> str:
    """Decrypt a stored password."""
    return _FERNET.decrypt(encrypted.encode()).decode()


class ONVIFClient:
    """Connect to ONVIF cameras and retrieve device information."""

    def __init__(self, default_user: str = "admin", default_pass: str = "admin123"):
        self.default_user = default_user
        self.default_pass = default_pass

    async def get_camera_info(self, endpoint: dict) -> dict[str, Any] | None:
        """Connect to a camera and retrieve all relevant info.

        Args:
            endpoint: Dict with 'ip', 'port', 'xaddr' from discovery.

        Returns:
            Camera info dict or None if connection fails.
        """
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, self._get_camera_info_sync, endpoint
        )

    def _get_camera_info_sync(self, endpoint: dict) -> dict[str, Any] | None:
        """Synchronous ONVIF camera info retrieval."""
        ip = endpoint["ip"]
        port = endpoint["port"]

        try:
            from onvif import ONVIFCamera

            cam = ONVIFCamera(
                ip, port, self.default_user, self.default_pass
            )

            # Get device info
            device_info = cam.devicemgmt.GetDeviceInformation()
            device_log = {
                "manufacturer": getattr(device_info, "Manufacturer", "Unknown"),
                "model": getattr(device_info, "Model", "Unknown"),
                "firmware": getattr(device_info, "FirmwareVersion", "Unknown"),
                "serial_number": getattr(device_info, "SerialNumber", ""),
            }

            # Get network interfaces for MAC address
            mac_address = ""
            try:
                net_interfaces = cam.devicemgmt.GetNetworkInterfaces()
                if net_interfaces:
                    hw_addr = getattr(
                        getattr(net_interfaces[0], "Info", None),
                        "HwAddress",
                        "",
                    )
                    mac_address = hw_addr or ""
            except Exception:
                pass

            # Get media profiles and stream URIs
            media_service = cam.create_media_service()
            profiles = media_service.GetProfiles()

            rtsp_main = ""
            rtsp_sub = ""
            profile_token = ""

            if profiles:
                # Main stream (first profile, usually highest res)
                profile_token = profiles[0].token
                try:
                    stream_setup = {
                        "Stream": "RTP-Unicast",
                        "Transport": {"Protocol": "RTSP"},
                    }
                    uri_response = media_service.GetStreamUri(
                        {"StreamSetup": stream_setup, "ProfileToken": profile_token}
                    )
                    rtsp_main = uri_response.Uri
                except Exception as e:
                    log.warning("onvif.main_stream_failed", ip=ip, error=str(e))

                # Sub stream (second profile if available)
                if len(profiles) > 1:
                    try:
                        uri_response = media_service.GetStreamUri(
                            {
                                "StreamSetup": stream_setup,
                                "ProfileToken": profiles[1].token,
                            }
                        )
                        rtsp_sub = uri_response.Uri
                    except Exception:
                        rtsp_sub = rtsp_main  # Fallback to main

            # Check PTZ capability
            has_ptz = False
            try:
                ptz_service = cam.create_ptz_service()
                if ptz_service:
                    has_ptz = True
            except Exception:
                pass

            # Inject credentials into RTSP URLs
            rtsp_main = self._inject_credentials(rtsp_main, self.default_user, self.default_pass)
            rtsp_sub = self._inject_credentials(
                rtsp_sub or rtsp_main, self.default_user, self.default_pass
            )

            camera_info = {
                "ip_address": ip,
                "onvif_port": port,
                "username": self.default_user,
                "password_encrypted": encrypt_password(self.default_pass),
                "manufacturer": device_log["manufacturer"],
                "model": device_log["model"],
                "firmware": device_log["firmware"],
                "serial_number": device_log["serial_number"],
                "mac_address": mac_address,
                "rtsp_main_stream": rtsp_main,
                "rtsp_sub_stream": rtsp_sub,
                "onvif_profile_token": profile_token,
                "has_ptz": has_ptz,
                "name": f"{device_log['manufacturer']} {device_log['model']} ({ip})",
            }

            log.info(
                "onvif.camera_info_retrieved",
                ip=ip,
                manufacturer=device_log["manufacturer"],
                model=device_log["model"],
                has_ptz=has_ptz,
            )
            return camera_info

        except Exception as e:
            log.warning("onvif.connection_failed", ip=ip, port=port, error=str(e))
            return None

    @staticmethod
    def _inject_credentials(rtsp_url: str, username: str, password: str) -> str:
        """Inject username:password into an RTSP URL."""
        if not rtsp_url:
            return ""
        if "@" in rtsp_url:
            return rtsp_url
        return rtsp_url.replace("rtsp://", f"rtsp://{username}:{password}@")
