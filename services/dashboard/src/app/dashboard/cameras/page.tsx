"use client";

import { useEffect, useState } from "react";
import { Grid2X2, Grid3X3, Scan, Plus, RefreshCw, X, Eye, EyeOff, Camera as CameraIcon } from "lucide-react";
import { Header } from "@/components/Header";
import { CameraGrid } from "@/components/CameraGrid";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { DEMO_CAMERAS } from "@/lib/demo-data";

interface Camera {
  id: string;
  name: string;
  ip_address: string;
  is_online: boolean;
  is_enabled: boolean;
  location?: string;
  manufacturer?: string;
  model?: string;
  port?: number;
  username?: string;
}

export default function CamerasPage() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [gridSize, setGridSize] = useState<2 | 3 | 4>(3);
  const [discovering, setDiscovering] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);

  // Add camera form
  const [formData, setFormData] = useState({
    name: "",
    ip_address: "",
    port: "80",
    username: "admin",
    password: "",
    location: "",
    manufacturer: "",
    model: "",
    camera_type: "",
  });

  const handleProbeOnvif = async () => {
    if (!formData.ip_address.trim()) {
      setFormError("Ingresa la IP para conectar por ONVIF");
      return;
    }
    setProbing(true);
    setProbeResult(null);
    setFormError("");
    try {
      const data = await api.post<any>("/cameras/probe-onvif", {
        ip: formData.ip_address.trim(),
        port: parseInt(formData.port) || 80,
        username: formData.username.trim() || "admin",
        password: formData.password,
      });
      if (data.success) {
        setFormData((prev) => ({
          ...prev,
          name: prev.name || data.name || "",
          manufacturer: data.manufacturer || prev.manufacturer,
          model: data.model || prev.model,
        }));
        setProbeResult(`Conectado: ${data.manufacturer} ${data.model}${data.has_ptz ? " (PTZ)" : ""}`);
      } else {
        setFormError(data.message || "No se pudo conectar por ONVIF");
      }
    } catch {
      setFormError("No se pudo conectar al API. Verifica que el servidor esté corriendo.");
    }
    setProbing(false);
  };

  const CAMERA_TYPES = [
    { value: "domo", label: "Domo", desc: "Interior/Exterior, visión 360°" },
    { value: "bala", label: "Bala (Bullet)", desc: "Largo alcance, exterior" },
    { value: "ptz", label: "PTZ", desc: "Pan-Tilt-Zoom, motorizada" },
    { value: "fisheye", label: "Fisheye", desc: "Ojo de pez, 180°-360°" },
    { value: "termica", label: "Térmica", desc: "Detección de calor" },
    { value: "turret", label: "Turret", desc: "Mini domo, interior" },
    { value: "box", label: "Box", desc: "Profesional, lente intercambiable" },
    { value: "otra", label: "Otra", desc: "Otro tipo de cámara" },
  ];

  const CAMERA_BRANDS = [
    "Hikvision", "Dahua", "Axis", "Hanwha (Samsung)", "Vivotek",
    "Uniview", "Bosch", "Honeywell", "Pelco", "Geovision", "Reolink", "Otra",
  ];

  useEffect(() => {
    // Clean legacy/corrupt localStorage data on mount
    cleanLegacyData();
    loadCameras();
  }, []);

  // Clean legacy cam-xxx IDs from localStorage (one-time migration)
  const cleanLegacyData = () => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem("custom_cameras");
      if (!raw) return;
      const cams = JSON.parse(raw);
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const VALID_LOCAL = /^cam-\d+$/;
      const cleaned = cams.filter((c: any) => UUID_RE.test(c.id) || VALID_LOCAL.test(c.id));
      if (cleaned.length !== cams.length) {
        localStorage.setItem("custom_cameras", JSON.stringify(cleaned));
        console.log(`Cleaned ${cams.length - cleaned.length} legacy camera entries`);
      }
    } catch { /* ignore */ }
  };

  // Get deleted camera IDs from localStorage
  const getDeletedIds = (): string[] => {
    const raw = typeof window !== "undefined" ? localStorage.getItem("deleted_cameras") : null;
    return raw ? JSON.parse(raw) : [];
  };

  // Get custom cameras from localStorage
  const getCustomCameras = (): Camera[] => {
    const raw = typeof window !== "undefined" ? localStorage.getItem("custom_cameras") : null;
    return raw ? JSON.parse(raw) : [];
  };

  // Get trash bin
  const getTrashBin = (): (Camera & { deleted_at: string })[] => {
    const raw = typeof window !== "undefined" ? localStorage.getItem("camera_trash") : null;
    if (!raw) return [];
    const items = JSON.parse(raw);
    // Filter out items older than 30 days
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return items.filter((item: any) => new Date(item.deleted_at).getTime() > thirtyDaysAgo);
  };

  const loadCameras = async () => {
    try {
      const data = await api.get<Camera[]>("/cameras");
      const customCams = getCustomCameras();
      const deletedIds = getDeletedIds();

      // Build set of API IPs to detect duplicates
      const apiIps = new Set(data.map((c: any) => c.ip_address).filter(Boolean));
      const apiIds = new Set(data.map((c) => c.id));

      // Clean localStorage: remove any local camera whose IP already exists in API
      const cleanedLocal = customCams.filter((c: any) => {
        if (apiIps.has(c.ip_address)) {
          // Duplicate by IP — remove from localStorage
          return false;
        }
        if (apiIds.has(c.id)) {
          // Duplicate by ID — remove from localStorage
          return false;
        }
        return true;
      });
      if (cleanedLocal.length !== customCams.length) {
        localStorage.setItem("custom_cameras", JSON.stringify(cleanedLocal));
      }

      // Merge API + cleaned local, exclude deleted
      const merged = [
        ...data.filter((c) => !deletedIds.includes(c.id)),
        ...cleanedLocal.filter((c) => !deletedIds.includes(c.id)),
      ];
      setCameras(merged);
    } catch (e) {
      console.error("Failed to load cameras:", e);
    }
  };

  const saveCustomCamera = (cam: Camera) => {
    const existing = getCustomCameras();
    existing.push(cam);
    localStorage.setItem("custom_cameras", JSON.stringify(existing));
    // Remove from deleted if it was there
    const deletedIds = getDeletedIds().filter((id) => id !== cam.id);
    localStorage.setItem("deleted_cameras", JSON.stringify(deletedIds));
  };

  const moveToTrash = (cam: Camera) => {
    // Add to trash bin with timestamp
    const trash = getTrashBin();
    trash.push({ ...cam, deleted_at: new Date().toISOString() });
    localStorage.setItem("camera_trash", JSON.stringify(trash));
    // Add to deleted IDs
    const deletedIds = getDeletedIds();
    if (!deletedIds.includes(cam.id)) {
      deletedIds.push(cam.id);
      localStorage.setItem("deleted_cameras", JSON.stringify(deletedIds));
    }
    // Remove from custom cameras
    const customCams = getCustomCameras().filter((c) => c.id !== cam.id);
    localStorage.setItem("custom_cameras", JSON.stringify(customCams));
  };

  const triggerDiscovery = async () => {
    setDiscovering(true);
    try {
      await api.post("/cameras/discover");
      setTimeout(loadCameras, 10000);
    } catch (e) {
      console.error("Discovery failed:", e);
    } finally {
      setTimeout(() => setDiscovering(false), 10000);
    }
  };

  const handleAddCamera = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");

    if (!formData.name.trim()) {
      setFormError("El nombre es obligatorio");
      return;
    }
    if (!formData.ip_address.trim()) {
      setFormError("La dirección IP es obligatoria");
      return;
    }

    // Validate IP format
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipRegex.test(formData.ip_address.trim())) {
      setFormError("Formato de IP inválido (ej: 192.168.1.100)");
      return;
    }
    if (!formData.camera_type) {
      setFormError("Selecciona el tipo de cámara");
      return;
    }
    if (!formData.manufacturer) {
      setFormError("Selecciona la marca de la cámara");
      return;
    }

    setSaving(true);

    const cameraPayload = {
      name: formData.name.trim(),
      ip_address: formData.ip_address.trim(),
      onvif_port: parseInt(formData.port) || 80,
      username: formData.username.trim(),
      password: formData.password,
      location: formData.location.trim() || undefined,
      manufacturer: formData.manufacturer.trim() || undefined,
      model: formData.model.trim() || undefined,
      camera_type: formData.camera_type,
    };

    // API-FIRST: try backend first to get real UUID and trigger go2rtc config
    try {
      const apiCam = await api.post<Camera>("/cameras", cameraPayload);
      if (apiCam && (apiCam as any).id) {
        // Success — reload full list from backend (single source of truth)
        await loadCameras();
      } else {
        throw new Error("API returned empty response");
      }
    } catch {
      // API not available — save locally as fallback
      const newCam: Camera = {
        id: `cam-${Date.now()}`,
        name: cameraPayload.name,
        ip_address: cameraPayload.ip_address,
        port: cameraPayload.onvif_port,
        username: cameraPayload.username,
        is_online: false,
        is_enabled: true,
        location: cameraPayload.location,
        manufacturer: cameraPayload.manufacturer,
        model: cameraPayload.model,
      };
      saveCustomCamera(newCam);
      setCameras((prev) => [...prev, newCam]);
    }

    // Reset form and close
    setFormData({
      name: "",
      ip_address: "",
      port: "80",
      username: "admin",
      password: "",
      location: "",
      manufacturer: "",
      model: "",
      camera_type: "",
    });
    setShowAddModal(false);
    setSaving(false);
  };

  const handleDeleteCamera = async (camId: string) => {
    const cam = cameras.find((c) => c.id === camId);
    if (!cam) return;

    // Move to trash
    moveToTrash(cam);

    // Also clean any localStorage entries with same IP (prevent ghosts)
    const camIp = (cam as any).ip_address;
    if (camIp) {
      const customCams = getCustomCameras().filter(
        (c: any) => c.id !== camId && c.ip_address !== camIp
      );
      localStorage.setItem("custom_cameras", JSON.stringify(customCams));
    }

    // Remove from state
    setCameras((prev) => prev.filter((c) => c.id !== camId));

    // Try API delete (triggers Redis event → camera-manager removes go2rtc stream)
    try {
      await api.del(`/cameras/${camId}`);
    } catch {
      // Camera may be local-only, ignore API errors
    }
  };

  const [showPassword, setShowPassword] = useState(false);

  return (
    <>
      <Header title="Cámaras" />
      <div className="p-6">
        {/* Toolbar */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-1">
            {([2, 3, 4] as const).map((size) => (
              <button
                key={size}
                onClick={() => setGridSize(size)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  gridSize === size
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {size === 2 && <span className="inline-flex items-center gap-1"><Grid2X2 className="h-4 w-4" /> 2×2</span>}
                {size === 3 && <span className="inline-flex items-center gap-1"><Grid3X3 className="h-4 w-4" /> 3×3</span>}
                {size === 4 && <span>4×4</span>}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={loadCameras}>
              <RefreshCw className="h-4 w-4 mr-1" /> Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={triggerDiscovery}
              disabled={discovering}
            >
              <Scan className="h-4 w-4 mr-1" />
              {discovering ? "Buscando..." : "Descubrir"}
            </Button>
            <Button size="sm" onClick={() => setShowAddModal(true)}>
              <Plus className="h-4 w-4 mr-1" /> Agregar Cámara
            </Button>
          </div>
        </div>

        {cameras.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-400">
            <Scan className="h-12 w-12 mb-4" />
            <p className="text-lg font-medium">No hay cámaras configuradas</p>
            <p className="text-sm mt-1 mb-4">
              Agrega una cámara manualmente o usa &quot;Descubrir&quot; para encontrar cámaras ONVIF
            </p>
            <Button onClick={() => setShowAddModal(true)}>
              <Plus className="h-4 w-4 mr-1" /> Agregar Cámara
            </Button>
          </div>
        ) : (
          <CameraGrid cameras={cameras} gridSize={gridSize} onDelete={handleDeleteCamera} />
        )}
      </div>

      {/* Add Camera Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-5 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Agregar Cámara</h2>
              <button
                onClick={() => setShowAddModal(false)}
                className="p-1 rounded-md hover:bg-gray-100 text-gray-500"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Form */}
            <form onSubmit={handleAddCamera}>
              <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto">
                {formError && (
                  <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
                    {formError}
                  </div>
                )}

                {/* Name */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Nombre <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    placeholder="Ej: Entrada Principal"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>

                {/* IP + Port + ONVIF Probe */}
                <div className="grid grid-cols-4 gap-3">
                  <div className="col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Dirección IP <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      placeholder="192.168.1.100"
                      value={formData.ip_address}
                      onChange={(e) => setFormData({ ...formData, ip_address: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Puerto ONVIF
                    </label>
                    <input
                      type="number"
                      placeholder="80"
                      value={formData.port}
                      onChange={(e) => setFormData({ ...formData, port: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
                    />
                  </div>
                  <div className="flex items-end">
                    <button
                      type="button"
                      onClick={handleProbeOnvif}
                      disabled={probing}
                      className="w-full px-3 py-2 bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      {probing ? "Conectando..." : "Detectar ONVIF"}
                    </button>
                  </div>
                </div>

                {/* Probe result */}
                {probeResult && (
                  <div className="p-3 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm">
                    ✅ {probeResult}
                  </div>
                )}

                {/* Username + Password */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Usuario
                    </label>
                    <input
                      type="text"
                      placeholder="admin"
                      value={formData.username}
                      onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Contraseña
                    </label>
                    <div className="relative">
                      <input
                        type={showPassword ? "text" : "password"}
                        placeholder="••••••"
                        value={formData.password}
                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                        className="w-full px-3 py-2 pr-9 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Camera Type */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Tipo de Cámara <span className="text-red-500">*</span>
                  </label>
                  <div className="grid grid-cols-4 gap-2">
                    {CAMERA_TYPES.map((type) => (
                      <button
                        key={type.value}
                        type="button"
                        onClick={() => setFormData({ ...formData, camera_type: type.value })}
                        className={`flex flex-col items-center p-2 rounded-lg border text-center transition-colors ${
                          formData.camera_type === type.value
                            ? "border-blue-500 bg-blue-50 text-blue-700"
                            : "border-gray-200 text-gray-600 hover:border-gray-300"
                        }`}
                      >
                        <CameraIcon className="h-5 w-5 mb-1" />
                        <span className="text-xs font-medium">{type.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Brand + Model */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Marca <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={formData.manufacturer}
                      onChange={(e) => setFormData({ ...formData, manufacturer: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                    >
                      <option value="">Seleccionar marca...</option>
                      {CAMERA_BRANDS.map((brand) => (
                        <option key={brand} value={brand}>{brand}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Modelo
                    </label>
                    <input
                      type="text"
                      placeholder="DS-2CD2143G2-I"
                      value={formData.model}
                      onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                </div>

                {/* Location */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Ubicación
                  </label>
                  <input
                    type="text"
                    placeholder="Ej: Lobby, Estacionamiento, Almacén"
                    value={formData.location}
                    onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
              </div>

              {/* Modal Footer */}
              <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-200">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowAddModal(false)}
                >
                  Cancelar
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? "Guardando..." : "Agregar Cámara"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
