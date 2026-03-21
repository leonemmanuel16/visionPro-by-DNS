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
  ChevronLeft,
  ChevronRight,
  Database,
  Flame,
  Route,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dashboard/cameras", label: "Cámaras", icon: Camera },
  { href: "/dashboard/events", label: "Eventos", icon: Activity },
  { href: "/dashboard/zones", label: "Zonas", icon: Shield },
  { href: "/dashboard/alerts", label: "Alertas", icon: Bell },
  { href: "/dashboard/heatmap", label: "Mapa de Calor", icon: Flame },
  { href: "/dashboard/traffic", label: "Tráfico", icon: Route },
  { href: "/dashboard/database", label: "Base de Datos", icon: Database },
  { href: "/dashboard/settings", label: "Configuración", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        "flex flex-col border-r border-gray-200 bg-white transition-all duration-200",
        collapsed ? "w-16" : "w-60"
      )}
    >
      {/* Logo */}
      <div className="flex h-20 items-center justify-center border-b border-gray-200 px-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/dns-logo.png"
          alt="DNS Integradores TI"
          className="object-contain shrink-0"
          style={{ height: collapsed ? "36px" : "60px", width: "auto" }}
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
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "text-blue-600 font-semibold"
                  : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              )}
            >
              <item.icon className="h-5 w-5 shrink-0" />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center justify-center border-t border-gray-200 p-3 text-gray-400 hover:text-gray-600"
      >
        {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
      </button>
    </aside>
  );
}
