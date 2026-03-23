"use client";

import { useState } from "react";
import { Maximize2, Grid2X2, Circle } from "lucide-react";
import { VideoPlayer } from "./VideoPlayer";

interface FisheyeDewarperProps {
  cameraName: string;
  isOnline: boolean;
  className?: string;
}

type ViewMode = "360" | "quad" | "single";

const QUAD_LABELS = [
  { label: "Vista 1 — Norte", suffix: "_dw0" },
  { label: "Vista 2 — Este", suffix: "_dw1" },
  { label: "Vista 3 — Sur", suffix: "_dw2" },
  { label: "Vista 4 — Oeste", suffix: "_dw3" },
];

/**
 * FisheyeDewarper — Shows fisheye camera in 360° or 4 flat dewarped views.
 *
 * Uses go2rtc server-side FFmpeg v360 filter to transform fisheye→flat:
 *   cam_XXX_dw0 = yaw 0°   (North)
 *   cam_XXX_dw1 = yaw 90°  (East)
 *   cam_XXX_dw2 = yaw 180° (South)
 *   cam_XXX_dw3 = yaw 270° (West)
 *
 * Each dewarped stream is a separate H.264 output from go2rtc,
 * giving true rectilinear flat views without browser-side processing.
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

      {/* 360° Original — full fisheye stream */}
      {viewMode === "360" && (
        <div className="relative rounded-lg overflow-hidden border border-gray-200">
          <VideoPlayer cameraName={cameraName} isOnline={isOnline} className="aspect-video w-full" />
          <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded">
            360° Fisheye Original
          </div>
        </div>
      )}

      {/* 4 Vistas Planas — dewarped streams from go2rtc */}
      {viewMode === "quad" && selectedQuad === null && (
        <div className="grid grid-cols-2 gap-2">
          {QUAD_LABELS.map((quad, i) => (
            <button
              key={i}
              onClick={() => setSelectedQuad(i)}
              className="relative rounded-lg overflow-hidden border border-gray-200 hover:border-blue-400 transition-colors group"
            >
              <VideoPlayer
                cameraName={`${cameraName}${quad.suffix}`}
                isOnline={isOnline}
                className="aspect-[4/3]"
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
          <VideoPlayer
            cameraName={`${cameraName}${QUAD_LABELS[selectedQuad].suffix}`}
            isOnline={isOnline}
            className="aspect-video w-full"
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
