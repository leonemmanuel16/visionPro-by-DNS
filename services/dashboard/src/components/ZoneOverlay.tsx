"use client";

import { useState, useRef, MouseEvent } from "react";

interface Point {
  x: number;
  y: number;
}

export interface ZonePolygon {
  id: string;
  name: string;
  points: Point[];
  color: string;
}

interface ZoneOverlayProps {
  zones: ZonePolygon[];
  isDrawing: boolean;
  currentPoints: Point[];
  onAddPoint: (point: Point) => void;
  drawColor?: string;
}

const ZONE_COLORS = [
  { fill: "rgba(37,99,235,0.15)", stroke: "#2563eb", dot: "#2563eb" },
  { fill: "rgba(234,88,12,0.15)", stroke: "#ea580c", dot: "#ea580c" },
  { fill: "rgba(22,163,74,0.15)", stroke: "#16a34a", dot: "#16a34a" },
  { fill: "rgba(168,85,247,0.15)", stroke: "#a855f7", dot: "#a855f7" },
];

export function getZoneColor(index: number) {
  return ZONE_COLORS[index % ZONE_COLORS.length];
}

/**
 * SVG overlay that sits on top of the video.
 * Shows existing zone polygons and allows drawing new ones.
 */
export function ZoneOverlay({
  zones,
  isDrawing,
  currentPoints,
  onAddPoint,
  drawColor = "#2563eb",
}: ZoneOverlayProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  const handleClick = (e: MouseEvent<SVGSVGElement>) => {
    if (!isDrawing) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    onAddPoint({
      x: Math.round(x * 1000) / 1000,
      y: Math.round(y * 1000) / 1000,
    });
  };

  const toSvgPoints = (pts: Point[]) =>
    pts.map((p) => `${p.x * 100}%,${p.y * 100}%`).join(" ");

  return (
    <svg
      ref={svgRef}
      className={`absolute inset-0 w-full h-full z-10 ${
        isDrawing ? "cursor-crosshair" : "pointer-events-none"
      }`}
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
      onClick={handleClick}
    >
      {/* Existing zones */}
      {zones.map((zone, idx) => {
        const colors = ZONE_COLORS[idx % ZONE_COLORS.length];
        if (zone.points.length < 3) return null;
        const pts = zone.points.map((p) => `${p.x * 1000},${p.y * 1000}`).join(" ");
        return (
          <g key={zone.id}>
            <polygon
              points={pts}
              fill={colors.fill}
              stroke={colors.stroke}
              strokeWidth={3}
              strokeLinejoin="round"
            />
            {/* Zone label */}
            <text
              x={zone.points[0].x * 1000}
              y={zone.points[0].y * 1000 - 12}
              fill={colors.stroke}
              fontSize={28}
              fontWeight="bold"
              style={{ textShadow: "0 1px 3px rgba(0,0,0,0.6)" }}
            >
              {zone.name}
            </text>
            {/* Dots */}
            {zone.points.map((p, i) => (
              <circle
                key={i}
                cx={p.x * 1000}
                cy={p.y * 1000}
                r={8}
                fill={colors.dot}
                stroke="white"
                strokeWidth={2}
              />
            ))}
          </g>
        );
      })}

      {/* Drawing in progress */}
      {isDrawing && currentPoints.length > 0 && (
        <g>
          {/* Lines between points */}
          {currentPoints.length > 1 && (
            <polyline
              points={currentPoints.map((p) => `${p.x * 1000},${p.y * 1000}`).join(" ")}
              fill="none"
              stroke={drawColor}
              strokeWidth={3}
              strokeDasharray="8,4"
            />
          )}
          {/* Closing line (preview) */}
          {currentPoints.length >= 3 && (
            <line
              x1={currentPoints[currentPoints.length - 1].x * 1000}
              y1={currentPoints[currentPoints.length - 1].y * 1000}
              x2={currentPoints[0].x * 1000}
              y2={currentPoints[0].y * 1000}
              stroke={drawColor}
              strokeWidth={2}
              strokeDasharray="4,4"
              opacity={0.5}
            />
          )}
          {/* Fill preview */}
          {currentPoints.length >= 3 && (
            <polygon
              points={currentPoints.map((p) => `${p.x * 1000},${p.y * 1000}`).join(" ")}
              fill={`${drawColor}22`}
              stroke="none"
            />
          )}
          {/* Points */}
          {currentPoints.map((p, i) => (
            <circle
              key={i}
              cx={p.x * 1000}
              cy={p.y * 1000}
              r={i === 0 ? 10 : 7}
              fill={i === 0 ? "#22c55e" : drawColor}
              stroke="white"
              strokeWidth={2}
            />
          ))}
        </g>
      )}
    </svg>
  );
}
