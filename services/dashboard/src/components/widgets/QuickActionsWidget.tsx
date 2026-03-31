"use client";

import Link from "next/link";
import {
  Camera,
  Shield,
  Bell,
  HeartPulse,
  Database,
  Flame,
  Route,
  Settings,
} from "lucide-react";

const actions = [
  { href: "/dashboard/cameras", label: "Camaras", icon: Camera, color: "bg-blue-50 text-blue-600" },
  { href: "/dashboard/zones", label: "Zonas", icon: Shield, color: "bg-green-50 text-green-600" },
  { href: "/dashboard/alerts", label: "Alertas", icon: Bell, color: "bg-red-50 text-red-600" },
  { href: "/dashboard/health", label: "Salud", icon: HeartPulse, color: "bg-purple-50 text-purple-600" },
  { href: "/dashboard/database", label: "Base Datos", icon: Database, color: "bg-amber-50 text-amber-600" },
  { href: "/dashboard/heatmap", label: "Mapa Calor", icon: Flame, color: "bg-orange-50 text-orange-600" },
  { href: "/dashboard/traffic", label: "Trafico", icon: Route, color: "bg-cyan-50 text-cyan-600" },
  { href: "/dashboard/settings", label: "Config", icon: Settings, color: "bg-gray-100 text-gray-600" },
];

export function QuickActionsWidget() {
  return (
    <div className="grid grid-cols-4 gap-2">
      {actions.map((a) => (
        <Link key={a.href} href={a.href}>
          <div className="flex flex-col items-center gap-1.5 p-3 rounded-lg hover:bg-gray-50 transition-colors cursor-pointer">
            <div className={`p-2.5 rounded-lg ${a.color}`}>
              <a.icon className="h-5 w-5" />
            </div>
            <span className="text-[10px] font-medium text-gray-600">{a.label}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}
