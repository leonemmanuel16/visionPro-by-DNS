"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Camera,
  Activity,
  Shield,
  Bell,
  Settings,
  Database,
  Flame,
  Route,
  HeartPulse,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useRef } from "react";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dashboard/cameras", label: "Camaras", icon: Camera },
  { href: "/dashboard/events", label: "Eventos", icon: Activity },
  { href: "/dashboard/zones", label: "Zonas", icon: Shield },
  { href: "/dashboard/alerts", label: "Alertas", icon: Bell },
  { href: "/dashboard/heatmap", label: "Mapa de Calor", icon: Flame },
  { href: "/dashboard/traffic", label: "Trafico", icon: Route },
  { href: "/dashboard/database", label: "Base de Datos", icon: Database },
  { href: "/dashboard/health", label: "Salud del Sistema", icon: HeartPulse },
  { href: "/dashboard/settings", label: "Configuracion", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const [hovered, setHovered] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const expanded = hovered;

  const handleMouseEnter = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setHovered(true);
  };

  const handleMouseLeave = () => {
    timeoutRef.current = setTimeout(() => setHovered(false), 200);
  };

  return (
    <aside
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={cn(
        "flex flex-col border-r border-gray-200 bg-white transition-all duration-200 z-30",
        expanded ? "w-60" : "w-16"
      )}
    >
      {/* Logo */}
      <div className="flex h-20 items-center justify-center border-b border-gray-200 px-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/dns-logo.png"
          alt="DNS Integradores TI"
          className="object-contain shrink-0"
          style={{ height: expanded ? "60px" : "36px", width: "auto" }}
        />
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1 p-2">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/dashboard" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap overflow-hidden",
                isActive
                  ? "text-blue-600 font-semibold"
                  : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              )}
              title={!expanded ? item.label : undefined}
            >
              <item.icon className="h-5 w-5 shrink-0" />
              <span
                className={cn(
                  "transition-opacity duration-200",
                  expanded ? "opacity-100" : "opacity-0 w-0"
                )}
              >
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
