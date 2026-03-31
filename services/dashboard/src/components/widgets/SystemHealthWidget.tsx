"use client";

import { useEffect, useState } from "react";
import { Cpu, HardDrive, Thermometer, MemoryStick } from "lucide-react";
import { api } from "@/lib/api";

interface HealthMetrics {
  cpu_percent: number;
  ram_percent: number;
  ram_used_gb: number;
  ram_total_gb: number;
  disk_percent: number;
  disk_used_gb: number;
  disk_total_gb: number;
  gpu_utilization?: number;
  gpu_temperature?: number;
  gpu_memory_used_mb?: number;
  gpu_memory_total_mb?: number;
  gpu_name?: string;
}

function CircularGauge({ value, label, color, size = 64 }: { value: number; label: string; color: string; size?: number }) {
  const radius = (size - 8) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - value / 100);
  const isWarning = value > 80;
  const isCritical = value > 90;
  const strokeColor = isCritical ? "#ef4444" : isWarning ? "#f59e0b" : color;

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#f3f4f6" strokeWidth={4} />
          <circle
            cx={size / 2} cy={size / 2} r={radius} fill="none"
            stroke={strokeColor} strokeWidth={4} strokeLinecap="round"
            strokeDasharray={circumference} strokeDashoffset={strokeDashoffset}
            className="transition-all duration-500"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-sm font-bold text-gray-900">{Math.round(value)}%</span>
        </div>
      </div>
      <span className="text-[10px] text-gray-500 font-medium">{label}</span>
    </div>
  );
}

export function SystemHealthWidget() {
  const [metrics, setMetrics] = useState<HealthMetrics | null>(null);

  useEffect(() => {
    const fetch = () => api.get<HealthMetrics>("/system/health-metrics").then(setMetrics).catch(() => {});
    fetch();
    const interval = setInterval(fetch, 5000);
    return () => clearInterval(interval);
  }, []);

  if (!metrics) {
    return <p className="text-sm text-gray-400 py-6 text-center">Cargando metricas...</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-around">
        <CircularGauge value={metrics.cpu_percent} label="CPU" color="#3b82f6" />
        <CircularGauge value={metrics.ram_percent} label="RAM" color="#8b5cf6" />
        <CircularGauge value={metrics.disk_percent} label="Disco" color="#f59e0b" />
        {metrics.gpu_utilization != null && (
          <CircularGauge value={metrics.gpu_utilization} label="GPU" color="#10b981" />
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex items-center gap-2 p-2 rounded bg-gray-50">
          <MemoryStick className="h-3.5 w-3.5 text-purple-500" />
          <span className="text-gray-600">RAM: {metrics.ram_used_gb?.toFixed(1)}/{metrics.ram_total_gb?.toFixed(0)} GB</span>
        </div>
        <div className="flex items-center gap-2 p-2 rounded bg-gray-50">
          <HardDrive className="h-3.5 w-3.5 text-amber-500" />
          <span className="text-gray-600">Disco: {metrics.disk_used_gb?.toFixed(0)}/{metrics.disk_total_gb?.toFixed(0)} GB</span>
        </div>
        {metrics.gpu_temperature != null && (
          <div className="flex items-center gap-2 p-2 rounded bg-gray-50">
            <Thermometer className="h-3.5 w-3.5 text-red-500" />
            <span className="text-gray-600">GPU Temp: {metrics.gpu_temperature}C</span>
          </div>
        )}
        {metrics.gpu_memory_used_mb != null && (
          <div className="flex items-center gap-2 p-2 rounded bg-gray-50">
            <Cpu className="h-3.5 w-3.5 text-green-500" />
            <span className="text-gray-600">VRAM: {(metrics.gpu_memory_used_mb / 1024).toFixed(1)}/{(metrics.gpu_memory_total_mb! / 1024).toFixed(0)} GB</span>
          </div>
        )}
      </div>
    </div>
  );
}
