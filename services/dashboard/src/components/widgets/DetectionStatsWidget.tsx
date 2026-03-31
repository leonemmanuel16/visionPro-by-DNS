"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { User, Car, Dog, Flame, Eye } from "lucide-react";

interface DetectionStat {
  label: string;
  count: number;
}

const ICONS: Record<string, any> = {
  person: User,
  vehicle: Car,
  car: Car,
  truck: Car,
  animal: Dog,
  fire_smoke: Flame,
  motion: Eye,
};

const COLORS: Record<string, string> = {
  person: "bg-green-100 text-green-700",
  vehicle: "bg-yellow-100 text-yellow-700",
  car: "bg-yellow-100 text-yellow-700",
  truck: "bg-orange-100 text-orange-700",
  animal: "bg-purple-100 text-purple-700",
  fire_smoke: "bg-red-100 text-red-700",
  motion: "bg-cyan-100 text-cyan-700",
};

export function DetectionStatsWidget() {
  const [stats, setStats] = useState<DetectionStat[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    // Fetch events and compute breakdown by type
    api.get<any[]>("/events?per_page=200").then((events) => {
      if (!Array.isArray(events)) return;
      const counts: Record<string, number> = {};
      events.forEach((e) => {
        const type = e.event_type || e.label || "unknown";
        counts[type] = (counts[type] || 0) + 1;
      });
      const arr = Object.entries(counts)
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);
      setStats(arr);
      setTotal(events.length);
    }).catch(() => {});
  }, []);

  if (stats.length === 0) {
    return <p className="text-sm text-gray-400 py-6 text-center">Sin detecciones recientes</p>;
  }

  const maxCount = Math.max(...stats.map((s) => s.count));

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500 mb-3">{total} detecciones totales</p>
      {stats.slice(0, 6).map((stat) => {
        const Icon = ICONS[stat.label] || Eye;
        const color = COLORS[stat.label] || "bg-gray-100 text-gray-700";
        const pct = maxCount > 0 ? (stat.count / maxCount) * 100 : 0;
        return (
          <div key={stat.label} className="flex items-center gap-3">
            <div className={`p-1 rounded ${color}`}>
              <Icon className="h-3.5 w-3.5" />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between text-xs mb-0.5">
                <span className="capitalize text-gray-700 font-medium">{stat.label}</span>
                <span className="text-gray-500">{stat.count}</span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
