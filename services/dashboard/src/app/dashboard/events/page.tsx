"use client";

import { useEffect, useState } from "react";
import { Header } from "@/components/Header";
import { EventCard } from "@/components/EventCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface EventItem {
  id: string;
  camera_id: string;
  event_type: string;
  label: string;
  confidence: number;
  occurred_at: string;
  thumbnail_path: string;
  snapshot_path: string;
  metadata?: {
    person_name?: string;
    person_id?: string;
    face_detected?: boolean;
    upper_color?: string;
    lower_color?: string;
    headgear?: string;
  };
}

export default function EventsPage() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState({ event_type: "", camera_id: "", person_name: "" });
  const [cameras, setCameras] = useState<{ id: string; name: string }[]>([]);
  const [persons, setPersons] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    api.get<{ id: string; name: string }[]>("/cameras").then(setCameras).catch(console.error);
    api.get<any[]>("/persons").then((data) => {
      if (data && Array.isArray(data)) {
        setPersons(data.map((p: any) => ({ id: p.id, name: p.name })));
      }
    }).catch(console.error);
  }, []);

  useEffect(() => {
    loadEvents();
  }, [page, filter]);

  const loadEvents = async () => {
    try {
      let url = `/events?page=${page}&per_page=20`;
      if (filter.event_type) url += `&event_type=${filter.event_type}`;
      if (filter.camera_id) url += `&camera_id=${filter.camera_id}`;
      if (filter.person_name) url += `&person_name=${encodeURIComponent(filter.person_name)}`;
      const data = await api.get<EventItem[]>(url);
      setEvents(data);
    } catch (e) {
      console.error("Failed to load events:", e);
    }
  };

  const getCameraName = (cameraId: string) => {
    return cameras.find((c) => c.id === cameraId)?.name || "Unknown";
  };

  return (
    <>
      <Header title="Events" />
      <div className="p-6 space-y-4">
        {/* Filters */}
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 p-4">
            <select
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700"
              value={filter.event_type}
              onChange={(e) => { setFilter({ ...filter, event_type: e.target.value }); setPage(1); }}
            >
              <option value="">Todos los tipos</option>
              <option value="person">Persona</option>
              <option value="vehicle">Vehículo</option>
              <option value="car">Car</option>
              <option value="truck">Truck</option>
              <option value="zone_crossing">Cruce de Zona</option>
              <option value="animal">Animal</option>
            </select>
            <select
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700"
              value={filter.camera_id}
              onChange={(e) => { setFilter({ ...filter, camera_id: e.target.value }); setPage(1); }}
            >
              <option value="">Todas las cámaras</option>
              {cameras.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <select
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700"
              value={filter.person_name}
              onChange={(e) => { setFilter({ ...filter, person_name: e.target.value }); setPage(1); }}
            >
              <option value="">Todas las Personas</option>
              {persons.map((p) => (
                <option key={p.id} value={p.name}>{p.name}</option>
              ))}
            </select>
          </CardContent>
        </Card>

        {/* Events */}
        <div className="space-y-2">
          {events.length === 0 ? (
            <p className="py-10 text-center text-gray-400">No events found</p>
          ) : (
            events.map((event) => (
              <EventCard
                key={event.id}
                {...event}
                camera_name={getCameraName(event.camera_id)}
                metadata={event.metadata}
              />
            ))
          )}
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page === 1}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-gray-400">Page {page}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(page + 1)}
            disabled={events.length < 20}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </>
  );
}
