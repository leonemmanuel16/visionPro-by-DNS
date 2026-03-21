// Demo data returned when API is unreachable (demo mode)

export const DEMO_CAMERAS = [
  {
    id: "cam-001",
    name: "Entrada Principal",
    ip_address: "192.168.1.100",
    is_online: true,
    is_enabled: true,
    location: "Lobby",
    manufacturer: "Hikvision",
    model: "DS-2CD2143G2-I",
  },
  {
    id: "cam-002",
    name: "Estacionamiento Norte",
    ip_address: "192.168.1.101",
    is_online: true,
    is_enabled: true,
    location: "Parking Lot",
    manufacturer: "Dahua",
    model: "IPC-HDBW2431E-S",
  },
  {
    id: "cam-003",
    name: "Oficina Servidores",
    ip_address: "192.168.1.102",
    is_online: true,
    is_enabled: true,
    location: "Server Room",
    manufacturer: "Axis",
    model: "P3245-V",
  },
  {
    id: "cam-004",
    name: "Pasillo Piso 2",
    ip_address: "192.168.1.103",
    is_online: false,
    is_enabled: true,
    location: "2nd Floor Hallway",
    manufacturer: "Hikvision",
    model: "DS-2CD2347G2-LU",
  },
  {
    id: "cam-005",
    name: "Almacén",
    ip_address: "192.168.1.104",
    is_online: true,
    is_enabled: true,
    location: "Warehouse",
    manufacturer: "Dahua",
    model: "IPC-HDW3849H-AS",
  },
  {
    id: "cam-006",
    name: "Recepción",
    ip_address: "192.168.1.105",
    is_online: true,
    is_enabled: false,
    location: "Reception",
    manufacturer: "Axis",
    model: "M3106-L Mk II",
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
    camera_name: "Entrada Principal",
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
    camera_name: "Estacionamiento Norte",
    event_type: "vehicle_detected",
    label: "car",
    confidence: 0.89,
    snapshot_path: "",
    thumbnail_path: "",
    occurred_at: hoursAgo(0.5),
  },
  {
    id: "evt-003",
    camera_id: "cam-001",
    camera_name: "Entrada Principal",
    event_type: "person_detected",
    label: "person",
    confidence: 0.91,
    snapshot_path: "",
    thumbnail_path: "",
    occurred_at: hoursAgo(1.2),
  },
  {
    id: "evt-004",
    camera_id: "cam-005",
    camera_name: "Almacén",
    event_type: "motion_detected",
    label: "person",
    confidence: 0.78,
    snapshot_path: "",
    thumbnail_path: "",
    occurred_at: hoursAgo(2.5),
  },
  {
    id: "evt-005",
    camera_id: "cam-003",
    camera_name: "Oficina Servidores",
    event_type: "person_detected",
    label: "person",
    confidence: 0.96,
    snapshot_path: "",
    thumbnail_path: "",
    occurred_at: hoursAgo(3.8),
  },
  {
    id: "evt-006",
    camera_id: "cam-002",
    camera_name: "Estacionamiento Norte",
    event_type: "vehicle_detected",
    label: "truck",
    confidence: 0.85,
    snapshot_path: "",
    thumbnail_path: "",
    occurred_at: hoursAgo(5),
  },
];

export const DEMO_STATS = {
  total_cameras: 6,
  online_cameras: 5,
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
  return null;
}
