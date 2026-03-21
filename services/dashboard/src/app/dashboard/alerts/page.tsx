"use client";

import { useEffect, useState } from "react";
import { Header } from "@/components/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import {
  Plus,
  Trash2,
  Bell,
  BellRing,
  Mail,
  X,
  Camera,
  Clock,
  Edit2,
  Check,
  Power,
  AlertTriangle,
  Image as ImageIcon,
  Send,
  Eye,
} from "lucide-react";

interface AlertRule {
  id: string;
  name: string;
  camera_id: string | null;
  camera_name?: string;
  event_types: string[];
  channel: string;
  target: string;
  cooldown_seconds: number;
  is_enabled: boolean;
  include_snapshot: boolean;
  last_triggered_at: string | null;
  trigger_count?: number;
}

const EVENT_TYPES = [
  { value: "person_detected", label: "Persona detectada", icon: "👤" },
  { value: "vehicle_detected", label: "Vehículo detectado", icon: "🚗" },
  { value: "motion_detected", label: "Movimiento detectado", icon: "🔄" },
  { value: "face_recognized", label: "Rostro reconocido", icon: "😀" },
  { value: "face_unknown", label: "Rostro desconocido", icon: "❓" },
  { value: "zone_intrusion", label: "Intrusión en zona", icon: "⚠️" },
  { value: "loitering", label: "Merodeo", icon: "🚶" },
  { value: "camera_offline", label: "Cámara desconectada", icon: "📴" },
];

const DEMO_CAMERAS = [
  { id: "cam-001", name: "Entrada Principal" },
  { id: "cam-002", name: "Estacionamiento Norte" },
  { id: "cam-003", name: "Oficina Servidores" },
  { id: "cam-004", name: "Pasillo Piso 2" },
  { id: "cam-005", name: "Almacén" },
  { id: "cam-006", name: "Recepción" },
];

const DEMO_ALERTS: AlertRule[] = [
  {
    id: "alert-001",
    name: "Intrusión nocturna - Entrada",
    camera_id: "cam-001",
    camera_name: "Entrada Principal",
    event_types: ["person_detected", "zone_intrusion"],
    channel: "email",
    target: "seguridad@dnsit.com.mx",
    cooldown_seconds: 60,
    is_enabled: true,
    include_snapshot: true,
    last_triggered_at: "2025-03-21T02:15:00Z",
    trigger_count: 12,
  },
  {
    id: "alert-002",
    name: "Vehículo en estacionamiento",
    camera_id: "cam-002",
    camera_name: "Estacionamiento Norte",
    event_types: ["vehicle_detected"],
    channel: "email",
    target: "admin@dnsit.com.mx",
    cooldown_seconds: 60,
    is_enabled: true,
    include_snapshot: true,
    last_triggered_at: "2025-03-21T08:30:00Z",
    trigger_count: 45,
  },
  {
    id: "alert-003",
    name: "Rostro desconocido - Server Room",
    camera_id: "cam-003",
    camera_name: "Oficina Servidores",
    event_types: ["face_unknown"],
    channel: "email",
    target: "it@dnsit.com.mx",
    cooldown_seconds: 60,
    is_enabled: false,
    include_snapshot: true,
    last_triggered_at: null,
    trigger_count: 0,
  },
];

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<AlertRule[]>(DEMO_ALERTS);
  const [cameras, setCameras] = useState<{ id: string; name: string }[]>(DEMO_CAMERAS);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingAlert, setEditingAlert] = useState<AlertRule | null>(null);
  const [formError, setFormError] = useState("");
  const [testSending, setTestSending] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; msg: string } | null>(null);

  // Form state
  const [form, setForm] = useState({
    name: "",
    camera_id: "",
    event_types: [] as string[],
    channel: "email",
    target: "",
    cooldown_seconds: 60,
    include_snapshot: true,
  });

  useEffect(() => {
    api.get<AlertRule[]>("/alerts").then(setAlerts).catch(() => setAlerts(DEMO_ALERTS));
    api.get<{ id: string; name: string }[]>("/cameras").then(setCameras).catch(() => setCameras(DEMO_CAMERAS));
  }, []);

  const resetForm = () => {
    setForm({
      name: "",
      camera_id: "",
      event_types: [],
      channel: "email",
      target: "",
      cooldown_seconds: 60,
      include_snapshot: true,
    });
    setFormError("");
  };

  const toggleEventType = (type: string) => {
    setForm((prev) => ({
      ...prev,
      event_types: prev.event_types.includes(type)
        ? prev.event_types.filter((t) => t !== type)
        : [...prev.event_types, type],
    }));
  };

  const handleSave = async () => {
    if (!form.name.trim()) { setFormError("El nombre es obligatorio"); return; }
    if (form.event_types.length === 0) { setFormError("Selecciona al menos un tipo de evento"); return; }
    if (!form.target.trim()) { setFormError("El destinatario es obligatorio"); return; }
    if (form.channel === "email" && !form.target.includes("@")) { setFormError("Ingresa un email válido"); return; }

    const camName = cameras.find((c) => c.id === form.camera_id)?.name || "Todas";

    if (editingAlert) {
      // Update
      setAlerts((prev) =>
        prev.map((a) =>
          a.id === editingAlert.id
            ? { ...a, ...form, camera_name: camName, camera_id: form.camera_id || null }
            : a
        )
      );
    } else {
      // Create
      const newAlert: AlertRule = {
        id: `alert-${Date.now()}`,
        ...form,
        camera_id: form.camera_id || null,
        camera_name: camName,
        is_enabled: true,
        last_triggered_at: null,
        trigger_count: 0,
      };
      setAlerts((prev) => [...prev, newAlert]);
    }

    try {
      if (editingAlert) {
        await api.put(`/alerts/${editingAlert.id}`, { ...form, camera_id: form.camera_id || null });
      } else {
        await api.post("/alerts", { ...form, camera_id: form.camera_id || null });
      }
    } catch { /* demo mode */ }

    resetForm();
    setShowCreateModal(false);
    setEditingAlert(null);
  };

  const handleDelete = (id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    try { api.del(`/alerts/${id}`); } catch { /* demo */ }
  };

  const handleToggle = (id: string) => {
    setAlerts((prev) =>
      prev.map((a) => (a.id === id ? { ...a, is_enabled: !a.is_enabled } : a))
    );
    const alert = alerts.find((a) => a.id === id);
    if (alert) {
      try { api.put(`/alerts/${id}`, { is_enabled: !alert.is_enabled }); } catch { /* demo */ }
    }
  };

  const handleEdit = (alert: AlertRule) => {
    setForm({
      name: alert.name,
      camera_id: alert.camera_id || "",
      event_types: alert.event_types,
      channel: alert.channel,
      target: alert.target,
      cooldown_seconds: alert.cooldown_seconds,
      include_snapshot: alert.include_snapshot,
    });
    setEditingAlert(alert);
    setShowCreateModal(true);
  };

  const handleTestAlert = async (alert: AlertRule) => {
    setTestSending(alert.id);
    setTestResult(null);
    // Simulate sending
    await new Promise((r) => setTimeout(r, 2000));
    setTestSending(null);
    setTestResult({ id: alert.id, ok: true, msg: `Email de prueba enviado a ${alert.target}` });
    setTimeout(() => setTestResult(null), 4000);
  };

  const activeCount = alerts.filter((a) => a.is_enabled).length;

  return (
    <>
      <Header title="Alertas" />
      <div className="p-6 space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <Bell className="h-7 w-7 text-blue-600" />
              <div>
                <p className="text-xl font-bold text-gray-900">{alerts.length}</p>
                <p className="text-xs text-gray-500">Reglas totales</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <BellRing className="h-7 w-7 text-green-600" />
              <div>
                <p className="text-xl font-bold text-gray-900">{activeCount}</p>
                <p className="text-xs text-gray-500">Activas</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <Mail className="h-7 w-7 text-orange-500" />
              <div>
                <p className="text-xl font-bold text-gray-900">
                  {alerts.reduce((s, a) => s + (a.trigger_count || 0), 0)}
                </p>
                <p className="text-xs text-gray-500">Alertas enviadas</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Info banner */}
        <div className="flex items-start gap-3 p-3 rounded-lg bg-blue-50 border border-blue-100 text-sm text-blue-700">
          <Clock className="h-5 w-5 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Límite de envío: 1 alerta por cámara por minuto</p>
            <p className="text-xs text-blue-600 mt-0.5">
              Cada cámara puede enviar máximo un correo por minuto. Si hay más detecciones, se acumularán y se enviarán en el siguiente ciclo. El correo incluye una imagen miniatura de la detección.
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-between items-center">
          <h2 className="text-sm font-medium text-gray-700">Reglas de Alerta</h2>
          <Button onClick={() => { resetForm(); setEditingAlert(null); setShowCreateModal(true); }}>
            <Plus className="h-4 w-4 mr-1" /> Nueva Regla
          </Button>
        </div>

        {/* Alert Rules List */}
        {alerts.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-gray-400">
            <Bell className="h-12 w-12 mb-3" />
            <p className="text-lg font-medium">No hay reglas de alerta</p>
            <p className="text-sm mt-1 mb-4">Crea una regla para recibir notificaciones por email</p>
            <Button onClick={() => { resetForm(); setShowCreateModal(true); }}>
              <Plus className="h-4 w-4 mr-1" /> Nueva Regla
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {alerts.map((alert) => (
              <Card key={alert.id} className={!alert.is_enabled ? "opacity-60" : ""}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm font-semibold text-gray-900">{alert.name}</h3>
                        <Badge variant={alert.is_enabled ? "success" : "secondary"}>
                          {alert.is_enabled ? "Activa" : "Pausada"}
                        </Badge>
                      </div>

                      <div className="grid grid-cols-2 gap-x-6 gap-y-1 mt-2 text-xs text-gray-500">
                        <div className="flex items-center gap-1.5">
                          <Camera className="h-3.5 w-3.5" />
                          <span>{alert.camera_name || "Todas las cámaras"}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Mail className="h-3.5 w-3.5" />
                          <span className="truncate">{alert.target}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Clock className="h-3.5 w-3.5" />
                          <span>Cooldown: {alert.cooldown_seconds}s (1 por minuto)</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <ImageIcon className="h-3.5 w-3.5" />
                          <span>{alert.include_snapshot ? "Con imagen adjunta" : "Sin imagen"}</span>
                        </div>
                      </div>

                      {/* Event types */}
                      <div className="flex flex-wrap gap-1 mt-2">
                        {alert.event_types.map((t) => {
                          const et = EVENT_TYPES.find((e) => e.value === t);
                          return (
                            <span key={t} className="inline-flex items-center gap-1 text-[11px] bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full">
                              {et?.icon} {et?.label || t}
                            </span>
                          );
                        })}
                      </div>

                      {/* Last triggered */}
                      {alert.last_triggered_at && (
                        <p className="text-[11px] text-gray-400 mt-2">
                          Última alerta: {new Date(alert.last_triggered_at).toLocaleString("es-MX")} · Total: {alert.trigger_count} enviadas
                        </p>
                      )}

                      {/* Test result */}
                      {testResult?.id === alert.id && (
                        <div className={`mt-2 p-2 rounded text-xs ${testResult.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
                          {testResult.msg}
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 ml-3">
                      <button
                        onClick={() => handleTestAlert(alert)}
                        disabled={testSending === alert.id}
                        className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded"
                        title="Enviar prueba"
                      >
                        {testSending === alert.id ? (
                          <Send className="h-4 w-4 animate-pulse" />
                        ) : (
                          <Send className="h-4 w-4" />
                        )}
                      </button>
                      <button
                        onClick={() => handleToggle(alert.id)}
                        className={`p-1.5 rounded ${alert.is_enabled ? "text-green-600 hover:bg-green-50" : "text-gray-400 hover:bg-gray-100"}`}
                        title={alert.is_enabled ? "Pausar" : "Activar"}
                      >
                        <Power className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleEdit(alert)}
                        className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded"
                        title="Editar"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(alert.id)}
                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"
                        title="Eliminar"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Create/Edit Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4">
            <div className="flex items-center justify-between p-5 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">
                {editingAlert ? "Editar Regla" : "Nueva Regla de Alerta"}
              </h2>
              <button onClick={() => { setShowCreateModal(false); setEditingAlert(null); }} className="p-1 rounded-md hover:bg-gray-100 text-gray-500">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-5 space-y-4 max-h-[65vh] overflow-y-auto">
              {formError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">{formError}</div>
              )}

              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Nombre de la regla <span className="text-red-500">*</span>
                </label>
                <Input
                  placeholder="Ej: Intrusión nocturna - Entrada"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>

              {/* Camera */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Cámara</label>
                <select
                  value={form.camera_id}
                  onChange={(e) => setForm({ ...form, camera_id: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                >
                  <option value="">Todas las cámaras</option>
                  {cameras.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              {/* Event Types */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Tipos de evento <span className="text-red-500">*</span>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {EVENT_TYPES.map((et) => (
                    <label
                      key={et.value}
                      className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer text-sm transition-colors ${
                        form.event_types.includes(et.value)
                          ? "border-blue-500 bg-blue-50 text-blue-700"
                          : "border-gray-200 text-gray-600 hover:border-gray-300"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={form.event_types.includes(et.value)}
                        onChange={() => toggleEventType(et.value)}
                        className="h-3.5 w-3.5 text-blue-600 rounded"
                      />
                      <span>{et.icon}</span>
                      <span className="text-xs">{et.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Email target */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Email destinatario <span className="text-red-500">*</span>
                </label>
                <Input
                  type="email"
                  placeholder="seguridad@dnsit.com.mx"
                  value={form.target}
                  onChange={(e) => setForm({ ...form, target: e.target.value })}
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  Puedes separar múltiples emails con coma: email1@dns.com, email2@dns.com
                </p>
              </div>

              {/* Cooldown */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Cooldown entre alertas
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    value={form.cooldown_seconds}
                    onChange={(e) => setForm({ ...form, cooldown_seconds: Math.max(60, parseInt(e.target.value) || 60) })}
                    min={60}
                    className="w-24"
                  />
                  <span className="text-sm text-gray-500">segundos (mínimo 60s)</span>
                </div>
                <p className="text-[11px] text-gray-400 mt-1">
                  Máximo 1 correo por cámara por minuto. Si hay más detecciones se esperará al siguiente ciclo.
                </p>
              </div>

              {/* Include snapshot */}
              <label className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 cursor-pointer hover:border-gray-300">
                <input
                  type="checkbox"
                  checked={form.include_snapshot}
                  onChange={(e) => setForm({ ...form, include_snapshot: e.target.checked })}
                  className="h-4 w-4 text-blue-600 rounded"
                />
                <div>
                  <p className="text-sm font-medium text-gray-700">Incluir imagen de la detección</p>
                  <p className="text-xs text-gray-500">Adjunta una miniatura del momento de la alerta en el correo</p>
                </div>
              </label>
            </div>

            <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-200">
              <Button variant="outline" onClick={() => { setShowCreateModal(false); setEditingAlert(null); }}>
                Cancelar
              </Button>
              <Button onClick={handleSave}>
                {editingAlert ? "Guardar Cambios" : "Crear Regla"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
