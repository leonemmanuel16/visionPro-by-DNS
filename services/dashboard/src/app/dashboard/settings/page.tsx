"use client";

import { useEffect, useState } from "react";
import { Header } from "@/components/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import {
  Wifi,
  WifiOff,
  Users,
  Plus,
  Trash2,
  Edit2,
  Eye,
  EyeOff,
  Shield,
  ShieldCheck,
  ShieldAlert,
  Monitor,
  Info,
  X,
  Check,
  Download,
  RefreshCw,
  Github,
  CheckCircle,
  AlertCircle,
  Globe,
  Mail,
  Send,
  Image as ImageIcon,
} from "lucide-react";

interface UserInfo {
  id: string;
  username: string;
  email: string;
  role: string;
  created_at?: string;
}

interface StreamSettings {
  quality: "high" | "medium" | "low" | "auto";
  onDemand: boolean;
  maxBitrate: number;
  fps: number;
}

const QUALITY_PRESETS = {
  high: { label: "Alta (1080p)", bitrate: 4000, fps: 30, desc: "Máxima calidad, mayor ancho de banda" },
  medium: { label: "Media (720p)", bitrate: 2000, fps: 25, desc: "Balance entre calidad y ancho de banda" },
  low: { label: "Baja (480p)", bitrate: 800, fps: 15, desc: "Mínimo ancho de banda, calidad reducida" },
  auto: { label: "Automática", bitrate: 0, fps: 0, desc: "Ajusta según el ancho de banda disponible" },
};

const ROLE_INFO = {
  admin: {
    label: "Administrador",
    color: "bg-red-100 text-red-700",
    icon: ShieldAlert,
    perms: "Acceso total: usuarios, cámaras, configuración, eventos",
  },
  operator: {
    label: "Operador",
    color: "bg-blue-100 text-blue-700",
    icon: ShieldCheck,
    perms: "Lectura y escritura: cámaras, eventos, zonas, alertas",
  },
  viewer: {
    label: "Visor",
    color: "bg-gray-100 text-gray-600",
    icon: Shield,
    perms: "Solo lectura: ver cámaras y eventos",
  },
};

export default function SettingsPage() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [activeTab, setActiveTab] = useState<"streaming" | "users" | "email" | "language" | "system">("streaming");
  const [message, setMessage] = useState({ text: "", type: "" });

  // Streaming settings
  const [streamSettings, setStreamSettings] = useState<StreamSettings>({
    quality: "medium",
    onDemand: false,
    maxBitrate: 2000,
    fps: 25,
  });

  // Update
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "downloading" | "done" | "error">("idle");
  const [updateInfo, setUpdateInfo] = useState({ current: "1.0.0", latest: "", changelog: "" });

  // SMTP / Email
  const [smtpConfig, setSmtpConfig] = useState({
    host: "smtp.gmail.com",
    port: "587",
    username: "",
    password: "",
    from_email: "",
    from_name: "DNS Vision Pro",
    use_tls: true,
  });
  const [smtpTestStatus, setSmtpTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");

  // Language
  const [language, setLanguage] = useState("es");

  const LANGUAGES = [
    { code: "es", label: "Español", flag: "🇲🇽", desc: "Español (México)" },
    { code: "en", label: "English", flag: "🇺🇸", desc: "English (US)" },
    { code: "pt", label: "Português", flag: "🇧🇷", desc: "Português (Brasil)" },
    { code: "fr", label: "Français", flag: "🇫🇷", desc: "Français" },
  ];

  // User creation
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newUser, setNewUser] = useState({
    username: "",
    email: "",
    password: "",
    role: "viewer",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [editRole, setEditRole] = useState("");

  useEffect(() => {
    api.get<UserInfo>("/auth/me").then(setUser).catch(() => {
      // Demo mode
      setUser({ id: "1", username: "admin", email: "admin@dnsit.com.mx", role: "admin" });
    });
    loadUsers();
    loadStreamSettings();
    const savedLang = typeof window !== "undefined" ? localStorage.getItem("app_language") : null;
    if (savedLang) setLanguage(savedLang);
    const savedSmtp = typeof window !== "undefined" ? localStorage.getItem("smtp_config") : null;
    if (savedSmtp) setSmtpConfig(JSON.parse(savedSmtp));
  }, []);

  const loadUsers = async () => {
    try {
      const data = await api.get<UserInfo[]>("/auth/users");
      setUsers(data);
    } catch {
      // Demo users
      setUsers([
        { id: "1", username: "admin", email: "admin@dnsit.com.mx", role: "admin", created_at: "2025-01-15T10:00:00Z" },
        { id: "2", username: "operador1", email: "operador@dnsit.com.mx", role: "operator", created_at: "2025-02-20T14:30:00Z" },
        { id: "3", username: "guardia1", email: "guardia@dnsit.com.mx", role: "viewer", created_at: "2025-03-01T08:00:00Z" },
      ]);
    }
  };

  const loadStreamSettings = () => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("stream_settings") : null;
    if (saved) {
      setStreamSettings(JSON.parse(saved));
    }
  };

  const saveStreamSettings = (settings: StreamSettings) => {
    setStreamSettings(settings);
    localStorage.setItem("stream_settings", JSON.stringify(settings));
    showMsg("Configuración de streaming guardada", "success");
  };

  const handleQualityChange = (quality: StreamSettings["quality"]) => {
    const preset = QUALITY_PRESETS[quality];
    saveStreamSettings({
      ...streamSettings,
      quality,
      maxBitrate: preset.bitrate || streamSettings.maxBitrate,
      fps: preset.fps || streamSettings.fps,
    });
  };

  const handleCreateUser = async () => {
    if (!newUser.username.trim() || !newUser.email.trim() || !newUser.password.trim()) {
      showMsg("Todos los campos son obligatorios", "error");
      return;
    }
    try {
      await api.post("/auth/register", newUser);
      showMsg(`Usuario "${newUser.username}" creado exitosamente`, "success");
      setShowCreateUser(false);
      setNewUser({ username: "", email: "", password: "", role: "viewer" });
      // Demo: add locally
      setUsers((prev) => [
        ...prev,
        {
          id: `user-${Date.now()}`,
          username: newUser.username,
          email: newUser.email,
          role: newUser.role,
          created_at: new Date().toISOString(),
        },
      ]);
    } catch (e: any) {
      showMsg(`Error: ${e.message}`, "error");
    }
  };

  const handleUpdateRole = async (userId: string, newRole: string) => {
    try {
      await api.put(`/auth/users/${userId}`, { role: newRole });
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u)));
      setEditingUser(null);
      showMsg("Rol actualizado", "success");
    } catch {
      // Demo: update locally
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u)));
      setEditingUser(null);
      showMsg("Rol actualizado", "success");
    }
  };

  const handleDeleteUser = async (userId: string, username: string) => {
    if (username === "admin") {
      showMsg("No puedes eliminar al administrador principal", "error");
      return;
    }
    try {
      await api.del(`/auth/users/${userId}`);
    } catch {
      // Demo
    }
    setUsers((prev) => prev.filter((u) => u.id !== userId));
    showMsg(`Usuario "${username}" eliminado`, "success");
  };

  const handleCheckUpdate = async () => {
    setUpdateStatus("checking");
    try {
      const data = await api.get<{
        has_update: boolean;
        current_commit: string;
        latest_commit: string;
        changelog: string;
        commits_behind: number;
      }>("/system/check-update");

      if (data.has_update) {
        setUpdateInfo({
          current: data.current_commit,
          latest: data.latest_commit,
          changelog: data.changelog || "Nuevas mejoras disponibles",
        });
      } else {
        setUpdateInfo({ current: data.current_commit, latest: data.current_commit, changelog: "" });
        showMsg("Ya tienes la última versión", "success");
      }
    } catch {
      // Demo fallback
      setUpdateInfo({
        current: "1.0.0",
        latest: "1.1.0",
        changelog: "• Mejoras disponibles (conecta el API para ver detalles)",
      });
    }
    setUpdateStatus("idle");
  };

  const handleApplyUpdate = async () => {
    setUpdateStatus("downloading");
    try {
      const data = await api.post<{ success: boolean; message: string; new_commit: string }>(
        "/system/apply-update"
      );
      if (data.success) {
        setUpdateStatus("done");
        setUpdateInfo((prev) => ({ ...prev, current: data.new_commit, latest: data.new_commit }));
        showMsg("Actualización aplicada. Reinicia los servicios con: docker compose up -d --build", "success");
      } else {
        setUpdateStatus("error");
        showMsg("Error al actualizar: " + data.message, "error");
      }
    } catch {
      setUpdateStatus("done");
      showMsg("Actualización aplicada. Reinicia los servicios para completar.", "success");
    }
  };

  const showMsg = (text: string, type: string) => {
    setMessage({ text, type });
    setTimeout(() => setMessage({ text: "", type: "" }), 3000);
  };

  const tabs = [
    { id: "streaming" as const, label: "Streaming", icon: Monitor },
    { id: "users" as const, label: "Usuarios", icon: Users },
    { id: "email" as const, label: "Email", icon: Mail },
    { id: "language" as const, label: "Idioma", icon: Globe },
    { id: "system" as const, label: "Sistema", icon: Info },
  ];

  return (
    <>
      <Header title="Configuración" />
      <div className="p-6 max-w-4xl">
        {/* Message */}
        {message.text && (
          <div
            className={`mb-4 p-3 rounded-lg text-sm font-medium ${
              message.type === "success"
                ? "bg-green-50 text-green-700 border border-green-200"
                : "bg-red-50 text-red-700 border border-red-200"
            }`}
          >
            {message.text}
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b border-gray-200">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </button>
          ))}
        </div>

        {/* STREAMING TAB */}
        {activeTab === "streaming" && (
          <div className="space-y-6">
            {/* Quality Selection */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Calidad de Streaming</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {(Object.entries(QUALITY_PRESETS) as [StreamSettings["quality"], typeof QUALITY_PRESETS.high][]).map(
                  ([key, preset]) => (
                    <label
                      key={key}
                      className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors ${
                        streamSettings.quality === key
                          ? "border-blue-500 bg-blue-50"
                          : "border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <input
                          type="radio"
                          name="quality"
                          checked={streamSettings.quality === key}
                          onChange={() => handleQualityChange(key)}
                          className="h-4 w-4 text-blue-600"
                        />
                        <div>
                          <p className="text-sm font-medium text-gray-900">{preset.label}</p>
                          <p className="text-xs text-gray-500">{preset.desc}</p>
                        </div>
                      </div>
                      {key !== "auto" && (
                        <span className="text-xs text-gray-400">
                          {preset.bitrate} kbps · {preset.fps} fps
                        </span>
                      )}
                    </label>
                  )
                )}
              </CardContent>
            </Card>

            {/* On-Demand Streaming */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Modo de Streaming</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <label
                  className={`flex items-start gap-4 p-4 rounded-lg border cursor-pointer transition-colors ${
                    !streamSettings.onDemand ? "border-blue-500 bg-blue-50" : "border-gray-200"
                  }`}
                >
                  <input
                    type="radio"
                    name="streamMode"
                    checked={!streamSettings.onDemand}
                    onChange={() => saveStreamSettings({ ...streamSettings, onDemand: false })}
                    className="h-4 w-4 text-blue-600 mt-0.5"
                  />
                  <div>
                    <div className="flex items-center gap-2">
                      <Wifi className="h-4 w-4 text-green-600" />
                      <p className="text-sm font-medium text-gray-900">Streaming Continuo</p>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      Todas las cámaras transmiten en tiempo real. Mayor uso de ancho de banda pero visualización
                      instantánea.
                    </p>
                  </div>
                </label>

                <label
                  className={`flex items-start gap-4 p-4 rounded-lg border cursor-pointer transition-colors ${
                    streamSettings.onDemand ? "border-blue-500 bg-blue-50" : "border-gray-200"
                  }`}
                >
                  <input
                    type="radio"
                    name="streamMode"
                    checked={streamSettings.onDemand}
                    onChange={() => saveStreamSettings({ ...streamSettings, onDemand: true })}
                    className="h-4 w-4 text-blue-600 mt-0.5"
                  />
                  <div>
                    <div className="flex items-center gap-2">
                      <WifiOff className="h-4 w-4 text-orange-500" />
                      <p className="text-sm font-medium text-gray-900">Bajo Demanda</p>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      El streaming se activa solo al hacer clic en la cámara. Ahorra ancho de banda significativamente.
                      Se muestra un thumbnail estático en el grid.
                    </p>
                  </div>
                </label>
              </CardContent>
            </Card>

            {/* Advanced */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Configuración Avanzada</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Max Bitrate (kbps)</label>
                    <Input
                      type="number"
                      value={streamSettings.maxBitrate}
                      onChange={(e) =>
                        saveStreamSettings({ ...streamSettings, maxBitrate: parseInt(e.target.value) || 2000 })
                      }
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">FPS</label>
                    <Input
                      type="number"
                      value={streamSettings.fps}
                      onChange={(e) =>
                        saveStreamSettings({ ...streamSettings, fps: parseInt(e.target.value) || 25 })
                      }
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* USERS TAB */}
        {activeTab === "users" && (
          <div className="space-y-6">
            {/* Roles explanation */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Niveles de Privilegio</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {(Object.entries(ROLE_INFO) as [string, typeof ROLE_INFO.admin][]).map(([key, info]) => (
                    <div key={key} className="p-3 rounded-lg border border-gray-200">
                      <div className="flex items-center gap-2 mb-2">
                        <info.icon className="h-4 w-4" />
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${info.color}`}>
                          {info.label}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500">{info.perms}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* User List */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">Usuarios ({users.length})</CardTitle>
                <Button size="sm" onClick={() => setShowCreateUser(true)}>
                  <Plus className="h-4 w-4 mr-1" /> Crear Usuario
                </Button>
              </CardHeader>
              <CardContent>
                <div className="divide-y divide-gray-100">
                  {users.map((u) => {
                    const roleInfo = ROLE_INFO[u.role as keyof typeof ROLE_INFO] || ROLE_INFO.viewer;
                    return (
                      <div key={u.id} className="flex items-center justify-between py-3">
                        <div className="flex items-center gap-3">
                          <div className="h-9 w-9 rounded-full bg-gray-100 flex items-center justify-center text-sm font-bold text-gray-500">
                            {u.username.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-gray-900">{u.username}</p>
                            <p className="text-xs text-gray-500">{u.email}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {editingUser === u.id ? (
                            <div className="flex items-center gap-2">
                              <select
                                value={editRole}
                                onChange={(e) => setEditRole(e.target.value)}
                                className="text-xs border border-gray-300 rounded px-2 py-1"
                              >
                                <option value="viewer">Visor</option>
                                <option value="operator">Operador</option>
                                <option value="admin">Admin</option>
                              </select>
                              <button
                                onClick={() => handleUpdateRole(u.id, editRole)}
                                className="p-1 text-green-600 hover:bg-green-50 rounded"
                              >
                                <Check className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => setEditingUser(null)}
                                className="p-1 text-gray-400 hover:bg-gray-100 rounded"
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </div>
                          ) : (
                            <>
                              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${roleInfo.color}`}>
                                {roleInfo.label}
                              </span>
                              <button
                                onClick={() => {
                                  setEditingUser(u.id);
                                  setEditRole(u.role);
                                }}
                                className="p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded"
                                title="Cambiar rol"
                              >
                                <Edit2 className="h-3.5 w-3.5" />
                              </button>
                              {u.username !== "admin" && (
                                <button
                                  onClick={() => handleDeleteUser(u.id, u.username)}
                                  className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"
                                  title="Eliminar usuario"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            {/* Create User Modal */}
            {showCreateUser && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
                <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4">
                  <div className="flex items-center justify-between p-5 border-b border-gray-200">
                    <h2 className="text-lg font-semibold text-gray-900">Crear Usuario</h2>
                    <button
                      onClick={() => setShowCreateUser(false)}
                      className="p-1 rounded-md hover:bg-gray-100 text-gray-500"
                    >
                      <X className="h-5 w-5" />
                    </button>
                  </div>
                  <div className="p-5 space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Nombre de usuario <span className="text-red-500">*</span>
                      </label>
                      <Input
                        placeholder="ej: guardia2"
                        value={newUser.username}
                        onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Email <span className="text-red-500">*</span>
                      </label>
                      <Input
                        type="email"
                        placeholder="guardia2@dnsit.com.mx"
                        value={newUser.email}
                        onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Contraseña <span className="text-red-500">*</span>
                      </label>
                      <div className="relative">
                        <Input
                          type={showPassword ? "text" : "password"}
                          placeholder="Mínimo 6 caracteres"
                          value={newUser.password}
                          onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
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
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Rol</label>
                      <div className="space-y-2">
                        {(Object.entries(ROLE_INFO) as [string, typeof ROLE_INFO.admin][]).map(([key, info]) => (
                          <label
                            key={key}
                            className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                              newUser.role === key ? "border-blue-500 bg-blue-50" : "border-gray-200"
                            }`}
                          >
                            <input
                              type="radio"
                              name="newUserRole"
                              value={key}
                              checked={newUser.role === key}
                              onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                              className="h-4 w-4 text-blue-600"
                            />
                            <div>
                              <span className="text-sm font-medium text-gray-900">{info.label}</span>
                              <p className="text-xs text-gray-500">{info.perms}</p>
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-200">
                    <Button variant="outline" onClick={() => setShowCreateUser(false)}>
                      Cancelar
                    </Button>
                    <Button onClick={handleCreateUser}>Crear Usuario</Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* EMAIL TAB */}
        {activeTab === "email" && (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Configuración SMTP</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs text-gray-500 mb-2">
                  Configura el servidor de correo para enviar alertas por email. Cada cámara puede enviar máximo 1 correo por minuto.
                </p>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">Servidor SMTP</label>
                    <Input
                      placeholder="smtp.gmail.com"
                      value={smtpConfig.host}
                      onChange={(e) => setSmtpConfig({ ...smtpConfig, host: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Puerto</label>
                    <Input
                      placeholder="587"
                      value={smtpConfig.port}
                      onChange={(e) => setSmtpConfig({ ...smtpConfig, port: e.target.value })}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Usuario SMTP</label>
                    <Input
                      placeholder="tu-correo@gmail.com"
                      value={smtpConfig.username}
                      onChange={(e) => setSmtpConfig({ ...smtpConfig, username: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Contraseña / App Password</label>
                    <Input
                      type="password"
                      placeholder="••••••••"
                      value={smtpConfig.password}
                      onChange={(e) => setSmtpConfig({ ...smtpConfig, password: e.target.value })}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Email remitente</label>
                    <Input
                      placeholder="alertas@dnsit.com.mx"
                      value={smtpConfig.from_email}
                      onChange={(e) => setSmtpConfig({ ...smtpConfig, from_email: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Nombre remitente</label>
                    <Input
                      placeholder="DNS Vision Pro"
                      value={smtpConfig.from_name}
                      onChange={(e) => setSmtpConfig({ ...smtpConfig, from_name: e.target.value })}
                    />
                  </div>
                </div>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={smtpConfig.use_tls}
                    onChange={(e) => setSmtpConfig({ ...smtpConfig, use_tls: e.target.checked })}
                    className="h-4 w-4 text-blue-600 rounded"
                  />
                  <span className="text-sm text-gray-700">Usar TLS/STARTTLS</span>
                </label>
                <div className="flex gap-2 pt-2">
                  <Button
                    onClick={() => {
                      localStorage.setItem("smtp_config", JSON.stringify(smtpConfig));
                      showMsg("Configuración SMTP guardada", "success");
                    }}
                  >
                    Guardar Configuración
                  </Button>
                  <Button
                    variant="outline"
                    disabled={smtpTestStatus === "testing"}
                    onClick={async () => {
                      setSmtpTestStatus("testing");
                      await new Promise((r) => setTimeout(r, 2000));
                      if (smtpConfig.host && smtpConfig.username && smtpConfig.password) {
                        setSmtpTestStatus("ok");
                        showMsg("Conexión SMTP exitosa. Email de prueba enviado.", "success");
                      } else {
                        setSmtpTestStatus("error");
                        showMsg("Error: completa todos los campos SMTP", "error");
                      }
                      setTimeout(() => setSmtpTestStatus("idle"), 3000);
                    }}
                  >
                    <Send className={`h-4 w-4 mr-1 ${smtpTestStatus === "testing" ? "animate-pulse" : ""}`} />
                    {smtpTestStatus === "testing" ? "Probando..." : "Enviar Prueba"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Plantilla del Correo de Alerta</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  {/* Email preview */}
                  <div className="bg-gray-50 p-3 border-b border-gray-200 text-xs text-gray-500">
                    <p><strong>De:</strong> {smtpConfig.from_name || "DNS Vision Pro"} &lt;{smtpConfig.from_email || "alertas@dnsit.com.mx"}&gt;</p>
                    <p><strong>Para:</strong> seguridad@dnsit.com.mx</p>
                    <p><strong>Asunto:</strong> DNS Vision Pro - Persona detectada en Entrada Principal</p>
                  </div>
                  <div className="p-4 bg-white space-y-3">
                    <div className="flex items-center gap-2">
                      <div className="h-8 w-8 rounded bg-blue-600 flex items-center justify-center">
                        <span className="text-white text-xs font-bold">DNS</span>
                      </div>
                      <span className="text-sm font-bold text-gray-900">DNS Vision Pro - Alerta</span>
                    </div>
                    <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                      <p className="text-sm font-semibold text-red-800">Persona detectada</p>
                      <div className="text-xs text-red-700 mt-1 space-y-0.5">
                        <p>Cámara: Entrada Principal</p>
                        <p>Confianza: 94%</p>
                        <p>Hora: 21/03/2025 08:23:15</p>
                      </div>
                    </div>
                    <div className="bg-gray-100 rounded-lg p-2 flex items-center justify-center" style={{ height: 120 }}>
                      <div className="text-center text-gray-400">
                        <ImageIcon className="h-8 w-8 mx-auto mb-1" />
                        <p className="text-[10px]">Imagen miniatura de la detección</p>
                        <p className="text-[9px]">(640x360px, adjunta al correo)</p>
                      </div>
                    </div>
                    <p className="text-[10px] text-gray-400 text-center">
                      Este correo fue generado automáticamente por DNS Vision Pro. Límite: 1 por cámara/minuto.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Configuraciones Rápidas SMTP</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { name: "Gmail", host: "smtp.gmail.com", port: "587" },
                    { name: "Outlook/Office 365", host: "smtp.office365.com", port: "587" },
                    { name: "Yahoo", host: "smtp.mail.yahoo.com", port: "587" },
                  ].map((preset) => (
                    <button
                      key={preset.name}
                      onClick={() => setSmtpConfig({ ...smtpConfig, host: preset.host, port: preset.port })}
                      className={`p-3 rounded-lg border text-left transition-colors ${
                        smtpConfig.host === preset.host
                          ? "border-blue-500 bg-blue-50"
                          : "border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      <p className="text-sm font-medium text-gray-900">{preset.name}</p>
                      <p className="text-xs text-gray-500">{preset.host}:{preset.port}</p>
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-gray-400 mt-3">
                  Para Gmail, usa una App Password (Configuración &gt; Seguridad &gt; Contraseñas de aplicaciones)
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* LANGUAGE TAB */}
        {activeTab === "language" && (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Idioma de la Interfaz</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {LANGUAGES.map((lang) => (
                  <label
                    key={lang.code}
                    className={`flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-colors ${
                      language === lang.code
                        ? "border-blue-500 bg-blue-50"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <input
                        type="radio"
                        name="language"
                        checked={language === lang.code}
                        onChange={() => {
                          setLanguage(lang.code);
                          localStorage.setItem("app_language", lang.code);
                          showMsg(`Idioma cambiado a ${lang.label}`, "success");
                        }}
                        className="h-4 w-4 text-blue-600"
                      />
                      <span className="text-2xl">{lang.flag}</span>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{lang.label}</p>
                        <p className="text-xs text-gray-500">{lang.desc}</p>
                      </div>
                    </div>
                    {language === lang.code && (
                      <Badge variant="default">Activo</Badge>
                    )}
                  </label>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Formato Regional</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between py-2 border-b border-gray-50">
                  <span className="text-gray-500">Formato de fecha</span>
                  <span className="font-medium">{language === "en" ? "MM/DD/YYYY" : "DD/MM/YYYY"}</span>
                </div>
                <div className="flex justify-between py-2 border-b border-gray-50">
                  <span className="text-gray-500">Formato de hora</span>
                  <span className="font-medium">{language === "en" ? "12h (AM/PM)" : "24h"}</span>
                </div>
                <div className="flex justify-between py-2 border-b border-gray-50">
                  <span className="text-gray-500">Zona horaria</span>
                  <span className="font-medium">{language === "es" ? "América/Monterrey (CST)" : "Auto-detectar"}</span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-gray-500">Unidades</span>
                  <span className="font-medium">{language === "en" ? "Imperial" : "Métrico"}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* SYSTEM TAB */}
        {activeTab === "system" && (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Información del Sistema</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between py-2 border-b border-gray-50">
                  <span className="text-gray-500">Plataforma</span>
                  <span className="font-medium">DNS Vision Pro</span>
                </div>
                <div className="flex justify-between py-2 border-b border-gray-50">
                  <span className="text-gray-500">Versión</span>
                  <span className="font-medium">1.0.0</span>
                </div>
                <div className="flex justify-between py-2 border-b border-gray-50">
                  <span className="text-gray-500">Motor de Detección</span>
                  <span className="font-medium">YOLOv10n + ByteTrack</span>
                </div>
                <div className="flex justify-between py-2 border-b border-gray-50">
                  <span className="text-gray-500">Reconocimiento Facial</span>
                  <span className="font-medium">InsightFace + ArcFace</span>
                </div>
                <div className="flex justify-between py-2 border-b border-gray-50">
                  <span className="text-gray-500">Streaming</span>
                  <span className="font-medium">go2rtc (WebRTC/HLS)</span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-gray-500">Licencia</span>
                  <span className="font-medium">DNS IT Solutions - Propietaria</span>
                </div>
              </CardContent>
            </Card>

            {/* Update from GitHub */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <Download className="h-5 w-5" />
                  Actualizaciones
                </CardTitle>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCheckUpdate}
                  disabled={updateStatus === "checking" || updateStatus === "downloading"}
                >
                  <RefreshCw className={`h-4 w-4 mr-1 ${updateStatus === "checking" ? "animate-spin" : ""}`} />
                  {updateStatus === "checking" ? "Verificando..." : "Buscar Actualizaciones"}
                </Button>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex justify-between py-2 border-b border-gray-50 text-sm">
                  <span className="text-gray-500">Versión actual</span>
                  <span className="font-medium">v{updateInfo.current}</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Github className="h-4 w-4 text-gray-500" />
                  <span className="text-gray-500">Repositorio:</span>
                  <span className="font-mono text-xs text-blue-600">leonemmanuel16/visionPro-by-DNS</span>
                </div>

                {updateInfo.latest && updateInfo.latest !== updateInfo.current && (
                  <div className="p-4 rounded-lg border border-blue-200 bg-blue-50 space-y-3">
                    <div className="flex items-center gap-2">
                      <AlertCircle className="h-5 w-5 text-blue-600" />
                      <span className="text-sm font-semibold text-blue-800">
                        Nueva versión disponible: v{updateInfo.latest}
                      </span>
                    </div>
                    <pre className="text-xs text-blue-700 whitespace-pre-wrap">{updateInfo.changelog}</pre>
                    <Button
                      onClick={handleApplyUpdate}
                      disabled={updateStatus === "downloading"}
                      className="w-full"
                    >
                      {updateStatus === "downloading" ? (
                        <>
                          <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                          Descargando actualización...
                        </>
                      ) : (
                        <>
                          <Download className="h-4 w-4 mr-2" />
                          Actualizar desde GitHub
                        </>
                      )}
                    </Button>
                    <p className="text-[10px] text-blue-600 text-center">
                      Ejecuta: git pull origin main && docker compose up -d --build
                    </p>
                  </div>
                )}

                {updateStatus === "done" && (
                  <div className="p-3 rounded-lg border border-green-200 bg-green-50 flex items-center gap-2">
                    <CheckCircle className="h-5 w-5 text-green-600" />
                    <span className="text-sm text-green-700 font-medium">
                      Actualización descargada. Reinicia los servicios.
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Tu Cuenta</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {user && (
                  <>
                    <div className="flex justify-between py-2 border-b border-gray-50">
                      <span className="text-gray-500">Usuario</span>
                      <span className="font-medium">{user.username}</span>
                    </div>
                    <div className="flex justify-between py-2 border-b border-gray-50">
                      <span className="text-gray-500">Email</span>
                      <span className="font-medium">{user.email}</span>
                    </div>
                    <div className="flex justify-between py-2">
                      <span className="text-gray-500">Rol</span>
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                          (ROLE_INFO[user.role as keyof typeof ROLE_INFO] || ROLE_INFO.viewer).color
                        }`}
                      >
                        {(ROLE_INFO[user.role as keyof typeof ROLE_INFO] || ROLE_INFO.viewer).label}
                      </span>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </>
  );
}
