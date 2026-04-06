"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { Loader2, WifiOff } from "lucide-react";
import { getGo2rtcUrl } from "@/lib/urls";

interface SnapshotPlayerProps {
  cameraName: string;
  isOnline?: boolean;
  className?: string;
  /** Refresh interval in milliseconds (default: 1000ms) */
  intervalMs?: number;
  /** Image width in pixels (default: 640) */
  width?: number;
  /** Use main stream instead of sub for higher quality (default: false) */
  useMainStream?: boolean;
}

/**
 * Fast snapshot player for camera grid.
 *
 * Fetches JPEG frames from go2rtc at /api/frame.jpeg every ~1 second.
 * Uses double-buffering: loads next image in background, swaps on load.
 * Result: smooth ~1 FPS view with no flicker, 640px wide, very lightweight.
 */
export function SnapshotPlayer({
  cameraName,
  isOnline = true,
  className = "",
  intervalMs = 1000,
  width = 640,
  useMainStream = false,
}: SnapshotPlayerProps) {
  const [currentSrc, setCurrentSrc] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const mountedRef = useRef(true);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const failsRef = useRef(0);
  const activeStreamRef = useRef<string>("");
  const loadingRef = useRef(false);

  const go2rtcUrl = getGo2rtcUrl();

  const candidates = useMainStream
    ? [`${cameraName}`, `${cameraName}_sub`]         // Main first for quality
    : [`${cameraName}_sub`, `${cameraName}`];         // Sub first for speed

  const fetchFrame = useCallback(() => {
    if (!mountedRef.current || !isOnline || loadingRef.current) return;
    loadingRef.current = true;

    const stream = activeStreamRef.current || candidates[0];
    const img = new Image();
    const url = `${go2rtcUrl}/api/frame.jpeg?src=${stream}&width=${width}&t=${Date.now()}`;

    img.onload = () => {
      if (!mountedRef.current) return;
      loadingRef.current = false;
      setCurrentSrc(url);
      setLoading(false);
      setError(false);
      failsRef.current = 0;
      activeStreamRef.current = stream;
    };

    img.onerror = () => {
      if (!mountedRef.current) return;
      loadingRef.current = false;
      failsRef.current++;

      // Try fallback stream
      if (failsRef.current === 1 && stream === candidates[0]) {
        activeStreamRef.current = candidates[1];
        fetchFrame();
        return;
      }

      if (failsRef.current >= 5) {
        setError(true);
        setLoading(false);
      }
    };

    img.src = url;
  }, [go2rtcUrl, cameraName, isOnline]);

  useEffect(() => {
    mountedRef.current = true;
    failsRef.current = 0;
    activeStreamRef.current = "";
    loadingRef.current = false;

    if (!isOnline) {
      setLoading(false);
      setError(false);
      return;
    }

    // First frame
    fetchFrame();

    // Continuous refresh
    timerRef.current = setInterval(fetchFrame, intervalMs);

    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [cameraName, isOnline, intervalMs, fetchFrame]);

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
      {currentSrc && !error && (
        <img
          src={currentSrc}
          alt={cameraName}
          className="w-full h-full object-contain"
          draggable={false}
        />
      )}

      {loading && !currentSrc && (
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
