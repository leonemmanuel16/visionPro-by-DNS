"use client";

import { useEffect, useState, useRef, MouseEvent as ReactMouseEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { Header } from "@/components/Header";
import { SnapshotPlayer } from "@/components/SnapshotPlayer";
import { PTZControls } from "@/components/PTZControls";
import { DetectionOverlay } from "@/components/DetectionOverlay";
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
  SquareDashedMousePointer,
  Undo2,
  Eraser,
  Check,
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

interface DetectionZoneConfig {
  zoneEnabled: boolean;
  points: Point[];
  zoneId?: string; // API zone ID if saved
}

// All detection capabilities
const DETECTION_CAPABILITIES = [
  { id: "person", label: "Personas", icon: User, color: "text-green-600", bg: "bg-green-50", border: "border-green-500", desc: "Detectar personas caminando, paradas" },
  { id: "face_recognition", label: "Reconocimiento Facial", icon: ScanFace, color: "text-blue-600", bg: "bg-blue-50", border: "border-blue-500", desc: "Identificar rostros de la base de datos" },
  { id: "face_unknown", label: "Rostros Desconocidos", icon: HelpCircle, color: "text-orange-500", bg: "bg-orange-50", border: "border-orange-500", desc: "Alertar cuando aparece un rostro no registrado" },
  { id: "vehicle", label: "Vehiculos", icon: Car, color: "text-yellow-600", bg: "bg-yellow-50", border: "border-yellow-500", desc: "Detectar autos, camionetas, camiones, motos" },
  { id: "animal", label: "Animales", icon: Dog, color: "text-purple-600", bg: "bg-purple-50", border: "border-purple-500", desc: "Detectar perros, gatos y otros animales" },
  { id: "intrusion", label: "Intrusion de Zona", icon: ShieldAlert, color: "text-red-600", bg: "bg-red-50", border: "border-red-500", desc: "Alertar cuando alguien entra a una zona prohibida" },
  { id: "loitering", label: "Merodeo", icon: Footprints, color: "text-amber-600", bg: "bg-amber-50", border: "border-amber-500", desc: "Detectar personas que permanecen mucho tiempo" },
  { id: "abandoned_object", label: "Objeto Abandonado", icon: Package, color: "text-gray-600", bg: "bg-gray-50", border: "border-gray-500", desc: "Detectar objetos dejados sin supervision" },
  { id: "fire_smoke", label: "Fuego / Humo", icon: Flame, color: "text-red-500", bg: "bg-red-50", border: "border-red-400", desc: "Detectar fuego o humo visible" },
  { id: "motion", label: "Movimiento General", icon: Eye, color: "text-cyan-600", bg: "bg-cyan-50", border: "border-cyan-500", desc: "Cualquier movimiento en el campo de vision" },
];

// UUID validation helper
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isValidUUID = (s: string) => UUID_REGEX.test(s);
const isLegacyId = (s: string) => s.startsWith("cam-") && !isValidUUID(s);

// ── Inline Zone Canvas ──
function ZoneCanvas({
  snapshotUrl,
  points,
  onPointsChange,
  disabled,
}: {
  snapshotUrl: string;
  points: Point[];
  onPointsChange: (pts: Point[]) => void;
  disabled: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { imgRef.current = img; setImgLoaded(true); };
    img.onerror = () => setImgLoaded(false);
    img.src = snapshotUrl;
  }, [snapshotUrl]);

  // Redraw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (imgRef.current && imgLoaded) {
      ctx.drawImage(imgRef.current, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = "#1f2937";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#6b7280";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Cargando imagen...", canvas.width / 2, canvas.height / 2);
    }

    // If disabled (full image), show green overlay on entire image
    if (disabled) {
      ctx.fillStyle = "rgba(34, 197, 94, 0.12)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = "#22c55e";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
      ctx.setLineDash([]);
      ctx.fillStyle = "#22c55e";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("IMAGEN COMPLETA", canvas.width / 2, canvas.height / 2 + (imgLoaded ? 0 : 20));
      return;
    }

    // Draw polygon
    if (points.length > 0) {
      ctx.beginPath();
      ctx.moveTo(points[0].x * canvas.width, points[0].y * canvas.height);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x * canvas.width, points[i].y * canvas.height);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(37, 99, 235, 0.2)";
      ctx.fill();
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Points
      points.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(p.x * canvas.width, p.y * canvas.height, 5, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? "#22c55e" : "#2563eb";
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    } else {
      // No points yet - show instructions
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#fff";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Haz clic para dibujar la zona", canvas.width / 2, canvas.height / 2);
    }
  }, [points, imgLoaded, disabled]);

  const handleClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    onPointsChange([...points, { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 }]);
  };

  return (
    <canvas
      ref={canvasRef}
      width={400}
      height={225}
      onClick={handleClick}
      className={`w-full rounded-lg border border-gray-300 ${disabled ? "cursor-default" : "cursor-crosshair"}`}
    />
  );
}

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
  const [enabledDetections, setEnabledDetections] = useState<string[]>(["person", "vehicle", "motion"]);

  // Currently selected detection for zone editing (right panel)
  const [selectedDetection, setSelectedDetection] = useState<string | null>(null);

  // Zone configs per detection type: { [detId]: { zoneEnabled, points, zoneId? } }
  const [detectionZones, setDetectionZones] = useState<Record<string, DetectionZoneConfig>>({});

  // Image adjustments
  const [imageSettings, setImageSettings] = useState({
    brightness: 50,
    contrast: 50,
    saturation: 50,
    sharpness: 50,
    wdr: false,
    nightMode: "auto" as "auto" | "on" | "off",
    irCut: true,
  });

  // Live tracking from WebSocket
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
    { value: "domo", label: "Domo" },
    { value: "bala", label: "Bala (Bullet)" },
    { value: "ptz", label: "PTZ" },
    { value: "fisheye", label: "Fisheye" },
    { value: "termica", label: "Termica" },
    { value: "turret", label: "Turret" },
    { value: "box", label: "Box" },
    { value: "otra", label: "Otra" },
  ];

  const CAMERA_BRANDS = [
    "Hikvision", "Dahua", "Axis", "Hanwha (Samsung)", "Vivotek",
    "Uniview", "Bosch", "Honeywell", "Pelco", "Geovision", "Reolink", "Otra",
  ];

  const go2rtcUrl = getGo2rtcUrl();

  useEffect(() => {
    if (isLegacyId(id)) {
      setNotFound(true);
      setLoadError("ID de camara invalido (formato legacy). Regresa y selecciona la camara correcta.");
      return;
    }

    api.get<CameraDetail>(`/cameras/${id}`).then((data) => {
      if (data && (data as any).id) {
        setCamera(data);
      } else {
        const customCam = loadFromLocalStorage(id);
        if (customCam) setCamera(customCam);
        else setNotFound(true);
      }
    }).catch(() => {
      const customCam = loadFromLocalStorage(id);
      if (customCam) setCamera(customCam);
      else setNotFound(true);
    });

    if (isValidUUID(id)) {
      api.get<any[]>(`/events?camera_id=${id}&per_page=10`).then(setEvents).catch(() => setEvents([]));
      // Load zones and map to detectionZones
      api.get<any[]>(`/zones?camera_id=${id}`).then((data) => {
        if (!Array.isArray(data)) return;
        const mapped: Record<string, DetectionZoneConfig> = {};
        data.forEach((z) => {
          if (z.detect_classes && Array.isArray(z.detect_classes)) {
            z.detect_classes.forEach((cls: string) => {
              mapped[cls] = {
                zoneEnabled: true,
                points: z.points || [],
                zoneId: z.id,
              };
            });
          }
        });
        setDetectionZones(mapped);
      }).catch(() => {});
    }

    // Load saved detection settings & zone configs
    try {
      const savedDet = localStorage.getItem(`cam_detections_${id}`);
      if (savedDet) setEnabledDetections(JSON.parse(savedDet));
      const savedImg = localStorage.getItem(`cam_image_${id}`);
      if (savedImg) setImageSettings(JSON.parse(savedImg));
      const savedZones = localStorage.getItem(`cam_zones_${id}`);
      if (savedZones) {
        const parsed = JSON.parse(savedZones);
        setDetectionZones((prev) => ({ ...parsed, ...prev })); // API takes priority
      }
    } catch {}
  }, [id]);

  // Populate edit fields when camera loads
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

  // Subscribe to live tracking data
  useEffect(() => {
    if (!camera) return;
    const handleTracking = (data: any) => {
      if (data.type === "tracking" && data.camera_id === camera.id) {
        setLiveDetections(data.tracks || []);
      }
    };
    wsClient.on("tracking", handleTracking);
    const clearTimer = setInterval(() => {
      setLiveDetections((prev) => (prev.length > 0 ? [] : prev));
    }, 3000);
    return () => {
      wsClient.off("tracking", handleTracking);
      clearInterval(clearTimer);
    };
  }, [camera]);

  // Save zone configs to localStorage whenever they change
  useEffect(() => {
    if (id) {
      try { localStorage.setItem(`cam_zones_${id}`, JSON.stringify(detectionZones)); } catch {}
    }
  }, [detectionZones, id]);

  const handleSaveCameraConfig = async () => {
    setEditSaving(true);
    try {
      const updateData: Record<string, any> = {
        name: editName,
        location: editLocation,
        manufacturer: editManufacturer,
        model: editModel,
        camera_type: editCameraType,
      };
      if (editPassword) updateData.password = editPassword;
      await api.put(`/cameras/${id}`, updateData);
      setCamera((prev) => prev ? { ...prev, name: editName, location: editLocation, manufacturer: editManufacturer, model: editModel, camera_type: editCameraType } : prev);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      try {
        const raw = localStorage.getItem("custom_cameras");
        if (raw) {
          const cams = JSON.parse(raw).map((c: any) =>
            c.id === id ? { ...c, name: editName, ip_address: editIp, location: editLocation, manufacturer: editManufacturer, model: editModel, camera_type: editCameraType } : c
          );
          localStorage.setItem("custom_cameras", JSON.stringify(cams));
        }
      } catch {}
      setCamera((prev) => prev ? { ...prev, name: editName, ip_address: editIp, location: editLocation, manufacturer: editManufacturer, model: editModel, camera_type: editCameraType } : prev);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
    setEditSaving(false);
  };

  function loadFromLocalStorage(camId: string): CameraDetail | null {
    try {
      const raw = localStorage.getItem("custom_cameras");
      if (!raw) return null;
      const cams = JSON.parse(raw);
      const found = cams.find((c: any) => c.id === camId);
      if (found) return { ...found, has_ptz: false } as CameraDetail;
    } catch {}
    return null;
  }

  const toggleDetection = (detId: string) => {
    const isCurrentlyEnabled = enabledDetections.includes(detId);

    setEnabledDetections((prev) => {
      const next = isCurrentlyEnabled ? prev.filter((d) => d !== detId) : [...prev, detId];
      const shouldEnable = next.length > 0;
      const wasEnabled = camera?.is_enabled ?? false;
      if (shouldEnable !== wasEnabled) {
        if (camera) camera.is_enabled = shouldEnable;
        setCamera((prev) => prev ? { ...prev, is_enabled: shouldEnable } : prev);
        api.put(`/cameras/${id}`, { is_enabled: shouldEnable }).catch(() => {
          if (camera) camera.is_enabled = wasEnabled;
          setCamera((prev) => prev ? { ...prev, is_enabled: wasEnabled } : prev);
        });
      }
      return next;
    });

    // If enabling, select it for zone editing. If disabling, deselect.
    if (!isCurrentlyEnabled) {
      setSelectedDetection(detId);
      // Initialize zone config if not exists (default: full image, no custom zone)
      setDetectionZones((prev) => prev[detId] ? prev : { ...prev, [detId]: { zoneEnabled: false, points: [] } });
    } else {
      if (selectedDetection === detId) setSelectedDetection(null);
    }
  };

  const handleSaveSettings = () => {
    localStorage.setItem(`cam_detections_${id}`, JSON.stringify(enabledDetections));
    localStorage.setItem(`cam_image_${id}`, JSON.stringify(imageSettings));
    localStorage.setItem(`cam_zones_${id}`, JSON.stringify(detectionZones));

    // Save zones to API
    saveZonesToApi();

    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    try {
      api.put(`/cameras/${id}/settings`, { detections: enabledDetections, image: imageSettings });
      const shouldEnable = enabledDetections.length > 0;
      if (camera && camera.is_enabled !== shouldEnable) {
        api.put(`/cameras/${id}`, { is_enabled: shouldEnable });
        setCamera((prev) => prev ? { ...prev, is_enabled: shouldEnable } : prev);
      }
    } catch {}
  };

  const saveZonesToApi = async () => {
    for (const [detId, config] of Object.entries(detectionZones)) {
      if (!enabledDetections.includes(detId)) continue;
      if (config.zoneEnabled && config.points.length >= 3) {
        if (config.zoneId) {
          // Update existing
          await api.put(`/zones/${config.zoneId}`, {
            name: `Zona ${detId}`,
            zone_type: "roi",
            points: config.points,
            detect_classes: [detId],
            is_enabled: true,
          }).catch(() => {});
        } else {
          // Create new
          const result = await api.post<any>("/zones", {
            camera_id: id,
            name: `Zona ${detId}`,
            zone_type: "roi",
            points: config.points,
            detect_classes: [detId],
            is_enabled: true,
          }).catch(() => null);
          if (result?.id) {
            setDetectionZones((prev) => ({
              ...prev,
              [detId]: { ...prev[detId], zoneId: result.id },
            }));
          }
        }
      } else if (!config.zoneEnabled && config.zoneId) {
        // Disable zone — delete from API since full image is used
        await api.del(`/zones/${config.zoneId}`).catch(() => {});
        setDetectionZones((prev) => {
          const copy = { ...prev };
          if (copy[detId]) copy[detId] = { ...copy[detId], zoneId: undefined };
          return copy;
        });
      }
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Eliminar camara "${camera?.name}"? Esta accion no se puede deshacer.`)) return;
    try { await api.del(`/cameras/${id}`); } catch {}
    const savedCams = localStorage.getItem("custom_cameras");
    if (savedCams) {
      const cams = JSON.parse(savedCams).filter((c: any) => c.id !== id);
      localStorage.setItem("custom_cameras", JSON.stringify(cams));
    }
    localStorage.removeItem(`cam_detections_${id}`);
    localStorage.removeItem(`cam_image_${id}`);
    localStorage.removeItem(`cam_zones_${id}`);
    router.push("/dashboard/cameras");
  };

  // Not found
  if (notFound) {
    return (
      <>
        <Header title="Camara no encontrada" />
        <div className="flex flex-col items-center justify-center h-[60vh] text-gray-400">
          <p className="text-lg font-medium mb-2">Camara no encontrada</p>
          <p className="text-sm mb-6">{loadError || `No se encontro una camara con ID: ${id}`}</p>
          <Button onClick={() => router.push("/dashboard/cameras")}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Volver a camaras
          </Button>
        </div>
      </>
    );
  }

  if (!camera) return <div className="flex items-center justify-center h-screen text-gray-400">Cargando...</div>;

  const streamName = `cam_${camera.id.replace(/-/g, "").slice(0, 12)}`;
  const detections = liveDetections;

  const tabs = [
    { id: "live" as const, label: "En Vivo" },
    { id: "config" as const, label: "Configuracion" },
    { id: "detections" as const, label: "Detecciones" },
    { id: "image" as const, label: "Imagen" },
    { id: "events" as const, label: "Eventos" },
  ];

  // Current selected detection info
  const selectedDef = selectedDetection ? DETECTION_CAPABILITIES.find((c) => c.id === selectedDetection) : null;
  const selectedZoneConfig = selectedDetection ? detectionZones[selectedDetection] || { zoneEnabled: false, points: [] } : null;

  // Show zone panel in right column when in detections tab with a selected detection
  const showZonePanel = activeTab === "detections" && selectedDetection && selectedDef && enabledDetections.includes(selectedDetection);

  const snapshotUrl = `${go2rtcUrl}/api/frame.jpeg?src=${streamName}&width=640&t=${Date.now()}`;

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
          {/* Video + overlay */}
          <div className="lg:col-span-2">
            {camera.camera_type === "fisheye" ? (
              <FisheyeDewarper cameraName={streamName} isOnline={camera.is_online} />
            ) : (
              <div className="relative rounded-lg overflow-hidden border border-gray-200">
                <SnapshotPlayer
                  cameraName={streamName}
                  isOnline={camera.is_online}
                  className="aspect-video w-full"
                  intervalMs={67}
                  width={1280}
                  useMainStream={true}
                />
                {camera.is_online && detections.length > 0 && (
                  <DetectionOverlay detections={detections} />
                )}
              </div>
            )}
          </div>

          {/* Right panel — contextual */}
          <div className="space-y-4">
            {showZonePanel && selectedDef ? (
              /* ── ZONE EDITOR PANEL ── */
              <Card className="overflow-hidden">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className={`p-1 rounded ${selectedDef.bg}`}>
                        {(() => { const Icon = selectedDef.icon; return <Icon className={`h-4 w-4 ${selectedDef.color}`} />; })()}
                      </div>
                      <span>Zona: {selectedDef.label}</span>
                    </div>
                    <button
                      onClick={() => setSelectedDetection(null)}
                      className="text-xs text-gray-400 hover:text-gray-600 underline"
                    >
                      Cerrar
                    </button>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Zone enable checkbox */}
                  <label className="flex items-center gap-3 p-2 rounded-lg border border-gray-200 cursor-pointer hover:bg-gray-50 transition-colors">
                    <input
                      type="checkbox"
                      checked={selectedZoneConfig?.zoneEnabled || false}
                      onChange={(e) => {
                        setDetectionZones((prev) => ({
                          ...prev,
                          [selectedDetection!]: {
                            ...prev[selectedDetection!] || { points: [] },
                            zoneEnabled: e.target.checked,
                          },
                        }));
                      }}
                      className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        <SquareDashedMousePointer className="h-3.5 w-3.5 inline mr-1" />
                        Habilitar zona personalizada
                      </p>
                      <p className="text-[10px] text-gray-500">
                        {selectedZoneConfig?.zoneEnabled ? "Dibuja la zona de interes" : "Se analiza la imagen completa"}
                      </p>
                    </div>
                  </label>

                  {/* Zone canvas */}
                  <ZoneCanvas
                    snapshotUrl={snapshotUrl}
                    points={selectedZoneConfig?.points || []}
                    onPointsChange={(pts) => {
                      setDetectionZones((prev) => ({
                        ...prev,
                        [selectedDetection!]: {
                          ...prev[selectedDetection!] || { zoneEnabled: true },
                          zoneEnabled: true,
                          points: pts,
                        },
                      }));
                    }}
                    disabled={!selectedZoneConfig?.zoneEnabled}
                  />

                  {/* Drawing tools */}
                  {selectedZoneConfig?.zoneEnabled && (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setDetectionZones((prev) => ({
                            ...prev,
                            [selectedDetection!]: { ...prev[selectedDetection!], points: [] },
                          }));
                        }}
                      >
                        <Eraser className="h-3.5 w-3.5 mr-1" /> Limpiar
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!selectedZoneConfig?.points?.length}
                        onClick={() => {
                          setDetectionZones((prev) => ({
                            ...prev,
                            [selectedDetection!]: {
                              ...prev[selectedDetection!],
                              points: (prev[selectedDetection!]?.points || []).slice(0, -1),
                            },
                          }));
                        }}
                      >
                        <Undo2 className="h-3.5 w-3.5 mr-1" /> Deshacer
                      </Button>
                      <span className="flex-1" />
                      <span className="text-[10px] text-gray-400">
                        {selectedZoneConfig?.points?.length || 0} puntos
                      </span>
                    </div>
                  )}

                  {/* Zone status per enabled detection */}
                  <div className="border-t pt-3 mt-2">
                    <p className="text-[10px] font-medium text-gray-500 uppercase mb-2">Zonas configuradas</p>
                    <div className="space-y-1.5">
                      {enabledDetections.map((detId) => {
                        const def = DETECTION_CAPABILITIES.find((c) => c.id === detId);
                        const zone = detectionZones[detId];
                        if (!def) return null;
                        const isSelected = selectedDetection === detId;
                        return (
                          <button
                            key={detId}
                            onClick={() => setSelectedDetection(detId)}
                            className={`w-full flex items-center gap-2 p-1.5 rounded text-left text-xs transition-colors ${
                              isSelected ? "bg-blue-50 border border-blue-200" : "hover:bg-gray-50"
                            }`}
                          >
                            {(() => { const DIcon = def.icon; return <DIcon className={`h-3.5 w-3.5 ${def.color}`} />; })()}
                            <span className="flex-1 text-gray-700">{def.label}</span>
                            {zone?.zoneEnabled && zone.points.length >= 3 ? (
                              <Badge variant="default" className="text-[9px] py-0 px-1.5 bg-blue-600">
                                Zona
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="text-[9px] py-0 px-1.5">
                                Completa
                              </Badge>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ) : (
              /* ── CAMERA INFO PANEL (default) ── */
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
                          Maximo 1 evento cada <strong>{EVENT_COOLDOWN} segundos</strong> por camara.
                          Detecciones adicionales se ignoran hasta que pase el cooldown.
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {camera.has_ptz && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Controles PTZ</CardTitle>
                    </CardHeader>
                    <CardContent className="p-4">
                      <PTZControls cameraId={camera.id} />
                    </CardContent>
                  </Card>
                )}
              </>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-gray-200">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => { setActiveTab(tab.id); if (tab.id !== "detections") setSelectedDetection(null); }}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* CONFIG TAB */}
        {activeTab === "config" && (
          <div className="space-y-4 max-w-2xl">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Configuracion de Camara</h3>
              <p className="text-xs text-gray-500 mt-0.5">Modifica los datos de conexion y clasificacion de esta camara</p>
            </div>

            <Card>
              <CardContent className="p-5 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Nombre</label>
                  <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Direccion IP</label>
                  <input type="text" value={editIp} onChange={(e) => setEditIp(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="192.168.1.100" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Puerto ONVIF</label>
                    <input type="number" value={editPort} onChange={(e) => setEditPort(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Usuario</label>
                    <input type="text" value={editUsername} onChange={(e) => setEditUsername(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Contrasena</label>
                  <input type="password" value={editPassword} onChange={(e) => setEditPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                  <p className="text-xs text-gray-400 mt-1">Dejar vacio para mantener la contrasena actual</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Ubicacion</label>
                  <input type="text" value={editLocation} onChange={(e) => setEditLocation(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="Ej: Lobby, Estacionamiento, Oficina" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5 space-y-4">
                <h4 className="text-sm font-semibold text-gray-900">Clasificacion</h4>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Tipo de Camara</label>
                  <div className="grid grid-cols-4 gap-2">
                    {CAMERA_TYPES.map((t) => (
                      <button key={t.value} onClick={() => setEditCameraType(t.value)}
                        className={`px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
                          editCameraType === t.value ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-600 hover:border-gray-300"
                        }`}>
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Marca</label>
                  <select value={editManufacturer} onChange={(e) => setEditManufacturer(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                    <option value="">Seleccionar marca...</option>
                    {CAMERA_BRANDS.map((b) => (<option key={b} value={b}>{b}</option>))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Modelo</label>
                  <input type="text" value={editModel} onChange={(e) => setEditModel(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="Ej: DS-2CD2143G2-I" />
                </div>
              </CardContent>
            </Card>

            <div className="flex items-center gap-3">
              <Button onClick={handleSaveCameraConfig} disabled={editSaving}>
                <Save className="h-4 w-4 mr-1" />
                {editSaving ? "Guardando..." : "Guardar Cambios"}
              </Button>
              {saved && <span className="text-sm text-green-600 font-medium">Guardado</span>}
            </div>
          </div>
        )}

        {/* DETECTIONS TAB */}
        {activeTab === "detections" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Capacidades de Deteccion</h3>
                <p className="text-xs text-gray-500 mt-0.5">Activa una deteccion para configurar su zona en el panel derecho.</p>
              </div>
              <Badge variant="default">{enabledDetections.length} activas</Badge>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {DETECTION_CAPABILITIES.map((cap) => {
                const isEnabled = enabledDetections.includes(cap.id);
                const isSelected = selectedDetection === cap.id;
                const zone = detectionZones[cap.id];
                const hasCustomZone = zone?.zoneEnabled && zone.points.length >= 3;
                return (
                  <div key={cap.id} className="relative">
                    <button
                      onClick={() => toggleDetection(cap.id)}
                      className={`w-full flex items-start gap-3 p-4 rounded-lg border text-left transition-all ${
                        isSelected
                          ? `${cap.border} ${cap.bg} ring-2 ring-offset-1 ring-blue-300`
                          : isEnabled
                          ? `border-blue-500 bg-blue-50`
                          : "border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      <div className={`mt-0.5 ${isEnabled ? cap.color : "text-gray-400"}`}>
                        {(() => { const CIcon = cap.icon; return <CIcon className="h-5 w-5" />; })()}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <span className={`text-sm font-medium ${isEnabled ? "text-gray-900" : "text-gray-600"}`}>
                            {cap.label}
                          </span>
                          <div className="flex items-center gap-2">
                            {isEnabled && hasCustomZone && (
                              <Badge variant="default" className="text-[9px] py-0 px-1.5 bg-blue-600">
                                Zona
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
                    {/* Click to configure zone (only when enabled) */}
                    {isEnabled && !isSelected && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setSelectedDetection(cap.id); }}
                        className="absolute top-2 right-14 p-1 text-gray-400 hover:text-blue-600 rounded hover:bg-blue-50 transition-colors"
                        title="Configurar zona"
                      >
                        <SquareDashedMousePointer className="h-3.5 w-3.5" />
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
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Ajustes de Imagen</h3>
              <p className="text-xs text-gray-500 mt-0.5">Configura los parametros de imagen de la camara</p>
            </div>

            <Card>
              <CardContent className="p-5 space-y-5">
                {[
                  { key: "brightness", label: "Brillo" },
                  { key: "contrast", label: "Contraste" },
                  { key: "saturation", label: "Saturacion" },
                  { key: "sharpness", label: "Nitidez" },
                ].map(({ key, label }) => (
                  <div key={key}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-gray-700">{label}</span>
                      <span className="font-medium">{(imageSettings as any)[key]}%</span>
                    </div>
                    <input type="range" min="0" max="100" value={(imageSettings as any)[key]}
                      onChange={(e) => setImageSettings({ ...imageSettings, [key]: parseInt(e.target.value) })}
                      className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600" />
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5 space-y-4">
                <label className="flex items-center justify-between cursor-pointer">
                  <div>
                    <p className="text-sm font-medium text-gray-700">WDR (Rango Dinamico Amplio)</p>
                    <p className="text-xs text-gray-500">Mejora la imagen en escenas con alto contraste de luz</p>
                  </div>
                  <div className={`h-5 w-10 rounded-full transition-colors cursor-pointer ${imageSettings.wdr ? "bg-blue-600" : "bg-gray-300"}`}
                    onClick={() => setImageSettings({ ...imageSettings, wdr: !imageSettings.wdr })}>
                    <div className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${imageSettings.wdr ? "translate-x-5" : "translate-x-0"}`} />
                  </div>
                </label>

                <label className="flex items-center justify-between cursor-pointer">
                  <div>
                    <p className="text-sm font-medium text-gray-700">IR-Cut Filter</p>
                    <p className="text-xs text-gray-500">Filtro infrarrojo para mejor color de dia</p>
                  </div>
                  <div className={`h-5 w-10 rounded-full transition-colors cursor-pointer ${imageSettings.irCut ? "bg-blue-600" : "bg-gray-300"}`}
                    onClick={() => setImageSettings({ ...imageSettings, irCut: !imageSettings.irCut })}>
                    <div className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${imageSettings.irCut ? "translate-x-5" : "translate-x-0"}`} />
                  </div>
                </label>

                <div>
                  <p className="text-sm font-medium text-gray-700 mb-2">Modo Nocturno</p>
                  <div className="flex gap-2">
                    {(["auto", "on", "off"] as const).map((mode) => (
                      <button key={mode} onClick={() => setImageSettings({ ...imageSettings, nightMode: mode })}
                        className={`px-4 py-2 text-sm rounded-lg border transition-colors ${
                          imageSettings.nightMode === mode
                            ? "border-blue-500 bg-blue-50 text-blue-700"
                            : "border-gray-200 text-gray-600 hover:border-gray-300"
                        }`}>
                        {mode === "auto" ? "Automatico" : mode === "on" ? "Siempre On" : "Siempre Off"}
                      </button>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* EVENTS TAB */}
        {activeTab === "events" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900">Eventos Recientes</h3>
              <div className="flex items-center gap-1 text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
                <Clock className="h-3 w-3" />
                1 evento cada {EVENT_COOLDOWN}s max
              </div>
            </div>
            {events.length === 0 ? (
              <p className="text-sm text-gray-400 py-8 text-center">Sin eventos para esta camara</p>
            ) : (
              events.map((e: any) => (
                <EventCard key={e.id} {...e} camera_name={camera.name} />
              ))
            )}
          </div>
        )}

        {/* LIVE TAB */}
        {activeTab === "live" && (
          <div className="text-center text-sm text-gray-400">
            Transmision en vivo arriba. Detecciones activas: {enabledDetections.length} de {DETECTION_CAPABILITIES.length}
          </div>
        )}
      </div>
    </>
  );
}
