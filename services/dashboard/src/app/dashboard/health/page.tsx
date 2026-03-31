"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Header } from "@/components/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import {
  Cpu,
  MemoryStick,
  HardDrive,
  Thermometer,
  Activity,
  Zap,
  AlertTriangle,
  RefreshCw,
  CheckCircle,
  XCircle,
  Gauge,
  Fan,
  Clock,
  Server,
  BellRing,
  Trash2,
  Settings,
  Save,
} from "lucide-react";

/* ── Types ─────────────────────────────────────────────────── */

interface GpuInfo {
  name: string;
  gpu_util: number;
  mem_used_mb: number;
  mem_total_mb: number;
  mem_percent: number;
  temperature: number;
  fan_speed: number;
  power_draw_w: number;
  power_limit_w: number;
  available: boolean;
}

interface DiskInfo {
  device: string;
  mountpoint: string;
  total_gb: number;
  used_gb: number;
  free_gb: number;
  percent: number;
}

interface HealthAlert {
  key: string;
  label: string;
  value: number;
  threshold: number;
  unit: string;
  severity: string;
  message: string;
  timestamp: string;
}

interface HealthMetrics {
  timestamp: string;
  cpu_percent: number;
  cpu_count: number;
  cpu_count_logical: number;
  cpu_freq_mhz: number;
  cpu_per_core: number[];
  ram_total_gb: number;
  ram_used_gb: number;
  ram_available_gb: number;
  ram_percent: number;
  swap_total_gb: number;
  swap_used_gb: number;
  swap_percent: number;
  gpu: GpuInfo;
  disks: DiskInfo[];
  uptime_seconds: number;
  load_avg: number[];
  alerts: HealthAlert[];
}

interface Thresholds {
  cpu_percent: number;
  ram_percent: number;
  gpu_percent: number;
  gpu_temp_c: number;
  gpu_mem_percent: number;
  disk_percent: number;
}

/* ── Gauge Component ───────────────────────────────────────── */

function CircularGauge({
  value,
  max = 100,
  label,
  unit = "%",
  size = 140,
  thresholdWarning = 70,
  thresholdCritical = 90,
  icon: Icon,
  subtitle,
}: {
  value: number;
  max?: number;
  label: string;
  unit?: string;
  size?: number;
  thresholdWarning?: number;
  thresholdCritical?: number;
  icon?: any;
  subtitle?: string;
}) {
  const pct = Math.min((value / max) * 100, 100);
  const radius = (size - 16) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (pct / 100) * circumference;

  let color = "text-green-500";
  let strokeColor = "#22c55e";
  let bgRing = "#e5e7eb";
  if (pct >= thresholdCritical) {
    color = "text-red-500";
    strokeColor = "#ef4444";
  } else if (pct >= thresholdWarning) {
    color = "text-amber-500";
    strokeColor = "#f59e0b";
  }

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          {/* Background ring */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={bgRing}
            strokeWidth={8}
          />
          {/* Value ring */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={strokeColor}
            strokeWidth={8}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            className="transition-all duration-700 ease-out"
          />
        </svg>
        {/* Center text */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {Icon && <Icon className={`h-4 w-4 mb-0.5 ${color}`} />}
          <span className={`text-xl font-bold ${color}`}>
            {Math.round(value)}
            <span className="text-xs font-normal">{unit}</span>
          </span>
        </div>
      </div>
      <span className="text-sm font-medium text-gray-700 mt-1">{label}</span>
      {subtitle && <span className="text-[11px] text-gray-400">{subtitle}</span>}
    </div>
  );
}

/* ── Mini Bar ──────────────────────────────────────────────── */

function MiniBar({ value, max = 100, color = "blue" }: { value: number; max?: number; color?: string }) {
  const pct = Math.min((value / max) * 100, 100);
  const colors: Record<string, string> = {
    blue: "bg-blue-500",
    green: "bg-green-500",
    amber: "bg-amber-500",
    red: "bg-red-500",
    purple: "bg-purple-500",
  };
  const barColor = pct > 90 ? "bg-red-500" : pct > 70 ? "bg-amber-500" : (colors[color] || "bg-blue-500");

  return (
    <div className="w-full bg-gray-200 rounded-full h-2">
      <div
        className={`h-2 rounded-full transition-all duration-500 ${barColor}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* ── Uptime formatter ──────────────────────────────────────── */

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/* ── Main Page ─────────────────────────────────────────────── */

export default function HealthPage() {
  const [metrics, setMetrics] = useState<HealthMetrics | null>(null);
  const [history, setHistory] = useState<HealthMetrics[]>([]);
  const [alertHistory, setAlertHistory] = useState<HealthAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(5); // seconds
  const [showThresholds, setShowThresholds] = useState(false);
  const [thresholds, setThresholds] = useState<Thresholds>({
    cpu_percent: 90,
    ram_percent: 90,
    gpu_percent: 95,
    gpu_temp_c: 85,
    gpu_mem_percent: 90,
    disk_percent: 90,
  });
  const [savingThresholds, setSavingThresholds] = useState(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchMetrics = useCallback(async () => {
    try {
      const data = await api.get<HealthMetrics>("/system/health-metrics");
      setMetrics(data);
      setHistory((prev) => [...prev.slice(-59), data]); // Keep last 60 samples
      setError(null);
    } catch (e: any) {
      setError("No se pudo conectar al servidor");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchAlerts = useCallback(async () => {
    try {
      const data = await api.get<{ alerts: HealthAlert[]; count: number }>("/system/health-alerts");
      setAlertHistory(data.alerts || []);
    } catch { /* ignore */ }
  }, []);

  const fetchThresholds = useCallback(async () => {
    try {
      const data = await api.get<Thresholds>("/system/health-thresholds");
      setThresholds(data);
    } catch { /* ignore */ }
  }, []);

  const saveThresholds = async () => {
    setSavingThresholds(true);
    try {
      await api.post("/system/health-thresholds", thresholds);
    } catch { /* ignore */ }
    setSavingThresholds(false);
  };

  const clearAlerts = async () => {
    try {
      await api.post("/system/health-alerts/clear", {});
      setAlertHistory([]);
    } catch { /* ignore */ }
  };

  // Initial load
  useEffect(() => {
    fetchMetrics();
    fetchAlerts();
    fetchThresholds();
  }, [fetchMetrics, fetchAlerts, fetchThresholds]);

  // Auto-refresh
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(() => {
        fetchMetrics();
      }, refreshInterval * 1000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, refreshInterval, fetchMetrics]);

  // Reload alerts every 30s
  useEffect(() => {
    const id = setInterval(fetchAlerts, 30000);
    return () => clearInterval(id);
  }, [fetchAlerts]);

  const m = metrics;

  return (
    <>
      <Header title="Salud del Sistema" />
      <div className="p-6 space-y-6">
        {/* Toolbar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Activity className={`h-5 w-5 ${m ? "text-green-500" : "text-gray-300"}`} />
              <span className="text-sm font-medium text-gray-600">
                {m ? "Monitoreo activo" : "Conectando..."}
              </span>
              {m && (
                <Badge variant="secondary" className="text-[10px]">
                  cada {refreshInterval}s
                </Badge>
              )}
            </div>
            {m && (
              <div className="flex items-center gap-1.5 text-xs text-gray-400">
                <Clock className="h-3 w-3" />
                Uptime: {formatUptime(m.uptime_seconds)}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={autoRefresh ? "border-green-300 text-green-700" : ""}
            >
              <RefreshCw className={`h-4 w-4 mr-1 ${autoRefresh ? "animate-spin" : ""}`} style={autoRefresh ? { animationDuration: "3s" } : {}} />
              {autoRefresh ? "Auto" : "Pausado"}
            </Button>
            <select
              value={refreshInterval}
              onChange={(e) => setRefreshInterval(Number(e.target.value))}
              className="text-xs border border-gray-200 rounded-md px-2 py-1.5 bg-white"
            >
              <option value={3}>3s</option>
              <option value={5}>5s</option>
              <option value={10}>10s</option>
              <option value={30}>30s</option>
            </select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { fetchMetrics(); fetchAlerts(); }}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button
              variant={showThresholds ? "default" : "outline"}
              size="sm"
              onClick={() => setShowThresholds(!showThresholds)}
            >
              <Settings className="h-4 w-4 mr-1" />
              Umbrales
            </Button>
          </div>
        </div>

        {/* Active Alerts Banner */}
        {m && m.alerts.length > 0 && (
          <div className="rounded-lg border-2 border-red-300 bg-red-50 p-4 space-y-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-600 animate-pulse" />
              <span className="text-sm font-bold text-red-800">
                {m.alerts.length} alerta{m.alerts.length > 1 ? "s" : ""} activa{m.alerts.length > 1 ? "s" : ""}
              </span>
            </div>
            {m.alerts.map((alert, i) => (
              <div key={i} className="flex items-center gap-2 text-sm text-red-700 ml-7">
                <XCircle className="h-4 w-4 shrink-0" />
                {alert.message}
              </div>
            ))}
          </div>
        )}

        {/* Error State */}
        {error && !m && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-8 text-center">
            <XCircle className="h-12 w-12 text-red-400 mx-auto mb-3" />
            <p className="text-red-700 font-medium">{error}</p>
            <p className="text-red-500 text-sm mt-1">Verifica que el API esté corriendo</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={fetchMetrics}>
              Reintentar
            </Button>
          </div>
        )}

        {/* Loading */}
        {loading && !m && !error && (
          <div className="flex items-center justify-center py-20">
            <RefreshCw className="h-8 w-8 text-blue-500 animate-spin" />
          </div>
        )}

        {/* Thresholds Panel */}
        {showThresholds && (
          <Card className="border-blue-200 bg-blue-50/30">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Settings className="h-5 w-5 text-blue-600" />
                Umbrales de Alerta
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                {[
                  { key: "cpu_percent" as const, label: "CPU %", icon: Cpu },
                  { key: "ram_percent" as const, label: "RAM %", icon: MemoryStick },
                  { key: "gpu_percent" as const, label: "GPU %", icon: Gauge },
                  { key: "gpu_temp_c" as const, label: "GPU Temp °C", icon: Thermometer },
                  { key: "gpu_mem_percent" as const, label: "GPU Mem %", icon: MemoryStick },
                  { key: "disk_percent" as const, label: "Disco %", icon: HardDrive },
                ].map(({ key, label, icon: TIcon }) => (
                  <div key={key} className="space-y-1">
                    <label className="flex items-center gap-1 text-xs font-medium text-gray-600">
                      <TIcon className="h-3 w-3" />
                      {label}
                    </label>
                    <input
                      type="number"
                      min={50}
                      max={100}
                      value={thresholds[key]}
                      onChange={(e) => setThresholds({ ...thresholds, [key]: Number(e.target.value) })}
                      className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm text-center"
                    />
                  </div>
                ))}
              </div>
              <div className="flex justify-end mt-4">
                <Button size="sm" onClick={saveThresholds} disabled={savingThresholds}>
                  <Save className="h-4 w-4 mr-1" />
                  {savingThresholds ? "Guardando..." : "Guardar Umbrales"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Main Gauges */}
        {m && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {/* CPU Gauge */}
              <Card className="flex flex-col items-center py-5">
                <CircularGauge
                  value={m.cpu_percent}
                  label="CPU"
                  icon={Cpu}
                  subtitle={`${m.cpu_count_logical} núcleos · ${m.cpu_freq_mhz} MHz`}
                  thresholdWarning={thresholds.cpu_percent - 20}
                  thresholdCritical={thresholds.cpu_percent}
                />
              </Card>

              {/* RAM Gauge */}
              <Card className="flex flex-col items-center py-5">
                <CircularGauge
                  value={m.ram_percent}
                  label="Memoria RAM"
                  icon={MemoryStick}
                  subtitle={`${m.ram_used_gb} / ${m.ram_total_gb} GB`}
                  thresholdWarning={thresholds.ram_percent - 20}
                  thresholdCritical={thresholds.ram_percent}
                />
              </Card>

              {/* GPU Gauge */}
              <Card className={`flex flex-col items-center py-5 ${!m.gpu.available ? "opacity-50" : ""}`}>
                {m.gpu.available ? (
                  <CircularGauge
                    value={m.gpu.gpu_util}
                    label="GPU"
                    icon={Zap}
                    subtitle={m.gpu.name}
                    thresholdWarning={thresholds.gpu_percent - 20}
                    thresholdCritical={thresholds.gpu_percent}
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center h-[170px]">
                    <Zap className="h-8 w-8 text-gray-300 mb-2" />
                    <span className="text-sm text-gray-400 font-medium">GPU no detectada</span>
                    <span className="text-[11px] text-gray-300">nvidia-smi no disponible</span>
                  </div>
                )}
              </Card>

              {/* Disk Gauge */}
              <Card className="flex flex-col items-center py-5">
                <CircularGauge
                  value={m.disks[0]?.percent || 0}
                  label="Disco Principal"
                  icon={HardDrive}
                  subtitle={m.disks[0] ? `${m.disks[0].used_gb} / ${m.disks[0].total_gb} GB` : "N/A"}
                  thresholdWarning={thresholds.disk_percent - 20}
                  thresholdCritical={thresholds.disk_percent}
                />
              </Card>
            </div>

            {/* Detail Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* CPU Detail */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-blue-600" />
                    CPU por Núcleo
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {m.cpu_per_core.map((core, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <span className="text-[11px] text-gray-400 w-14 shrink-0">Core {i}</span>
                      <MiniBar value={core} color="blue" />
                      <span className={`text-xs font-mono w-10 text-right ${core > 90 ? "text-red-600 font-bold" : "text-gray-500"}`}>
                        {Math.round(core)}%
                      </span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between text-xs text-gray-400 pt-2 border-t border-gray-100">
                    <span>Load Average: {m.load_avg.join(" / ")}</span>
                    <span>{m.cpu_count} físicos · {m.cpu_count_logical} lógicos</span>
                  </div>
                </CardContent>
              </Card>

              {/* GPU Detail */}
              <Card className={!m.gpu.available ? "opacity-50" : ""}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Zap className="h-4 w-4 text-purple-600" />
                    GPU NVIDIA
                    {m.gpu.available && (
                      <Badge variant="secondary" className="text-[10px] ml-auto">{m.gpu.name}</Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {m.gpu.available ? (
                    <>
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-gray-500 flex items-center gap-1"><Gauge className="h-3 w-3" /> Utilización</span>
                          <span className={`font-mono font-bold ${m.gpu.gpu_util > thresholds.gpu_percent ? "text-red-600" : m.gpu.gpu_util > 70 ? "text-amber-600" : "text-green-600"}`}>
                            {m.gpu.gpu_util}%
                          </span>
                        </div>
                        <MiniBar value={m.gpu.gpu_util} color="purple" />
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-gray-500 flex items-center gap-1"><MemoryStick className="h-3 w-3" /> VRAM</span>
                          <span className="font-mono text-gray-700">{m.gpu.mem_used_mb} / {m.gpu.mem_total_mb} MB</span>
                        </div>
                        <MiniBar value={m.gpu.mem_percent} color="purple" />
                      </div>

                      <div className="grid grid-cols-3 gap-3 pt-2 border-t border-gray-100">
                        <div className="text-center">
                          <Thermometer className={`h-4 w-4 mx-auto mb-1 ${m.gpu.temperature > thresholds.gpu_temp_c ? "text-red-500" : m.gpu.temperature > 70 ? "text-amber-500" : "text-green-500"}`} />
                          <span className={`text-lg font-bold ${m.gpu.temperature > thresholds.gpu_temp_c ? "text-red-600" : m.gpu.temperature > 70 ? "text-amber-600" : "text-gray-800"}`}>
                            {m.gpu.temperature}°C
                          </span>
                          <p className="text-[10px] text-gray-400">Temperatura</p>
                        </div>
                        <div className="text-center">
                          <Fan className="h-4 w-4 mx-auto mb-1 text-blue-400" />
                          <span className="text-lg font-bold text-gray-800">{m.gpu.fan_speed}%</span>
                          <p className="text-[10px] text-gray-400">Ventilador</p>
                        </div>
                        <div className="text-center">
                          <Zap className="h-4 w-4 mx-auto mb-1 text-yellow-500" />
                          <span className="text-lg font-bold text-gray-800">{m.gpu.power_draw_w}W</span>
                          <p className="text-[10px] text-gray-400">/ {m.gpu.power_limit_w}W</p>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="text-center py-4 text-gray-400 text-sm">
                      <Zap className="h-8 w-8 mx-auto mb-2 text-gray-300" />
                      No se detectó GPU NVIDIA.<br />
                      Verifica que nvidia-smi esté disponible.
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* RAM + Swap Detail */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <MemoryStick className="h-4 w-4 text-green-600" />
                    Memoria
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-500">RAM</span>
                      <span className="font-mono text-gray-700">{m.ram_used_gb} / {m.ram_total_gb} GB</span>
                    </div>
                    <MiniBar value={m.ram_percent} color="green" />
                    <div className="flex justify-between text-[11px] text-gray-400">
                      <span>Usada: {m.ram_used_gb} GB</span>
                      <span>Disponible: {m.ram_available_gb} GB</span>
                    </div>
                  </div>
                  <div className="space-y-1 pt-2 border-t border-gray-100">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-500">Swap</span>
                      <span className="font-mono text-gray-700">{m.swap_used_gb} / {m.swap_total_gb} GB</span>
                    </div>
                    <MiniBar value={m.swap_percent} color="amber" />
                  </div>
                </CardContent>
              </Card>

              {/* Disks Detail */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <HardDrive className="h-4 w-4 text-indigo-600" />
                    Almacenamiento
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {m.disks.map((disk, i) => (
                    <div key={i} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-gray-500 font-mono truncate max-w-[200px]" title={disk.device}>
                          {disk.mountpoint}
                        </span>
                        <span className="font-mono text-gray-700">{disk.used_gb} / {disk.total_gb} GB</span>
                      </div>
                      <MiniBar value={disk.percent} />
                      <div className="flex justify-between text-[11px] text-gray-400">
                        <span>{disk.device}</span>
                        <span>Libre: {disk.free_gb} GB</span>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>

            {/* System Summary Bar */}
            <Card className="bg-gray-50">
              <CardContent className="py-3">
                <div className="flex items-center justify-between flex-wrap gap-3 text-xs text-gray-500">
                  <div className="flex items-center gap-1">
                    <Server className="h-3 w-3" />
                    <span>Uptime: <strong className="text-gray-700">{formatUptime(m.uptime_seconds)}</strong></span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Cpu className="h-3 w-3" />
                    <span>{m.cpu_count_logical} cores · {m.cpu_freq_mhz} MHz</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <MemoryStick className="h-3 w-3" />
                    <span>{m.ram_total_gb} GB RAM</span>
                  </div>
                  {m.gpu.available && (
                    <div className="flex items-center gap-1">
                      <Zap className="h-3 w-3" />
                      <span>{m.gpu.name} · {m.gpu.mem_total_mb} MB VRAM</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1">
                    <HardDrive className="h-3 w-3" />
                    <span>{m.disks.reduce((s, d) => s + d.total_gb, 0).toFixed(0)} GB total</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Alert History */}
            <Card>
              <CardHeader className="pb-3 flex flex-row items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <BellRing className="h-4 w-4 text-amber-600" />
                  Historial de Alertas
                  {alertHistory.length > 0 && (
                    <Badge variant="destructive" className="text-[10px]">{alertHistory.length}</Badge>
                  )}
                </CardTitle>
                {alertHistory.length > 0 && (
                  <Button variant="outline" size="sm" onClick={clearAlerts}>
                    <Trash2 className="h-3 w-3 mr-1" />
                    Limpiar
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                {alertHistory.length === 0 ? (
                  <div className="text-center py-6 text-gray-400">
                    <CheckCircle className="h-8 w-8 mx-auto mb-2 text-green-300" />
                    <p className="text-sm">Sin alertas recientes</p>
                    <p className="text-[11px]">El sistema opera dentro de los umbrales configurados</p>
                  </div>
                ) : (
                  <div className="space-y-2 max-h-[300px] overflow-y-auto">
                    {alertHistory.slice(0, 50).map((alert, i) => (
                      <div
                        key={i}
                        className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm ${
                          alert.severity === "critical"
                            ? "bg-red-50 text-red-700 border border-red-200"
                            : "bg-amber-50 text-amber-700 border border-amber-200"
                        }`}
                      >
                        {alert.severity === "critical" ? (
                          <XCircle className="h-4 w-4 shrink-0" />
                        ) : (
                          <AlertTriangle className="h-4 w-4 shrink-0" />
                        )}
                        <span className="flex-1">{alert.message}</span>
                        <span className="text-[10px] opacity-60 shrink-0">
                          {new Date(alert.timestamp).toLocaleTimeString("es-MX")}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
