"use client";

import { useEffect, useState } from "react";
import { SnapshotPlayer } from "@/components/SnapshotPlayer";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import Link from "next/link";

interface Camera {
  id: string;
  name: string;
  is_online: boolean;
  is_enabled?: boolean;
}

export function CameraPreviewWidget() {
  const [cameras, setCameras] = useState<Camera[]>([]);

  useEffect(() => {
    api.get<Camera[]>("/cameras").then((data) => {
      setCameras(Array.isArray(data) ? data.slice(0, 6) : []);
    }).catch(() => {});
  }, []);

  if (cameras.length === 0) {
    return <p className="text-sm text-gray-400 py-6 text-center">Sin camaras configuradas</p>;
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
      {cameras.map((cam) => {
        const streamName = `cam_${cam.id.replace(/-/g, "").slice(0, 12)}`;
        return (
          <Link key={cam.id} href={`/dashboard/cameras/${cam.id}`}>
            <div className="relative rounded-lg overflow-hidden border border-gray-200 hover:border-blue-400 transition-colors group">
              <SnapshotPlayer
                cameraName={streamName}
                isOnline={cam.is_online}
                className="aspect-video"
                intervalMs={2000}
                width={280}
              />
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-medium text-white truncate">{cam.name}</span>
                  <div className={`h-1.5 w-1.5 rounded-full ${cam.is_online ? "bg-green-400" : "bg-red-400"}`} />
                </div>
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
