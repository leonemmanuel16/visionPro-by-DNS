// Demo data returned when API is unreachable (demo mode)

export const DEMO_CAMERAS = [
  {
    id: "cam-001",
    name: "Cámara 1",
    ip_address: "192.168.8.26",
    is_online: true,
    is_enabled: true,
    location: "Oficina DNS",
    manufacturer: "",
    model: "",
    port: 80,
    username: "dns",
  },
  {
    id: "cam-002",
    name: "Cámara 2 (Fisheye)",
    ip_address: "192.168.8.64",
    is_online: true,
    is_enabled: true,
    location: "Oficina DNS",
    manufacturer: "",
    model: "",
    port: 80,
    username: "dns",
    camera_type: "fisheye",
  },
];

const now = new Date();
function hoursAgo(h: number) {
  return new Date(now.getTime() - h * 3600000).toISOString();
}

export const DEMO_EVENTS = [
  {
    id: "evt-001",
    camera_id: "cam-001",
    camera_name: "Cámara 1",
    event_type: "person_detected",
    label: "person",
    confidence: 0.94,
    snapshot_path: "",
    thumbnail_path: "",
    occurred_at: hoursAgo(0.1),
  },
  {
    id: "evt-002",
    camera_id: "cam-002",
    camera_name: "Cámara 2",
    event_type: "person_detected",
    label: "person",
    confidence: 0.89,
    snapshot_path: "",
    thumbnail_path: "",
    occurred_at: hoursAgo(0.5),
  },
  {
    id: "evt-003",
    camera_id: "cam-001",
    camera_name: "Cámara 1",
    event_type: "motion_detected",
    label: "motion",
    confidence: 0.91,
    snapshot_path: "",
    thumbnail_path: "",
    occurred_at: hoursAgo(1.2),
  },
  {
    id: "evt-004",
    camera_id: "cam-002",
    camera_name: "Cámara 2",
    event_type: "motion_detected",
    label: "motion",
    confidence: 0.78,
    snapshot_path: "",
    thumbnail_path: "",
    occurred_at: hoursAgo(2.5),
  },
];

export const DEMO_STATS = {
  total_cameras: 2,
  online_cameras: 2,
  events_today: 47,
  events_this_week: 312,
};

export const DEMO_ACTIVITY = Array.from({ length: 24 }, (_, i) => ({
  hour: `${String(i).padStart(2, "0")}:00`,
  count: Math.floor(Math.random() * 15) + (i >= 8 && i <= 18 ? 10 : 2),
}));

// Route-based demo data lookup
export function getDemoData(path: string): unknown | null {
  if (path === "/dashboard/stats") return DEMO_STATS;
  if (path === "/dashboard/recent") return DEMO_EVENTS;
  if (path === "/dashboard/activity") return DEMO_ACTIVITY;
  if (path === "/cameras") return DEMO_CAMERAS;
  if (path.startsWith("/cameras/")) {
    const id = path.split("/")[2];
    return DEMO_CAMERAS.find((c) => c.id === id) || null;
  }
  if (path === "/events") return DEMO_EVENTS;
  if (path === "/alerts") return [];
  return null;
}
