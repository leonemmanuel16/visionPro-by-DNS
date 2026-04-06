"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { Loader2, WifiOff } from "lucide-react";
import { getGo2rtcUrl, getApiUrl } from "@/lib/urls";

interface SnapshotPlayerProps {
  cameraName: string;
  /** Camera UUID — used for AI snapshot endpoint */
  cameraId?: string;
  isOnline?: boolean;
  className?: string;
  /** Refresh interval in milliseconds (default: 200ms for AI snapshots) */
  intervalMs?: number;
  /** Image width in pixels (default: 640, only used for go2rtc fallback) */
  width?: number;
  /** Use main stream instead of sub for higher quality (default: false) */
  useMainStream?: boolean;
}

/**
 * AI Snapshot Player — shows video with detections already drawn.
 *
 * Primary: Fetches AI-annotated JPEGs from the detector via API.
 * These frames already have bounding boxes, labels, and tracking IDs drawn.
 * Fallback: If no AI snapshot available, falls back to go2rtc raw stream.
 */
export function SnapshotPlayer({
  cameraName,
  cameraId,
  isOnline = true,
  className = "",
  intervalMs = 200,
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
  const usingAiRef = useRef(true);

  const go2rtcUrl = getGo2rtcUrl();
  const apiUrl = getApiUrl();

  const candidates = useMainStream
    ? [`${cameraName}`, `${cameraName}_sub`]
    : [`${cameraName}_sub`, `${cameraName}`];

  const fetchFrame = useCallback(() => {
    if (!mountedRef.current || !isOnline || loadingRef.current) return;
    loadingRef.current = true;

    const img = new Image();
    let url: string;

    if (cameraId && usingAiRef.current) {
      // Primary: AI-annotated snapshot from detector
      url = `${apiUrl}/api/v1/cameras/${cameraId}/ai-snapshot?t=${Date.now()}`;
    } else {
      // Fallback: raw go2rtc snapshot
      const stream = activeStreamRef.current || candidates[0];
      url = `${go2rtcUrl}/api/frame.jpeg?src=${stream}&width=${width}&t=${Date.now()}`;
    }

    img.onload = () => {
      if (!mountedRef.current) return;
      loadingRef.current = false;
      setCurrentSrc(url);
      setLoading(false);
      setError(false);
      failsRef.current = 0;
    };

    img.onerror = () => {
      if (!mountedRef.current) return;
      loadingRef.current = false;
      failsRef.current++;

      // If AI snapshot fails, fall back to go2rtc
      if (usingAiRef.current && failsRef.current <= 3) {
        usingAiRef.current = false;
        failsRef.current = 0;
        fetchFrame();
        return;
      }

      // Try fallback go2rtc stream
      const stream = activeStreamRef.current || candidates[0];
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
  }, [go2rtcUrl, apiUrl, cameraName, cameraId, isOnline, width]);

  useEffect(() => {
    mountedRef.current = true;
    failsRef.current = 0;
    activeStreamRef.current = "";
    loadingRef.current = false;
    usingAiRef.current = !!cameraId;

    if (!isOnline) {
      setLoading(false);
      setError(false);
      return;
    }

    fetchFrame();
    timerRef.current = setInterval(fetchFrame, intervalMs);

    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [cameraName, cameraId, isOnline, intervalMs, fetchFrame]);

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
