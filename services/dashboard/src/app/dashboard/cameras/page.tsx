"use client";

import { useEffect, useState } from "react";
import { Grid2X2, Grid3X3, Scan, Plus, RefreshCw } from "lucide-react";
import { Header } from "@/components/Header";
import { CameraGrid } from "@/components/CameraGrid";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

interface Camera {
  id: string;
  name: string;
  ip_address: string;
  is_online: boolean;
  is_enabled: boolean;
  location?: string;
  manufacturer?: string;
  model?: string;
}

export default function CamerasPage() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [gridSize, setGridSize] = useState<2 | 3 | 4>(3);
  const [discovering, setDiscovering] = useState(false);

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
      setTimeout(loadCameras, 10000); // Reload after 10s
    } catch (e) {
      console.error("Discovery failed:", e);
    } finally {
      setTimeout(() => setDiscovering(false), 10000);
    }
  };

  return (
    <>
      <Header title="Cameras" />
      <div className="p-6">
        {/* Toolbar */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Button
              variant={gridSize === 2 ? "default" : "outline"}
              size="sm"
              onClick={() => setGridSize(2)}
            >
              <Grid2X2 className="h-4 w-4 mr-1" /> 2x2
            </Button>
            <Button
              variant={gridSize === 3 ? "default" : "outline"}
              size="sm"
              onClick={() => setGridSize(3)}
            >
              <Grid3X3 className="h-4 w-4 mr-1" /> 3x3
            </Button>
            <Button
              variant={gridSize === 4 ? "default" : "outline"}
              size="sm"
              onClick={() => setGridSize(4)}
            >
              4x4
            </Button>
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
              {discovering ? "Discovering..." : "Discover"}
            </Button>
          </div>
        </div>

        {cameras.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-slate-500">
            <Scan className="h-12 w-12 mb-4" />
            <p className="text-lg font-medium">No cameras found</p>
            <p className="text-sm mt-1">Click "Discover" to find ONVIF cameras on your network</p>
          </div>
        ) : (
          <CameraGrid cameras={cameras} gridSize={gridSize} />
        )}
      </div>
    </>
  );
}
