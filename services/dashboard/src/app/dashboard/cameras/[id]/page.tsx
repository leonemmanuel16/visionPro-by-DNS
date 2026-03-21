"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Header } from "@/components/Header";
import { VideoPlayer } from "@/components/VideoPlayer";
import { PTZControls } from "@/components/PTZControls";
import { EventCard } from "@/components/EventCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";

interface CameraDetail {
  id: string;
  name: string;
  ip_address: string;
  manufacturer?: string;
  model?: string;
  firmware?: string;
  has_ptz: boolean;
  is_online: boolean;
  is_enabled: boolean;
  location?: string;
  last_seen_at?: string;
}

export default function CameraDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [camera, setCamera] = useState<CameraDetail | null>(null);
  const [events, setEvents] = useState<any[]>([]);

  useEffect(() => {
    api.get<CameraDetail>(`/cameras/${id}`).then(setCamera).catch(console.error);
    api.get<any[]>(`/events?camera_id=${id}&per_page=10`).then(setEvents).catch(console.error);
  }, [id]);

  if (!camera) return <div className="flex items-center justify-center h-screen text-gray-400">Loading...</div>;

  const streamName = `cam_${camera.id.replace(/-/g, "").slice(0, 12)}`;

  return (
    <>
      <Header title={camera.name} />
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Video */}
          <div className="lg:col-span-2">
            <VideoPlayer cameraName={streamName} isOnline={camera.is_online} className="aspect-video w-full" />
          </div>

          {/* Info + PTZ */}
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center justify-between">
                  Camera Info
                  <Badge variant={camera.is_online ? "success" : "destructive"}>
                    {camera.is_online ? "Online" : "Offline"}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-gray-500">IP</span><span>{camera.ip_address}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Manufacturer</span><span>{camera.manufacturer || "—"}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Model</span><span>{camera.model || "—"}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Firmware</span><span>{camera.firmware || "—"}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Location</span><span>{camera.location || "—"}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">PTZ</span><span>{camera.has_ptz ? "Yes" : "No"}</span></div>
              </CardContent>
            </Card>

            {camera.has_ptz && (
              <Card>
                <CardContent className="p-4">
                  <PTZControls cameraId={camera.id} />
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {/* Recent events for this camera */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Events</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {events.length === 0 ? (
              <p className="text-sm text-gray-400">No events for this camera</p>
            ) : (
              events.map((e: any) => (
                <EventCard key={e.id} {...e} camera_name={camera.name} />
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
