"use client";

import { useEffect, useState } from "react";
import { Camera, Wifi, Activity, Calendar, ShieldCheck, AlertTriangle } from "lucide-react";
import { api } from "@/lib/api";

interface Stats {
  total_cameras: number;
  online_cameras: number;
  events_today: number;
  events_this_week: number;
}

export function StatsWidget() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    api.get<Stats>("/dashboard/stats").then(setStats).catch(() => {});
    const interval = setInterval(() => {
      api.get<Stats>("/dashboard/stats").then(setStats).catch(() => {});
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const items = [
    { label: "Camaras", value: stats?.total_cameras ?? "--", icon: Camera, color: "text-blue-600", bg: "bg-blue-50" },
    { label: "Online", value: stats?.online_cameras ?? "--", icon: Wifi, color: "text-green-600", bg: "bg-green-50" },
    { label: "Eventos Hoy", value: stats?.events_today ?? "--", icon: Activity, color: "text-orange-600", bg: "bg-orange-50" },
    { label: "Esta Semana", value: stats?.events_this_week ?? "--", icon: Calendar, color: "text-purple-600", bg: "bg-purple-50" },
  ];

  return (
    <div className="grid grid-cols-2 gap-3">
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-3 p-3 rounded-lg border border-gray-100 bg-white">
          <div className={`p-2 rounded-lg ${item.bg}`}>
            <item.icon className={`h-5 w-5 ${item.color}`} />
          </div>
          <div>
            <p className="text-2xl font-bold text-gray-900">{item.value}</p>
            <p className="text-xs text-gray-500">{item.label}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
