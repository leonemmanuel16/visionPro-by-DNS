"use client";

import { useEffect, useState } from "react";
import { Header } from "@/components/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { Plus, Trash2, Bell } from "lucide-react";

interface AlertRule {
  id: string;
  name: string;
  camera_id: string | null;
  event_types: string[];
  channel: string;
  target: string;
  cooldown_seconds: number;
  is_enabled: boolean;
  last_triggered_at: string | null;
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<AlertRule[]>([]);
  const [creating, setCreating] = useState(false);
  const [cameras, setCameras] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({
    name: "",
    camera_id: "",
    event_types: ["person"],
    channel: "webhook",
    target: "",
    cooldown_seconds: 60,
  });

  useEffect(() => {
    api.get<AlertRule[]>("/alerts").then(setAlerts).catch(console.error);
    api.get<{ id: string; name: string }[]>("/cameras").then(setCameras).catch(console.error);
  }, []);

  const handleCreate = async () => {
    try {
      await api.post("/alerts", {
        ...form,
        camera_id: form.camera_id || null,
      });
      setCreating(false);
      setAlerts(await api.get<AlertRule[]>("/alerts"));
    } catch (e) {
      console.error("Failed to create alert:", e);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.del(`/alerts/${id}`);
      setAlerts(alerts.filter((a) => a.id !== id));
    } catch (e) {
      console.error("Failed to delete alert:", e);
    }
  };

  return (
    <>
      <Header title="Alerts" />
      <div className="p-6 space-y-6">
        {creating ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Create Alert Rule</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input
                placeholder="Rule name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <select
                  className="rounded-md border border-gray-300 bg-gray-100 px-3 py-2 text-sm text-gray-700"
                  value={form.camera_id}
                  onChange={(e) => setForm({ ...form, camera_id: e.target.value })}
                >
                  <option value="">All Cameras</option>
                  {cameras.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <select
                  className="rounded-md border border-gray-300 bg-gray-100 px-3 py-2 text-sm text-gray-700"
                  value={form.channel}
                  onChange={(e) => setForm({ ...form, channel: e.target.value })}
                >
                  <option value="webhook">Webhook</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="email">Email</option>
                </select>
              </div>
              <Input
                placeholder={form.channel === "whatsapp" ? "Phone number" : form.channel === "email" ? "Email address" : "Webhook URL"}
                value={form.target}
                onChange={(e) => setForm({ ...form, target: e.target.value })}
              />
              <Input
                type="number"
                placeholder="Cooldown (seconds)"
                value={form.cooldown_seconds}
                onChange={(e) => setForm({ ...form, cooldown_seconds: parseInt(e.target.value) || 60 })}
              />
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
                <Button onClick={handleCreate}>Create Rule</Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4 mr-1" /> Create Alert Rule
          </Button>
        )}

        <div className="space-y-3">
          {alerts.length === 0 && !creating ? (
            <div className="flex flex-col items-center py-10 text-gray-400">
              <Bell className="h-12 w-12 mb-4" />
              <p>No alert rules configured</p>
            </div>
          ) : (
            alerts.map((alert) => (
              <Card key={alert.id}>
                <CardContent className="flex items-center justify-between p-4">
                  <div>
                    <p className="font-medium text-gray-900">{alert.name}</p>
                    <p className="text-sm text-gray-500">
                      {alert.channel.toUpperCase()} → {alert.target}
                    </p>
                    <div className="flex gap-1 mt-1">
                      {alert.event_types.map((t) => (
                        <Badge key={t} variant="secondary">{t}</Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={alert.is_enabled ? "success" : "secondary"}>
                      {alert.is_enabled ? "Active" : "Disabled"}
                    </Badge>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(alert.id)}>
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
