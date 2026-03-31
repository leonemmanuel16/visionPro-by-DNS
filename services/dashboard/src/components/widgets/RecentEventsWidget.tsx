"use client";

import { useEffect, useState } from "react";
import { EventCard } from "@/components/EventCard";
import { api } from "@/lib/api";

interface RecentEvent {
  id: string;
  camera_id: string;
  camera_name: string;
  event_type: string;
  label: string;
  confidence: number;
  snapshot_path: string;
  thumbnail_path: string;
  occurred_at: string;
  metadata?: Record<string, any>;
}

export function RecentEventsWidget() {
  const [events, setEvents] = useState<RecentEvent[]>([]);

  useEffect(() => {
    api.get<RecentEvent[]>("/dashboard/recent").then(setEvents).catch(() => setEvents([]));
    const interval = setInterval(() => {
      api.get<RecentEvent[]>("/dashboard/recent").then(setEvents).catch(() => {});
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-2 max-h-[400px] overflow-auto pr-1">
      {events.length === 0 ? (
        <p className="text-sm text-gray-400 py-6 text-center">Sin eventos recientes</p>
      ) : (
        events.slice(0, 8).map((event) => (
          <EventCard key={event.id} {...event} />
        ))
      )}
    </div>
  );
}
