"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { Circle, Grid2X2, Maximize2, Move } from "lucide-react";
import { VideoPlayer } from "./VideoPlayer";
import { WebGLDewarper } from "./WebGLDewarper";

interface FisheyeDewarperProps {
  cameraName: string;
  isOnline: boolean;
  className?: string;
}

type ViewMode = "360" | "quad" | "panoramic" | "interactive";

/**
 * FisheyeDewarper — Client-side WebGL dewarping of fisheye cameras.
 *
 * Uses ONE video stream from go2rtc and renders dewarped views using
 * WebGL2 shaders directly in the browser. No server-side FFmpeg processing.
 *
 * View modes:
 * - 360° Original: raw fisheye stream
 * - 4 Vistas Planas: 4 WebGL canvases at 0°, 90°, 180°, 270°
 * - Panorámica: single wide equirectangular unwrap
 * - Interactivo: drag to pan/tilt, scroll to zoom
 */
export function FisheyeDewarper({ cameraName, isOnline, className = "" }: FisheyeDewarperProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("quad");
  const videoRef = useRef<HTMLVideoElement>(null);
  // Store video element in state so re-renders happen when it becomes available
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);

  // Poll for video readiness — videoRef.current is set by forwardRef,
  // but we need state to trigger a re-render when the element is available
  useEffect(() => {
    if (viewMode === "360") return; // No dewarping needed for 360° view
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout>;

    const checkVideo = () => {
      if (cancelled) return;
      const el = videoRef.current;
      if (el) {
        // Video element is mounted — store in state
        setVideoElement(el);
        // Also wait for actual video data to start WebGL rendering
        if (el.readyState < 2) {
          el.addEventListener("loadeddata", () => {
            if (!cancelled) setVideoElement(prev => prev === el ? el : el);
          }, { once: true });
        }
      } else {
        // Keep polling until the video element is available
        pollTimer = setTimeout(checkVideo, 50);
      }
    };
    // Small delay to let VideoPlayer mount
    pollTimer = setTimeout(checkVideo, 100);
    return () => { cancelled = true; clearTimeout(pollTimer); };
  }, [viewMode]);

  if (!isOnline) {
    return (
      <div className={`flex items-center justify-center bg-gray-200 rounded-lg aspect-video ${className}`}>
        <p className="text-sm text-gray-400">Cámara Offline</p>
      </div>
    );
  }

  return (
    <div className={className}>
      {/* View mode selector */}
      <div className="flex items-center gap-1 mb-3 flex-wrap">
        <button
          onClick={() => setViewMode("360")}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            viewMode === "360" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          <Circle className="h-3.5 w-3.5" /> 360° Original
        </button>
        <button
          onClick={() => setViewMode("quad")}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            viewMode === "quad" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          <Grid2X2 className="h-3.5 w-3.5" /> 4 Vistas Planas
        </button>
        <button
          onClick={() => setViewMode("panoramic")}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            viewMode === "panoramic" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          <Maximize2 className="h-3.5 w-3.5" /> Panorámica
        </button>
        <button
          onClick={() => setViewMode("interactive")}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            viewMode === "interactive" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          <Move className="h-3.5 w-3.5" /> Interactivo
        </button>
      </div>

      {/* 360° Original — raw fisheye */}
      {viewMode === "360" && (
        <div className="relative rounded-lg overflow-hidden border border-gray-200">
          <VideoPlayer cameraName={cameraName} isOnline={isOnline} className="aspect-video w-full" />
          <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded">
            360° Fisheye Original
          </div>
        </div>
      )}

      {/* WebGL dewarped views — all use ONE hidden video stream */}
      {viewMode !== "360" && (
        <>
          {/* Hidden video player — source for WebGL dewarping */}
          <div style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}>
            <VideoPlayer
              ref={videoRef}
              cameraName={cameraName}
              isOnline={isOnline}
              className="w-px h-px"
            />
          </div>

          <WebGLDewarper
            videoElement={videoElement}
            mode={viewMode === "quad" ? "quad" : viewMode === "panoramic" ? "panoramic" : "interactive"}
          />
        </>
      )}
    </div>
  );
}
