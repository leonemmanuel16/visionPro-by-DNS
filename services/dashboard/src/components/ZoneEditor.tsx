"use client";

import { useRef, useState, useEffect, MouseEvent } from "react";
import { Button } from "@/components/ui/button";

interface Point {
  x: number;
  y: number;
}

interface ZoneEditorProps {
  snapshotUrl?: string;
  initialPoints?: Point[];
  onSave: (points: Point[]) => void;
  onCancel: () => void;
}

export function ZoneEditor({ snapshotUrl, initialPoints = [], onSave, onCancel }: ZoneEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [points, setPoints] = useState<Point[]>(initialPoints);
  const [imgLoaded, setImgLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (snapshotUrl) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        imgRef.current = img;
        setImgLoaded(true);
      };
      img.src = snapshotUrl;
    }
  }, [snapshotUrl]);

  useEffect(() => {
    draw();
  }, [points, imgLoaded]);

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw background image
    if (imgRef.current && imgLoaded) {
      ctx.drawImage(imgRef.current, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = "#f3f4f6";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#6b7280";
      ctx.font = "14px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Click to draw zone points", canvas.width / 2, canvas.height / 2);
    }

    // Draw polygon
    if (points.length > 0) {
      ctx.beginPath();
      ctx.moveTo(points[0].x * canvas.width, points[0].y * canvas.height);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x * canvas.width, points[i].y * canvas.height);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(37, 99, 235, 0.15)";
      ctx.fill();
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Draw points
      points.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p.x * canvas.width, p.y * canvas.height, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#2563eb";
        ctx.fill();
      });
    }
  };

  const handleClick = (e: MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    setPoints([...points, { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 }]);
  };

  return (
    <div className="space-y-4">
      <canvas
        ref={canvasRef}
        width={640}
        height={360}
        onClick={handleClick}
        className="w-full cursor-crosshair rounded-lg border border-gray-300"
      />
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setPoints([])}>
          Clear
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPoints(points.slice(0, -1))}
          disabled={points.length === 0}
        >
          Undo
        </Button>
        <div className="flex-1" />
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => onSave(points)} disabled={points.length < 3}>
          Save Zone
        </Button>
      </div>
      <p className="text-xs text-gray-400">
        {points.length} points — Click to add points. Minimum 3 points required.
      </p>
    </div>
  );
}
