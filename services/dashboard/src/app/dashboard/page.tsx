"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  LayoutDashboard,
  Plus,
  RotateCcw,
  Camera,
  Activity,
  BarChart3,
  HeartPulse,
  Zap,
  PieChart,
  Bell,
  GripVertical,
  Check,
} from "lucide-react";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { WidgetWrapper } from "@/components/widgets/WidgetWrapper";
import { StatsWidget } from "@/components/widgets/StatsWidget";
import { RecentEventsWidget } from "@/components/widgets/RecentEventsWidget";
import { ActivityChartWidget } from "@/components/widgets/ActivityChartWidget";
import { CameraPreviewWidget } from "@/components/widgets/CameraPreviewWidget";
import { SystemHealthWidget } from "@/components/widgets/SystemHealthWidget";
import { QuickActionsWidget } from "@/components/widgets/QuickActionsWidget";
import { DetectionStatsWidget } from "@/components/widgets/DetectionStatsWidget";

// ── Widget Registry ──
interface WidgetDef {
  id: string;
  label: string;
  icon: any;
  size: "small" | "medium" | "large" | "full";
  component: React.ComponentType;
  expandable?: boolean;
}

const WIDGET_REGISTRY: WidgetDef[] = [
  { id: "stats", label: "Estadisticas", icon: BarChart3, size: "full", component: StatsWidget },
  { id: "cameras", label: "Camaras en Vivo", icon: Camera, size: "large", component: CameraPreviewWidget, expandable: true },
  { id: "events", label: "Eventos Recientes", icon: Bell, size: "medium", component: RecentEventsWidget, expandable: true },
  { id: "activity", label: "Actividad 24h", icon: Activity, size: "medium", component: ActivityChartWidget },
  { id: "health", label: "Salud del Sistema", icon: HeartPulse, size: "medium", component: SystemHealthWidget },
  { id: "quick_actions", label: "Acceso Rapido", icon: Zap, size: "small", component: QuickActionsWidget },
  { id: "detection_stats", label: "Detecciones por Tipo", icon: PieChart, size: "medium", component: DetectionStatsWidget },
];

const DEFAULT_LAYOUT = ["stats", "cameras", "events", "activity", "health", "quick_actions"];
const STORAGE_KEY = "dashboard_layout_v2";

function loadLayout(): string[] {
  if (typeof window === "undefined") return DEFAULT_LAYOUT;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return DEFAULT_LAYOUT;
}

function saveLayout(layout: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {}
}

// ── Size to grid class mapping ──
function sizeToClass(size: string): string {
  switch (size) {
    case "full": return "col-span-full";
    case "large": return "col-span-full lg:col-span-2";
    case "medium": return "col-span-full md:col-span-1";
    case "small": return "col-span-full md:col-span-1";
    default: return "col-span-full md:col-span-1";
  }
}

export default function DashboardPage() {
  const [layout, setLayout] = useState<string[]>(DEFAULT_LAYOUT);
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const initialized = useRef(false);

  // Load layout from localStorage on mount
  useEffect(() => {
    if (!initialized.current) {
      setLayout(loadLayout());
      initialized.current = true;
    }
  }, []);

  // Save on change (skip initial)
  useEffect(() => {
    if (initialized.current) {
      saveLayout(layout);
    }
  }, [layout]);

  const removeWidget = useCallback((widgetId: string) => {
    setLayout((prev) => prev.filter((id) => id !== widgetId));
  }, []);

  const addWidget = useCallback((widgetId: string) => {
    setLayout((prev) => {
      if (prev.includes(widgetId)) return prev;
      return [...prev, widgetId];
    });
  }, []);

  const resetLayout = useCallback(() => {
    setLayout([...DEFAULT_LAYOUT]);
    setShowAddPanel(false);
    setIsEditing(false);
  }, []);

  // ── Drag & Drop ──
  const handleDragStart = (idx: number) => (e: React.DragEvent) => {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(idx));
  };

  const handleDragEnd = () => {
    setDragIdx(null);
    setDragOverIdx(null);
  };

  const handleDragOver = (idx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIdx(idx);
  };

  const handleDrop = (dropIdx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    const fromIdx = dragIdx;
    if (fromIdx === null || fromIdx === dropIdx) return;
    setLayout((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(dropIdx, 0, moved);
      return next;
    });
    setDragIdx(null);
    setDragOverIdx(null);
  };

  const availableWidgets = WIDGET_REGISTRY.filter((w) => !layout.includes(w.id));

  return (
    <>
      <Header title="Dashboard" />
      <div className="p-6 space-y-4">
        {/* Toolbar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <LayoutDashboard className="h-5 w-5 text-blue-600" />
            <span className="text-sm text-gray-500">{layout.length} widgets activos</span>
          </div>
          <div className="flex items-center gap-2">
            {isEditing ? (
              <Button size="sm" onClick={() => setIsEditing(false)}>
                <Check className="h-4 w-4 mr-1" /> Listo
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setIsEditing(true)}>
                <GripVertical className="h-4 w-4 mr-1" /> Editar
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowAddPanel(!showAddPanel)}
              disabled={availableWidgets.length === 0}
            >
              <Plus className="h-4 w-4 mr-1" /> Agregar
            </Button>
            <Button size="sm" variant="outline" onClick={resetLayout}>
              <RotateCcw className="h-4 w-4 mr-1" /> Resetear
            </Button>
          </div>
        </div>

        {/* Add Widget Panel */}
        {showAddPanel && availableWidgets.length > 0 && (
          <div className="border border-dashed border-blue-300 bg-blue-50 rounded-lg p-4">
            <p className="text-xs text-blue-700 font-medium mb-3">Widgets disponibles — haz clic para agregar:</p>
            <div className="flex flex-wrap gap-2">
              {availableWidgets.map((w) => (
                <button
                  key={w.id}
                  onClick={() => {
                    addWidget(w.id);
                    if (availableWidgets.length <= 1) setShowAddPanel(false);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-white border border-blue-200 rounded-lg hover:border-blue-400 hover:bg-blue-50 transition-colors text-sm"
                >
                  <w.icon className="h-4 w-4 text-blue-600" />
                  <span className="text-gray-700">{w.label}</span>
                  <Plus className="h-3 w-3 text-blue-500" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Widget Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {layout.map((widgetId, idx) => {
            const def = WIDGET_REGISTRY.find((w) => w.id === widgetId);
            if (!def) return null;
            const Widget = def.component;
            const isDragging = dragIdx === idx;
            const isDragOver = dragOverIdx === idx && dragIdx !== idx;

            return (
              <div
                key={widgetId}
                className={`${sizeToClass(def.size)} ${
                  isDragOver ? "ring-2 ring-blue-400 ring-offset-2 rounded-lg" : ""
                } transition-all duration-150`}
                onDragOver={isEditing ? handleDragOver(idx) : undefined}
                onDrop={isEditing ? handleDrop(idx) : undefined}
              >
                <WidgetWrapper
                  title={def.label}
                  icon={<def.icon className="h-4 w-4" />}
                  onRemove={isEditing ? () => removeWidget(widgetId) : undefined}
                  isDragging={isDragging}
                  expandable={def.expandable}
                  dragHandleProps={
                    isEditing
                      ? {
                          draggable: true,
                          onDragStart: handleDragStart(idx),
                          onDragEnd: handleDragEnd,
                        }
                      : undefined
                  }
                >
                  <Widget />
                </WidgetWrapper>
              </div>
            );
          })}
        </div>

        {/* Empty state */}
        {layout.length === 0 && (
          <div className="text-center py-16 text-gray-400">
            <LayoutDashboard className="h-12 w-12 mx-auto mb-3 opacity-40" />
            <p className="text-sm font-medium">Dashboard vacio</p>
            <p className="text-xs mt-1">Haz clic en "Agregar" para agregar widgets</p>
            <Button size="sm" variant="outline" className="mt-4" onClick={resetLayout}>
              <RotateCcw className="h-4 w-4 mr-1" /> Restaurar por defecto
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
