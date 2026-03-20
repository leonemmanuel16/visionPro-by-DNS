"""ONVIF WS-Discovery - Find cameras on the local network."""

import asyncio
from urllib.parse import urlparse

import structlog
from wsdiscovery import WSDiscovery

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
        """Synchronous WS-Discovery probe."""
        endpoints = []
        wsd = WSDiscovery()

        try:
            wsd.start()
            services = wsd.searchServices(timeout=timeout)

            for service in services:
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

                        if ip:
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
            log.error("discovery.ws_discovery_error", error=str(e))
        finally:
            wsd.stop()

        # Deduplicate by IP
        seen = set()
        unique = []
        for ep in endpoints:
            if ep["ip"] not in seen:
                seen.add(ep["ip"])
                unique.append(ep)

        log.info("discovery.results", total=len(endpoints), unique=len(unique))
        return unique
