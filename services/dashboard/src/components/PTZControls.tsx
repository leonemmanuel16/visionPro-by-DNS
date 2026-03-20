"use client";

import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Plus, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

interface PTZControlsProps {
  cameraId: string;
}

export function PTZControls({ cameraId }: PTZControlsProps) {
  const sendPTZ = async (pan: number, tilt: number, zoom: number) => {
    try {
      await api.post(`/cameras/${cameraId}/ptz`, { pan, tilt, zoom });
    } catch (e) {
      console.error("PTZ command failed:", e);
    }
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <p className="text-sm text-slate-400 mb-1">PTZ Controls</p>
      <div className="grid grid-cols-3 gap-1">
        <div />
        <Button variant="outline" size="icon" onClick={() => sendPTZ(0, 0.5, 0)}>
          <ArrowUp className="h-4 w-4" />
        </Button>
        <div />
        <Button variant="outline" size="icon" onClick={() => sendPTZ(-0.5, 0, 0)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="h-9 w-9" />
        <Button variant="outline" size="icon" onClick={() => sendPTZ(0.5, 0, 0)}>
          <ArrowRight className="h-4 w-4" />
        </Button>
        <div />
        <Button variant="outline" size="icon" onClick={() => sendPTZ(0, -0.5, 0)}>
          <ArrowDown className="h-4 w-4" />
        </Button>
        <div />
      </div>
      <div className="flex gap-2 mt-2">
        <Button variant="outline" size="sm" onClick={() => sendPTZ(0, 0, 0.5)}>
          <Plus className="h-4 w-4 mr-1" /> Zoom
        </Button>
        <Button variant="outline" size="sm" onClick={() => sendPTZ(0, 0, -0.5)}>
          <Minus className="h-4 w-4 mr-1" /> Zoom
        </Button>
      </div>
    </div>
  );
}
