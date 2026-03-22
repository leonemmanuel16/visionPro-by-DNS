"""ONVIF WS-Discovery - Find cameras on the local network."""

import asyncio
import socket
import threading
from urllib.parse import urlparse

import structlog

log = structlog.get_logger()

ONVIF_SCOPE = "onvif://www.onvif.org"
DISCOVERY_TIMEOUT = 5


class ONVIFDiscovery:
    """Discover ONVIF cameras using WS-Discovery multicast."""

    async def discover(self, timeout: int = DISCOVERY_TIMEOUT) -> list[dict]:
        """Send WS-Discovery probe and collect ONVIF device endpoints.

        Returns list of dicts with 'ip', 'port', 'xaddrs' keys.
        """
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._discover_sync, timeout)

    def _discover_sync(self, timeout: int) -> list[dict]:
        """Synchronous WS-Discovery probe with robust error handling."""
        endpoints = []

        try:
            from wsdiscovery import WSDiscovery
        except ImportError:
            log.error("discovery.wsdiscovery_not_installed")
            return []

        wsd = None
        try:
            # Patch threading to handle invalid interfaces gracefully
            original_handle = None
            if hasattr(threading, "_handle_probe"):
                original_handle = threading._handle_probe

            wsd = WSDiscovery()

            try:
                wsd.start()
            except OSError as e:
                # Handle "No valid interfaces" or socket binding errors
                log.warning("discovery.start_failed", error=str(e))
                return []

            try:
                services = wsd.searchServices(timeout=timeout)
            except Exception as e:
                log.warning("discovery.search_failed", error=str(e))
                return []

            for service in services:
                try:
                    scopes = service.getScopes()
                    scope_strs = [str(s) for s in scopes]

                    # Filter for ONVIF devices
                    is_onvif = any("onvif" in s.lower() for s in scope_strs)
                    if not is_onvif:
                        continue

                    xaddrs = service.getXAddrs()
                    for xaddr in xaddrs:
                        try:
                            parsed = urlparse(xaddr)
                            ip = parsed.hostname
                            port = parsed.port or 80

                            if ip and not ip.startswith("169.254"):
                                endpoints.append(
                                    {
                                        "ip": ip,
                                        "port": port,
                                        "xaddr": xaddr,
                                        "scopes": scope_strs,
                                    }
                                )
                                log.debug(
                                    "discovery.endpoint_found", ip=ip, port=port, xaddr=xaddr
                                )
                        except Exception as e:
                            log.warning("discovery.parse_xaddr_failed", xaddr=xaddr, error=str(e))

                except Exception as e:
                    log.warning("discovery.service_parse_error", error=str(e))
                    continue

        except Exception as e:
            err_str = str(e)
            # Suppress noisy "No valid interfaces" errors, just warn once
            if "interface" in err_str.lower() or "socket" in err_str.lower():
                log.warning("discovery.network_error", error=err_str)
            else:
                log.error("discovery.ws_discovery_error", error=err_str)
        finally:
            if wsd:
                try:
                    wsd.stop()
                except Exception:
                    pass  # Ignore cleanup errors

        # Deduplicate by IP
        seen = set()
        unique = []
        for ep in endpoints:
            if ep["ip"] not in seen:
                seen.add(ep["ip"])
                unique.append(ep)

        log.info("discovery.results", total=len(endpoints), unique=len(unique))
        return unique
