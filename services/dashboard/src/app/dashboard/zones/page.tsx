"use client";

import { useEffect, useState } from "react";
import { Header } from "@/components/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ZoneEditor } from "@/components/ZoneEditor";
import { api } from "@/lib/api";
import { Plus, Trash2, Edit } from "lucide-react";

interface Zone {
  id: string;
  camera_id: string;
  name: string;
  zone_type: string;
  points: { x: number; y: number }[];
  detect_classes: string[];
  is_enabled: boolean;
}

interface CameraOption {
  id: string;
  name: string;
}

export default function ZonesPage() {
  const [zones, setZones] = useState<Zone[]>([]);
  const [cameras, setCameras] = useState<CameraOption[]>([]);
  const [editing, setEditing] = useState(false);
  const [newZone, setNewZone] = useState({ name: "", camera_id: "", zone_type: "roi" });

  useEffect(() => {
    api.get<Zone[]>("/zones").then(setZones).catch(console.error);
    api.get<CameraOption[]>("/cameras").then(setCameras).catch(console.error);
  }, []);

  const handleSaveZone = async (points: { x: number; y: number }[]) => {
    try {
      await api.post("/zones", {
        ...newZone,
        points,
        detect_classes: ["person", "vehicle"],
      });
      setEditing(false);
      const data = await api.get<Zone[]>("/zones");
      setZones(data);
    } catch (e) {
      console.error("Failed to save zone:", e);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.del(`/zones/${id}`);
      setZones(zones.filter((z) => z.id !== id));
    } catch (e) {
      console.error("Failed to delete zone:", e);
    }
  };

  const getCameraName = (id: string) => cameras.find((c) => c.id === id)?.name || "Unknown";

  return (
    <>
      <Header title="Zones" />
      <div className="p-6 space-y-6">
        {editing ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Create Zone</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Input
                  placeholder="Zone name"
                  value={newZone.name}
                  onChange={(e) => setNewZone({ ...newZone, name: e.target.value })}
                />
                <select
                  className="rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200"
                  value={newZone.camera_id}
                  onChange={(e) => setNewZone({ ...newZone, camera_id: e.target.value })}
                >
                  <option value="">Select Camera</option>
                  {cameras.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <select
                  className="rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200"
                  value={newZone.zone_type}
                  onChange={(e) => setNewZone({ ...newZone, zone_type: e.target.value })}
                >
                  <option value="roi">Region of Interest (ROI)</option>
                  <option value="tripwire">Tripwire</option>
                  <option value="perimeter">Perimeter</option>
                </select>
              </div>
              <ZoneEditor
                onSave={handleSaveZone}
                onCancel={() => setEditing(false)}
              />
            </CardContent>
          </Card>
        ) : (
          <Button onClick={() => setEditing(true)}>
            <Plus className="h-4 w-4 mr-1" /> Create Zone
          </Button>
        )}

        {/* Zone list */}
        <div className="space-y-3">
          {zones.length === 0 && !editing ? (
            <p className="py-10 text-center text-slate-500">No zones configured</p>
          ) : (
            zones.map((zone) => (
              <Card key={zone.id}>
                <CardContent className="flex items-center justify-between p-4">
                  <div>
                    <p className="font-medium text-white">{zone.name}</p>
                    <p className="text-sm text-slate-400">
                      {getCameraName(zone.camera_id)} — {zone.zone_type.toUpperCase()} — {zone.points.length} points
                    </p>
                    <div className="flex gap-1 mt-1">
                      {zone.detect_classes?.map((cls) => (
                        <Badge key={cls} variant="secondary">{cls}</Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={zone.is_enabled ? "success" : "secondary"}>
                      {zone.is_enabled ? "Active" : "Disabled"}
                    </Badge>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(zone.id)}>
                      <Trash2 className="h-4 w-4 text-red-400" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>
    </>
  );
}
