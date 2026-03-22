/**
 * Dynamic URL resolution for DNS Vision Pro.
 *
 * Priority:
 *   1. Explicit env var (NEXT_PUBLIC_API_URL, etc.)
 *   2. Derived from window.location (production)
 *   3. localhost fallback (dev only, SSR)
 */

function getBaseHost(): string {
  if (typeof window !== "undefined") {
    return window.location.hostname;
  }
  return "localhost";
}

function getBaseProtocol(): string {
  if (typeof window !== "undefined") {
    return window.location.protocol;
  }
  return "http:";
}

function getWsProtocol(): string {
  return getBaseProtocol() === "https:" ? "wss:" : "ws:";
}

/** API base URL (FastAPI on port 8000) */
export function getApiUrl(): string {
  if (process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }
  return `${getBaseProtocol()}//${getBaseHost()}:8000`;
}

/** go2rtc base URL (streaming relay on port 1984) */
export function getGo2rtcUrl(): string {
  if (process.env.NEXT_PUBLIC_GO2RTC_URL) {
    return process.env.NEXT_PUBLIC_GO2RTC_URL;
  }
  return `${getBaseProtocol()}//${getBaseHost()}:1984`;
}

/** WebSocket URL (FastAPI WS on port 8000) */
export function getWsUrl(): string {
  if (process.env.NEXT_PUBLIC_WS_URL) {
    return process.env.NEXT_PUBLIC_WS_URL;
  }
  return `${getWsProtocol()}//${getBaseHost()}:8000/ws`;
}
