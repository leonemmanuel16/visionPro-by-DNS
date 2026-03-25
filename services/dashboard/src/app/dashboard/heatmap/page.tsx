"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Header } from "@/components/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Flame, User, Camera } from "lucide-react";
import { api } from "@/lib/api";
import { getApiUrl, getGo2rtcUrl } from "@/lib/urls";

interface CameraItem {
  id: string;
  name: string;
  ip_address?: string;
  location?: string;
  is_online: boolean;
}

interface EventItem {
  id: string;
  camera_id: string;
  event_type: string;
  label: string;
  confidence: number;
  bbox: { x1: number; y1: number; x2: number; y2: number } | null;
  occurred_at: string;
  metadata?: any;
}

interface PersonItem {
  id: string;
  name: string;
}

const TIME_RANGES = [
  { id: "1h", label: "Última hora", hours: 1 },
  { id: "6h", label: "Últimas 6h", hours: 6 },
  { id: "24h", label: "Últimas 24h", hours: 24 },
  { id: "7d", label: "Última semana", hours: 168 },
  { id: "30d", label: "Último mes", hours: 720 },
];

const GRID_COLS = 32;
const GRID_ROWS = 24;

function intensityToColor(intensity: number): string {
  if (intensity < 5) return "transparent";
  if (intensity < 15) return `rgba(0,0,255,${0.15 + intensity * 0.005})`;
  if (intensity < 30) return `rgba(0,180,255,${0.2 + intensity * 0.006})`;
  if (intensity < 50) return `rgba(0,220,100,${0.25 + intensity * 0.006})`;
  if (intensity < 70) return `rgba(255,200,0,${0.35 + intensity * 0.005})`;
  if (intensity < 85) return `rgba(255,100,0,${0.5 + intensity * 0.004})`;
  return `rgba(255,0,0,${0.6 + intensity * 0.004})`;
}

export default function HeatmapPage() {
  const [cameras, setCameras] = useState<CameraItem[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<string>("");
  const [selectedPerson, setSelectedPerson] = useState("all");
  const [timeRange, setTimeRange] = useState("24h");
  const [events, setEvents] = useState<EventItem[]>([]);
  const [persons, setPersons] = useState<PersonItem[]>([]);
  const [heatData, setHeatData] = useState<number[][]>([]);
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Load cameras
  useEffect(() => {
    loadCameras();
    loadPersons();
  }, []);

  // Load events when camera or filters change
  useEffect(() => {
    if (selectedCamera) {
      loadEvents();
      loadSnapshot();
    }
  }, [selectedCamera, timeRange, selectedPerson]);

  const loadCameras = async () => {
    let allCams: CameraItem[] = [];
    try {
      const apiCams = await api.get<CameraItem[]>("/cameras");
      if (Array.isArray(apiCams) && apiCams.length > 0) {
        allCams = apiCams;
      }
    } catch { /* API unavailable */ }

    setCameras(allCams);
    if (allCams.length > 0 && !selectedCamera) {
      setSelectedCamera(allCams[0].id);
    }
  };

  const loadPersons = async () => {
    try {
      const data = await api.get<PersonItem[]>("/persons");
      if (Array.isArray(data)) {
        setPersons(data);
      }
    } catch { /* ignore */ }
  };

  const loadSnapshot = () => {
    if (!selectedCamera) return;
    const cam = cameras.find((c) => c.id === selectedCamera);
    if (!cam) return;

    // Use go2rtc snapshot API for live frame — try h264 stream first, then base
    const camId = selectedCamera.replace(/-/g, "").slice(0, 12);
    const go2rtcUrl = getGo2rtcUrl();
    // Add timestamp to prevent caching
    const ts = Date.now();
    setSnapshotUrl(`${go2rtcUrl}/api/frame.jpeg?src=cam_${camId}_h264&t=${ts}`);
  };

  const loadEvents = async () => {
    setLoading(true);
    try {
      const range = TIME_RANGES.find((t) => t.id === timeRange);
      const since = new Date(Date.now() - (range?.hours || 24) * 3600000).toISOString();

      // API uses "from" parameter (not "since"), and max per_page is 200
      // Fetch multiple pages to get up to 1000 events for heatmap accuracy
      let url = `/events?camera_id=${selectedCamera}&per_page=200&from=${encodeURIComponent(since)}`;
      if (selectedPerson !== "all") {
        // Filter by person name in metadata — done client-side after fetch
      }

      const data = await api.get<EventItem[]>(url);
      if (Array.isArray(data)) {
        let filtered = data;

        // Filter by person if selected
        if (selectedPerson !== "all") {
          filtered = data.filter((e) => {
            const meta = e.metadata;
            return meta && meta.person_id === selectedPerson;
          });
        }

        setEvents(filtered);
        generateHeatmap(filtered);
      } else {
        setEvents([]);
        generateHeatmap([]);
      }
    } catch {
      setEvents([]);
      generateHeatmap([]);
    }
    setLoading(false);
  };

  const generateHeatmap = (evts: EventItem[]) => {
    // Initialize grid
    const grid: number[][] = [];
    for (let y = 0; y < GRID_ROWS; y++) {
      grid.push(new Array(GRID_COLS).fill(0));
    }

    // Auto-detect frame dimensions from event metadata or bbox values
    // The detector stores frame_width/frame_height in metadata
    let frameW = 0;
    let frameH = 0;

    // First, try to get dimensions from metadata of any event
    for (const evt of evts) {
      if (evt.metadata?.frame_width && evt.metadata?.frame_height) {
        frameW = evt.metadata.frame_width;
        frameH = evt.metadata.frame_height;
        break;
      }
    }

    // Fallback: auto-detect from max bbox coordinates
    if (frameW === 0 || frameH === 0) {
      let maxX = 0, maxY = 0;
      for (const evt of evts) {
        if (!evt.bbox) continue;
        if (evt.bbox.x2 > maxX) maxX = evt.bbox.x2;
        if (evt.bbox.y2 > maxY) maxY = evt.bbox.y2;
      }
      // Round up to common resolutions
      if (maxX <= 1 && maxY <= 1) {
        frameW = 1; frameH = 1; // Already normalized
      } else if (maxX <= 640) {
        frameW = 640; frameH = 480;
      } else if (maxX <= 704) {
        frameW = 704; frameH = 576;
      } else if (maxX <= 1280) {
        frameW = 1280; frameH = 720;
      } else if (maxX <= 1920) {
        frameW = 1920; frameH = 1080;
      } else if (maxX <= 2048) {
        frameW = 2048; frameH = 1536;
      } else if (maxX <= 2560) {
        frameW = 2560; frameH = 1440;
      } else {
        frameW = 3840; frameH = 2160;
      }
    }

    // Accumulate detections by grid position
    let maxCount = 0;
    for (const evt of evts) {
      if (!evt.bbox) continue;

      const { x1, y1, x2, y2 } = evt.bbox;
      // Center of detection
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;

      // Normalize to 0-1 using detected frame dimensions
      const nx = frameW <= 1 ? cx : cx / frameW;
      const ny = frameH <= 1 ? cy : cy / frameH;

      // Map to grid cell
      const gx = Math.min(Math.floor(nx * GRID_COLS), GRID_COLS - 1);
      const gy = Math.min(Math.floor(ny * GRID_ROWS), GRID_ROWS - 1);

      if (gx >= 0 && gx < GRID_COLS && gy >= 0 && gy < GRID_ROWS) {
        grid[gy][gx]++;

        // Gaussian-like spread to surrounding cells (2-cell radius for smoother look)
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (dx === 0 && dy === 0) continue;
            const ny2 = gy + dy;
            const nx2 = gx + dx;
            if (ny2 >= 0 && ny2 < GRID_ROWS && nx2 >= 0 && nx2 < GRID_COLS) {
              const dist = Math.sqrt(dx * dx + dy * dy);
              grid[ny2][nx2] += Math.max(0, 1 - dist * 0.35);
            }
          }
        }

        if (grid[gy][gx] > maxCount) maxCount = grid[gy][gx];
      }
    }

    // Normalize to 0-100
    if (maxCount > 0) {
      for (let y = 0; y < GRID_ROWS; y++) {
        for (let x = 0; x < GRID_COLS; x++) {
          grid[y][x] = Math.round((grid[y][x] / maxCount) * 100);
        }
      }
    }

    setHeatData(grid);
  };

  const cameraInfo = cameras.find((c) => c.id === selectedCamera);

  // Stats from real data
  const maxIntensity = heatData.length > 0 ? Math.max(...heatData.flat()) : 0;
  const avgIntensity = heatData.length > 0
    ? Math.round(heatData.flat().reduce((a, b) => a + b, 0) / heatData.flat().length)
    : 0;
  const hotZones = heatData.length > 0 ? heatData.flat().filter((v) => v > 70).length : 0;
  const totalDetections = events.length;

  // Peak hours from real events
  const hourCounts: Record<number, number> = {};
  for (const evt of events) {
    const hour = new Date(evt.occurred_at).getHours();
    hourCounts[hour] = (hourCounts[hour] || 0) + 1;
  }
  const peakHours = Object.entries(hourCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4)
    .map(([hour, count]) => ({
      hour: `${String(hour).padStart(2, "0")}:00 - ${String((parseInt(hour) + 1) % 24).padStart(2, "0")}:00`,
      count,
      level: count > 20 ? "Alto" : count > 10 ? "Medio" : "Bajo",
    }));

  return (
    <>
      <Header title="Mapa de Calor" />
      <div className="p-6 space-y-6">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Camera className="h-4 w-4 text-gray-500" />
            <select
              value={selectedCamera}
              onChange={(e) => setSelectedCamera(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
            >
              {cameras.length === 0 && <option value="">No hay cámaras</option>}
              {cameras.map((cam) => (
                <option key={cam.id} value={cam.id}>
                  {cam.name} {cam.is_online ? "● Online" : "○ Offline"}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <User className="h-4 w-4 text-gray-500" />
            <select
              value={selectedPerson}
              onChange={(e) => setSelectedPerson(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
            >
              <option value="all">Todas las personas</option>
              {persons.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

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

          {loading && (
            <span className="text-xs text-gray-400">Cargando detecciones...</span>
          )}
        </div>

        {cameras.length === 0 ? (
          <Card>
            <CardContent className="flex items-center justify-center py-16 text-gray-400">
              <div className="text-center">
                <Camera className="mx-auto h-12 w-12 mb-3 text-gray-300" />
                <p className="text-sm">No hay cámaras configuradas</p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Heatmap with camera background */}
            <div className="lg:col-span-3">
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Flame className="h-5 w-5 text-orange-500" />
                      {cameraInfo?.name || "Cámara"} — {cameraInfo?.location || ""}
                    </CardTitle>
                    <Badge variant="default">
                      {totalDetections} detecciones
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="relative bg-gray-900 rounded-lg overflow-hidden aspect-video">
                    {/* Camera snapshot background */}
                    {snapshotUrl && (
                      <img
                        src={snapshotUrl}
                        alt="Camera snapshot"
                        className="absolute inset-0 w-full h-full object-cover opacity-60"
                        onError={(e) => {
                          const img = e.target as HTMLImageElement;
                          // Fallback: try base stream (without _h264)
                          if (img.src.includes("_h264")) {
                            const camId = selectedCamera.replace(/-/g, "").slice(0, 12);
                            img.src = `${getGo2rtcUrl()}/api/frame.jpeg?src=cam_${camId}&t=${Date.now()}`;
                          } else {
                            img.style.display = "none";
                          }
                        }}
                      />
                    )}

                    {/* No detections message */}
                    {totalDetections === 0 && !loading && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <p className="text-sm text-gray-400 bg-black/50 px-4 py-2 rounded">
                          Sin detecciones en este período
                        </p>
                      </div>
                    )}

                    {/* Heatmap overlay */}
                    {heatData.length > 0 && (
                      <div
                        className="absolute inset-0"
                        style={{
                          display: "grid",
                          gridTemplateRows: `repeat(${GRID_ROWS}, 1fr)`,
                          gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)`,
                        }}
                      >
                        {heatData.map((row, y) =>
                          row.map((val, x) => (
                            <div
                              key={`${y}-${x}`}
                              style={{
                                backgroundColor: intensityToColor(val),
                                filter: "blur(6px)",
                              }}
                              title={`Zona (${x},${y}): ${Math.round(val)}% actividad`}
                            />
                          ))
                        )}
                      </div>
                    )}

                    {/* Legend */}
                    <div className="absolute bottom-3 right-3 flex items-center gap-1 bg-black/70 rounded-md px-2 py-1">
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
                    <span className="text-xs text-gray-500">Total detecciones</span>
                    <span className="text-sm font-bold text-blue-600">{totalDetections}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-gray-500">Intensidad máxima</span>
                    <span className="text-sm font-bold text-red-600">{maxIntensity}%</span>
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
                  <CardTitle className="text-sm">Horas pico</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1">
                  {peakHours.length === 0 ? (
                    <p className="text-xs text-gray-400">Sin datos suficientes</p>
                  ) : (
                    peakHours.map((h) => (
                      <div key={h.hour} className="flex justify-between items-center text-xs">
                        <span className="text-gray-600">{h.hour}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-gray-400">{h.count}</span>
                          <Badge
                            variant={
                              h.level === "Alto" ? "destructive" : h.level === "Medio" ? "default" : "secondary"
                            }
                          >
                            {h.level}
                          </Badge>
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
