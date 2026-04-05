"use client";

import { useRef, useState, useEffect, useCallback } from "react";

interface BBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface DetectedFace {
  bbox: BBox;
  score: number;
}

interface FaceSelectorProps {
  imageUrl: string;
  faces: DetectedFace[];
  imageWidth: number;
  imageHeight: number;
  onSelectFace: (bbox: BBox) => void;
  allowManualSelection?: boolean;
}

const FACE_COLORS = [
  "#3b82f6", // blue
  "#ef4444", // red
  "#22c55e", // green
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#f97316", // orange
];

export function FaceSelector({
  imageUrl,
  faces,
  imageWidth,
  imageHeight,
  onSelectFace,
  allowManualSelection = false,
}: FaceSelectorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [renderedSize, setRenderedSize] = useState({ w: 0, h: 0, offsetX: 0, offsetY: 0 });
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  // Manual draw state
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawEnd, setDrawEnd] = useState<{ x: number; y: number } | null>(null);
  const [manualRect, setManualRect] = useState<BBox | null>(null);

  const updateRenderedSize = useCallback(() => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return;
    // The image is rendered with object-fit contain behavior via w-full
    // We calculate the actual rendered area
    const containerW = img.clientWidth;
    const containerH = img.clientHeight;
    const scale = Math.min(containerW / imageWidth, containerH / imageHeight);
    const w = imageWidth * scale;
    const h = imageHeight * scale;
    const offsetX = (containerW - w) / 2;
    const offsetY = (containerH - h) / 2;
    setRenderedSize({ w, h, offsetX, offsetY });
  }, [imageWidth, imageHeight]);

  useEffect(() => {
    updateRenderedSize();
    window.addEventListener("resize", updateRenderedSize);
    return () => window.removeEventListener("resize", updateRenderedSize);
  }, [updateRenderedSize]);

  // Convert original image coords to rendered pixel coords
  const toRendered = (bbox: BBox) => {
    if (!renderedSize.w) return { left: 0, top: 0, width: 0, height: 0 };
    const scaleX = renderedSize.w / imageWidth;
    const scaleY = renderedSize.h / imageHeight;
    return {
      left: renderedSize.offsetX + bbox.x1 * scaleX,
      top: renderedSize.offsetY + bbox.y1 * scaleY,
      width: (bbox.x2 - bbox.x1) * scaleX,
      height: (bbox.y2 - bbox.y1) * scaleY,
    };
  };

  // Convert rendered pixel coords back to original image coords
  const toOriginal = (rx: number, ry: number): { x: number; y: number } => {
    if (!renderedSize.w) return { x: 0, y: 0 };
    const scaleX = imageWidth / renderedSize.w;
    const scaleY = imageHeight / renderedSize.h;
    return {
      x: Math.max(0, Math.min(imageWidth, (rx - renderedSize.offsetX) * scaleX)),
      y: Math.max(0, Math.min(imageHeight, (ry - renderedSize.offsetY) * scaleY)),
    };
  };

  const handleFaceClick = (idx: number, bbox: BBox) => {
    setSelectedIdx(idx);
    setManualRect(null);
    onSelectFace(bbox);
  };

  // Manual selection handlers
  const getRelativePos = (e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!allowManualSelection) return;
    // Don't start draw if clicking a face overlay
    if ((e.target as HTMLElement).dataset.faceIdx) return;
    const pos = getRelativePos(e);
    setIsDrawing(true);
    setDrawStart(pos);
    setDrawEnd(pos);
    setSelectedIdx(null);
    setManualRect(null);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDrawing || !drawStart) return;
    setDrawEnd(getRelativePos(e));
  };

  const handleMouseUp = () => {
    if (!isDrawing || !drawStart || !drawEnd) {
      setIsDrawing(false);
      return;
    }
    setIsDrawing(false);

    const x1r = Math.min(drawStart.x, drawEnd.x);
    const y1r = Math.min(drawStart.y, drawEnd.y);
    const x2r = Math.max(drawStart.x, drawEnd.x);
    const y2r = Math.max(drawStart.y, drawEnd.y);

    // Minimum 20px rectangle
    if (x2r - x1r < 20 || y2r - y1r < 20) {
      setDrawStart(null);
      setDrawEnd(null);
      return;
    }

    const p1 = toOriginal(x1r, y1r);
    const p2 = toOriginal(x2r, y2r);
    const bbox: BBox = {
      x1: Math.round(p1.x),
      y1: Math.round(p1.y),
      x2: Math.round(p2.x),
      y2: Math.round(p2.y),
    };
    setManualRect(bbox);
    setSelectedIdx(null);
    onSelectFace(bbox);
    setDrawStart(null);
    setDrawEnd(null);
  };

  // Drawing rect in pixel coords
  const drawRect = drawStart && drawEnd && isDrawing
    ? {
        left: Math.min(drawStart.x, drawEnd.x),
        top: Math.min(drawStart.y, drawEnd.y),
        width: Math.abs(drawEnd.x - drawStart.x),
        height: Math.abs(drawEnd.y - drawStart.y),
      }
    : null;

  return (
    <div
      ref={containerRef}
      className="relative select-none"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => { if (isDrawing) handleMouseUp(); }}
      style={{ cursor: allowManualSelection ? "crosshair" : "default" }}
    >
      <img
        ref={imgRef}
        src={imageUrl}
        alt="Imagen con rostros detectados"
        className="w-full rounded-lg"
        onLoad={updateRenderedSize}
        draggable={false}
      />

      {/* Detected face overlays */}
      {faces.map((face, idx) => {
        const r = toRendered(face.bbox);
        const isSelected = selectedIdx === idx;
        const color = FACE_COLORS[idx % FACE_COLORS.length];
        return (
          <div
            key={idx}
            data-face-idx={idx}
            onClick={(e) => { e.stopPropagation(); handleFaceClick(idx, face.bbox); }}
            className="absolute cursor-pointer transition-all"
            style={{
              left: r.left,
              top: r.top,
              width: r.width,
              height: r.height,
              border: `2px solid ${color}`,
              backgroundColor: isSelected ? `${color}22` : "transparent",
              boxShadow: isSelected ? `0 0 0 2px ${color}, 0 0 12px ${color}44` : "none",
              zIndex: 10,
            }}
          >
            {/* Score label */}
            <div
              className="absolute -top-5 left-0 text-[10px] font-bold px-1 py-0.5 rounded-t text-white whitespace-nowrap"
              style={{ backgroundColor: color }}
            >
              {(face.score * 100).toFixed(0)}%
            </div>
            {isSelected && (
              <div
                className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-[9px] font-medium px-1.5 py-0.5 rounded text-white whitespace-nowrap"
                style={{ backgroundColor: color }}
              >
                Seleccionado
              </div>
            )}
          </div>
        );
      })}

      {/* Manual drawn rectangle (while drawing) */}
      {drawRect && (
        <div
          className="absolute border-2 border-dashed border-yellow-400 bg-yellow-400/10 pointer-events-none"
          style={{
            left: drawRect.left,
            top: drawRect.top,
            width: drawRect.width,
            height: drawRect.height,
            zIndex: 20,
          }}
        />
      )}

      {/* Confirmed manual rectangle */}
      {manualRect && !isDrawing && (
        <div
          className="absolute border-2 border-dashed border-yellow-500 bg-yellow-500/15"
          style={{
            ...toRendered(manualRect),
            zIndex: 20,
          }}
        >
          <div className="absolute -top-5 left-0 text-[10px] font-bold px-1 py-0.5 rounded-t text-white bg-yellow-500 whitespace-nowrap">
            Manual
          </div>
          <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-[9px] font-medium px-1.5 py-0.5 rounded text-white bg-yellow-500 whitespace-nowrap">
            Seleccionado
          </div>
        </div>
      )}

      {/* Hint for manual selection */}
      {allowManualSelection && faces.length === 0 && !manualRect && !isDrawing && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-black/50 text-white text-sm px-4 py-2 rounded-lg">
            Haz clic y arrastra para seleccionar un rostro
          </div>
        </div>
      )}
    </div>
  );
}
