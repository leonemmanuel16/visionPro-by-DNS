"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Maximize2, Grid2X2, Circle } from "lucide-react";
import { getGo2rtcUrl } from "@/lib/urls";

interface FisheyeDewarperProps {
  cameraName: string;
  isOnline: boolean;
  className?: string;
}

type ViewMode = "360" | "quad" | "single";

/**
 * Fisheye Dewarper — Converts 360° fisheye video into 4 flat perspective views.
 *
 * Uses Canvas + equirectangular-to-rectilinear remapping:
 * 1. Captures fisheye video frames
 * 2. For each of 4 quadrants (0°, 90°, 180°, 270°), maps pixels from the
 *    circular fisheye projection to a flat rectilinear view
 * 3. Renders dewarped frames onto individual canvases
 */
const QUAD_LABELS = [
  { angle: 0,   label: "Vista 1 — Norte" },
  { angle: 90,  label: "Vista 2 — Este" },
  { angle: 180, label: "Vista 3 — Sur" },
  { angle: 270, label: "Vista 4 — Oeste" },
];

export function FisheyeDewarper({ cameraName, isOnline, className = "" }: FisheyeDewarperProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("quad");
  const [selectedQuad, setSelectedQuad] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([null, null, null, null]);
  const animFrameRef = useRef<number>(0);
  const [videoReady, setVideoReady] = useState(false);

  const go2rtcUrl = getGo2rtcUrl();

  // Connect video to go2rtc WebRTC stream
  useEffect(() => {
    if (!isOnline || !videoRef.current) return;

    const video = videoRef.current;
    let pc: RTCPeerConnection | null = null;
    let cancelled = false;

    async function connect() {
      // Try candidates in order
      const candidates = [
        `${cameraName}_h264`,
        `${cameraName}_sub_h264`,
        `${cameraName}_sub`,
        cameraName,
      ];

      for (const candidate of candidates) {
        if (cancelled) return;

        try {
          pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
          });

          const connected = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), 6000);

            pc!.ontrack = (event) => {
              video.srcObject = event.streams[0];
              video.onloadeddata = () => {
                clearTimeout(timer);
                setVideoReady(true);
                resolve(true);
              };
            };

            pc!.oniceconnectionstatechange = () => {
              if (pc!.iceConnectionState === "failed") {
                clearTimeout(timer);
                resolve(false);
              }
            };

            pc!.addTransceiver("video", { direction: "recvonly" });
            pc!.addTransceiver("audio", { direction: "recvonly" });

            pc!.createOffer()
              .then((offer) => pc!.setLocalDescription(offer).then(() => offer))
              .then((offer) =>
                fetch(`${go2rtcUrl}/api/webrtc?src=${encodeURIComponent(candidate)}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/sdp" },
                  body: offer.sdp,
                })
              )
              .then((res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.text();
              })
              .then((sdp) => pc!.setRemoteDescription({ type: "answer", sdp }))
              .catch(() => {
                clearTimeout(timer);
                resolve(false);
              });
          });

          if (connected) return;
          pc.close();
        } catch {
          pc?.close();
        }
      }
    }

    connect();
    return () => {
      cancelled = true;
      pc?.close();
    };
  }, [cameraName, isOnline, go2rtcUrl]);

  // Dewarp rendering loop
  const dewarpFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) {
      animFrameRef.current = requestAnimationFrame(dewarpFrame);
      return;
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw === 0 || vh === 0) {
      animFrameRef.current = requestAnimationFrame(dewarpFrame);
      return;
    }

    // Fisheye center and radius
    const cx = vw / 2;
    const cy = vh / 2;
    const radius = Math.min(cx, cy);

    // Output size per quadrant
    const outW = 480;
    const outH = 360;

    // Field of view for each dewarped view (radians)
    const fov = Math.PI / 2; // 90 degrees

    // Which quadrants to render
    const quadsToRender = selectedQuad !== null ? [selectedQuad] : [0, 1, 2, 3];

    // Create offscreen canvas for source
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = vw;
    srcCanvas.height = vh;
    const srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true });
    if (!srcCtx) {
      animFrameRef.current = requestAnimationFrame(dewarpFrame);
      return;
    }
    srcCtx.drawImage(video, 0, 0);
    const srcData = srcCtx.getImageData(0, 0, vw, vh);
    const src = srcData.data;

    for (const qi of quadsToRender) {
      const canvas = canvasRefs.current[qi];
      if (!canvas) continue;

      const canvasIdx = selectedQuad !== null ? 0 : qi;
      const actualCanvas = selectedQuad !== null ? canvasRefs.current[0] : canvas;
      if (!actualCanvas) continue;

      actualCanvas.width = outW;
      actualCanvas.height = outH;
      const ctx = actualCanvas.getContext("2d");
      if (!ctx) continue;

      const imageData = ctx.createImageData(outW, outH);
      const dst = imageData.data;

      // Pan angle for this quadrant (in radians)
      const panAngle = (QUAD_LABELS[qi].angle * Math.PI) / 180;

      // For each output pixel, compute the corresponding fisheye pixel
      for (let oy = 0; oy < outH; oy++) {
        for (let ox = 0; ox < outW; ox++) {
          // Normalized coordinates in output (-1 to 1)
          const nx = (2 * ox) / outW - 1;
          const ny = (2 * oy) / outH - 1;

          // Convert to spherical coordinates
          const theta = panAngle + Math.atan2(nx, 1) * (fov / (Math.PI / 2));
          const phi = Math.atan2(ny, Math.sqrt(1 + nx * nx)) * (fov / (Math.PI / 2));

          // Convert spherical to equidistant fisheye radius
          const r = (Math.sqrt(theta * theta + phi * phi) / Math.PI) * radius * 2;

          // Angle in the fisheye image
          const angle = Math.atan2(phi, theta);

          // Map to fisheye pixel coordinates
          const fx = Math.round(cx + r * Math.cos(angle));
          const fy = Math.round(cy + r * Math.sin(angle));

          const dstIdx = (oy * outW + ox) * 4;

          if (fx >= 0 && fx < vw && fy >= 0 && fy < vh) {
            const srcIdx = (fy * vw + fx) * 4;
            dst[dstIdx] = src[srcIdx];
            dst[dstIdx + 1] = src[srcIdx + 1];
            dst[dstIdx + 2] = src[srcIdx + 2];
            dst[dstIdx + 3] = 255;
          } else {
            dst[dstIdx + 3] = 255; // black for out-of-bounds
          }
        }
      }

      ctx.putImageData(imageData, 0, 0);
    }

    animFrameRef.current = requestAnimationFrame(dewarpFrame);
  }, [selectedQuad]);

  // Start/stop dewarping loop
  useEffect(() => {
    if (!videoReady) return;

    animFrameRef.current = requestAnimationFrame(dewarpFrame);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [videoReady, dewarpFrame]);

  if (!isOnline) {
    return (
      <div className={`flex items-center justify-center bg-gray-200 rounded-lg aspect-video ${className}`}>
        <p className="text-sm text-gray-400">Cámara Offline</p>
      </div>
    );
  }

  return (
    <div className={className}>
      {/* Hidden video element — source for dewarping */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{ display: "none" }}
      />

      {/* View mode selector */}
      <div className="flex items-center gap-1 mb-3">
        <button
          onClick={() => { setViewMode("360"); setSelectedQuad(null); }}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            viewMode === "360" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          <Circle className="h-3.5 w-3.5" /> 360° Original
        </button>
        <button
          onClick={() => { setViewMode("quad"); setSelectedQuad(null); }}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            viewMode === "quad" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          <Grid2X2 className="h-3.5 w-3.5" /> 4 Vistas Planas
        </button>
        {selectedQuad !== null && (
          <button
            onClick={() => setSelectedQuad(null)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-gray-100 text-gray-600 hover:bg-gray-200"
          >
            ← Volver al grid
          </button>
        )}
      </div>

      {/* 360 Original — show raw video */}
      {viewMode === "360" && (
        <div className="relative rounded-lg overflow-hidden border border-gray-200 bg-black">
          <canvas
            ref={(el) => { canvasRefs.current[0] = el; }}
            className="w-full aspect-video"
            style={{ display: "none" }}
          />
          <video
            autoPlay
            playsInline
            muted
            ref={(el) => {
              if (el && videoRef.current?.srcObject) {
                el.srcObject = videoRef.current.srcObject;
              }
            }}
            className="w-full aspect-video object-contain"
          />
          <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded">
            360° Fisheye Original
          </div>
        </div>
      )}

      {/* Quad View — 4 dewarped flat views */}
      {viewMode === "quad" && selectedQuad === null && (
        <div className="grid grid-cols-2 gap-2">
          {QUAD_LABELS.map((quad, i) => (
            <button
              key={i}
              onClick={() => setSelectedQuad(i)}
              className="relative rounded-lg overflow-hidden border border-gray-200 hover:border-blue-400 transition-colors group"
            >
              <canvas
                ref={(el) => { canvasRefs.current[i] = el; }}
                className="w-full aspect-[4/3] bg-gray-900"
              />
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2">
                <span className="text-[11px] font-medium text-white">{quad.label}</span>
              </div>
              <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="bg-black/60 p-1 rounded">
                  <Maximize2 className="h-3.5 w-3.5 text-white" />
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Single expanded dewarped view */}
      {viewMode === "quad" && selectedQuad !== null && (
        <div className="relative rounded-lg overflow-hidden border border-gray-200">
          <canvas
            ref={(el) => { canvasRefs.current[0] = el; }}
            className="w-full aspect-video bg-gray-900"
          />
          <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded">
            {QUAD_LABELS[selectedQuad].label} — Dewarped
          </div>
          <div className="absolute bottom-2 right-2 flex gap-1">
            {QUAD_LABELS.map((_, i) => (
              <button
                key={i}
                onClick={(e) => { e.stopPropagation(); setSelectedQuad(i); }}
                className={`w-8 h-6 rounded border-2 text-[8px] font-bold flex items-center justify-center transition-colors ${
                  selectedQuad === i
                    ? "border-blue-500 bg-blue-600 text-white"
                    : "border-white/50 bg-black/40 text-white/80 hover:bg-black/60"
                }`}
              >
                {i + 1}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
