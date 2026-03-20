"use client";

import { useEffect, useState } from "react";
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
  has_ptz: boolean;
}

export function useCameras() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setLoading(true);
      const data = await api.get<Camera[]>("/cameras");
      setCameras(data);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return { cameras, loading, error, refresh: load };
}
