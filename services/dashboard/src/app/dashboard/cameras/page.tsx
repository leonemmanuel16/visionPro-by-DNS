"use client";

import { useEffect, useState } from "react";
import { Grid2X2, Grid3X3, Scan, Plus, RefreshCw, X, Eye, EyeOff } from "lucide-react";
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

  // Add camera form
  const [formData, setFormData] = useState({
    name: "",
    ip_address: "",
    port: "554",
    username: "admin",
    password: "",
    location: "",
    manufacturer: "",
    model: "",
  });

  useEffect(() => {
    loadCameras();
  }, []);

  const loadCameras = async () => {
    try {
      const data = await api.get<Camera[]>("/cameras");
      setCameras(data);
    } catch (e) {
      console.error("Failed to load cameras:", e);
    }
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

    setSaving(true);
    try {
      await api.post("/cameras", {
        name: formData.name.trim(),
        ip_address: formData.ip_address.trim(),
        port: parseInt(formData.port) || 554,
        username: formData.username.trim(),
        password: formData.password,
        location: formData.location.trim() || undefined,
        manufacturer: formData.manufacturer.trim() || undefined,
        model: formData.model.trim() || undefined,
      });

      // In demo mode, add it locally
      const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
      if (token === "demo-access-token") {
        const newCam: Camera = {
          id: `cam-${Date.now()}`,
          name: formData.name.trim(),
          ip_address: formData.ip_address.trim(),
          port: parseInt(formData.port) || 554,
          username: formData.username.trim(),
          is_online: false,
          is_enabled: true,
          location: formData.location.trim() || undefined,
          manufacturer: formData.manufacturer.trim() || undefined,
          model: formData.model.trim() || undefined,
        };
        setCameras((prev) => [...prev, newCam]);
      } else {
        await loadCameras();
      }

      // Reset form and close
      setFormData({
        name: "",
        ip_address: "",
        port: "554",
        username: "admin",
        password: "",
        location: "",
        manufacturer: "",
        model: "",
      });
      setShowAddModal(false);
    } catch (err: any) {
      setFormError(err.message || "Error al agregar cámara");
    } finally {
      setSaving(false);
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
          <CameraGrid cameras={cameras} gridSize={gridSize} />
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

                {/* IP + Port */}
                <div className="grid grid-cols-3 gap-3">
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
                      Puerto RTSP
                    </label>
                    <input
                      type="number"
                      placeholder="554"
                      value={formData.port}
                      onChange={(e) => setFormData({ ...formData, port: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
                    />
                  </div>
                </div>

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

                {/* Manufacturer + Model */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Marca
                    </label>
                    <input
                      type="text"
                      placeholder="Hikvision, Dahua, Axis..."
                      value={formData.manufacturer}
                      onChange={(e) => setFormData({ ...formData, manufacturer: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
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
