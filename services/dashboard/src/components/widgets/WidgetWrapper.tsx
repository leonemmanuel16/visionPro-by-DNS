"use client";

import { GripVertical, X, Maximize2, Minimize2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useState } from "react";

interface WidgetWrapperProps {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  onRemove?: () => void;
  isDragging?: boolean;
  dragHandleProps?: {
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: (e: React.DragEvent) => void;
    draggable: boolean;
  };
  className?: string;
  expandable?: boolean;
}

export function WidgetWrapper({
  title,
  icon,
  children,
  onRemove,
  isDragging,
  dragHandleProps,
  className = "",
  expandable = false,
}: WidgetWrapperProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card
      className={`relative group transition-all duration-200 ${
        isDragging ? "opacity-50 ring-2 ring-blue-400 scale-[0.98]" : ""
      } ${expanded ? "col-span-full" : ""} ${className}`}
    >
      <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2">
          {dragHandleProps && (
            <div
              {...dragHandleProps}
              className="cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500 transition-colors"
            >
              <GripVertical className="h-4 w-4" />
            </div>
          )}
          {icon && <span className="text-blue-600">{icon}</span>}
          <CardTitle className="text-sm font-semibold text-gray-900">{title}</CardTitle>
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {expandable && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100 transition-colors"
              title={expanded ? "Minimizar" : "Expandir"}
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
          )}
          {onRemove && (
            <button
              onClick={onRemove}
              className="p-1 text-gray-400 hover:text-red-500 rounded hover:bg-red-50 transition-colors"
              title="Quitar widget"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">{children}</CardContent>
    </Card>
  );
}
