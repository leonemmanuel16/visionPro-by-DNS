"use client";

import { useMemo, useState, useEffect } from "react";
import { SnapshotPlayer } from "./SnapshotPlayer";
import { DetectionOverlay } from "./DetectionOverlay";
import { wsClient } from "@/lib/websocket";
import { Badge } from "@/components/ui/badge";
import { Trash2, BrainCircuit } from "lucide-react";
import Link from "next/link";

interface Camera {
  id: string;
  name: string;
  is_online: boolean;
  is_enabled?: boolean;
  location?: string;
}

interface CameraGridProps {
  cameras: Camera[];
  gridSize: 2 | 3 | 4;
  onDelete?: (id: string) => void;
}

// UUID format check
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function CameraGrid({ cameras, gridSize, onDelete }: CameraGridProps) {
  // Live tracking detections per camera
  const [trackingMap, setTrackingMap] = useState<Record<string, any[]>>({});

  useEffect(() => {
    // Subscribe to live tracking data
    const handleTracking = (data: any) => {
      if (data.type === "tracking" && data.camera_id) {
        setTrackingMap((prev) => ({
          ...prev,
          [data.camera_id]: data.tracks || [],
        }));
      }
    };
    wsClient.on("tracking", handleTracking);

    // Clear stale detections every 3s
    const clearTimer = setInterval(() => {
      setTrackingMap((prev) => {
        const next: Record<string, any[]> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (v.length > 0) next[k] = v;
        }
        return Object.keys(next).length === Object.keys(prev).length ? prev : next;
      });
    }, 3000);

    return () => {
      wsClient.off("tracking", handleTracking);
      clearInterval(clearTimer);
    };
  }, []);

  // Filter out legacy cam-xxxxx IDs that aren't valid UUIDs or cam-timestamp IDs
  const validCameras = useMemo(() => {
    return cameras.filter((c) => {
      // Accept UUIDs from backend
      if (UUID_REGEX.test(c.id)) return true;
      // Accept cam-timestamp IDs from localStorage (they start with cam- followed by digits)
      if (c.id.startsWith("cam-") && /^cam-\d+$/.test(c.id)) return true;
      // Reject everything else (legacy corrupt IDs)
      return false;
    });
  }, [cameras]);
  const gridCols = {
    2: "grid-cols-2",
    3: "grid-cols-2 md:grid-cols-3",
    4: "grid-cols-2 md:grid-cols-3 lg:grid-cols-4",
  };

  return (
    <div className={`grid ${gridCols[gridSize]} gap-4`}>
      {validCameras.map((camera) => {
        const streamName = `cam_${camera.id.replace(/-/g, "").slice(0, 12)}`;
        const detections = trackingMap[camera.id] || [];
        return (
          <div key={camera.id} className="relative group">
            <Link
              href={`/dashboard/cameras/${camera.id}`}
            >
              <div className="relative rounded-lg border border-gray-200 bg-white overflow-hidden hover:border-blue-400 transition-colors shadow-sm">
                <div className="relative">
                  <SnapshotPlayer
                    cameraName={streamName}
                    isOnline={camera.is_online}
                    className="aspect-video"
                    intervalMs={gridSize === 2 ? 100 : gridSize === 3 ? 150 : 250}
                    width={gridSize === 2 ? 640 : gridSize === 3 ? 420 : 280}
                  />
                  {camera.is_online && detections.length > 0 && (
                    <DetectionOverlay detections={detections} />
                  )}
                </div>
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-white truncate">
                      {camera.name}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <Badge variant={camera.is_enabled ? "default" : "secondary"} className={camera.is_enabled ? "bg-purple-600 hover:bg-purple-700" : "bg-gray-500/70 text-gray-200"}>
                        <BrainCircuit className="h-3 w-3 mr-1" />
                        {camera.is_enabled ? "AI" : "AI Off"}
                      </Badge>
                      <Badge variant={camera.is_online ? "success" : "destructive"}>
                        {camera.is_online ? "Online" : "Offline"}
                      </Badge>
                    </div>
                  </div>
                  {camera.location && (
                    <p className="text-xs text-gray-300 mt-0.5">{camera.location}</p>
                  )}
                  {detections.length > 0 && camera.is_online && (
                    <div className="flex items-center gap-2 mt-1">
                      {detections.some((d) => d.personName) && (
                        <span className="text-[10px] bg-blue-500/80 text-white px-1.5 py-0.5 rounded">
                          {detections.filter((d) => d.personName).length} identificados
                        </span>
                      )}
                      <span className="text-[10px] bg-green-500/80 text-white px-1.5 py-0.5 rounded">
                        {detections.length} detecciones
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </Link>
            {/* Delete button */}
            {onDelete && (
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (confirm(`¿Eliminar cámara "${camera.name}"?`)) {
                    onDelete(camera.id);
                  }
                }}
                className="absolute top-2 right-2 p-1.5 bg-red-600/80 hover:bg-red-600 text-white rounded-md opacity-0 group-hover:opacity-100 transition-opacity z-10"
                title="Eliminar cámara"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
