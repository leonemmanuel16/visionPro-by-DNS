"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Header } from "@/components/Header";
import { VideoPlayer } from "@/components/VideoPlayer";
import { PTZControls } from "@/components/PTZControls";
import { DetectionOverlay } from "@/components/DetectionOverlay";
import { wsClient } from "@/lib/websocket";
import { FisheyeDewarper } from "@/components/FisheyeDewarper";
import { EventCard } from "@/components/EventCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
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
  Palette,
  Save,
  ArrowLeft,
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

// All detection capabilities
const DETECTION_CAPABILITIES = [
  { id: "person", label: "Personas", icon: User, color: "text-green-600", desc: "Detectar personas caminando, paradas" },
  { id: "face_recognition", label: "Reconocimiento Facial", icon: ScanFace, color: "text-blue-600", desc: "Identificar rostros de la base de datos" },
  { id: "face_unknown", label: "Rostros Desconocidos", icon: HelpCircle, color: "text-orange-500", desc: "Alertar cuando aparece un rostro no registrado" },
  { id: "vehicle", label: "Vehículos", icon: Car, color: "text-yellow-600", desc: "Detectar autos, camionetas, camiones, motos" },
  { id: "animal", label: "Animales", icon: Dog, color: "text-purple-600", desc: "Detectar perros, gatos y otros animales" },
  { id: "intrusion", label: "Intrusión de Zona", icon: ShieldAlert, color: "text-red-600", desc: "Alertar cuando alguien entra a una zona prohibida" },
  { id: "loitering", label: "Merodeo", icon: Footprints, color: "text-amber-600", desc: "Detectar personas que permanecen mucho tiempo en un área" },
  { id: "abandoned_object", label: "Objeto Abandonado", icon: Package, color: "text-gray-600", desc: "Detectar objetos dejados sin supervisión" },
  { id: "fire_smoke", label: "Fuego / Humo", icon: Flame, color: "text-red-500", desc: "Detectar fuego o humo visible" },
  { id: "motion", label: "Movimiento General", icon: Eye, color: "text-cyan-600", desc: "Cualquier movimiento en el campo de visión" },
];

// UUID validation helper
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isValidUUID = (s: string) => UUID_REGEX.test(s);
const isLegacyId = (s: string) => s.startsWith("cam-") && !isValidUUID(s);

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

  // Event rate limit display
  const EVENT_COOLDOWN = 30;

  // Saved message
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
    { value: "termica", label: "Térmica" },
    { value: "turret", label: "Turret" },
    { value: "box", label: "Box" },
    { value: "otra", label: "Otra" },
  ];

  const CAMERA_BRANDS = [
    "Hikvision", "Dahua", "Axis", "Hanwha (Samsung)", "Vivotek",
    "Uniview", "Bosch", "Honeywell", "Pelco", "Geovision", "Reolink", "Otra",
  ];

  useEffect(() => {
    // Validate ID format
    if (isLegacyId(id)) {
      setNotFound(true);
      setLoadError("ID de cámara inválido (formato legacy). Regresa y selecciona la cámara correcta.");
      return;
    }

    // Try to load camera from API first, then localStorage
    api.get<CameraDetail>(`/cameras/${id}`).then((data) => {
      if (data && (data as any).id) {
        setCamera(data);
      } else {
        // Check localStorage custom cameras
        const customCam = loadFromLocalStorage(id);
        if (customCam) {
          setCamera(customCam);
        } else {
          setNotFound(true);
        }
      }
    }).catch(() => {
      const customCam = loadFromLocalStorage(id);
      if (customCam) {
        setCamera(customCam);
      } else {
        setNotFound(true);
      }
    });

    // Load events
    if (isValidUUID(id)) {
      api.get<any[]>(`/events?camera_id=${id}&per_page=10`).then(setEvents).catch(() => setEvents([]));
    }

    // Load saved detection settings
    try {
      const savedDet = localStorage.getItem(`cam_detections_${id}`);
      if (savedDet) setEnabledDetections(JSON.parse(savedDet));
      const savedImg = localStorage.getItem(`cam_image_${id}`);
      if (savedImg) setImageSettings(JSON.parse(savedImg));
    } catch { /* ignore parse errors */ }
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

  // Subscribe to live tracking data from WebSocket
  useEffect(() => {
    if (!camera) return;

    const handleTracking = (data: any) => {
      if (data.type === "tracking" && data.camera_id === camera.id) {
        setLiveDetections(data.tracks || []);
      }
    };

    wsClient.on("tracking", handleTracking);

    // Clear detections if no update for 3 seconds (camera stopped sending)
    const clearTimer = setInterval(() => {
      setLiveDetections((prev) => (prev.length > 0 ? [] : prev));
    }, 3000);

    return () => {
      wsClient.off("tracking", handleTracking);
      clearInterval(clearTimer);
    };
  }, [camera]);

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
      if (editPassword) {
        updateData.password = editPassword;
      }
      await api.put(`/cameras/${id}`, updateData);
      // Update local state
      setCamera((prev) => prev ? {
        ...prev,
        name: editName,
        location: editLocation,
        manufacturer: editManufacturer,
        model: editModel,
        camera_type: editCameraType,
      } : prev);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // Save to localStorage as fallback
      try {
        const raw = localStorage.getItem("custom_cameras");
        if (raw) {
          const cams = JSON.parse(raw).map((c: any) =>
            c.id === id ? {
              ...c,
              name: editName,
              ip_address: editIp,
              location: editLocation,
              manufacturer: editManufacturer,
              model: editModel,
              camera_type: editCameraType,
            } : c
          );
          localStorage.setItem("custom_cameras", JSON.stringify(cams));
        }
      } catch { /* ignore */ }
      setCamera((prev) => prev ? {
        ...prev,
        name: editName,
        ip_address: editIp,
        location: editLocation,
        manufacturer: editManufacturer,
        model: editModel,
        camera_type: editCameraType,
      } : prev);
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
    } catch { /* ignore */ }
    return null;
  }

  const toggleDetection = (detId: string) => {
    setEnabledDetections((prev) =>
      prev.includes(detId) ? prev.filter((d) => d !== detId) : [...prev, detId]
    );
  };

  const handleSaveSettings = () => {
    localStorage.setItem(`cam_detections_${id}`, JSON.stringify(enabledDetections));
    localStorage.setItem(`cam_image_${id}`, JSON.stringify(imageSettings));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    // Also try to save to API
    try {
      api.put(`/cameras/${id}/settings`, { detections: enabledDetections, image: imageSettings });
    } catch { /* demo */ }
  };

  const handleDelete = async () => {
    if (!confirm(`¿Eliminar cámara "${camera?.name}"? Esta acción no se puede deshacer.`)) return;
    try { await api.del(`/cameras/${id}`); } catch { /* demo */ }
    // Remove from localStorage
    const saved = localStorage.getItem("custom_cameras");
    if (saved) {
      const cams = JSON.parse(saved).filter((c: any) => c.id !== id);
      localStorage.setItem("custom_cameras", JSON.stringify(cams));
    }
    localStorage.removeItem(`cam_detections_${id}`);
    localStorage.removeItem(`cam_image_${id}`);
    router.push("/dashboard/cameras");
  };

  // Not found or invalid ID
  if (notFound) {
    return (
      <>
        <Header title="Cámara no encontrada" />
        <div className="flex flex-col items-center justify-center h-[60vh] text-gray-400">
          <p className="text-lg font-medium mb-2">Cámara no encontrada</p>
          <p className="text-sm mb-6">{loadError || `No se encontró una cámara con ID: ${id}`}</p>
          <Button onClick={() => router.push("/dashboard/cameras")}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Volver a cámaras
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
    { id: "config" as const, label: "Configuración" },
    { id: "detections" as const, label: "Detecciones" },
    { id: "image" as const, label: "Imagen" },
    { id: "events" as const, label: "Eventos" },
  ];

  return (
    <>
      <Header title={camera.name} />
      <div className="p-6 space-y-6">
        {/* Top bar */}
        <div className="flex items-center justify-between">
          <button onClick={() => router.push("/dashboard/cameras")} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
            <ArrowLeft className="h-4 w-4" /> Volver a cámaras
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
              <FisheyeDewarper
                cameraName={streamName}
                isOnline={camera.is_online}
              />
            ) : (
              <div className="relative rounded-lg overflow-hidden border border-gray-200">
                <VideoPlayer
                  cameraName={streamName}
                  isOnline={camera.is_online}
                  className="aspect-video w-full"
                  videoFilter={`brightness(${imageSettings.brightness / 50}) contrast(${imageSettings.contrast / 50}) saturate(${imageSettings.saturation / 50})`}
                  preferSubStream={true}
                />
                {camera.is_online && detections.length > 0 && (
                  <DetectionOverlay detections={detections} />
                )}
              </div>
            )}
          </div>

          {/* Camera info */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center justify-between">
                  Info de Cámara
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
                <div className="flex justify-between"><span className="text-gray-500">Ubicación</span><span>{camera.location || "--"}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">PTZ</span><span>{camera.has_ptz ? "Sí" : "No"}</span></div>
              </CardContent>
            </Card>

            {/* Event rate limit info */}
            <Card>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <Clock className="h-5 w-5 text-orange-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-gray-900">Límite de eventos</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Máximo 1 evento cada <strong>{EVENT_COOLDOWN} segundos</strong> por cámara.
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
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-gray-200">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
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

        {/* DETECTIONS TAB */}
        {/* CONFIG TAB */}
        {activeTab === "config" && (
          <div className="space-y-4 max-w-2xl">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Configuración de Cámara</h3>
              <p className="text-xs text-gray-500 mt-0.5">Modifica los datos de conexión y clasificación de esta cámara</p>
            </div>

            <Card>
              <CardContent className="p-5 space-y-4">
                {/* Name */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Nombre</label>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>

                {/* IP */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Dirección IP</label>
                  <input
                    type="text"
                    value={editIp}
                    onChange={(e) => setEditIp(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="192.168.1.100"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  {/* Port */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Puerto ONVIF</label>
                    <input
                      type="number"
                      value={editPort}
                      onChange={(e) => setEditPort(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>

                  {/* Username */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Usuario</label>
                    <input
                      type="text"
                      value={editUsername}
                      onChange={(e) => setEditUsername(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                </div>

                {/* Password */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Contraseña</label>
                  <input
                    type="password"
                    value={editPassword}
                    onChange={(e) => setEditPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <p className="text-xs text-gray-400 mt-1">Dejar vacío para mantener la contraseña actual</p>
                </div>

                {/* Location */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Ubicación</label>
                  <input
                    type="text"
                    value={editLocation}
                    onChange={(e) => setEditLocation(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="Ej: Lobby, Estacionamiento, Oficina"
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5 space-y-4">
                <h4 className="text-sm font-semibold text-gray-900">Clasificación</h4>

                {/* Camera Type */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Tipo de Cámara</label>
                  <div className="grid grid-cols-4 gap-2">
                    {CAMERA_TYPES.map((t) => (
                      <button
                        key={t.value}
                        onClick={() => setEditCameraType(t.value)}
                        className={`px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
                          editCameraType === t.value
                            ? "border-blue-500 bg-blue-50 text-blue-700"
                            : "border-gray-200 text-gray-600 hover:border-gray-300"
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Brand */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Marca</label>
                  <select
                    value={editManufacturer}
                    onChange={(e) => setEditManufacturer(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">Seleccionar marca...</option>
                    {CAMERA_BRANDS.map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                </div>

                {/* Model */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Modelo</label>
                  <input
                    type="text"
                    value={editModel}
                    onChange={(e) => setEditModel(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="Ej: DS-2CD2143G2-I"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Save button */}
            <div className="flex items-center gap-3">
              <Button onClick={handleSaveCameraConfig} disabled={editSaving}>
                <Save className="h-4 w-4 mr-1" />
                {editSaving ? "Guardando..." : "Guardar Cambios"}
              </Button>
              {saved && <span className="text-sm text-green-600 font-medium">✓ Guardado</span>}
            </div>
          </div>
        )}

        {/* DETECTIONS TAB */}
        {activeTab === "detections" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Capacidades de Detección</h3>
                <p className="text-xs text-gray-500 mt-0.5">Selecciona qué debe detectar esta cámara. Los eventos se almacenan cada {EVENT_COOLDOWN}s máximo.</p>
              </div>
              <Badge variant="default">{enabledDetections.length} activas</Badge>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {DETECTION_CAPABILITIES.map((cap) => {
                const isEnabled = enabledDetections.includes(cap.id);
                return (
                  <button
                    key={cap.id}
                    onClick={() => toggleDetection(cap.id)}
                    className={`flex items-start gap-3 p-4 rounded-lg border text-left transition-all ${
                      isEnabled
                        ? "border-blue-500 bg-blue-50"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <div className={`mt-0.5 ${isEnabled ? cap.color : "text-gray-400"}`}>
                      <cap.icon className="h-5 w-5" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <span className={`text-sm font-medium ${isEnabled ? "text-gray-900" : "text-gray-600"}`}>
                          {cap.label}
                        </span>
                        <div className={`h-4 w-8 rounded-full transition-colors ${isEnabled ? "bg-blue-600" : "bg-gray-300"}`}>
                          <div className={`h-4 w-4 rounded-full bg-white shadow transition-transform ${isEnabled ? "translate-x-4" : "translate-x-0"}`} />
                        </div>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">{cap.desc}</p>
                    </div>
                  </button>
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
              <p className="text-xs text-gray-500 mt-0.5">Configura los parámetros de imagen de la cámara</p>
            </div>

            <Card>
              <CardContent className="p-5 space-y-5">
                {/* Brightness */}
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-gray-700">Brillo</span>
                    <span className="font-medium">{imageSettings.brightness}%</span>
                  </div>
                  <input type="range" min="0" max="100" value={imageSettings.brightness}
                    onChange={(e) => setImageSettings({ ...imageSettings, brightness: parseInt(e.target.value) })}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                  />
                </div>

                {/* Contrast */}
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-gray-700">Contraste</span>
                    <span className="font-medium">{imageSettings.contrast}%</span>
                  </div>
                  <input type="range" min="0" max="100" value={imageSettings.contrast}
                    onChange={(e) => setImageSettings({ ...imageSettings, contrast: parseInt(e.target.value) })}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                  />
                </div>

                {/* Saturation */}
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-gray-700">Saturación</span>
                    <span className="font-medium">{imageSettings.saturation}%</span>
                  </div>
                  <input type="range" min="0" max="100" value={imageSettings.saturation}
                    onChange={(e) => setImageSettings({ ...imageSettings, saturation: parseInt(e.target.value) })}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                  />
                </div>

                {/* Sharpness */}
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-gray-700">Nitidez</span>
                    <span className="font-medium">{imageSettings.sharpness}%</span>
                  </div>
                  <input type="range" min="0" max="100" value={imageSettings.sharpness}
                    onChange={(e) => setImageSettings({ ...imageSettings, sharpness: parseInt(e.target.value) })}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5 space-y-4">
                {/* WDR */}
                <label className="flex items-center justify-between cursor-pointer">
                  <div>
                    <p className="text-sm font-medium text-gray-700">WDR (Rango Dinámico Amplio)</p>
                    <p className="text-xs text-gray-500">Mejora la imagen en escenas con alto contraste de luz</p>
                  </div>
                  <div className={`h-5 w-10 rounded-full transition-colors cursor-pointer ${imageSettings.wdr ? "bg-blue-600" : "bg-gray-300"}`}
                    onClick={() => setImageSettings({ ...imageSettings, wdr: !imageSettings.wdr })}>
                    <div className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${imageSettings.wdr ? "translate-x-5" : "translate-x-0"}`} />
                  </div>
                </label>

                {/* IR Cut */}
                <label className="flex items-center justify-between cursor-pointer">
                  <div>
                    <p className="text-sm font-medium text-gray-700">IR-Cut Filter</p>
                    <p className="text-xs text-gray-500">Filtro infrarrojo para mejor color de día</p>
                  </div>
                  <div className={`h-5 w-10 rounded-full transition-colors cursor-pointer ${imageSettings.irCut ? "bg-blue-600" : "bg-gray-300"}`}
                    onClick={() => setImageSettings({ ...imageSettings, irCut: !imageSettings.irCut })}>
                    <div className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${imageSettings.irCut ? "translate-x-5" : "translate-x-0"}`} />
                  </div>
                </label>

                {/* Night Mode */}
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-2">Modo Nocturno</p>
                  <div className="flex gap-2">
                    {(["auto", "on", "off"] as const).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => setImageSettings({ ...imageSettings, nightMode: mode })}
                        className={`px-4 py-2 text-sm rounded-lg border transition-colors ${
                          imageSettings.nightMode === mode
                            ? "border-blue-500 bg-blue-50 text-blue-700"
                            : "border-gray-200 text-gray-600 hover:border-gray-300"
                        }`}
                      >
                        {mode === "auto" ? "Automático" : mode === "on" ? "Siempre On" : "Siempre Off"}
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
                1 evento cada {EVENT_COOLDOWN}s máx
              </div>
            </div>
            {events.length === 0 ? (
              <p className="text-sm text-gray-400 py-8 text-center">Sin eventos para esta cámara</p>
            ) : (
              events.map((e: any) => (
                <EventCard key={e.id} {...e} camera_name={camera.name} />
              ))
            )}
          </div>
        )}

        {/* LIVE TAB - just shows the video bigger, already shown above */}
        {activeTab === "live" && (
          <div className="text-center text-sm text-gray-400">
            Transmisión en vivo arriba. Detecciones activas: {enabledDetections.length} de {DETECTION_CAPABILITIES.length}
          </div>
        )}
      </div>
    </>
  );
}
