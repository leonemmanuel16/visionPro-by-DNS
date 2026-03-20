"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Event {
  id: string;
  camera_id: string;
  event_type: string;
  label: string;
  confidence: number;
  occurred_at: string;
  snapshot_path: string;
  thumbnail_path: string;
}

export function useEvents(filters?: { camera_id?: string; event_type?: string; page?: number }) {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setLoading(true);
      let url = `/events?per_page=50`;
      if (filters?.camera_id) url += `&camera_id=${filters.camera_id}`;
      if (filters?.event_type) url += `&event_type=${filters.event_type}`;
      if (filters?.page) url += `&page=${filters.page}`;
      const data = await api.get<Event[]>(url);
      setEvents(data);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [filters?.camera_id, filters?.event_type, filters?.page]);

  return { events, loading, error, refresh: load };
}
