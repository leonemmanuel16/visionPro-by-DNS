"use client";

import { useEffect, useState } from "react";
import { Camera, Wifi, Activity, Calendar } from "lucide-react";
import { Header } from "@/components/Header";
import { StatsCard } from "@/components/StatsCard";
import { EventCard } from "@/components/EventCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface Stats {
  total_cameras: number;
  online_cameras: number;
  events_today: number;
  events_this_week: number;
}

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

interface ActivityPoint {
  hour: string;
  count: number;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [events, setEvents] = useState<RecentEvent[]>([]);
  const [activity, setActivity] = useState<ActivityPoint[]>([]);

  useEffect(() => {
    api.get<Stats>("/dashboard/stats").then(setStats).catch(console.error);
    api.get<RecentEvent[]>("/dashboard/recent").then(setEvents).catch(console.error);
    api.get<ActivityPoint[]>("/dashboard/activity").then(setActivity).catch(console.error);
  }, []);

  return (
    <>
      <Header title="Dashboard" />
      <div className="p-6 space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatsCard
            label="Total Cámaras"
            value={stats?.total_cameras ?? "—"}
            icon={Camera}
          />
          <StatsCard
            label="Cámaras Online"
            value={stats?.online_cameras ?? "—"}
            icon={Wifi}
          />
          <StatsCard
            label="Eventos Hoy"
            value={stats?.events_today ?? "—"}
            icon={Activity}
          />
          <StatsCard
            label="Eventos Esta Semana"
            value={stats?.events_this_week ?? "—"}
            icon={Calendar}
          />
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Recent Events */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Eventos Recientes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 max-h-96 overflow-auto">
              {events.length === 0 ? (
                <p className="text-sm text-gray-400">Sin eventos recientes</p>
              ) : (
                events.map((event) => (
                  <EventCard key={event.id} {...event} />
                ))
              )}
            </CardContent>
          </Card>

          {/* Activity Chart */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Actividad (Últimas 24h)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={activity}>
                    <XAxis dataKey="hour" stroke="#9ca3af" fontSize={12} />
                    <YAxis stroke="#9ca3af" fontSize={12} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#ffffff",
                        border: "1px solid #e5e7eb",
                        borderRadius: "8px",
                        color: "#374151",
                      }}
                    />
                    <Bar dataKey="count" fill="#2563eb" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
