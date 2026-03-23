"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Maximize2, Grid2X2, Circle, Loader2 } from "lucide-react";
import { VideoPlayer } from "./VideoPlayer";

interface FisheyeDewarperProps {
  cameraName: string;
  isOnline: boolean;
  className?: string;
}

type ViewMode = "360" | "quad" | "single";

const QUAD_LABELS = [
  { label: "Vista 1 — Norte" },
  { label: "Vista 2 — Este" },
  { label: "Vista 3 — Sur" },
  { label: "Vista 4 — Oeste" },
];

/**
 * FisheyeDewarper — Splits a fisheye camera into 4 flat perspective views.
 *
 * In "360° Original" mode: shows the raw fisheye stream via VideoPlayer.
 * In "4 Vistas Planas" mode: shows 4 CSS-cropped quadrants from the same stream,
 * each zoomed into a different quarter of the fisheye image to simulate dewarping.
 *
 * For proper server-side dewarping, go2rtc supports FFmpeg filters
 * (e.g. v360=fisheye:flat) which would give true rectilinear output.
 */
export function FisheyeDewarper({ cameraName, isOnline, className = "" }: FisheyeDewarperProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("quad");
  const [selectedQuad, setSelectedQuad] = useState<number | null>(null);

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

      {/* 360° Original — full stream */}
      {viewMode === "360" && (
        <div className="relative rounded-lg overflow-hidden border border-gray-200">
          <VideoPlayer cameraName={cameraName} isOnline={isOnline} className="aspect-video w-full" />
          <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded">
            360° Fisheye Original
          </div>
        </div>
      )}

      {/* 4 Vistas Planas — quad crop from the same stream */}
      {viewMode === "quad" && selectedQuad === null && (
        <div className="grid grid-cols-2 gap-2">
          {QUAD_LABELS.map((quad, i) => (
            <button
              key={i}
              onClick={() => setSelectedQuad(i)}
              className="relative rounded-lg overflow-hidden border border-gray-200 hover:border-blue-400 transition-colors group"
            >
              <FisheyeQuadrant
                cameraName={cameraName}
                isOnline={isOnline}
                quadrant={i}
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

      {/* Single expanded quadrant */}
      {viewMode === "quad" && selectedQuad !== null && (
        <div className="relative rounded-lg overflow-hidden border border-gray-200">
          <FisheyeQuadrant
            cameraName={cameraName}
            isOnline={isOnline}
            quadrant={selectedQuad}
            large
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

/**
 * FisheyeQuadrant — Shows one quadrant of a fisheye stream.
 * Uses CSS transform to zoom into a specific quarter of the circular image,
 * giving a semi-dewarped flat view effect.
 */
function FisheyeQuadrant({
  cameraName,
  isOnline,
  quadrant,
  large = false,
}: {
  cameraName: string;
  isOnline: boolean;
  quadrant: number;
  large?: boolean;
}) {
  // Each quadrant shows a zoomed/translated portion of the stream
  // Quadrant 0=top-left, 1=top-right, 2=bottom-left, 3=bottom-right
  const transforms: Record<number, { x: string; y: string }> = {
    0: { x: "0%", y: "0%" },      // top-left (North)
    1: { x: "-100%", y: "0%" },    // top-right (East)
    2: { x: "0%", y: "-100%" },    // bottom-left (South)
    3: { x: "-100%", y: "-100%" }, // bottom-right (West)
  };

  const t = transforms[quadrant];

  return (
    <div className={`relative bg-gray-900 overflow-hidden ${large ? "aspect-video" : "aspect-[4/3]"}`}>
      <div
        className="absolute"
        style={{
          width: "200%",
          height: "200%",
          left: t.x,
          top: t.y,
        }}
      >
        <VideoPlayer
          cameraName={cameraName}
          isOnline={isOnline}
          className="w-full h-full"
        />
      </div>
    </div>
  );
}
