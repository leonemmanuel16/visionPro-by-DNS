"use client";

import { useState } from "react";
import { Header } from "@/components/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowRight, TrendingUp, Users, Clock, MapPin } from "lucide-react";

interface TrafficZone {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  avgDaily: number;
  peakHour: string;
  currentOccupancy: number;
  maxCapacity: number;
}

interface TrafficFlow {
  from: string;
  to: string;
  count: number;
  avgTime: string;
}

const ZONES: TrafficZone[] = [
  { id: "z1", name: "Entrada Principal", x: 5, y: 75, w: 18, h: 20, avgDaily: 245, peakHour: "08:30", currentOccupancy: 3, maxCapacity: 15 },
  { id: "z2", name: "Recepción", x: 25, y: 60, w: 20, h: 25, avgDaily: 189, peakHour: "09:00", currentOccupancy: 2, maxCapacity: 10 },
  { id: "z3", name: "Pasillo Central", x: 35, y: 30, w: 30, h: 15, avgDaily: 312, peakHour: "12:15", currentOccupancy: 5, maxCapacity: 20 },
  { id: "z4", name: "Oficinas", x: 10, y: 10, w: 25, h: 30, avgDaily: 156, peakHour: "10:00", currentOccupancy: 12, maxCapacity: 30 },
  { id: "z5", name: "Sala de Juntas", x: 70, y: 10, w: 22, h: 25, avgDaily: 67, peakHour: "11:00", currentOccupancy: 0, maxCapacity: 12 },
  { id: "z6", name: "Cafetería", x: 70, y: 55, w: 22, h: 25, avgDaily: 198, peakHour: "13:00", currentOccupancy: 8, maxCapacity: 25 },
  { id: "z7", name: "Estacionamiento", x: 5, y: 45, w: 18, h: 20, avgDaily: 134, peakHour: "08:00", currentOccupancy: 18, maxCapacity: 50 },
  { id: "z8", name: "Server Room", x: 48, y: 55, w: 18, h: 20, avgDaily: 23, peakHour: "14:00", currentOccupancy: 1, maxCapacity: 5 },
];

const FLOWS: TrafficFlow[] = [
  { from: "Entrada Principal", to: "Recepción", count: 189, avgTime: "15s" },
  { from: "Recepción", to: "Pasillo Central", count: 156, avgTime: "25s" },
  { from: "Pasillo Central", to: "Oficinas", count: 134, avgTime: "20s" },
  { from: "Pasillo Central", to: "Cafetería", count: 112, avgTime: "35s" },
  { from: "Pasillo Central", to: "Sala de Juntas", count: 45, avgTime: "30s" },
  { from: "Estacionamiento", to: "Entrada Principal", count: 98, avgTime: "45s" },
  { from: "Cafetería", to: "Pasillo Central", count: 105, avgTime: "40s" },
  { from: "Oficinas", to: "Server Room", count: 18, avgTime: "1m 10s" },
];

const HOURLY_DATA = Array.from({ length: 24 }, (_, i) => ({
  hour: i,
  count:
    i >= 7 && i <= 9
      ? 40 + Math.floor(Math.random() * 20)
      : i >= 12 && i <= 13
      ? 35 + Math.floor(Math.random() * 15)
      : i >= 17 && i <= 18
      ? 30 + Math.floor(Math.random() * 15)
      : i >= 22 || i <= 5
      ? Math.floor(Math.random() * 5)
      : 10 + Math.floor(Math.random() * 15),
}));

const DAY_NAMES = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const WEEKLY_DATA = DAY_NAMES.map((day, i) => ({
  day,
  count: i < 5 ? 180 + Math.floor(Math.random() * 80) : 30 + Math.floor(Math.random() * 40),
}));

function occupancyColor(current: number, max: number) {
  const pct = (current / max) * 100;
  if (pct > 80) return { bg: "rgba(239,68,68,0.25)", border: "#ef4444", text: "text-red-700" };
  if (pct > 50) return { bg: "rgba(245,158,11,0.25)", border: "#f59e0b", text: "text-orange-700" };
  if (pct > 20) return { bg: "rgba(34,197,94,0.2)", border: "#22c55e", text: "text-green-700" };
  return { bg: "rgba(59,130,246,0.15)", border: "#93c5fd", text: "text-blue-700" };
}

export default function TrafficPage() {
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"map" | "flows">("map");

  const maxHourly = Math.max(...HOURLY_DATA.map((h) => h.count));
  const maxWeekly = Math.max(...WEEKLY_DATA.map((d) => d.count));
  const totalToday = HOURLY_DATA.reduce((sum, h) => sum + h.count, 0);
  const currentOccupancy = ZONES.reduce((sum, z) => sum + z.currentOccupancy, 0);

  return (
    <>
      <Header title="Tráfico y Ocupación" />
      <div className="p-6 space-y-6">
        {/* Stats bar */}
        <div className="grid grid-cols-4 gap-4">
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <Users className="h-7 w-7 text-blue-600" />
              <div>
                <p className="text-xl font-bold text-gray-900">{currentOccupancy}</p>
                <p className="text-xs text-gray-500">En instalaciones ahora</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <TrendingUp className="h-7 w-7 text-green-600" />
              <div>
                <p className="text-xl font-bold text-gray-900">{totalToday}</p>
                <p className="text-xs text-gray-500">Tránsitos hoy</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <Clock className="h-7 w-7 text-orange-500" />
              <div>
                <p className="text-xl font-bold text-gray-900">08:30</p>
                <p className="text-xs text-gray-500">Hora pico</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <MapPin className="h-7 w-7 text-purple-600" />
              <div>
                <p className="text-xl font-bold text-gray-900">{ZONES.length}</p>
                <p className="text-xs text-gray-500">Zonas monitoreadas</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* View toggle */}
        <div className="flex gap-1">
          <button
            onClick={() => setViewMode("map")}
            className={`px-4 py-2 text-sm font-medium rounded-md ${
              viewMode === "map" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600"
            }`}
          >
            Mapa de Ocupación
          </button>
          <button
            onClick={() => setViewMode("flows")}
            className={`px-4 py-2 text-sm font-medium rounded-md ${
              viewMode === "flows" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600"
            }`}
          >
            Flujos de Tráfico
          </button>
        </div>

        {viewMode === "map" ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Floor map */}
            <div className="lg:col-span-2">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Plano de Ocupación en Tiempo Real</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="relative bg-gray-50 border border-gray-200 rounded-lg" style={{ aspectRatio: "16/10" }}>
                    {/* Grid lines */}
                    <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                      {/* Walls / structure lines */}
                      <rect x="3" y="3" width="94" height="94" fill="none" stroke="#d1d5db" strokeWidth="0.5" />
                      <line x1="30" y1="3" x2="30" y2="50" stroke="#e5e7eb" strokeWidth="0.3" strokeDasharray="2 2" />
                      <line x1="65" y1="3" x2="65" y2="97" stroke="#e5e7eb" strokeWidth="0.3" strokeDasharray="2 2" />
                      <line x1="3" y1="50" x2="97" y2="50" stroke="#e5e7eb" strokeWidth="0.3" strokeDasharray="2 2" />
                    </svg>

                    {/* Zones */}
                    {ZONES.map((zone) => {
                      const colors = occupancyColor(zone.currentOccupancy, zone.maxCapacity);
                      const isSelected = selectedZone === zone.id;
                      return (
                        <button
                          key={zone.id}
                          onClick={() => setSelectedZone(isSelected ? null : zone.id)}
                          className="absolute transition-all hover:scale-[1.02]"
                          style={{
                            left: `${zone.x}%`,
                            top: `${zone.y}%`,
                            width: `${zone.w}%`,
                            height: `${zone.h}%`,
                          }}
                        >
                          <div
                            className={`w-full h-full rounded-md flex flex-col items-center justify-center ${
                              isSelected ? "ring-2 ring-blue-500" : ""
                            }`}
                            style={{
                              backgroundColor: colors.bg,
                              border: `1.5px solid ${colors.border}`,
                            }}
                          >
                            <span className="text-[9px] font-semibold text-gray-800 leading-tight text-center px-1">
                              {zone.name}
                            </span>
                            <span className={`text-[10px] font-bold ${colors.text}`}>
                              {zone.currentOccupancy}/{zone.maxCapacity}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Zone detail */}
            <div className="space-y-4">
              {selectedZone ? (
                (() => {
                  const zone = ZONES.find((z) => z.id === selectedZone)!;
                  const pct = Math.round((zone.currentOccupancy / zone.maxCapacity) * 100);
                  return (
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-base">{zone.name}</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-500">Ocupación actual</span>
                          <span className="font-bold">{zone.currentOccupancy} / {zone.maxCapacity}</span>
                        </div>
                        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{
                              width: `${pct}%`,
                              backgroundColor: pct > 80 ? "#ef4444" : pct > 50 ? "#f59e0b" : "#22c55e",
                            }}
                          />
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-500">Promedio diario</span>
                          <span className="font-medium">{zone.avgDaily} tránsitos</span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-500">Hora pico</span>
                          <span className="font-medium">{zone.peakHour}</span>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })()
              ) : (
                <Card>
                  <CardContent className="p-6 text-center text-gray-400">
                    <MapPin className="h-8 w-8 mx-auto mb-2" />
                    <p className="text-sm">Selecciona una zona para ver detalles</p>
                  </CardContent>
                </Card>
              )}

              {/* Hourly chart */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Tráfico por Hora (Hoy)</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-end gap-[2px] h-24">
                    {HOURLY_DATA.map((h) => (
                      <div
                        key={h.hour}
                        className="flex-1 rounded-t-sm transition-colors hover:opacity-80"
                        style={{
                          height: `${(h.count / maxHourly) * 100}%`,
                          backgroundColor:
                            h.count > 40 ? "#ef4444" : h.count > 20 ? "#f59e0b" : "#93c5fd",
                          minHeight: "2px",
                        }}
                        title={`${String(h.hour).padStart(2, "0")}:00 — ${h.count} tránsitos`}
                      />
                    ))}
                  </div>
                  <div className="flex justify-between text-[9px] text-gray-400 mt-1">
                    <span>00:00</span>
                    <span>06:00</span>
                    <span>12:00</span>
                    <span>18:00</span>
                    <span>23:00</span>
                  </div>
                </CardContent>
              </Card>

              {/* Weekly chart */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Tráfico Semanal</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {WEEKLY_DATA.map((d) => (
                      <div key={d.day} className="flex items-center gap-2">
                        <span className="text-xs text-gray-500 w-8">{d.day}</span>
                        <div className="flex-1 h-4 bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${(d.count / maxWeekly) * 100}%`,
                              backgroundColor: d.count > 200 ? "#3b82f6" : d.count > 100 ? "#60a5fa" : "#93c5fd",
                            }}
                          />
                        </div>
                        <span className="text-xs font-medium text-gray-700 w-8 text-right">{d.count}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        ) : (
          /* Flows view */
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Flujos de Tráfico Principales</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {FLOWS.sort((a, b) => b.count - a.count).map((flow, i) => (
                  <div key={i} className="flex items-center gap-3 p-3 rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors">
                    <span className="text-sm font-medium text-gray-500 w-6">{i + 1}.</span>
                    <div className="flex items-center gap-2 flex-1">
                      <span className="text-sm font-medium text-gray-900 bg-white px-2 py-1 rounded border border-gray-200">
                        {flow.from}
                      </span>
                      <ArrowRight className="h-4 w-4 text-blue-500" />
                      <span className="text-sm font-medium text-gray-900 bg-white px-2 py-1 rounded border border-gray-200">
                        {flow.to}
                      </span>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-gray-900">{flow.count}</p>
                      <p className="text-[10px] text-gray-500">~{flow.avgTime}</p>
                    </div>
                    <div className="w-20 h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-full"
                        style={{ width: `${(flow.count / FLOWS[0].count) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
