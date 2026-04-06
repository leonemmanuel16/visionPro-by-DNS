"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Header } from "@/components/Header";
import { SnapshotPlayer } from "@/components/SnapshotPlayer";
import { VideoPlayer } from "@/components/VideoPlayer";
import { PTZControls } from "@/components/PTZControls";
import { DetectionOverlay } from "@/components/DetectionOverlay";
import { ZoneOverlay, ZonePolygon, getZoneColor } from "@/components/ZoneOverlay";
import { wsClient } from "@/lib/websocket";
import { FisheyeDewarper } from "@/components/FisheyeDewarper";
import { EventCard } from "@/components/EventCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { getGo2rtcUrl } from "@/lib/urls";
import {
  Trash2,
  Settings,
  Eye,
  User,
  Car,
  Dog,
  Flame,
  ShieldAlert,
  ScanFace,
  HelpCircle,
  Footprints,
  Package,
  Clock,
  Save,
  ArrowLeft,
  Crosshair,
  Undo,
  XCircle,
  Plus,
  PenTool,
  ArrowLeftRight,
  Users,
} from "lucide-react";

interface CameraDetail {
  id: string;
  name: string;
  ip_address: string;
  manufacturer?: string;
  model?: string;
  firmware?: string;
  has_ptz: boolean;
  is_online: boolean;
  is_enabled: boolean;
  location?: string;
  last_seen_at?: string;
  port?: number;
  camera_type?: string;
}

interface Point { x: number; y: number; }

// Per-detection zone data: up to 4 zones per detection
interface DetZoneData {
  zones: { id: string; name: string; points: Point[]; apiId?: string; direction?: "A_to_B" | "B_to_A" | "both" }[];
  schedule?: { enabled: boolean; startTime: string; endTime: string };
  subOptions?: Record<string, boolean>;
}

const DETECTION_CAPABILITIES = [
  { id: "person", label: "Personas", icon: User, color: "text-green-600", bg: "bg-green-50", border: "border-green-500", desc: "Detectar personas caminando, paradas" },
  { id: "face_recognition", label: "Reconocimiento Facial", icon: ScanFace, color: "text-blue-600", bg: "bg-blue-50", border: "border-blue-500", desc: "Identificar rostros de la base de datos" },
  { id: "face_unknown", label: "Rostros Desconocidos", icon: HelpCircle, color: "text-orange-500", bg: "bg-orange-50", border: "border-orange-500", desc: "Alertar cuando aparece un rostro no registrado" },
  { id: "vehicle", label: "Vehiculos", icon: Car, color: "text-yellow-600", bg: "bg-yellow-50", border: "border-yellow-500", desc: "Detectar autos, camionetas, camiones, motos" },
  { id: "animal", label: "Animales", icon: Dog, color: "text-purple-600", bg: "bg-purple-50", border: "border-purple-500", desc: "Detectar perros, gatos y otros animales" },
  { id: "intrusion", label: "Intrusion de Zona", icon: ShieldAlert, color: "text-red-600", bg: "bg-red-50", border: "border-red-500", desc: "Alertar cuando alguien entra a zona prohibida" },
  { id: "line_crossing", label: "Cruce de Linea", icon: ArrowLeftRight, color: "text-pink-600", bg: "bg-pink-50", border: "border-pink-500", desc: "Detectar cuando alguien cruza una linea virtual" },
  { id: "person_count", label: "Conteo de Personas", icon: Users, color: "text-teal-600", bg: "bg-teal-50", border: "border-teal-500", desc: "Contar personas en una zona definida" },
  { id: "loitering", label: "Merodeo", icon: Footprints, color: "text-amber-600", bg: "bg-amber-50", border: "border-amber-500", desc: "Personas que permanecen mucho tiempo" },
  { id: "abandoned_object", label: "Objeto Abandonado", icon: Package, color: "text-gray-600", bg: "bg-gray-50", border: "border-gray-500", desc: "Objetos dejados o removidos sin supervision" },
];

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isValidUUID = (s: string) => UUID_REGEX.test(s);
const isLegacyId = (s: string) => s.startsWith("cam-") && !isValidUUID(s);

const MAX_ZONES_PER_DET = 4;

export default function CameraDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [camera, setCamera] = useState<CameraDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<"live" | "config" | "detections" | "image" | "events">("live");

  // Detection settings
  const [enabledDetections, setEnabledDetections] = useState<string[]>([]);
  const [selectedDetection, setSelectedDetection] = useState<string | null>(null);

  // Zones per detection: { "person": { zones: [...] }, "vehicle": { zones: [...] } }
  const [detZones, setDetZones] = useState<Record<string, DetZoneData>>({});

  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawingPoints, setDrawingPoints] = useState<Point[]>([]);

  // Image adjustments
  const [imageSettings, setImageSettings] = useState({
    brightness: 50, contrast: 50, saturation: 50, sharpness: 50,
    wdr: false, nightMode: "auto" as "auto" | "on" | "off", irCut: true,
  });

  const [liveDetections, setLiveDetections] = useState<any[]>([]);
  const EVENT_COOLDOWN = 30;
  const [saved, setSaved] = useState(false);

  // Camera edit fields
  const [editName, setEditName] = useState("");
  const [editIp, setEditIp] = useState("");
  const [editPort, setEditPort] = useState("80");
  const [editUsername, setEditUsername] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editLocation, setEditLocation] = useState("");
  const [editManufacturer, setEditManufacturer] = useState("");
  const [editModel, setEditModel] = useState("");
  const [editCameraType, setEditCameraType] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const CAMERA_TYPES = [
    { value: "domo", label: "Domo" }, { value: "bala", label: "Bala (Bullet)" },
    { value: "ptz", label: "PTZ" }, { value: "fisheye", label: "Fisheye" },
    { value: "termica", label: "Termica" }, { value: "turret", label: "Turret" },
    { value: "box", label: "Box" }, { value: "otra", label: "Otra" },
  ];

  const CAMERA_BRANDS = [
    "Hikvision", "Dahua", "Axis", "Hanwha (Samsung)", "Vivotek",
    "Uniview", "Bosch", "Honeywell", "Pelco", "Geovision", "Reolink", "Otra",
  ];

  const go2rtcUrl = getGo2rtcUrl();

  // ── Load camera + zones ──
  useEffect(() => {
    if (isLegacyId(id)) {
      setNotFound(true);
      setLoadError("ID de camara invalido.");
      return;
    }
    api.get<CameraDetail>(`/cameras/${id}`).then((data) => {
      if (data && (data as any).id) setCamera(data);
      else {
        const c = loadLS(id);
        if (c) setCamera(c); else setNotFound(true);
      }
    }).catch(() => {
      const c = loadLS(id);
      if (c) setCamera(c); else setNotFound(true);
    });

    if (isValidUUID(id)) {
      api.get<any[]>(`/events?camera_id=${id}&per_page=10`).then(setEvents).catch(() => setEvents([]));
      // Load zones from API and map per detection class
      api.get<any[]>(`/zones?camera_id=${id}`).then((data) => {
        if (!Array.isArray(data)) return;
        const mapped: Record<string, DetZoneData> = {};
        data.forEach((z) => {
          const classes = z.detect_classes || [];
          classes.forEach((cls: string) => {
            if (!mapped[cls]) mapped[cls] = { zones: [] };
            mapped[cls].zones.push({
              id: z.id,
              name: z.name || `Zona ${mapped[cls].zones.length + 1}`,
              points: z.points || [],
              apiId: z.id,
            });
          });
        });
        setDetZones((prev) => ({ ...prev, ...mapped }));
      }).catch(() => {});
    }

    try {
      const sd = localStorage.getItem(`cam_detections_${id}`);
      if (sd) setEnabledDetections(JSON.parse(sd));
      const si = localStorage.getItem(`cam_image_${id}`);
      if (si) setImageSettings(JSON.parse(si));
      const sz = localStorage.getItem(`cam_zones_v2_${id}`);
      if (sz) setDetZones((prev) => {
        const parsed = JSON.parse(sz);
        // API data takes priority
        return { ...parsed, ...prev };
      });
    } catch (_e) {}
  }, [id]);

  useEffect(() => {
    if (camera) {
      setEditName(camera.name || "");
      setEditIp(camera.ip_address || "");
      setEditPort(String(camera.port || 80));
      setEditUsername((camera as any).username || "");
      setEditLocation(camera.location || "");
      setEditManufacturer(camera.manufacturer || "");
      setEditModel(camera.model || "");
      setEditCameraType(camera.camera_type || "");
    }
  }, [camera]);

  useEffect(() => {
    if (!camera) return;
    let lastTrackingTime = 0;
    const h = (data: any) => {
      if (data.type === "tracking" && data.camera_id === camera.id) {
        lastTrackingTime = Date.now();
        setLiveDetections(data.tracks || []);
      }
    };
    wsClient.on("tracking", h);
    // Clear stale detections: if no tracking update in 1s, clear boxes
    const t = setInterval(() => {
      if (Date.now() - lastTrackingTime > 1000) {
        setLiveDetections([]);
      }
    }, 500);
    return () => { wsClient.off("tracking", h); clearInterval(t); };
  }, [camera]);

  // Persist zones
  useEffect(() => {
    if (id) {
      try { localStorage.setItem(`cam_zones_v2_${id}`, JSON.stringify(detZones)); } catch (_e) {}
    }
  }, [detZones, id]);

  function loadLS(camId: string): CameraDetail | null {
    try {
      const raw = localStorage.getItem("custom_cameras");
      if (!raw) return null;
      const found = JSON.parse(raw).find((c: any) => c.id === camId);
      if (found) return { ...found, has_ptz: false } as CameraDetail;
    } catch (_e) {}
    return null;
  }

  // ── Toggle detection ──
  const toggleDetection = (detId: string) => {
    const wasEnabled = enabledDetections.includes(detId);
    setEnabledDetections((prev) => {
      let next = wasEnabled ? prev.filter((d) => d !== detId) : [...prev, detId];
      // person_count requires line_crossing
      if (detId === "person_count" && !wasEnabled && !next.includes("line_crossing")) {
        next = [...next, "line_crossing"];
      }
      const shouldBeOn = next.length > 0;
      const wasOn = camera?.is_enabled ?? false;
      if (shouldBeOn !== wasOn) {
        if (camera) camera.is_enabled = shouldBeOn;
        setCamera((p) => p ? { ...p, is_enabled: shouldBeOn } : p);
        api.put(`/cameras/${id}`, { is_enabled: shouldBeOn }).catch(() => {});
      }
      // Auto-save detect_classes to API immediately (don't wait for "Guardar")
      localStorage.setItem(`cam_detections_${id}`, JSON.stringify(next));
      api.put(`/cameras/${id}/settings`, { detections: next }).catch(() => {});
      return next;
    });
    if (!wasEnabled) {
      setSelectedDetection(detId);
      setIsDrawing(false);
      setDrawingPoints([]);
    } else if (selectedDetection === detId) {
      setSelectedDetection(null);
      setIsDrawing(false);
    }
  };

  // ── Zone management ──
  const startDrawing = () => {
    setIsDrawing(true);
    setDrawingPoints([]);
  };

  const cancelDrawing = () => {
    setIsDrawing(false);
    setDrawingPoints([]);
  };

  const saveCurrentZone = () => {
    const minPts = selectedDetection === "line_crossing" ? 2 : 3;
    if (!selectedDetection || drawingPoints.length < minPts) return;
    const existing = detZones[selectedDetection]?.zones || [];
    if (existing.length >= MAX_ZONES_PER_DET) return;
    const newZone: any = {
      id: `zone_${Date.now()}`,
      name: selectedDetection === "line_crossing" ? `Linea ${existing.length + 1}` : `Zona ${existing.length + 1}`,
      points: drawingPoints,
    };
    if (selectedDetection === "line_crossing") {
      newZone.direction = "both";
    }
    setDetZones((prev) => ({
      ...prev,
      [selectedDetection]: { ...prev[selectedDetection], zones: [...(prev[selectedDetection]?.zones || []), newZone] },
    }));
    setIsDrawing(false);
    setDrawingPoints([]);
  };

  const deleteZone = (detId: string, zoneId: string) => {
    setDetZones((prev) => {
      const zones = (prev[detId]?.zones || []).filter((z) => z.id !== zoneId);
      return { ...prev, [detId]: { zones } };
    });
  };

  // ── Save everything ──
  const handleSaveSettings = async () => {
    localStorage.setItem(`cam_detections_${id}`, JSON.stringify(enabledDetections));
    localStorage.setItem(`cam_image_${id}`, JSON.stringify(imageSettings));
    localStorage.setItem(`cam_zones_v2_${id}`, JSON.stringify(detZones));

    // Save detection classes to camera config
    try {
      await api.put(`/cameras/${id}/settings`, { detections: enabledDetections, image: imageSettings });
    } catch (_e) {}

    // Sync is_enabled
    const shouldBeOn = enabledDetections.length > 0;
    if (camera && camera.is_enabled !== shouldBeOn) {
      await api.put(`/cameras/${id}`, { is_enabled: shouldBeOn }).catch(() => {});
      setCamera((p) => p ? { ...p, is_enabled: shouldBeOn } : p);
    }

    // Save zones to API
    for (const [detId, data] of Object.entries(detZones)) {
      if (!enabledDetections.includes(detId)) continue;
      // line_crossing uses tripwire zone type (2 points = line), others use roi (polygon)
      const zoneType = detId === "line_crossing" ? "tripwire" : "roi";
      const minPoints = detId === "line_crossing" ? 2 : 3;
      for (const zone of data.zones) {
        if (zone.points.length < minPoints) continue;
        const payload: any = {
          name: zone.name, zone_type: zoneType, points: zone.points,
          detect_classes: [detId], is_enabled: true,
        };
        if ((zone as any).direction) {
          payload.direction = (zone as any).direction;
        }
        if (zone.apiId) {
          await api.put(`/zones/${zone.apiId}`, payload).catch(() => {});
        } else {
          const res = await api.post<any>("/zones", {
            camera_id: id, ...payload,
          }).catch(() => null);
          if (res?.id) zone.apiId = res.id;
        }
      }
    }

    // Save schedule and subOptions to camera config
    const detConfig: Record<string, any> = {};
    for (const [detId, data] of Object.entries(detZones)) {
      if (data.schedule?.enabled) {
        detConfig[`${detId}_schedule`] = data.schedule;
      }
      if (data.subOptions && Object.keys(data.subOptions).length > 0) {
        detConfig[`${detId}_options`] = data.subOptions;
      }
    }
    try {
      await api.put(`/cameras/${id}/settings`, {
        detections: enabledDetections,
        image: imageSettings,
        detection_config: detConfig,
      });
    } catch (_e) {}

    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleSaveCameraConfig = async () => {
    setEditSaving(true);
    try {
      const d: Record<string, any> = {
        name: editName, location: editLocation, manufacturer: editManufacturer,
        model: editModel, camera_type: editCameraType,
      };
      if (editPassword) d.password = editPassword;
      await api.put(`/cameras/${id}`, d);
      setCamera((p) => p ? { ...p, ...d } : p);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (_e) {
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    }
    setEditSaving(false);
  };

  const handleDelete = async () => {
    if (!confirm(`Eliminar camara "${camera?.name}"?`)) return;
    try { await api.del(`/cameras/${id}`); } catch (_e) {}
    localStorage.removeItem(`cam_detections_${id}`);
    localStorage.removeItem(`cam_image_${id}`);
    localStorage.removeItem(`cam_zones_v2_${id}`);
    router.push("/dashboard/cameras");
  };

  // ── Render ──
  if (notFound) {
    return (
      <>
        <Header title="Camara no encontrada" />
        <div className="flex flex-col items-center justify-center h-[60vh] text-gray-400">
          <p className="text-lg font-medium mb-2">Camara no encontrada</p>
          <p className="text-sm mb-6">{loadError || `ID: ${id}`}</p>
          <Button onClick={() => router.push("/dashboard/cameras")}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Volver
          </Button>
        </div>
      </>
    );
  }
  if (!camera) return <div className="flex items-center justify-center h-screen text-gray-400">Cargando...</div>;

  const streamName = `cam_${camera.id.replace(/-/g, "").slice(0, 12)}`;
  const tabs = [
    { id: "live" as const, label: "En Vivo" },
    { id: "config" as const, label: "Configuracion" },
    { id: "detections" as const, label: "Detecciones" },
    { id: "image" as const, label: "Imagen" },
    { id: "events" as const, label: "Eventos" },
  ];

  const selectedDef = selectedDetection ? DETECTION_CAPABILITIES.find((c) => c.id === selectedDetection) : null;
  const showZonePanel = activeTab === "detections" && selectedDetection && selectedDef && enabledDetections.includes(selectedDetection);
  const selectedZones = selectedDetection ? (detZones[selectedDetection]?.zones || []) : [];

  // Build all zone polygons for overlay on video (show all enabled detections' zones)
  const allZonePolygons: ZonePolygon[] = [];
  let colorIdx = 0;
  enabledDetections.forEach((detId) => {
    const data = detZones[detId];
    if (!data) return;
    data.zones.forEach((z) => {
      const minPts = detId === "line_crossing" ? 2 : 3;
      if (z.points.length >= minPts) {
        allZonePolygons.push({
          id: z.id,
          name: z.name,
          points: z.points,
          color: getZoneColor(colorIdx).stroke,
          direction: (z as any).direction,
          type: detId === "line_crossing" ? "tripwire" : "roi",
        } as any);
        colorIdx++;
      }
    });
  });

  const drawColor = selectedDef ? getZoneColor(allZonePolygons.length).stroke : "#2563eb";

  return (
    <>
      <Header title={camera.name} />
      <div className="p-6 space-y-6">
        {/* Top bar */}
        <div className="flex items-center justify-between">
          <button onClick={() => router.push("/dashboard/cameras")} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
            <ArrowLeft className="h-4 w-4" /> Volver a camaras
          </button>
          <div className="flex items-center gap-2">
            {saved && <span className="text-xs text-green-600 font-medium">Guardado</span>}
            <Button size="sm" onClick={handleSaveSettings}>
              <Save className="h-4 w-4 mr-1" /> Guardar Config
            </Button>
            <Button size="sm" variant="outline" className="text-red-600 hover:bg-red-50" onClick={handleDelete}>
              <Trash2 className="h-4 w-4 mr-1" /> Eliminar
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Video + zone overlay */}
          <div className="lg:col-span-2">
            <div className="relative rounded-lg overflow-hidden border border-gray-200">
              {camera.camera_type === "fisheye" ? (
                <FisheyeDewarper cameraName={streamName} isOnline={camera.is_online} />
              ) : (
                <>
                  <SnapshotPlayer
                    cameraName={streamName}
                    cameraId={camera.id}
                    isOnline={camera.is_online}
                    className="aspect-video w-full"
                    intervalMs={150}
                    width={1920}
                    useMainStream={true}
                  />
                  {/* Zone polygons ON the video */}
                  {activeTab === "detections" && (
                    <ZoneOverlay
                      zones={allZonePolygons}
                      isDrawing={isDrawing}
                      currentPoints={drawingPoints}
                      onAddPoint={(p) => setDrawingPoints((prev) => [...prev, p])}
                      drawColor={drawColor}
                      drawType={selectedDetection === "line_crossing" ? "tripwire" : "roi"}
                    />
                  )}
                </>
              )}

              {/* Drawing toolbar on video */}
              {isDrawing && (
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-black/70 rounded-lg px-4 py-2 backdrop-blur">
                  <span className="text-white text-xs font-medium">{drawingPoints.length} puntos</span>
                  <Button size="sm" variant="outline" className="h-7 text-xs border-gray-500 text-white hover:bg-white/20"
                    onClick={() => setDrawingPoints((p) => p.slice(0, -1))} disabled={drawingPoints.length === 0}>
                    <Undo className="h-3 w-3 mr-1" /> Deshacer
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs border-gray-500 text-white hover:bg-white/20"
                    onClick={cancelDrawing}>
                    <XCircle className="h-3 w-3 mr-1" /> Cancelar
                  </Button>
                  <Button size="sm" className="h-7 text-xs bg-green-600 hover:bg-green-700"
                    onClick={saveCurrentZone} disabled={drawingPoints.length < (selectedDetection === "line_crossing" ? 2 : 3)}>
                    <Save className="h-3 w-3 mr-1" /> {selectedDetection === "line_crossing" ? "Guardar Linea" : "Guardar Zona"}
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Right panel */}
          <div className="space-y-4">
            {showZonePanel && selectedDef ? (
              /* ── ZONE CONTROL PANEL ── */
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {(() => { const I = selectedDef.icon; return <I className={`h-4 w-4 ${selectedDef.color}`} />; })()}
                      <span>{selectedDef.label}</span>
                    </div>
                    <button onClick={() => { setSelectedDetection(null); setIsDrawing(false); }}
                      className="text-xs text-gray-400 hover:text-gray-600 underline">Cerrar</button>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Zones list */}
                  <div className="space-y-2">
                    {selectedZones.length === 0 ? (
                      <div className="text-center py-4 border border-dashed border-gray-200 rounded-lg">
                        <Crosshair className="h-6 w-6 mx-auto mb-1 text-gray-300" />
                        <p className="text-xs text-gray-400">Sin zonas — se analiza toda la imagen</p>
                      </div>
                    ) : (
                      selectedZones.map((z, i) => {
                        const c = getZoneColor(i);
                        return (
                          <div key={z.id} className="flex items-center justify-between p-2 rounded-lg border border-gray-200">
                            <div className="flex items-center gap-2">
                              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: c.stroke }} />
                              <span className="text-sm font-medium text-gray-700">{z.name}</span>
                              <span className="text-[10px] text-gray-400">{z.points.length} pts</span>
                            </div>
                            <button onClick={() => deleteZone(selectedDetection!, z.id)}
                              className="p-1 text-gray-400 hover:text-red-500 rounded hover:bg-red-50">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>

                  {/* Add zone button */}
                  {!isDrawing && selectedZones.length < MAX_ZONES_PER_DET && (
                    <Button size="sm" className="w-full" onClick={startDrawing}>
                      <PenTool className="h-4 w-4 mr-1" />
                      Dibujar Zona ({selectedZones.length}/{MAX_ZONES_PER_DET})
                    </Button>
                  )}

                  {isDrawing && (
                    <div className="p-2 bg-blue-50 border border-blue-200 rounded-lg">
                      <p className="text-xs text-blue-700 font-medium">
                        {selectedDetection === "line_crossing"
                          ? "Haz clic en 2 puntos para crear la linea de cruce."
                          : "Dibujando sobre el video. Haz clic para agregar puntos (min 3)."}
                      </p>
                    </div>
                  )}

                  {/* Direction selector for line_crossing */}
                  {selectedDetection === "line_crossing" && selectedZones.length > 0 && (
                    <div className="space-y-2 border-t pt-2">
                      <p className="text-[10px] font-medium text-gray-500 uppercase">Direccion de cruce</p>
                      {selectedZones.map((z, i) => (
                        <div key={`dir-${z.id}`} className="flex items-center gap-2">
                          <span className="text-xs text-gray-600 w-16">{z.name}:</span>
                          <div className="flex gap-1">
                            {(["A_to_B", "B_to_A", "both"] as const).map((dir) => (
                              <button key={dir}
                                onClick={() => {
                                  setDetZones((prev) => {
                                    const zones = [...(prev[selectedDetection!]?.zones || [])];
                                    const idx = zones.findIndex(zz => zz.id === z.id);
                                    if (idx >= 0) zones[idx] = { ...zones[idx], direction: dir };
                                    return { ...prev, [selectedDetection!]: { ...prev[selectedDetection!], zones } };
                                  });
                                }}
                                className={`px-2 py-1 text-[10px] rounded border ${
                                  (z as any).direction === dir
                                    ? "bg-pink-100 border-pink-400 text-pink-700 font-medium"
                                    : "border-gray-200 text-gray-500 hover:bg-gray-50"
                                }`}>
                                {dir === "A_to_B" ? "A \u2192 B" : dir === "B_to_A" ? "B \u2192 A" : "Ambos"}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Schedule */}
                  <div className="border-t pt-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] font-medium text-gray-500 uppercase">Horario</p>
                      <button
                        onClick={() => {
                          setDetZones((prev) => {
                            const current = prev[selectedDetection!] || { zones: [] };
                            const schedule = current.schedule?.enabled
                              ? { enabled: false, startTime: "00:00", endTime: "23:59" }
                              : { enabled: true, startTime: "08:00", endTime: "18:00" };
                            return { ...prev, [selectedDetection!]: { ...current, schedule } };
                          });
                        }}
                        className={`text-[10px] px-2 py-0.5 rounded border ${
                          detZones[selectedDetection!]?.schedule?.enabled
                            ? "bg-blue-50 border-blue-300 text-blue-700"
                            : "border-gray-200 text-gray-500"
                        }`}>
                        {detZones[selectedDetection!]?.schedule?.enabled ? "Personalizado" : "24 Horas"}
                      </button>
                    </div>
                    {detZones[selectedDetection!]?.schedule?.enabled && (
                      <div className="flex items-center gap-2">
                        <input type="time"
                          value={detZones[selectedDetection!]?.schedule?.startTime || "08:00"}
                          onChange={(e) => {
                            setDetZones((prev) => {
                              const current = prev[selectedDetection!] || { zones: [] };
                              return { ...prev, [selectedDetection!]: { ...current, schedule: { ...current.schedule!, startTime: e.target.value } } };
                            });
                          }}
                          className="px-2 py-1 text-xs border border-gray-300 rounded" />
                        <span className="text-xs text-gray-400">a</span>
                        <input type="time"
                          value={detZones[selectedDetection!]?.schedule?.endTime || "18:00"}
                          onChange={(e) => {
                            setDetZones((prev) => {
                              const current = prev[selectedDetection!] || { zones: [] };
                              return { ...prev, [selectedDetection!]: { ...current, schedule: { ...current.schedule!, endTime: e.target.value } } };
                            });
                          }}
                          className="px-2 py-1 text-xs border border-gray-300 rounded" />
                      </div>
                    )}
                  </div>

                  {/* Objeto Movido sub-option for abandoned_object */}
                  {selectedDetection === "abandoned_object" && (
                    <div className="border-t pt-3">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox"
                          checked={detZones[selectedDetection]?.subOptions?.object_moved || false}
                          onChange={(e) => {
                            setDetZones((prev) => {
                              const current = prev[selectedDetection!] || { zones: [] };
                              const subOptions = { ...(current.subOptions || {}), object_moved: e.target.checked };
                              return { ...prev, [selectedDetection!]: { ...current, subOptions } };
                            });
                          }}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                        <div>
                          <p className="text-xs font-medium text-gray-700">Objeto Movido</p>
                          <p className="text-[10px] text-gray-500">Alertar cuando un objeto es removido de su posicion</p>
                        </div>
                      </label>
                    </div>
                  )}

                  {/* All detections zone summary */}
                  <div className="border-t pt-3">
                    <p className="text-[10px] font-medium text-gray-500 uppercase mb-2">Resumen de zonas</p>
                    {enabledDetections.map((detId) => {
                      const def = DETECTION_CAPABILITIES.find((c) => c.id === detId);
                      const zones = detZones[detId]?.zones || [];
                      const isSel = selectedDetection === detId;
                      if (!def) return null;
                      return (
                        <button key={detId} onClick={() => { setSelectedDetection(detId); setIsDrawing(false); setDrawingPoints([]); }}
                          className={`w-full flex items-center gap-2 p-1.5 rounded text-left text-xs mb-1 transition-colors ${
                            isSel ? "bg-blue-50 border border-blue-200" : "hover:bg-gray-50"
                          }`}>
                          {(() => { const I = def.icon; return <I className={`h-3.5 w-3.5 ${def.color}`} />; })()}
                          <span className="flex-1 text-gray-700">{def.label}</span>
                          {zones.length > 0 ? (
                            <Badge variant="default" className="text-[9px] py-0 px-1.5 bg-blue-600">{zones.length} zona{zones.length > 1 ? "s" : ""}</Badge>
                          ) : (
                            <Badge variant="secondary" className="text-[9px] py-0 px-1.5">Completa</Badge>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            ) : (
              /* ── CAMERA INFO (default) ── */
              <>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center justify-between">
                      Info de Camara
                      <Badge variant={camera.is_online ? "success" : "destructive"}>
                        {camera.is_online ? "Online" : "Offline"}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <div className="flex justify-between"><span className="text-gray-500">IP</span><span className="font-mono">{camera.ip_address}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Marca</span><span>{camera.manufacturer || "--"}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Modelo</span><span>{camera.model || "--"}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Tipo</span><span className="capitalize">{camera.camera_type || "--"}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Ubicacion</span><span>{camera.location || "--"}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">PTZ</span><span>{camera.has_ptz ? "Si" : "No"}</span></div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <Clock className="h-5 w-5 text-orange-500 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm font-medium text-gray-900">Limite de eventos</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          Maximo 1 evento cada <strong>{EVENT_COOLDOWN}s</strong> por camara.
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                {camera.has_ptz && (
                  <Card>
                    <CardHeader className="pb-2"><CardTitle className="text-sm">Controles PTZ</CardTitle></CardHeader>
                    <CardContent className="p-4"><PTZControls cameraId={camera.id} /></CardContent>
                  </Card>
                )}
              </>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-gray-200">
          {tabs.map((tab) => (
            <button key={tab.id}
              onClick={() => { setActiveTab(tab.id); if (tab.id !== "detections") { setSelectedDetection(null); setIsDrawing(false); } }}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"
              }`}>
              {tab.label}
            </button>
          ))}
        </div>

        {/* CONFIG TAB */}
        {activeTab === "config" && (
          <div className="space-y-4 max-w-2xl">
            <Card>
              <CardContent className="p-5 space-y-4">
                <div><label className="block text-sm font-medium text-gray-700 mb-1">Nombre</label>
                  <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" /></div>
                <div><label className="block text-sm font-medium text-gray-700 mb-1">IP</label>
                  <input type="text" value={editIp} onChange={(e) => setEditIp(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono" placeholder="192.168.1.100" /></div>
                <div className="grid grid-cols-2 gap-4">
                  <div><label className="block text-sm font-medium text-gray-700 mb-1">Puerto</label>
                    <input type="number" value={editPort} onChange={(e) => setEditPort(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" /></div>
                  <div><label className="block text-sm font-medium text-gray-700 mb-1">Usuario</label>
                    <input type="text" value={editUsername} onChange={(e) => setEditUsername(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" /></div>
                </div>
                <div><label className="block text-sm font-medium text-gray-700 mb-1">Contrasena</label>
                  <input type="password" value={editPassword} onChange={(e) => setEditPassword(e.target.value)}
                    placeholder="••••••••" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" /></div>
                <div><label className="block text-sm font-medium text-gray-700 mb-1">Ubicacion</label>
                  <input type="text" value={editLocation} onChange={(e) => setEditLocation(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" placeholder="Ej: Lobby" /></div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-5 space-y-4">
                <h4 className="text-sm font-semibold">Clasificacion</h4>
                <div className="grid grid-cols-4 gap-2">
                  {CAMERA_TYPES.map((t) => (
                    <button key={t.value} onClick={() => setEditCameraType(t.value)}
                      className={`px-3 py-2 text-xs font-medium rounded-lg border ${editCameraType === t.value ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-600"}`}>
                      {t.label}</button>
                  ))}
                </div>
                <select value={editManufacturer} onChange={(e) => setEditManufacturer(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white">
                  <option value="">Marca...</option>
                  {CAMERA_BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
                <input type="text" value={editModel} onChange={(e) => setEditModel(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" placeholder="Modelo" />
              </CardContent>
            </Card>
            <Button onClick={handleSaveCameraConfig} disabled={editSaving}>
              <Save className="h-4 w-4 mr-1" /> {editSaving ? "Guardando..." : "Guardar"}
            </Button>
          </div>
        )}

        {/* DETECTIONS TAB */}
        {activeTab === "detections" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Capacidades de Deteccion</h3>
                <p className="text-xs text-gray-500 mt-0.5">Activa una deteccion y dibuja zonas sobre el video.</p>
              </div>
              <Badge variant="default">{enabledDetections.length} activas</Badge>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {DETECTION_CAPABILITIES.map((cap) => {
                const isEnabled = enabledDetections.includes(cap.id);
                const isSel = selectedDetection === cap.id;
                const zones = detZones[cap.id]?.zones || [];
                return (
                  <div key={cap.id} className="relative">
                    <button onClick={() => toggleDetection(cap.id)}
                      className={`w-full flex items-start gap-3 p-4 rounded-lg border text-left transition-all ${
                        isSel ? `${cap.border} ${cap.bg} ring-2 ring-offset-1 ring-blue-300`
                          : isEnabled ? "border-blue-500 bg-blue-50"
                          : "border-gray-200 hover:border-gray-300"
                      }`}>
                      <div className={`mt-0.5 ${isEnabled ? cap.color : "text-gray-400"}`}>
                        {(() => { const I = cap.icon; return <I className="h-5 w-5" />; })()}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <span className={`text-sm font-medium ${isEnabled ? "text-gray-900" : "text-gray-600"}`}>{cap.label}</span>
                          <div className="flex items-center gap-2">
                            {isEnabled && zones.length > 0 && (
                              <Badge variant="default" className="text-[9px] py-0 px-1.5 bg-blue-600">
                                {zones.length} zona{zones.length > 1 ? "s" : ""}
                              </Badge>
                            )}
                            <div className={`h-4 w-8 rounded-full transition-colors ${isEnabled ? "bg-blue-600" : "bg-gray-300"}`}>
                              <div className={`h-4 w-4 rounded-full bg-white shadow transition-transform ${isEnabled ? "translate-x-4" : "translate-x-0"}`} />
                            </div>
                          </div>
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">{cap.desc}</p>
                      </div>
                    </button>
                    {isEnabled && !isSel && (
                      <button onClick={(e) => { e.stopPropagation(); setSelectedDetection(cap.id); setIsDrawing(false); setDrawingPoints([]); }}
                        className="absolute top-2 right-14 p-1 text-gray-400 hover:text-blue-600 rounded hover:bg-blue-50"
                        title="Configurar zonas">
                        <Crosshair className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* IMAGE TAB */}
        {activeTab === "image" && (
          <div className="space-y-4 max-w-2xl">
            <Card>
              <CardContent className="p-5 space-y-5">
                {[
                  { key: "brightness", label: "Brillo" }, { key: "contrast", label: "Contraste" },
                  { key: "saturation", label: "Saturacion" }, { key: "sharpness", label: "Nitidez" },
                ].map(({ key, label }) => (
                  <div key={key}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-gray-700">{label}</span><span className="font-medium">{(imageSettings as any)[key]}%</span>
                    </div>
                    <input type="range" min="0" max="100" value={(imageSettings as any)[key]}
                      onChange={(e) => setImageSettings({ ...imageSettings, [key]: parseInt(e.target.value) })}
                      className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600" />
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        )}

        {/* EVENTS TAB */}
        {activeTab === "events" && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-gray-900">Eventos Recientes</h3>
            {events.length === 0 ? (
              <p className="text-sm text-gray-400 py-8 text-center">Sin eventos</p>
            ) : events.map((e: any) => <EventCard key={e.id} {...e} camera_name={camera.name} />)}
          </div>
        )}

        {activeTab === "live" && (
          <div className="text-center text-sm text-gray-400">
            Transmision en vivo arriba. Detecciones activas: {enabledDetections.length}
          </div>
        )}
      </div>
    </>
  );
}
