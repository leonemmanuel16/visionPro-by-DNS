"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Header } from "@/components/Header";
import { VideoPlayer } from "@/components/VideoPlayer";
import { PTZControls } from "@/components/PTZControls";
import { DetectionOverlay, DEMO_DETECTIONS } from "@/components/DetectionOverlay";
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

export default function CameraDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [camera, setCamera] = useState<CameraDetail | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<"live" | "detections" | "image" | "events">("live");

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

  // Event rate limit display
  const EVENT_COOLDOWN = 30;

  // Saved message
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get<CameraDetail>(`/cameras/${id}`).then(setCamera).catch(() => {
      // Demo fallback
      const demoCams = [
        { id: "cam-001", name: "Entrada Principal", ip_address: "192.168.1.100", manufacturer: "Hikvision", model: "DS-2CD2143G2-I", has_ptz: false, is_online: true, is_enabled: true, location: "Lobby", camera_type: "domo" },
        { id: "cam-002", name: "Estacionamiento Norte", ip_address: "192.168.1.101", manufacturer: "Dahua", model: "IPC-HDBW2431E-S", has_ptz: false, is_online: true, is_enabled: true, location: "Parking Lot", camera_type: "bala" },
        { id: "cam-003", name: "Oficina Servidores", ip_address: "192.168.1.102", manufacturer: "Axis", model: "P3245-V", has_ptz: false, is_online: true, is_enabled: true, location: "Server Room", camera_type: "domo" },
        { id: "cam-004", name: "Pasillo Piso 2", ip_address: "192.168.1.103", manufacturer: "Hikvision", model: "DS-2CD2347G2-LU", has_ptz: true, is_online: false, is_enabled: true, location: "2nd Floor Hallway", camera_type: "ptz" },
        { id: "cam-005", name: "Almacen", ip_address: "192.168.1.104", manufacturer: "Dahua", model: "IPC-HDW3849H-AS", has_ptz: false, is_online: true, is_enabled: true, location: "Warehouse", camera_type: "bala" },
        { id: "cam-006", name: "Recepcion", ip_address: "192.168.1.105", manufacturer: "Axis", model: "M3106-L Mk II", has_ptz: false, is_online: true, is_enabled: false, location: "Reception", camera_type: "turret" },
      ];
      setCamera(demoCams.find((c) => c.id === id) as CameraDetail || null);
    });
    api.get<any[]>(`/events?camera_id=${id}&per_page=10`).then(setEvents).catch(() => {
      // Demo events
      setEvents([
        { id: "e1", camera_id: id, event_type: "person_detected", label: "person", confidence: 0.94, occurred_at: new Date(Date.now() - 300000).toISOString() },
        { id: "e2", camera_id: id, event_type: "motion_detected", label: "motion", confidence: 0.78, occurred_at: new Date(Date.now() - 900000).toISOString() },
        { id: "e3", camera_id: id, event_type: "vehicle_detected", label: "car", confidence: 0.89, occurred_at: new Date(Date.now() - 1800000).toISOString() },
      ]);
    });

    // Load saved detection settings
    const savedDet = localStorage.getItem(`cam_detections_${id}`);
    if (savedDet) setEnabledDetections(JSON.parse(savedDet));
    const savedImg = localStorage.getItem(`cam_image_${id}`);
    if (savedImg) setImageSettings(JSON.parse(savedImg));
  }, [id]);

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

  if (!camera) return <div className="flex items-center justify-center h-screen text-gray-400">Cargando...</div>;

  const streamName = `cam_${camera.id.replace(/-/g, "").slice(0, 12)}`;
  const detections = DEMO_DETECTIONS[camera.id] || [];

  const tabs = [
    { id: "live" as const, label: "En Vivo" },
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
            <div className="relative rounded-lg overflow-hidden border border-gray-200">
              <VideoPlayer cameraName={streamName} isOnline={camera.is_online} className="aspect-video w-full" />
              {camera.is_online && detections.length > 0 && (
                <DetectionOverlay detections={detections} />
              )}
            </div>
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
