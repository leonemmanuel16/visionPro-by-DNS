"use client";

import { useState, useEffect } from "react";
import { Header } from "@/components/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Flame, User, Camera } from "lucide-react";
import { api } from "@/lib/api";

interface CameraItem {
  id: string;
  name: string;
  location?: string;
  is_online: boolean;
}

// Simulated heatmap data — each cell is a zone with an intensity 0-100
function generateHeatData(seed: number) {
  const data: number[][] = [];
  for (let y = 0; y < 12; y++) {
    const row: number[] = [];
    for (let x = 0; x < 16; x++) {
      const distToCenter = Math.sqrt(Math.pow(x - 8, 2) + Math.pow(y - 6, 2));
      const distToDoor = Math.sqrt(Math.pow(x - 2, 2) + Math.pow(y - 10, 2));
      const distToDesk = Math.sqrt(Math.pow(x - 12, 2) + Math.pow(y - 3, 2));
      const base = Math.max(
        80 - distToCenter * (8 + seed),
        90 - distToDoor * (6 + seed * 2),
        70 - distToDesk * (7 + seed),
        5
      );
      row.push(Math.min(100, Math.max(0, base + Math.random() * 15)));
    }
    data.push(row);
  }
  return data;
}

const DEMO_PEOPLE = [
  { id: "all", name: "Todas las personas" },
  { id: "p-001", name: "Juan Pérez" },
  { id: "p-002", name: "María García" },
  { id: "p-004", name: "Ana Martínez" },
  { id: "p-005", name: "Roberto Díaz" },
];

const TIME_RANGES = [
  { id: "1h", label: "Última hora" },
  { id: "6h", label: "Últimas 6h" },
  { id: "24h", label: "Últimas 24h" },
  { id: "7d", label: "Última semana" },
  { id: "30d", label: "Último mes" },
];

function intensityToColor(intensity: number): string {
  if (intensity < 15) return "rgba(0,0,255,0.05)";
  if (intensity < 30) return `rgba(0,100,255,${0.1 + intensity * 0.005})`;
  if (intensity < 50) return `rgba(0,200,100,${0.2 + intensity * 0.006})`;
  if (intensity < 70) return `rgba(255,200,0,${0.3 + intensity * 0.006})`;
  if (intensity < 85) return `rgba(255,100,0,${0.5 + intensity * 0.004})`;
  return `rgba(255,0,0,${0.6 + intensity * 0.004})`;
}

export default function HeatmapPage() {
  const [cameras, setCameras] = useState<CameraItem[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<string>("");
  const [selectedPerson, setSelectedPerson] = useState("all");
  const [timeRange, setTimeRange] = useState("24h");

  // Load cameras from API + localStorage (same logic as cameras page)
  useEffect(() => {
    loadCameras();
  }, []);

  const loadCameras = async () => {
    let allCams: CameraItem[] = [];

    // From API
    try {
      const apiCams = await api.get<CameraItem[]>("/cameras");
      if (Array.isArray(apiCams) && apiCams.length > 0) {
        allCams = apiCams;
      }
    } catch { /* API unavailable */ }

    // From localStorage
    try {
      const raw = localStorage.getItem("custom_cameras");
      if (raw) {
        const localCams = JSON.parse(raw) as CameraItem[];
        // Merge: avoid duplicates by IP
        const apiIps = new Set(allCams.map((c) => c.ip_address || ""));
        for (const lc of localCams) {
          if (!apiIps.has((lc as any).ip_address)) {
            allCams.push(lc);
          }
        }
      }
    } catch { /* ignore */ }

    // Filter deleted
    try {
      const deletedRaw = localStorage.getItem("deleted_cameras");
      if (deletedRaw) {
        const deletedIds = JSON.parse(deletedRaw) as string[];
        allCams = allCams.filter((c) => !deletedIds.includes(c.id));
      }
    } catch { /* ignore */ }

    setCameras(allCams);
    if (allCams.length > 0 && !selectedCamera) {
      setSelectedCamera(allCams[0].id);
    }
  };

  const cameraInfo = cameras.find((c) => c.id === selectedCamera);
  const personSeed = selectedPerson === "all" ? 0 : DEMO_PEOPLE.findIndex((p) => p.id === selectedPerson);
  const timeSeed = TIME_RANGES.findIndex((t) => t.id === timeRange);
  const heatData = generateHeatData(personSeed + timeSeed);

  // Stats
  const maxIntensity = Math.max(...heatData.flat());
  const avgIntensity = Math.round(heatData.flat().reduce((a, b) => a + b, 0) / heatData.flat().length);
  const hotZones = heatData.flat().filter((v) => v > 70).length;

  return (
    <>
      <Header title="Mapa de Calor" />
      <div className="p-6 space-y-6">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-4">
          {/* Camera selector */}
          <div className="flex items-center gap-2">
            <Camera className="h-4 w-4 text-gray-500" />
            <select
              value={selectedCamera}
              onChange={(e) => setSelectedCamera(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
            >
              {cameras.length === 0 && (
                <option value="">No hay cámaras</option>
              )}
              {cameras.map((cam) => (
                <option key={cam.id} value={cam.id}>
                  {cam.name} {cam.is_online ? "● Online" : "○ Offline"}
                </option>
              ))}
            </select>
          </div>

          {/* Person filter */}
          <div className="flex items-center gap-2">
            <User className="h-4 w-4 text-gray-500" />
            <select
              value={selectedPerson}
              onChange={(e) => setSelectedPerson(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
            >
              {DEMO_PEOPLE.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* Time range */}
          <div className="flex items-center gap-1">
            {TIME_RANGES.map((t) => (
              <button
                key={t.id}
                onClick={() => setTimeRange(t.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  timeRange === t.id
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {cameras.length === 0 ? (
          <Card>
            <CardContent className="flex items-center justify-center py-16 text-gray-400">
              <div className="text-center">
                <Camera className="mx-auto h-12 w-12 mb-3 text-gray-300" />
                <p className="text-sm">No hay cámaras configuradas</p>
                <p className="text-xs mt-1">Agrega cámaras desde la sección de Cámaras</p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Heatmap */}
            <div className="lg:col-span-3">
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Flame className="h-5 w-5 text-orange-500" />
                      {cameraInfo?.name || "Selecciona una cámara"} — {cameraInfo?.location || ""}
                    </CardTitle>
                    {selectedPerson !== "all" && (
                      <Badge variant="default">
                        Filtrado: {DEMO_PEOPLE.find((p) => p.id === selectedPerson)?.name}
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="relative bg-gray-900 rounded-lg overflow-hidden aspect-video">
                    {/* Camera placeholder bg */}
                    <div className="absolute inset-0 flex items-center justify-center text-gray-700 text-sm">
                      Vista de cámara
                    </div>
                    {/* Heatmap overlay */}
                    <div className="absolute inset-0 grid" style={{ gridTemplateRows: `repeat(12, 1fr)`, gridTemplateColumns: `repeat(16, 1fr)` }}>
                      {heatData.map((row, y) =>
                        row.map((val, x) => (
                          <div
                            key={`${y}-${x}`}
                            style={{
                              backgroundColor: intensityToColor(val),
                              filter: "blur(2px)",
                            }}
                            title={`Intensidad: ${Math.round(val)}%`}
                          />
                        ))
                      )}
                    </div>
                    {/* Legend */}
                    <div className="absolute bottom-3 right-3 flex items-center gap-1 bg-black/60 rounded-md px-2 py-1">
                      <span className="text-[10px] text-white mr-1">Baja</span>
                      {[10, 30, 50, 70, 90].map((v) => (
                        <div
                          key={v}
                          className="w-4 h-3 rounded-sm"
                          style={{ backgroundColor: intensityToColor(v) }}
                        />
                      ))}
                      <span className="text-[10px] text-white ml-1">Alta</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Stats sidebar */}
            <div className="space-y-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Estadísticas</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-gray-500">Intensidad máxima</span>
                    <span className="text-sm font-bold text-red-600">{Math.round(maxIntensity)}%</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-gray-500">Intensidad promedio</span>
                    <span className="text-sm font-bold text-orange-500">{avgIntensity}%</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-gray-500">Zonas calientes</span>
                    <span className="text-sm font-bold text-yellow-600">{hotZones}</span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Zonas más transitadas</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {[
                    { zone: "Entrada/Salida", pct: 92 },
                    { zone: "Pasillo central", pct: 78 },
                    { zone: "Escritorios", pct: 65 },
                    { zone: "Esquina NE", pct: 23 },
                  ].map((z) => (
                    <div key={z.zone}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-gray-600">{z.zone}</span>
                        <span className="font-medium">{z.pct}%</span>
                      </div>
                      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${z.pct}%`,
                            backgroundColor:
                              z.pct > 80 ? "#ef4444" : z.pct > 50 ? "#f59e0b" : "#22c55e",
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Horas pico</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1">
                  {[
                    { hour: "08:00 - 09:00", level: "Alto" },
                    { hour: "12:00 - 13:00", level: "Alto" },
                    { hour: "17:00 - 18:00", level: "Medio" },
                    { hour: "03:00 - 05:00", level: "Bajo" },
                  ].map((h) => (
                    <div key={h.hour} className="flex justify-between items-center text-xs">
                      <span className="text-gray-600">{h.hour}</span>
                      <Badge
                        variant={
                          h.level === "Alto" ? "destructive" : h.level === "Medio" ? "default" : "secondary"
                        }
                      >
                        {h.level}
                      </Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
