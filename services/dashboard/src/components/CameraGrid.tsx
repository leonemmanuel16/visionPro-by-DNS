"use client";

import { VideoPlayer } from "./VideoPlayer";
import { DetectionOverlay, DEMO_DETECTIONS } from "./DetectionOverlay";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";

interface Camera {
  id: string;
  name: string;
  is_online: boolean;
  location?: string;
}

interface CameraGridProps {
  cameras: Camera[];
  gridSize: 2 | 3 | 4;
}

export function CameraGrid({ cameras, gridSize }: CameraGridProps) {
  const gridCols = {
    2: "grid-cols-2",
    3: "grid-cols-2 md:grid-cols-3",
    4: "grid-cols-2 md:grid-cols-3 lg:grid-cols-4",
  };

  return (
    <div className={`grid ${gridCols[gridSize]} gap-4`}>
      {cameras.map((camera) => {
        const streamName = `cam_${camera.id.replace(/-/g, "").slice(0, 12)}`;
        const detections = DEMO_DETECTIONS[camera.id] || [];
        return (
          <Link
            key={camera.id}
            href={`/dashboard/cameras/${camera.id}`}
            className="group"
          >
            <div className="relative rounded-lg border border-gray-200 bg-white overflow-hidden hover:border-blue-400 transition-colors shadow-sm">
              <div className="relative">
                <VideoPlayer
                  cameraName={streamName}
                  isOnline={camera.is_online}
                  className="aspect-video"
                />
                {/* Detection overlay with bounding boxes */}
                {camera.is_online && detections.length > 0 && (
                  <DetectionOverlay detections={detections} />
                )}
              </div>
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-white truncate">
                    {camera.name}
                  </span>
                  <Badge variant={camera.is_online ? "success" : "destructive"}>
                    {camera.is_online ? "Online" : "Offline"}
                  </Badge>
                </div>
                {camera.location && (
                  <p className="text-xs text-gray-300 mt-0.5">{camera.location}</p>
                )}
                {/* Detection count indicator */}
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
        );
      })}
    </div>
  );
}
