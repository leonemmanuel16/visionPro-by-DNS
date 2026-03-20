"use client";

import { VideoPlayer } from "./VideoPlayer";
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
    2: "grid-cols-1 md:grid-cols-2",
    3: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3",
    4: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
  };

  return (
    <div className={`grid ${gridCols[gridSize]} gap-4`}>
      {cameras.map((camera) => {
        const streamName = `cam_${camera.id.replace(/-/g, "").slice(0, 12)}`;
        return (
          <Link
            key={camera.id}
            href={`/dashboard/cameras/${camera.id}`}
            className="group"
          >
            <div className="relative rounded-lg border border-slate-700/50 bg-slate-900 overflow-hidden hover:border-cyan-500/50 transition-colors">
              <VideoPlayer
                cameraName={streamName}
                isOnline={camera.is_online}
                className="aspect-video"
              />
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-white truncate">
                    {camera.name}
                  </span>
                  <Badge variant={camera.is_online ? "success" : "destructive"}>
                    {camera.is_online ? "Online" : "Offline"}
                  </Badge>
                </div>
                {camera.location && (
                  <p className="text-xs text-slate-400 mt-0.5">{camera.location}</p>
                )}
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
