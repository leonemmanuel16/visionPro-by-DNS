"use client";

import { useEffect, useState } from "react";

interface Detection {
  id: string;
  label: string;
  confidence: number;
  bbox: { x: number; y: number; w: number; h: number }; // percentages 0-100
  personName?: string; // if face recognized
  trackId?: number;
}

interface DetectionOverlayProps {
  detections: Detection[];
  showLabels?: boolean;
  showConfidence?: boolean;
  className?: string;
}

const LABEL_COLORS: Record<string, { border: string; bg: string; text: string }> = {
  person: { border: "#22c55e", bg: "rgba(34,197,94,0.15)", text: "#16a34a" },
  face: { border: "#3b82f6", bg: "rgba(59,130,246,0.15)", text: "#2563eb" },
  car: { border: "#f59e0b", bg: "rgba(245,158,11,0.15)", text: "#d97706" },
  truck: { border: "#f97316", bg: "rgba(249,115,22,0.15)", text: "#ea580c" },
  dog: { border: "#a855f7", bg: "rgba(168,85,247,0.15)", text: "#9333ea" },
  cat: { border: "#ec4899", bg: "rgba(236,72,153,0.15)", text: "#db2777" },
  default: { border: "#6b7280", bg: "rgba(107,114,128,0.15)", text: "#4b5563" },
};

export function DetectionOverlay({
  detections,
  showLabels = true,
  showConfidence = true,
  className = "",
}: DetectionOverlayProps) {
  return (
    <div className={`absolute inset-0 pointer-events-none ${className}`}>
      {detections.map((det) => {
        const colors = LABEL_COLORS[det.label] || LABEL_COLORS.default;
        const isRecognized = !!det.personName;

        return (
          <div
            key={det.id}
            className="absolute"
            style={{
              left: `${det.bbox.x}%`,
              top: `${det.bbox.y}%`,
              width: `${det.bbox.w}%`,
              height: `${det.bbox.h}%`,
            }}
          >
            {/* Bounding box */}
            <div
              className="absolute inset-0 rounded-sm"
              style={{
                border: `2px solid ${isRecognized ? "#3b82f6" : colors.border}`,
                backgroundColor: isRecognized ? "rgba(59,130,246,0.08)" : colors.bg,
              }}
            />

            {/* Corner markers for better visibility */}
            {[
              { top: -1, left: -1 },
              { top: -1, right: -1 },
              { bottom: -1, left: -1 },
              { bottom: -1, right: -1 },
            ].map((pos, i) => (
              <div
                key={i}
                className="absolute"
                style={{
                  ...pos,
                  width: 8,
                  height: 8,
                  borderColor: isRecognized ? "#3b82f6" : colors.border,
                  borderWidth: 3,
                  borderStyle: "solid",
                  borderTopStyle: pos.top !== undefined ? "solid" : "none",
                  borderBottomStyle: pos.bottom !== undefined ? "solid" : "none",
                  borderLeftStyle: pos.left !== undefined ? "solid" : "none",
                  borderRightStyle: pos.right !== undefined ? "solid" : "none",
                }}
              />
            ))}

            {/* Label */}
            {showLabels && (
              <div
                className="absolute left-0 flex items-center gap-1 px-1.5 py-0.5 rounded-b-sm"
                style={{
                  bottom: "100%",
                  backgroundColor: isRecognized ? "#3b82f6" : colors.border,
                  maxWidth: "200%",
                }}
              >
                {isRecognized ? (
                  <span className="text-[10px] font-bold text-white truncate">
                    {det.personName}
                  </span>
                ) : (
                  <>
                    <span className="text-[10px] font-medium text-white capitalize">
                      {det.label}
                    </span>
                    {showConfidence && (
                      <span className="text-[9px] text-white/80">
                        {Math.round(det.confidence * 100)}%
                      </span>
                    )}
                  </>
                )}
                {det.trackId !== undefined && (
                  <span className="text-[9px] text-white/70">#{det.trackId}</span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Demo detections for preview mode
export const DEMO_DETECTIONS: Record<string, Detection[]> = {
  "cam-001": [
    {
      id: "d1",
      label: "person",
      confidence: 0.94,
      bbox: { x: 30, y: 25, w: 15, h: 55 },
      personName: "Juan Pérez",
      trackId: 1,
    },
    {
      id: "d2",
      label: "person",
      confidence: 0.89,
      bbox: { x: 60, y: 30, w: 12, h: 50 },
      trackId: 2,
    },
  ],
  "cam-002": [
    {
      id: "d3",
      label: "car",
      confidence: 0.92,
      bbox: { x: 20, y: 40, w: 25, h: 30 },
      trackId: 5,
    },
    {
      id: "d4",
      label: "person",
      confidence: 0.87,
      bbox: { x: 55, y: 20, w: 10, h: 45 },
      personName: "Ana Martínez",
      trackId: 3,
    },
  ],
  "cam-003": [
    {
      id: "d5",
      label: "person",
      confidence: 0.96,
      bbox: { x: 40, y: 15, w: 18, h: 60 },
      personName: "Roberto Díaz",
      trackId: 7,
    },
  ],
  "cam-005": [
    {
      id: "d6",
      label: "person",
      confidence: 0.78,
      bbox: { x: 35, y: 30, w: 14, h: 48 },
      trackId: 9,
    },
    {
      id: "d7",
      label: "truck",
      confidence: 0.85,
      bbox: { x: 5, y: 45, w: 28, h: 35 },
      trackId: 10,
    },
  ],
};
