"use client";

import { useState } from "react";
import { VideoPlayer } from "./VideoPlayer";
import { Maximize2, Grid2X2, Circle } from "lucide-react";

interface FisheyeDewarperProps {
  cameraName: string;
  isOnline: boolean;
  className?: string;
}

type ViewMode = "360" | "quad" | "single";

const QUAD_LABELS = [
  { id: "nw", label: "Vista 1 (NO)", rotation: 0 },
  { id: "ne", label: "Vista 2 (NE)", rotation: 90 },
  { id: "sw", label: "Vista 3 (SO)", rotation: 180 },
  { id: "se", label: "Vista 4 (SE)", rotation: 270 },
];

export function FisheyeDewarper({ cameraName, isOnline, className = "" }: FisheyeDewarperProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("quad");
  const [selectedQuad, setSelectedQuad] = useState<number | null>(null);

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
          <Grid2X2 className="h-3.5 w-3.5" /> 4 Vistas
        </button>
        {viewMode === "quad" && selectedQuad !== null && (
          <button
            onClick={() => setSelectedQuad(null)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-gray-100 text-gray-600 hover:bg-gray-200"
          >
            ← Volver al grid
          </button>
        )}
      </div>

      {/* 360 Original View */}
      {viewMode === "360" && (
        <div className="relative rounded-lg overflow-hidden border border-gray-200">
          <VideoPlayer cameraName={cameraName} isOnline={isOnline} className="aspect-video w-full" />
          <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded">
            360° Fisheye Original
          </div>
        </div>
      )}

      {/* Quad View - 4 dewarped views */}
      {viewMode === "quad" && selectedQuad === null && (
        <div className="grid grid-cols-2 gap-2">
          {QUAD_LABELS.map((quad, i) => (
            <button
              key={quad.id}
              onClick={() => setSelectedQuad(i)}
              className="relative rounded-lg overflow-hidden border border-gray-200 hover:border-blue-400 transition-colors group"
            >
              <div className="relative aspect-video bg-gray-900">
                {/* Simulated dewarped view - clips different quadrant of the fisheye */}
                <div
                  className="absolute inset-0 overflow-hidden"
                  style={{
                    /* CSS transform to simulate dewarping each quadrant */
                  }}
                >
                  <VideoPlayer
                    cameraName={cameraName}
                    isOnline={isOnline}
                    className="w-full h-full"
                  />
                  {/* Overlay to differentiate quadrants visually */}
                  <div className="absolute inset-0" style={{
                    clipPath: i === 0 ? "inset(0 50% 50% 0)" :
                              i === 1 ? "inset(0 0 50% 50%)" :
                              i === 2 ? "inset(50% 50% 0 0)" :
                                        "inset(50% 0 0 50%)",
                    transform: "scale(2)",
                    transformOrigin: i === 0 ? "top left" :
                                     i === 1 ? "top right" :
                                     i === 2 ? "bottom left" :
                                               "bottom right",
                  }}>
                    <VideoPlayer
                      cameraName={cameraName}
                      isOnline={isOnline}
                      className="w-full h-full"
                    />
                  </div>
                </div>

                {/* Label */}
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2">
                  <span className="text-[11px] font-medium text-white">{quad.label}</span>
                </div>

                {/* Expand icon on hover */}
                <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="bg-black/60 p-1 rounded">
                    <Maximize2 className="h-3.5 w-3.5 text-white" />
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Single expanded quad view */}
      {viewMode === "quad" && selectedQuad !== null && (
        <div className="relative rounded-lg overflow-hidden border border-gray-200">
          <div className="relative aspect-video bg-gray-900 overflow-hidden">
            <div className="absolute inset-0" style={{
              clipPath: selectedQuad === 0 ? "inset(0 50% 50% 0)" :
                        selectedQuad === 1 ? "inset(0 0 50% 50%)" :
                        selectedQuad === 2 ? "inset(50% 50% 0 0)" :
                                             "inset(50% 0 0 50%)",
              transform: "scale(2)",
              transformOrigin: selectedQuad === 0 ? "top left" :
                               selectedQuad === 1 ? "top right" :
                               selectedQuad === 2 ? "bottom left" :
                                                    "bottom right",
            }}>
              <VideoPlayer
                cameraName={cameraName}
                isOnline={isOnline}
                className="w-full h-full"
              />
            </div>
          </div>
          <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded">
            {QUAD_LABELS[selectedQuad].label} — Dewarped
          </div>

          {/* Quad selector thumbnails */}
          <div className="absolute bottom-2 right-2 flex gap-1">
            {QUAD_LABELS.map((_, i) => (
              <button
                key={i}
                onClick={() => setSelectedQuad(i)}
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
