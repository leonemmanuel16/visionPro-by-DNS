"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useCameras } from "@/hooks/useCameras";
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
  ChevronDown,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
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
  config?: { detect_classes?: string[]; image_settings?: Record<string, any>; [key: string]: any };
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
  const [lineCounts, setLineCounts] = useState<Record<string, Record<string, number>>>({});
  const EVENT_COOLDOWN = 30;
  const [saved, setSaved] = useState(false);

  // Debounced ISAPI image settings
  const imageTimerRef = useRef<NodeJS.Timeout | null>(null);
  const applyImageToCamera = useCallback((settings: typeof imageSettings) => {
    if (!id) return;
    if (imageTimerRef.current) clearTimeout(imageTimerRef.current);
    imageTimerRef.current = setTimeout(async () => {
      try {
        await api.put(`/cameras/${id}/image`, {
          brightness: settings.brightness,
          contrast: settings.contrast,
          saturation: settings.saturation,
          sharpness: settings.sharpness,
          wdr: settings.wdr,
        });
      } catch (_e) { /* silent — camera may not support ISAPI */ }
    }, 300);
  }, [id]);

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
  const [isDirty, setIsDirty] = useState(false);
  const [showCameraSwitcher, setShowCameraSwitcher] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const { cameras: allCameras } = useCameras();
  const switcherRef = useRef<HTMLDivElement>(null);

  // Track initial state for dirty detection
  const initialStateRef = useRef<string>("");

  // Mark dirty on any settings change
  const markDirty = useCallback(() => setIsDirty(true), []);

  // Close camera switcher on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setShowCameraSwitcher(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Warn on browser navigation (close tab, refresh) with unsaved changes
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  // Navigate to another camera with unsaved changes check
  const navigateToCamera = useCallback((camId: string) => {
    if (isDirty) {
      if (!confirm("Tienes cambios sin guardar. Deseas salir sin guardar?")) return;
    }
    setIsDirty(false);
    setShowCameraSwitcher(false);
    router.push(`/dashboard/cameras/${camId}`);
  }, [isDirty, router]);

  // Back button with unsaved changes check
  const handleBack = useCallback(() => {
    if (isDirty) {
      if (!confirm("Tienes cambios sin guardar. Deseas salir sin guardar?")) return;
    }
    router.push("/dashboard/cameras");
  }, [isDirty, router]);

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

  // Sort cameras: current first, then alphabetical (must be before early returns)
  const sortedCameras = useMemo(() => {
    return [...allCameras].sort((a, b) => {
      if (a.id === id) return -1;
      if (b.id === id) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [allCameras, id]);

  const currentCamIndex = sortedCameras.findIndex(c => c.id === id);

  // ── Load camera + zones ──
  useEffect(() => {
    if (isLegacyId(id)) {
      setNotFound(true);
      setLoadError("ID de camara invalido.");
      return;
    }
    api.get<CameraDetail>(`/cameras/${id}`).then((data) => {
      if (data && (data as any).id) {
        setCamera(data);
        // Load enabledDetections from API (camera.config.detect_classes) — single source of truth
        const apiDetections: string[] = data.config?.detect_classes || [];
        const validIds = DETECTION_CAPABILITIES.map(c => c.id);
        const cleaned = [...new Set(apiDetections.filter((d: string) => validIds.includes(d)))];
        setEnabledDetections(cleaned);
        localStorage.setItem(`cam_detections_${id}`, JSON.stringify(cleaned));
      } else {
        const c = loadLS(id);
        if (c) setCamera(c); else setNotFound(true);
      }
    }).catch(() => {
      const c = loadLS(id);
      if (c) setCamera(c); else setNotFound(true);
      // Fallback: load from localStorage only if API fails
      try {
        const sd = localStorage.getItem(`cam_detections_${id}`);
        if (sd) {
          const parsed: string[] = JSON.parse(sd);
          const validIds = DETECTION_CAPABILITIES.map(c => c.id);
          const cleaned = [...new Set(parsed.filter(d => validIds.includes(d)))];
          setEnabledDetections(cleaned);
        }
      } catch (_e) {}
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
        if (data.line_counts) setLineCounts(data.line_counts);
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
    markDirty();
    const wasEnabled = enabledDetections.includes(detId); // for UI selection logic only
    setEnabledDetections((prev) => {
      // Use prev (actual current state) to avoid stale closure / duplicate entries
      const actuallyEnabled = prev.includes(detId);
      let next = actuallyEnabled ? prev.filter((d) => d !== detId) : [...prev, detId];
      // person_count requires line_crossing
      if (detId === "person_count" && !actuallyEnabled && !next.includes("line_crossing")) {
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
    markDirty();
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
    markDirty();
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

    setIsDirty(false);
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
      {/* ── Compact top bar ── */}
      <div className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-2">
        <div className="flex items-center justify-between">
          {/* Left: back + camera switcher */}
          <div className="flex items-center gap-3">
            <button onClick={handleBack} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700" title="Volver a camaras">
              <ArrowLeft className="h-4 w-4" />
            </button>

            {/* Camera switcher dropdown */}
            <div ref={switcherRef} className="relative">
              <button
                onClick={() => setShowCameraSwitcher(!showCameraSwitcher)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors min-w-[200px]"
              >
                <div className={`w-2 h-2 rounded-full ${camera.is_online ? "bg-green-500" : "bg-red-400"}`} />
                <span className="text-sm font-medium text-gray-900 truncate">{camera.name}</span>
                <ChevronDown className={`h-4 w-4 text-gray-400 ml-auto transition-transform ${showCameraSwitcher ? "rotate-180" : ""}`} />
              </button>

              {showCameraSwitcher && (
                <div className="absolute top-full left-0 mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg max-h-80 overflow-y-auto z-50">
                  {sortedCameras.map((cam) => (
                    <button
                      key={cam.id}
                      onClick={() => navigateToCamera(cam.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-gray-50 transition-colors ${cam.id === id ? "bg-blue-50" : ""}`}
                    >
                      <div className={`w-2 h-2 rounded-full shrink-0 ${cam.is_online ? "bg-green-500" : "bg-red-400"}`} />
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm truncate ${cam.id === id ? "font-semibold text-blue-700" : "text-gray-700"}`}>{cam.name}</p>
                        {cam.location && <p className="text-[10px] text-gray-400 truncate">{cam.location}</p>}
                      </div>
                      {cam.id === id && <div className="w-1.5 h-1.5 rounded-full bg-blue-600 shrink-0" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Prev/Next camera buttons */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => { const prev = sortedCameras[currentCamIndex - 1]; if (prev) navigateToCamera(prev.id); }}
                disabled={currentCamIndex <= 0}
                className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 disabled:opacity-30 disabled:cursor-not-allowed"
                title="Camara anterior"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-[10px] text-gray-400 min-w-[3ch] text-center">{currentCamIndex + 1}/{sortedCameras.length}</span>
              <button
                onClick={() => { const next = sortedCameras[currentCamIndex + 1]; if (next) navigateToCamera(next.id); }}
                disabled={currentCamIndex >= sortedCameras.length - 1}
                className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 disabled:opacity-30 disabled:cursor-not-allowed"
                title="Siguiente camara"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Right: dirty indicator + save + delete */}
          <div className="flex items-center gap-2">
            {isDirty && (
              <span className="flex items-center gap-1 text-xs text-amber-600 font-medium">
                <AlertTriangle className="h-3.5 w-3.5" /> Sin guardar
              </span>
            )}
            {saved && <span className="text-xs text-green-600 font-medium">Guardado</span>}
            <Button size="sm" onClick={handleSaveSettings} className={isDirty ? "animate-pulse" : ""}>
              <Save className="h-4 w-4 mr-1" /> Guardar
            </Button>
            <Button size="sm" variant="outline" className="text-red-600 hover:bg-red-50" onClick={handleDelete}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* ── Main layout: Video (left) + Tabs Panel (right) ── */}
      <div className="flex h-[calc(100vh-57px)]">
        {/* ── LEFT: Video feed ── */}
        <div className={`transition-all duration-300 ${panelCollapsed ? "flex-1" : "w-[60%]"} p-4 flex flex-col`}>
          <div className="relative rounded-lg overflow-hidden border border-gray-200 flex-1">
            {camera.camera_type === "fisheye" ? (
              <FisheyeDewarper cameraName={streamName} isOnline={camera.is_online} />
            ) : (
              <>
                <SnapshotPlayer
                  cameraName={streamName}
                  isOnline={camera.is_online}
                  className="aspect-video w-full"
                  intervalMs={67}
                  width={1920}
                  useMainStream={true}
                />
                {/* Zone polygons ON the video */}
                {(activeTab === "detections" || activeTab === "live") && allZonePolygons.length > 0 && (
                  <ZoneOverlay
                    zones={allZonePolygons}
                    isDrawing={activeTab === "detections" && isDrawing}
                    currentPoints={activeTab === "detections" ? drawingPoints : []}
                    onAddPoint={(p) => activeTab === "detections" && setDrawingPoints((prev) => [...prev, p])}
                    drawColor={drawColor}
                    drawType={selectedDetection === "line_crossing" ? "tripwire" : "roi"}
                  />
                )}
                {/* Line crossing counters overlay */}
                {activeTab === "live" && Object.keys(lineCounts).length > 0 && (
                  <div className="absolute top-2 right-2 z-30 space-y-1">
                    {Object.entries(lineCounts).map(([twId, dirs]) => {
                      const zone = allZonePolygons.find(z => z.id === twId);
                      const name = zone?.name || "Linea";
                      const aToB = dirs["A\u2192B"] || 0;
                      const bToA = dirs["B\u2192A"] || 0;
                      return (
                        <div key={twId} className="bg-black/75 backdrop-blur rounded-lg px-3 py-1.5 text-white text-xs font-medium flex items-center gap-3">
                          <span className="text-blue-300">{name}</span>
                          <span>A\u2192B: <span className="text-green-400 font-bold">{aToB}</span></span>
                          <span>B\u2192A: <span className="text-yellow-400 font-bold">{bToA}</span></span>
                          <span className="text-white/60">Total: {aToB + bToA}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* Detection boxes */}
                {camera.is_online && liveDetections.length > 0 && (
                  <DetectionOverlay detections={liveDetections} className="z-20" />
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

            {/* Collapse/expand panel toggle on video corner */}
            <button
              onClick={() => setPanelCollapsed(!panelCollapsed)}
              className="absolute top-2 left-2 z-20 p-1.5 bg-black/50 hover:bg-black/70 rounded-lg text-white backdrop-blur transition-colors"
              title={panelCollapsed ? "Mostrar panel" : "Maximizar video"}
            >
              {panelCollapsed ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
          </div>

          {/* Camera info bar below video */}
          <div className="flex items-center gap-4 mt-2 px-1 text-xs text-gray-400">
            <span className="font-mono">{camera.ip_address}</span>
            {camera.manufacturer && <span>{camera.manufacturer}</span>}
            {camera.model && <span>{camera.model}</span>}
            {camera.location && <span>{camera.location}</span>}
            <span className="ml-auto">{enabledDetections.length} detecciones activas</span>
          </div>
        </div>

        {/* ── RIGHT: Tabs + Content Panel ── */}
        <div className={`transition-all duration-300 ${panelCollapsed ? "w-0 overflow-hidden opacity-0" : "w-[40%]"} border-l border-gray-200 flex flex-col bg-gray-50/50`}>
          {/* Tab bar */}
          <div className="flex border-b border-gray-200 bg-white shrink-0">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => { setActiveTab(tab.id); if (tab.id !== "detections") { setSelectedDetection(null); setIsDrawing(false); } }}
                className={`flex-1 px-2 py-2.5 text-xs font-medium border-b-2 transition-colors truncate ${
                  activeTab === tab.id ? "border-blue-600 text-blue-600 bg-blue-50/50" : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab content — scrollable */}
          <div className="flex-1 overflow-y-auto p-4">

            {/* ── LIVE TAB ── */}
            {activeTab === "live" && (
              <div className="space-y-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center justify-between">
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
              </div>
            )}

            {/* ── CONFIG TAB ── */}
            {activeTab === "config" && (
              <div className="space-y-4">
                <Card>
                  <CardContent className="p-4 space-y-3">
                    <div><label className="block text-xs font-medium text-gray-700 mb-1">Nombre</label>
                      <input type="text" value={editName} onChange={(e) => { setEditName(e.target.value); markDirty(); }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" /></div>
                    <div><label className="block text-xs font-medium text-gray-700 mb-1">IP</label>
                      <input type="text" value={editIp} onChange={(e) => { setEditIp(e.target.value); markDirty(); }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono" placeholder="192.168.1.100" /></div>
                    <div className="grid grid-cols-2 gap-3">
                      <div><label className="block text-xs font-medium text-gray-700 mb-1">Puerto</label>
                        <input type="number" value={editPort} onChange={(e) => { setEditPort(e.target.value); markDirty(); }}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" /></div>
                      <div><label className="block text-xs font-medium text-gray-700 mb-1">Usuario</label>
                        <input type="text" value={editUsername} onChange={(e) => { setEditUsername(e.target.value); markDirty(); }}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" /></div>
                    </div>
                    <div><label className="block text-xs font-medium text-gray-700 mb-1">Contrasena</label>
                      <input type="password" value={editPassword} onChange={(e) => { setEditPassword(e.target.value); markDirty(); }}
                        placeholder="••••••••" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" /></div>
                    <div><label className="block text-xs font-medium text-gray-700 mb-1">Ubicacion</label>
                      <input type="text" value={editLocation} onChange={(e) => { setEditLocation(e.target.value); markDirty(); }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" placeholder="Ej: Lobby" /></div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 space-y-3">
                    <h4 className="text-xs font-semibold">Clasificacion</h4>
                    <div className="grid grid-cols-2 gap-2">
                      {CAMERA_TYPES.map((t) => (
                        <button key={t.value} onClick={() => { setEditCameraType(t.value); markDirty(); }}
                          className={`px-2 py-1.5 text-xs font-medium rounded-lg border ${editCameraType === t.value ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-600"}`}>
                          {t.label}</button>
                      ))}
                    </div>
                    <select value={editManufacturer} onChange={(e) => { setEditManufacturer(e.target.value); markDirty(); }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white">
                      <option value="">Marca...</option>
                      {CAMERA_BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                    <input type="text" value={editModel} onChange={(e) => { setEditModel(e.target.value); markDirty(); }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" placeholder="Modelo" />
                  </CardContent>
                </Card>
                <Button size="sm" className="w-full" onClick={handleSaveCameraConfig} disabled={editSaving}>
                  <Save className="h-4 w-4 mr-1" /> {editSaving ? "Guardando..." : "Guardar Camara"}
                </Button>
              </div>
            )}

            {/* ── DETECTIONS TAB ── */}
            {activeTab === "detections" && (
              <div className="space-y-3">
                {/* Zone control panel when a detection is selected */}
                {showZonePanel && selectedDef && (
                  <Card className="mb-3 border-blue-200 bg-blue-50/30">
                    <CardHeader className="pb-2 pt-3 px-4">
                      <CardTitle className="text-sm flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {(() => { const I = selectedDef.icon; return <I className={`h-4 w-4 ${selectedDef.color}`} />; })()}
                          <span>{selectedDef.label}</span>
                        </div>
                        <button onClick={() => { setSelectedDetection(null); setIsDrawing(false); }}
                          className="text-xs text-gray-400 hover:text-gray-600 underline">Cerrar</button>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 px-4 pb-3">
                      {/* Zones list */}
                      <div className="space-y-2">
                        {selectedZones.length === 0 ? (
                          <div className="text-center py-3 border border-dashed border-gray-200 rounded-lg bg-white">
                            <Crosshair className="h-5 w-5 mx-auto mb-1 text-gray-300" />
                            <p className="text-xs text-gray-400">Sin zonas - se analiza toda la imagen</p>
                          </div>
                        ) : (
                          selectedZones.map((z, i) => {
                            const c = getZoneColor(i);
                            return (
                              <div key={z.id} className="flex items-center justify-between p-2 rounded-lg border border-gray-200 bg-white">
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
                          Dibujar {selectedDetection === "line_crossing" ? "Linea" : "Zona"} ({selectedZones.length}/{MAX_ZONES_PER_DET})
                        </Button>
                      )}

                      {isDrawing && (
                        <div className="p-2 bg-blue-50 border border-blue-200 rounded-lg">
                          <p className="text-xs text-blue-700 font-medium">
                            {selectedDetection === "line_crossing"
                              ? "Haz clic en 2 puntos sobre el video para crear la linea."
                              : "Haz clic sobre el video para agregar puntos (min 3)."}
                          </p>
                        </div>
                      )}

                      {/* Direction selector for line_crossing */}
                      {selectedDetection === "line_crossing" && selectedZones.length > 0 && (
                        <div className="space-y-2 border-t pt-2">
                          <p className="text-[10px] font-medium text-gray-500 uppercase">Direccion de cruce</p>
                          {selectedZones.map((z) => (
                            <div key={`dir-${z.id}`} className="flex items-center gap-2">
                              <span className="text-xs text-gray-600 w-14 truncate">{z.name}:</span>
                              <div className="flex gap-1">
                                {(["A_to_B", "B_to_A", "both"] as const).map((dir) => (
                                  <button key={dir}
                                    onClick={() => {
                                      markDirty();
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
                      <div className="border-t pt-2 space-y-2">
                        <div className="flex items-center justify-between">
                          <p className="text-[10px] font-medium text-gray-500 uppercase">Horario</p>
                          <button
                            onClick={() => {
                              markDirty();
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
                                markDirty();
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
                                markDirty();
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
                        <div className="border-t pt-2">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox"
                              checked={detZones[selectedDetection]?.subOptions?.object_moved || false}
                              onChange={(e) => {
                                markDirty();
                                setDetZones((prev) => {
                                  const current = prev[selectedDetection!] || { zones: [] };
                                  const subOptions = { ...(current.subOptions || {}), object_moved: e.target.checked };
                                  return { ...prev, [selectedDetection!]: { ...current, subOptions } };
                                });
                              }}
                              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                            <div>
                              <p className="text-xs font-medium text-gray-700">Objeto Movido</p>
                              <p className="text-[10px] text-gray-500">Alertar cuando un objeto es removido</p>
                            </div>
                          </label>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}

                {/* Detection capabilities list */}
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900">Detecciones</h3>
                    <p className="text-[10px] text-gray-500">Activa y dibuja zonas sobre el video.</p>
                  </div>
                  <Badge variant="default" className="text-[10px]">{enabledDetections.length} activas</Badge>
                </div>
                <div className="space-y-2">
                  {DETECTION_CAPABILITIES.map((cap) => {
                    const isEnabled = enabledDetections.includes(cap.id);
                    const isSel = selectedDetection === cap.id;
                    const zones = detZones[cap.id]?.zones || [];
                    return (
                      <div key={cap.id} className="relative">
                        <button onClick={() => toggleDetection(cap.id)}
                          className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-all ${
                            isSel ? `${cap.border} ${cap.bg} ring-2 ring-offset-1 ring-blue-300`
                              : isEnabled ? "border-blue-500 bg-blue-50"
                              : "border-gray-200 hover:border-gray-300 bg-white"
                          }`}>
                          <div className={`${isEnabled ? cap.color : "text-gray-400"}`}>
                            {(() => { const I = cap.icon; return <I className="h-4 w-4" />; })()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between">
                              <span className={`text-xs font-medium ${isEnabled ? "text-gray-900" : "text-gray-600"}`}>{cap.label}</span>
                              <div className="flex items-center gap-2">
                                {isEnabled && zones.length > 0 && (
                                  <Badge variant="default" className="text-[9px] py-0 px-1.5 bg-blue-600">
                                    {zones.length}
                                  </Badge>
                                )}
                                <div className={`h-4 w-7 rounded-full transition-colors ${isEnabled ? "bg-blue-600" : "bg-gray-300"}`}>
                                  <div className={`h-4 w-4 rounded-full bg-white shadow transition-transform ${isEnabled ? "translate-x-3" : "translate-x-0"}`} />
                                </div>
                              </div>
                            </div>
                            <p className="text-[10px] text-gray-500 mt-0.5 truncate">{cap.desc}</p>
                          </div>
                        </button>
                        {isEnabled && !isSel && (
                          <button onClick={(e) => { e.stopPropagation(); setSelectedDetection(cap.id); setIsDrawing(false); setDrawingPoints([]); }}
                            className="absolute top-2 right-12 p-1 text-gray-400 hover:text-blue-600 rounded hover:bg-blue-50"
                            title="Configurar zonas">
                            <Crosshair className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Zones summary */}
                {enabledDetections.length > 0 && (
                  <div className="border-t pt-3 mt-3">
                    <p className="text-[10px] font-medium text-gray-500 uppercase mb-2">Resumen de zonas</p>
                    {enabledDetections.map((detId) => {
                      const def = DETECTION_CAPABILITIES.find((c) => c.id === detId);
                      const zones = detZones[detId]?.zones || [];
                      const isSel = selectedDetection === detId;
                      if (!def) return null;
                      return (
                        <button key={detId} onClick={() => { setSelectedDetection(detId); setIsDrawing(false); setDrawingPoints([]); }}
                          className={`w-full flex items-center gap-2 p-1.5 rounded text-left text-xs mb-1 transition-colors ${
                            isSel ? "bg-blue-50 border border-blue-200" : "hover:bg-gray-100"
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
                )}
              </div>
            )}

            {/* ── IMAGE TAB ── */}
            {activeTab === "image" && (
              <div className="space-y-4">
                <Card>
                  <CardContent className="p-4 space-y-4">
                    {[
                      { key: "brightness", label: "Brillo" }, { key: "contrast", label: "Contraste" },
                      { key: "saturation", label: "Saturacion" }, { key: "sharpness", label: "Nitidez" },
                    ].map(({ key, label }) => (
                      <div key={key}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="text-gray-700">{label}</span><span className="font-medium">{(imageSettings as any)[key]}%</span>
                        </div>
                        <input type="range" min="0" max="100" value={(imageSettings as any)[key]}
                          onChange={(e) => {
                            markDirty();
                            const next = { ...imageSettings, [key]: parseInt(e.target.value) };
                            setImageSettings(next);
                            applyImageToCamera(next);
                          }}
                          className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600" />
                      </div>
                    ))}
                    {/* WDR Toggle */}
                    <div className="flex items-center justify-between pt-2 border-t">
                      <div>
                        <span className="text-sm text-gray-700 font-medium">WDR</span>
                        <p className="text-[10px] text-gray-500">Rango dinamico amplio</p>
                      </div>
                      <button
                        onClick={() => {
                          markDirty();
                          const next = { ...imageSettings, wdr: !imageSettings.wdr };
                          setImageSettings(next);
                          applyImageToCamera(next);
                        }}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${imageSettings.wdr ? "bg-blue-600" : "bg-gray-300"}`}
                      >
                        <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${imageSettings.wdr ? "translate-x-6" : "translate-x-1"}`} />
                      </button>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* ── EVENTS TAB ── */}
            {activeTab === "events" && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Eventos Recientes</h3>
                {events.length === 0 ? (
                  <p className="text-sm text-gray-400 py-8 text-center">Sin eventos</p>
                ) : events.map((e: any) => <EventCard key={e.id} {...e} camera_name={camera.name} />)}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
