"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Header } from "@/components/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { format } from "date-fns";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export default function EventDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [event, setEvent] = useState<any>(null);

  useEffect(() => {
    api.get(`/events/${id}`).then(setEvent).catch(console.error);
  }, [id]);

  if (!event) return <div className="flex items-center justify-center h-screen text-slate-500">Loading...</div>;

  return (
    <>
      <Header title="Event Detail" />
      <div className="p-6 space-y-6">
        <Link href="/dashboard/events">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to Events
          </Button>
        </Link>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Snapshot */}
          <Card>
            <CardContent className="p-2">
              {event.snapshot_path ? (
                <img
                  src={`${API_URL}/api/v1/events/${id}/snapshot`}
                  alt="Event snapshot"
                  className="w-full rounded-lg"
                />
              ) : (
                <div className="flex h-64 items-center justify-center rounded-lg bg-slate-800 text-slate-500">
                  No snapshot available
                </div>
              )}
            </CardContent>
          </Card>

          {/* Details */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Event Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-400">Type</span>
                <Badge>{event.event_type}</Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Label</span>
                <span>{event.label || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Confidence</span>
                <span>{event.confidence ? `${(event.confidence * 100).toFixed(1)}%` : "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Camera</span>
                <Link href={`/dashboard/cameras/${event.camera_id}`} className="text-cyan-400 hover:underline">
                  {event.camera_id}
                </Link>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Time</span>
                <span>{format(new Date(event.occurred_at), "PPpp")}</span>
              </div>
              {event.bbox && (
                <div className="flex justify-between">
                  <span className="text-slate-400">Bounding Box</span>
                  <span className="text-xs font-mono">{JSON.stringify(event.bbox)}</span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
