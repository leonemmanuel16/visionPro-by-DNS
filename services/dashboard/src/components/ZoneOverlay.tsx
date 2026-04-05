"use client";

import { useRef, MouseEvent } from "react";

interface Point {
  x: number;
  y: number;
}

export interface ZonePolygon {
  id: string;
  name: string;
  points: Point[];
  color: string;
  direction?: "A_to_B" | "B_to_A" | "both";
  type?: "roi" | "tripwire";
}

interface ZoneOverlayProps {
  zones: ZonePolygon[];
  isDrawing: boolean;
  currentPoints: Point[];
  onAddPoint: (point: Point) => void;
  drawColor?: string;
  drawType?: "roi" | "tripwire";
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
 * Renders a tripwire line between two points with direction arrows and A/B labels.
 */
function TripwireLine({
  p1,
  p2,
  color,
  direction,
  name,
  markerId,
}: {
  p1: Point;
  p2: Point;
  color: string;
  direction?: "A_to_B" | "B_to_A" | "both";
  name: string;
  markerId: string;
}) {
  const x1 = p1.x * 1000;
  const y1 = p1.y * 1000;
  const x2 = p2.x * 1000;
  const y2 = p2.y * 1000;

  // Midpoint of the line
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;

  // Direction vector along the line
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return null;

  // Unit vector along the line
  const ux = dx / len;
  const uy = dy / len;

  // Perpendicular vector (pointing to the "right" of the line direction = B side)
  // A side is to the left, B side is to the right
  const px = -uy;
  const py = ux;

  const arrowLen = 40;
  const labelOffset = 55;
  const arrowHeadSize = 12;

  // A label position (left side of line)
  const aX = mx - px * labelOffset;
  const aY = my - py * labelOffset;

  // B label position (right side of line)
  const bX = mx + px * labelOffset;
  const bY = my + py * labelOffset;

  // Build direction arrows
  const arrows: JSX.Element[] = [];

  const renderArrow = (fromSide: "A" | "B", key: string) => {
    // A_to_B: arrow from A side (left) to B side (right) = along +perpendicular
    // B_to_A: arrow from B side (right) to A side (left) = along -perpendicular
    const sign = fromSide === "A" ? 1 : -1;
    const startX = mx - px * arrowLen * sign;
    const startY = my - py * arrowLen * sign;
    const endX = mx + px * arrowLen * sign;
    const endY = my + py * arrowLen * sign;

    // Arrowhead points
    const headDx = endX - startX;
    const headDy = endY - startY;
    const headLen = Math.sqrt(headDx * headDx + headDy * headDy);
    const hux = headDx / headLen;
    const huy = headDy / headLen;
    // Perpendicular to arrow direction
    const hpx = -huy;
    const hpy = hux;

    const tipX = endX;
    const tipY = endY;
    const baseX = endX - hux * arrowHeadSize;
    const baseY = endY - huy * arrowHeadSize;
    const leftX = baseX + hpx * (arrowHeadSize * 0.6);
    const leftY = baseY + hpy * (arrowHeadSize * 0.6);
    const rightX = baseX - hpx * (arrowHeadSize * 0.6);
    const rightY = baseY - hpy * (arrowHeadSize * 0.6);

    return (
      <g key={key}>
        {/* Arrow shaft */}
        <line
          x1={startX}
          y1={startY}
          x2={endX}
          y2={endY}
          stroke={color}
          strokeWidth={3}
          strokeLinecap="round"
        />
        {/* Arrowhead */}
        <polygon
          points={`${tipX},${tipY} ${leftX},${leftY} ${rightX},${rightY}`}
          fill={color}
        />
      </g>
    );
  };

  if (direction === "A_to_B" || direction === "both") {
    arrows.push(renderArrow("A", `${markerId}-arrow-atob`));
  }
  if (direction === "B_to_A" || direction === "both") {
    arrows.push(renderArrow("B", `${markerId}-arrow-btoa`));
  }
  // Default: if no direction specified, show both
  if (!direction) {
    arrows.push(renderArrow("A", `${markerId}-arrow-atob`));
    arrows.push(renderArrow("B", `${markerId}-arrow-btoa`));
  }

  return (
    <g>
      {/* Glow effect for visibility */}
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={color}
        strokeWidth={8}
        strokeLinecap="round"
        opacity={0.25}
      />
      {/* Main tripwire line */}
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={color}
        strokeWidth={4}
        strokeLinecap="round"
      />

      {/* Direction arrows */}
      {arrows}

      {/* A label (left side) */}
      <circle cx={aX} cy={aY} r={16} fill="rgba(0,0,0,0.6)" stroke={color} strokeWidth={2} />
      <text
        x={aX}
        y={aY + 1}
        fill="white"
        fontSize={18}
        fontWeight="bold"
        textAnchor="middle"
        dominantBaseline="central"
      >
        A
      </text>

      {/* B label (right side) */}
      <circle cx={bX} cy={bY} r={16} fill="rgba(0,0,0,0.6)" stroke={color} strokeWidth={2} />
      <text
        x={bX}
        y={bY + 1}
        fill="white"
        fontSize={18}
        fontWeight="bold"
        textAnchor="middle"
        dominantBaseline="central"
      >
        B
      </text>

      {/* Zone name label */}
      <text
        x={mx}
        y={my - 30}
        fill={color}
        fontSize={24}
        fontWeight="bold"
        textAnchor="middle"
        style={{ textShadow: "0 1px 4px rgba(0,0,0,0.8)" }}
      >
        {name}
      </text>

      {/* Endpoint circles (larger for draggable feel) */}
      <circle
        cx={x1}
        cy={y1}
        r={10}
        fill={color}
        stroke="white"
        strokeWidth={3}
      />
      <circle
        cx={x2}
        cy={y2}
        r={10}
        fill={color}
        stroke="white"
        strokeWidth={3}
      />
    </g>
  );
}

/**
 * SVG overlay that sits on top of the video.
 * Shows existing zone polygons / tripwire lines and allows drawing new ones.
 */
export function ZoneOverlay({
  zones,
  isDrawing,
  currentPoints,
  onAddPoint,
  drawColor = "#2563eb",
  drawType,
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

  const isTripwire = (zone: ZonePolygon) =>
    zone.type === "tripwire" || zone.points.length === 2;

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

        // Tripwire rendering (2 points or type === "tripwire")
        if (isTripwire(zone) && zone.points.length >= 2) {
          return (
            <g key={zone.id}>
              <TripwireLine
                p1={zone.points[0]}
                p2={zone.points[1]}
                color={colors.stroke}
                direction={zone.direction}
                name={zone.name}
                markerId={`marker-${zone.id}`}
              />
            </g>
          );
        }

        // Polygon rendering (3+ points)
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
          {/* Tripwire preview: exactly 2 points */}
          {currentPoints.length === 2 && drawType === "tripwire" ? (
            <>
              {/* Glow */}
              <line
                x1={currentPoints[0].x * 1000}
                y1={currentPoints[0].y * 1000}
                x2={currentPoints[1].x * 1000}
                y2={currentPoints[1].y * 1000}
                stroke={drawColor}
                strokeWidth={8}
                strokeLinecap="round"
                opacity={0.2}
              />
              {/* Main line */}
              <line
                x1={currentPoints[0].x * 1000}
                y1={currentPoints[0].y * 1000}
                x2={currentPoints[1].x * 1000}
                y2={currentPoints[1].y * 1000}
                stroke={drawColor}
                strokeWidth={4}
                strokeLinecap="round"
                strokeDasharray="12,6"
              />
              {/* Endpoint dots */}
              {currentPoints.map((p, i) => (
                <circle
                  key={i}
                  cx={p.x * 1000}
                  cy={p.y * 1000}
                  r={10}
                  fill={i === 0 ? "#22c55e" : drawColor}
                  stroke="white"
                  strokeWidth={3}
                />
              ))}
            </>
          ) : (
            <>
              {/* Polygon drawing mode */}
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
            </>
          )}
        </g>
      )}
    </svg>
  );
}
