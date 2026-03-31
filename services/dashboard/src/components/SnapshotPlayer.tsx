"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { Loader2, WifiOff } from "lucide-react";
import { getGo2rtcUrl } from "@/lib/urls";

interface SnapshotPlayerProps {
  cameraName: string;
  isOnline?: boolean;
  className?: string;
  /** Refresh interval in milliseconds (default: 1500ms) */
  intervalMs?: number;
}

/**
 * Lightweight snapshot player for camera grid.
 *
 * Instead of maintaining a WebRTC/HLS connection per camera,
 * fetches a JPEG snapshot from go2rtc every N seconds.
 * 19 cameras × 1 JPEG/sec = ~19 small HTTP requests vs 19 video streams.
 */
export function SnapshotPlayer({
  cameraName,
  isOnline = true,
  className = "",
  intervalMs = 1500,
}: SnapshotPlayerProps) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);
  const failCountRef = useRef(0);
  const MAX_FAILS = 5;

  const go2rtcUrl = getGo2rtcUrl();

  // Stream candidates — try sub-stream first (lighter, often H.264)
  const candidates = [
    `${cameraName}_sub`,
    `${cameraName}`,
  ];

  const fetchSnapshot = useCallback(async () => {
    if (!mountedRef.current || !isOnline) return;

    for (const stream of candidates) {
      try {
        const url = `${go2rtcUrl}/api/frame.jpeg?src=${stream}&t=${Date.now()}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) continue;

        const blob = await res.blob();
        if (!mountedRef.current) return;

        if (blob.size < 500) continue; // Too small = probably error frame

        const objectUrl = URL.createObjectURL(blob);
        setImgSrc((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return objectUrl;
        });
        setLoading(false);
        setError(false);
        failCountRef.current = 0;
        return; // Success — stop trying candidates
      } catch {
        continue;
      }
    }

    // All candidates failed
    failCountRef.current++;
    if (failCountRef.current >= MAX_FAILS) {
      setError(true);
      setLoading(false);
    }
  }, [go2rtcUrl, cameraName, isOnline]);

  useEffect(() => {
    mountedRef.current = true;
    failCountRef.current = 0;

    if (!isOnline) {
      setLoading(false);
      setError(false);
      return;
    }

    // Initial fetch
    fetchSnapshot();

    // Periodic refresh
    timerRef.current = setInterval(fetchSnapshot, intervalMs);

    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      setImgSrc((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, [cameraName, isOnline, intervalMs, fetchSnapshot]);

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
      {imgSrc && !error && (
        <img
          src={imgSrc}
          alt={cameraName}
          className="w-full h-full object-contain"
          draggable={false}
        />
      )}

      {loading && !imgSrc && (
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
