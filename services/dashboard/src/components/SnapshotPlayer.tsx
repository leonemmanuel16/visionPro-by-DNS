"use client";

import React, { useEffect, useRef, useState } from "react";
import { Loader2, WifiOff } from "lucide-react";
import { getGo2rtcUrl } from "@/lib/urls";

interface SnapshotPlayerProps {
  cameraName: string;
  isOnline?: boolean;
  className?: string;
  /** Ignored — kept for API compat. MJPEG streams continuously. */
  intervalMs?: number;
}

/**
 * MJPEG stream player for camera grid.
 *
 * Uses go2rtc's native MJPEG endpoint: /api/stream.mjpeg?src={stream}
 * The browser renders a continuous JPEG stream with ~0.5-1s latency.
 * No WebRTC negotiation, no JavaScript decoding, no buffering.
 * Just a native <img> tag that updates itself.
 *
 * Much lighter than WebRTC for 19+ cameras simultaneously.
 */
export function SnapshotPlayer({
  cameraName,
  isOnline = true,
  className = "",
}: SnapshotPlayerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<NodeJS.Timeout | null>(null);
  const MAX_RETRIES = 3;

  const go2rtcUrl = getGo2rtcUrl();

  // Stream candidates — sub-stream first (640x360, lighter)
  const candidates = [
    `${cameraName}_sub`,
    `${cameraName}`,
  ];

  useEffect(() => {
    if (!isOnline) {
      setLoading(false);
      setError(false);
      setStreamUrl(null);
      return;
    }

    // Try first candidate (sub-stream)
    retryCountRef.current = 0;
    const url = `${go2rtcUrl}/api/stream.mjpeg?src=${candidates[0]}&width=640`;
    setStreamUrl(url);
    setLoading(true);
    setError(false);

    return () => {
      setStreamUrl(null);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [cameraName, isOnline, go2rtcUrl]);

  const handleLoad = () => {
    setLoading(false);
    setError(false);
    retryCountRef.current = 0;
  };

  const handleError = () => {
    retryCountRef.current++;

    if (retryCountRef.current === 1) {
      // First fail: try main stream instead of sub
      const url = `${go2rtcUrl}/api/stream.mjpeg?src=${candidates[1]}&width=640`;
      setStreamUrl(url);
      return;
    }

    if (retryCountRef.current <= MAX_RETRIES) {
      // Retry with delay
      retryTimerRef.current = setTimeout(() => {
        const url = `${go2rtcUrl}/api/stream.mjpeg?src=${candidates[0]}&width=640&t=${Date.now()}`;
        setStreamUrl(url);
      }, 3000);
      return;
    }

    // All retries exhausted
    setError(true);
    setLoading(false);
  };

  if (!isOnline) {
    return (
      <div className={`relative bg-gray-900 flex items-center justify-center ${className}`}>
        <div className="text-center text-gray-500">
          <WifiOff className="h-8 w-8 mx-auto mb-1" />
          <span className="text-xs">Desconectada</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`relative bg-black overflow-hidden ${className}`}>
      {streamUrl && !error && (
        <img
          ref={imgRef}
          src={streamUrl}
          alt={cameraName}
          className="w-full h-full object-contain"
          draggable={false}
          onLoad={handleLoad}
          onError={handleError}
        />
      )}

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-6 w-6 text-blue-400 animate-spin" />
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-500">
          <div className="text-center">
            <WifiOff className="h-6 w-6 mx-auto mb-1" />
            <span className="text-[10px]">Sin señal</span>
          </div>
        </div>
      )}
    </div>
  );
}
