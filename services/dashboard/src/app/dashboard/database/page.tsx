"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { getApiUrl } from "@/lib/urls";
import {
  Plus,
  Upload,
  Search,
  Trash2,
  Edit2,
  X,
  User,
  Users,
  UserPlus,
  Camera,
  Check,
  Image as ImageIcon,
  HelpCircle,
  Clock,
  Eye,
  ZoomIn,
} from "lucide-react";

interface Person {
  id: string;
  name: string;
  role: string;
  department: string;
  photos: string[];
  photoCount: number;
  lastSeen?: string;
  lastCamera?: string;
  status: "active" | "inactive";
  created_at: string;
}

// No demo data — all persons loaded from API

const ROLES = ["Empleado", "Visitante", "Guardia", "Contratista", "Proveedor", "VIP", "Restringido"];
const DEPARTMENTS = [
  "Sistemas",
  "Administración",
  "Seguridad",
  "Ingeniería",
  "Ventas",
  "Recursos Humanos",
  "Dirección",
  "Externo",
];

interface UnknownFace {
  id: string;
  thumbnailColor: string; // fallback color when no thumbnail
  thumbnailPath: string;  // actual MinIO path (e.g. "faces/unknown/...")
  firstSeen: string;
  lastSeen: string;
  camera: string;
  detectionCount: number;
  daysRemaining: number;
}

// No demo data — all unknown faces loaded from API

export default function DatabasePage() {
  const router = useRouter();
  const [people, setPeople] = useState<Person[]>([]);
  const [unknownFaces, setUnknownFaces] = useState<UnknownFace[]>([]);
  const [activeTab, setActiveTab] = useState<"known" | "unknown">("known");
  const [searchQuery, setSearchQuery] = useState("");
  const [filterRole, setFilterRole] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showIdentifyModal, setShowIdentifyModal] = useState(false);
  const [selectedUnknown, setSelectedUnknown] = useState<UnknownFace | null>(null);
  const [snapshotFaceId, setSnapshotFaceId] = useState<string | null>(null);
  const [identifyMode, setIdentifyMode] = useState<"existing" | "new">("existing");
  const [identifyPersonId, setIdentifyPersonId] = useState("");
  const [identifyName, setIdentifyName] = useState("");
  const [identifyRole, setIdentifyRole] = useState("Visitante");
  const [identifyDept, setIdentifyDept] = useState("Externo");
  const [identifyError, setIdentifyError] = useState("");

  // Form state
  const [formData, setFormData] = useState({
    name: "",
    role: "Empleado",
    department: "Sistemas",
  });
  const [formError, setFormError] = useState("");

  const handleIdentifyUnknown = async () => {
    if (!selectedUnknown) return;
    setIdentifyError("");

    try {
      let targetPersonId = "";

      if (identifyMode === "existing") {
        // Associate to existing person
        if (!identifyPersonId) {
          setIdentifyError("Selecciona una persona");
          return;
        }
        targetPersonId = identifyPersonId;
      } else {
        // Create new person first
        if (!identifyName.trim()) {
          setIdentifyError("El nombre es obligatorio");
          return;
        }
        const result = await api.post<any>("/persons", {
          name: identifyName.trim(),
          role: identifyRole,
          department: identifyDept,
        });
        if (!result?.id) {
          setIdentifyError("Error al crear la persona");
          return;
        }
        targetPersonId = result.id;
        // Add to local state
        setPeople((prev) => [...prev, {
          id: result.id,
          name: result.name,
          role: result.role || identifyRole,
          department: result.department || identifyDept,
          photos: [],
          photoCount: 0,
          status: "active",
          created_at: new Date().toISOString().split("T")[0],
        }]);
      }

      // Associate unknown face to the person via API (moves embedding)
      await api.post(`/unknown-faces/${selectedUnknown.id}/identify`, {
        person_id: targetPersonId,
      });

      // Update photo count in local state
      setPeople((prev) =>
        prev.map((p) => p.id === targetPersonId ? { ...p, photoCount: p.photoCount + 1 } : p)
      );

      // Remove from unknown faces list
      setUnknownFaces((prev) => prev.filter((f) => f.id !== selectedUnknown.id));
      setShowIdentifyModal(false);
      setSelectedUnknown(null);
      setIdentifyName("");
      setIdentifyPersonId("");
      setIdentifyRole("Visitante");
      setIdentifyDept("Externo");
      setIdentifyMode("existing");
    } catch (e: any) {
      setIdentifyError(e?.message || "Error al identificar el rostro");
    }
  };

  const handleDeleteUnknown = async (id: string) => {
    try { await api.del(`/unknown-faces/${id}`); } catch { /* local only */ }
    setUnknownFaces((prev) => prev.filter((f) => f.id !== id));
  };

  // Load persons from API on mount
  useEffect(() => {
    api.get<any[]>("/persons").then((data) => {
      if (data && Array.isArray(data)) {
        setPeople(data.map((p: any) => ({
          id: p.id,
          name: p.name,
          role: p.role || "Empleado",
          department: p.department || "",
          photos: [],
          photoCount: p.photo_count || 0,
          lastSeen: "",
          lastCamera: "",
          status: p.is_active ? "active" : "inactive",
          created_at: p.created_at?.split("T")[0] || "",
        })));
      }
    }).catch(() => { setPeople([]); });

    api.get<any[]>("/unknown-faces").then((data) => {
      if (data && Array.isArray(data)) {
        const colors = ["bg-rose-200", "bg-amber-200", "bg-sky-200", "bg-emerald-200", "bg-violet-200", "bg-pink-200", "bg-teal-200"];
        setUnknownFaces(data.map((f: any, i: number) => ({
          id: f.id,
          thumbnailColor: colors[i % colors.length],
          thumbnailPath: f.thumbnail_path || "",
          firstSeen: f.first_seen || "",
          lastSeen: f.last_seen || "",
          camera: f.camera_id || "",
          detectionCount: f.detection_count || 1,
          daysRemaining: f.days_remaining || 30,
        })));
      }
    }).catch(() => { setUnknownFaces([]); });
  }, []);

  const filteredPeople = people.filter((p) => {
    const matchSearch =
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.department.toLowerCase().includes(searchQuery.toLowerCase());
    const matchRole = !filterRole || p.role === filterRole;
    return matchSearch && matchRole;
  });

  const handleAddPerson = async () => {
    if (!formData.name.trim()) {
      setFormError("El nombre es obligatorio");
      return;
    }

    // Try API first
    try {
      const result = await api.post<any>("/persons", {
        name: formData.name.trim(),
        role: formData.role,
        department: formData.department,
      });
      if (result && result.id) {
        const newPerson: Person = {
          id: result.id,
          name: result.name,
          role: result.role || formData.role,
          department: result.department || formData.department,
          photos: [],
          photoCount: 0,
          status: "active",
          created_at: new Date().toISOString().split("T")[0],
        };
        setPeople((prev) => [...prev, newPerson]);
        setFormData({ name: "", role: "Empleado", department: "Sistemas" });
        setFormError("");
    setShowAddModal(false);
        // Open upload modal for the new person
        setSelectedPerson(newPerson);
        setShowUploadModal(true);
        return;
      }
    } catch {
      // API not available — fallback to local
    }

    // Fallback: local only
    const newPerson: Person = {
      id: `p-${Date.now()}`,
      name: formData.name.trim(),
      role: formData.role,
      department: formData.department,
      photos: [],
      photoCount: 0,
      status: "active",
      created_at: new Date().toISOString().split("T")[0],
    };
    setPeople((prev) => [...prev, newPerson]);
    setFormData({ name: "", role: "Empleado", department: "Sistemas" });
    setFormError("");
    setShowAddModal(false);
    setSelectedPerson(newPerson);
    setShowUploadModal(true);
  };

  const handleDeletePerson = async (id: string) => {
    try { await api.del(`/persons/${id}`); } catch { /* local only */ }
    setPeople((prev) => prev.filter((p) => p.id !== id));
    if (selectedPerson?.id === id) setSelectedPerson(null);
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);

  const handleUploadPhoto = (personId: string) => {
    // Trigger the hidden file input
    if (fileInputRef.current) {
      fileInputRef.current.dataset.personId = personId;
      fileInputRef.current.value = ""; // Reset so same file can be re-selected
      fileInputRef.current.click();
    }
  };

  const uploadFiles = async (files: FileList | File[], personId: string) => {
    if (!files || files.length === 0 || !personId) return;

    setUploading(true);
    setUploadMsg(null);

    let successCount = 0;
    let lastError = "";

    for (const file of Array.from(files)) {
      try {
        const fd = new FormData();
        fd.append("file", file);

        const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
        const res = await fetch(`${getApiUrl()}/api/v1/persons/${personId}/photos`, {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: fd,
        });

        if (res.ok) {
          const data = await res.json();
          successCount++;
          setPeople((prev) =>
            prev.map((p) =>
              p.id === personId ? { ...p, photoCount: p.photoCount + 1 } : p
            )
          );
          setUploadMsg(data.message || `${successCount} foto(s) subida(s) correctamente`);
        } else {
          const err = await res.json().catch(() => ({ detail: "Error al subir la foto" }));
          lastError = err.detail || "Error al subir la foto";
          setUploadMsg(lastError);
        }
      } catch {
        lastError = "Error de conexión al subir la foto";
        setUploadMsg(lastError);
      }
    }

    if (successCount > 0 && lastError) {
      setUploadMsg(`${successCount} foto(s) subida(s). Último error: ${lastError}`);
    } else if (successCount > 0) {
      setUploadMsg(`${successCount} foto(s) subida(s) y procesada(s) correctamente ✓`);
    }

    setUploading(false);
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    const personId = e.target.dataset?.personId || selectedPerson?.id;
    if (!files || files.length === 0 || !personId) return;
    await uploadFiles(files, personId);
    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const stats = {
    total: people.length,
    active: people.filter((p) => p.status === "active").length,
    totalPhotos: people.reduce((sum, p) => sum + p.photoCount, 0),
  };

  return (
    <>
      {/* Global hidden file input — outside modals so ref is always available */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        style={{ display: "none" }}
        onChange={handleFileSelected}
      />
      <Header title="Base de Datos - Reconocimiento Facial" />
      <div className="p-6">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <Users className="h-8 w-8 text-blue-600" />
              <div>
                <p className="text-2xl font-bold text-gray-900">{stats.total}</p>
                <p className="text-xs text-gray-500">Personas Registradas</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <User className="h-8 w-8 text-green-600" />
              <div>
                <p className="text-2xl font-bold text-gray-900">{stats.active}</p>
                <p className="text-xs text-gray-500">Activas</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <ImageIcon className="h-8 w-8 text-purple-600" />
              <div>
                <p className="text-2xl font-bold text-gray-900">{stats.totalPhotos}</p>
                <p className="text-xs text-gray-500">Fotos Cargadas</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-4 border-b border-gray-200">
          <button
            onClick={() => setActiveTab("known")}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "known"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            <Users className="h-4 w-4" />
            Personas Registradas ({people.length})
          </button>
          <button
            onClick={() => setActiveTab("unknown")}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "unknown"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            <HelpCircle className="h-4 w-4" />
            Rostros Desconocidos ({unknownFaces.length})
          </button>
        </div>

        {activeTab === "known" && (
          <>
        {/* Search + Actions */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3 flex-1 max-w-xl">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Buscar por nombre o departamento..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <select
              value={filterRole}
              onChange={(e) => setFilterRole(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
            >
              <option value="">Todos los roles</option>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <Button onClick={() => setShowAddModal(true)}>
            <Plus className="h-4 w-4 mr-1" /> Agregar Persona
          </Button>
        </div>

        {/* People Table */}
        <Card>
          <CardContent className="p-0">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">
                    Persona
                  </th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">
                    Rol
                  </th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">
                    Departamento
                  </th>
                  <th className="text-center text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">
                    Fotos
                  </th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">
                    Última Detección
                  </th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">
                    Estado
                  </th>
                  <th className="text-right text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">
                    Acciones
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredPeople.map((person) => (
                  <tr key={person.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div
                        className="flex items-center gap-3 cursor-pointer group"
                        onClick={() => router.push(`/dashboard/database/${person.id}`)}
                      >
                        <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center text-sm font-bold text-blue-600 group-hover:bg-blue-200 transition-colors">
                          {person.name
                            .split(" ")
                            .map((n) => n[0])
                            .join("")
                            .slice(0, 2)}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900 group-hover:text-blue-600 transition-colors">{person.name}</p>
                          <p className="text-xs text-gray-500">Registrado: {person.created_at}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-gray-700">{person.role}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-gray-700">{person.department}</span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`inline-flex items-center gap-1 text-sm font-medium ${
                          person.photoCount >= 3 ? "text-green-600" : person.photoCount > 0 ? "text-orange-500" : "text-red-500"
                        }`}
                      >
                        <ImageIcon className="h-3.5 w-3.5" />
                        {person.photoCount}
                      </span>
                      {person.photoCount < 3 && (
                        <p className="text-[10px] text-gray-400">Mín. 3 recomendadas</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {person.lastSeen ? (
                        <div>
                          <p className="text-sm text-gray-700">{person.lastSeen}</p>
                          <p className="text-xs text-gray-400">{person.lastCamera}</p>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">Sin detecciones</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={person.status === "active" ? "success" : "secondary"}>
                        {person.status === "active" ? "Activo" : "Inactivo"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => {
                            setSelectedPerson(person);
                            setShowUploadModal(true);
                          }}
                          className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded"
                          title="Subir fotos"
                        >
                          <Upload className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDeletePerson(person.id)}
                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"
                          title="Eliminar"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {filteredPeople.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                      <Users className="h-10 w-10 mx-auto mb-2" />
                      <p className="text-sm">No se encontraron personas</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
          </>
        )}

        {/* UNKNOWN FACES TAB */}
        {activeTab === "unknown" && (
          <>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Clock className="h-4 w-4" />
                <span>Los rostros desconocidos se conservan por 30 días</span>
              </div>
            </div>

            <Card>
              <CardContent className="p-0">
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 p-4">
                  {unknownFaces.map((face) => (
                    <div
                      key={face.id}
                      className="border border-gray-200 rounded-lg overflow-hidden hover:border-blue-300 transition-colors"
                    >
                      {/* Face thumbnail */}
                      <div className={`aspect-square ${face.thumbnailColor} flex items-center justify-center relative group`}>
                        {face.thumbnailPath ? (
                          <>
                            <img
                              src={`${getApiUrl()}/api/v1/unknown-faces/${face.id}/thumbnail`}
                              alt="Rostro desconocido"
                              className="w-full h-full object-cover"
                              onError={(e) => {
                                (e.target as HTMLImageElement).style.display = "none";
                              }}
                            />
                            <button
                              onClick={() => setSnapshotFaceId(face.id)}
                              className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center cursor-pointer"
                              title="Ver imagen completa"
                            >
                              <ZoomIn className="h-6 w-6 text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-lg" />
                            </button>
                          </>
                        ) : (
                          <HelpCircle className="h-12 w-12 text-white/60" />
                        )}
                        {/* Days remaining badge */}
                        <div
                          className={`absolute top-2 right-2 text-[10px] font-bold px-1.5 py-0.5 rounded ${
                            face.daysRemaining <= 7
                              ? "bg-red-500 text-white"
                              : face.daysRemaining <= 14
                              ? "bg-orange-500 text-white"
                              : "bg-gray-800/60 text-white"
                          }`}
                        >
                          {face.daysRemaining}d
                        </div>
                        {/* Detection count */}
                        <div className="absolute bottom-2 left-2 text-[10px] bg-black/50 text-white px-1.5 py-0.5 rounded flex items-center gap-1">
                          <Eye className="h-3 w-3" />
                          {face.detectionCount}x
                        </div>
                      </div>

                      {/* Info */}
                      <div className="p-3 space-y-1.5">
                        <div className="text-xs text-gray-500">
                          <p><span className="font-medium text-gray-700">Primera vez:</span> {face.firstSeen}</p>
                          <p><span className="font-medium text-gray-700">Última vez:</span> {face.lastSeen}</p>
                          <p><span className="font-medium text-gray-700">Cámara:</span> {face.camera}</p>
                        </div>
                        <div className="flex gap-1.5 pt-1">
                          <Button
                            size="sm"
                            className="flex-1 text-xs h-7"
                            onClick={() => {
                              setSelectedUnknown(face);
                              setShowIdentifyModal(true);
                            }}
                          >
                            <UserPlus className="h-3 w-3 mr-1" />
                            Identificar
                          </Button>
                          <button
                            onClick={() => handleDeleteUnknown(face.id)}
                            className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded h-7 w-7 flex items-center justify-center"
                            title="Eliminar"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {unknownFaces.length === 0 && (
                  <div className="p-12 text-center text-gray-400">
                    <Check className="h-10 w-10 mx-auto mb-2 text-green-400" />
                    <p className="text-sm font-medium">No hay rostros desconocidos pendientes</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Identify Unknown Modal */}
      {showIdentifyModal && selectedUnknown && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between p-5 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Identificar Persona</h2>
              <button
                onClick={() => { setShowIdentifyModal(false); setSelectedUnknown(null); setIdentifyError(""); }}
                className="p-1 rounded-md hover:bg-gray-100 text-gray-500"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {/* Face thumbnail */}
              <div className={`h-32 ${selectedUnknown.thumbnailColor} rounded-lg flex items-center justify-center overflow-hidden`}>
                {selectedUnknown.thumbnailPath ? (
                  <img
                    src={`${getApiUrl()}/api/v1/unknown-faces/${selectedUnknown.id}/thumbnail`}
                    alt="Rostro"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <HelpCircle className="h-16 w-16 text-white/50" />
                )}
              </div>
              <div className="text-xs text-gray-500 space-y-1">
                <p>Detectado {selectedUnknown.detectionCount} veces desde {selectedUnknown.firstSeen}</p>
              </div>

              {identifyError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">{identifyError}</div>
              )}

              {/* Mode selector: existing or new */}
              <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
                <button
                  onClick={() => setIdentifyMode("existing")}
                  className={`flex-1 text-xs font-medium py-2 rounded-md transition-colors ${
                    identifyMode === "existing" ? "bg-white text-blue-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  Persona Existente
                </button>
                <button
                  onClick={() => setIdentifyMode("new")}
                  className={`flex-1 text-xs font-medium py-2 rounded-md transition-colors ${
                    identifyMode === "new" ? "bg-white text-blue-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  Crear Nueva
                </button>
              </div>

              {identifyMode === "existing" ? (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Seleccionar Persona <span className="text-red-500">*</span>
                  </label>
                  {people.length > 0 ? (
                    <select
                      value={identifyPersonId}
                      onChange={(e) => setIdentifyPersonId(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                    >
                      <option value="">-- Seleccionar --</option>
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} — {p.role} ({p.department}) [{p.photoCount} fotos]
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="text-sm text-gray-400">No hay personas registradas. Crea una nueva.</p>
                  )}
                  <p className="text-xs text-gray-400 mt-1">
                    El rostro se asociará a esta persona, mejorando el reconocimiento desde más ángulos.
                  </p>
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Nombre Completo <span className="text-red-500">*</span>
                    </label>
                    <Input
                      placeholder="Ej: Juan Pérez"
                      value={identifyName}
                      onChange={(e) => setIdentifyName(e.target.value)}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Rol</label>
                      <select
                        value={identifyRole}
                        onChange={(e) => setIdentifyRole(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Departamento</label>
                      <select
                        value={identifyDept}
                        onChange={(e) => setIdentifyDept(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                      >
                        {DEPARTMENTS.map((d) => (
                          <option key={d} value={d}>{d}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-200">
              <Button variant="outline" onClick={() => { setShowIdentifyModal(false); setSelectedUnknown(null); setIdentifyError(""); }}>
                Cancelar
              </Button>
              <Button
                onClick={handleIdentifyUnknown}
                disabled={identifyMode === "existing" ? !identifyPersonId : !identifyName.trim()}
              >
                <UserPlus className="h-4 w-4 mr-1" />
                {identifyMode === "existing" ? "Asociar Rostro" : "Crear y Asociar"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Add Person Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between p-5 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Agregar Persona</h2>
              <button onClick={() => setShowAddModal(false)} className="p-1 rounded-md hover:bg-gray-100 text-gray-500">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {formError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">{formError}</div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Nombre Completo <span className="text-red-500">*</span>
                </label>
                <Input
                  placeholder="Ej: Juan Pérez"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Rol</label>
                  <select
                    value={formData.role}
                    onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Departamento</label>
                  <select
                    value={formData.department}
                    onChange={(e) => setFormData({ ...formData, department: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                  >
                    {DEPARTMENTS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="p-3 rounded-lg bg-blue-50 border border-blue-100 text-xs text-blue-700">
                <strong>Tip:</strong> Después de crear la persona, sube al menos 3 fotos desde diferentes ángulos para
                mejorar la precisión del reconocimiento facial.
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-200">
              <Button variant="outline" onClick={() => setShowAddModal(false)}>
                Cancelar
              </Button>
              <Button onClick={handleAddPerson}>Agregar y Subir Fotos</Button>
            </div>
          </div>
        </div>
      )}

      {/* Full Snapshot Lightbox for Unknown Faces */}
      {snapshotFaceId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-pointer" onClick={() => setSnapshotFaceId(null)}>
          <button className="absolute top-4 right-4 text-white hover:text-gray-300 z-50" onClick={() => setSnapshotFaceId(null)}>
            <X className="h-8 w-8" />
          </button>
          <img
            src={`${getApiUrl()}/api/v1/unknown-faces/${snapshotFaceId}/snapshot`}
            alt="Imagen completa"
            className="max-w-[95vw] max-h-[95vh] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            onError={(e) => {
              // Fallback to thumbnail if no full snapshot
              (e.target as HTMLImageElement).src = `${getApiUrl()}/api/v1/unknown-faces/${snapshotFaceId}/thumbnail`;
            }}
          />
        </div>
      )}

      {/* Upload Photos Modal */}
      {showUploadModal && selectedPerson && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4">
            <div className="flex items-center justify-between p-5 border-b border-gray-200">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Subir Fotos</h2>
                <p className="text-sm text-gray-500">{selectedPerson.name}</p>
              </div>
              <button
                onClick={() => {
                  setShowUploadModal(false);
                  setSelectedPerson(null);
                }}
                className="p-1 rounded-md hover:bg-gray-100 text-gray-500"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {/* Current photos count */}
              <div className="flex items-center justify-between p-3 rounded-lg bg-gray-50">
                <span className="text-sm text-gray-600">Fotos actuales:</span>
                <span
                  className={`text-sm font-bold ${
                    selectedPerson.photoCount >= 3 ? "text-green-600" : "text-orange-500"
                  }`}
                >
                  {selectedPerson.photoCount} / 3 mínimo
                </span>
              </div>

              {/* Upload Zone */}
              <div
                className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center hover:border-blue-400 transition-colors cursor-pointer"
                onClick={() => handleUploadPhoto(selectedPerson.id)}
                onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("border-blue-500", "bg-blue-50"); }}
                onDragLeave={(e) => { e.currentTarget.classList.remove("border-blue-500", "bg-blue-50"); }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.remove("border-blue-500", "bg-blue-50");
                  if (e.dataTransfer.files.length > 0) {
                    // Directly process dropped files — no need for synthetic events
                    uploadFiles(Array.from(e.dataTransfer.files), selectedPerson.id);
                  }
                }}
              >
                {uploading ? (
                  <div className="animate-pulse">
                    <div className="h-10 w-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                    <p className="text-sm font-medium text-blue-600">Subiendo y procesando rostro...</p>
                  </div>
                ) : (
                  <>
                    <Upload className="h-10 w-10 text-gray-400 mx-auto mb-3" />
                    <p className="text-sm font-medium text-gray-700">
                      Haz clic o arrastra fotos aquí
                    </p>
                    <p className="text-xs text-gray-500 mt-1">JPG, PNG — Se detectará el rostro automáticamente</p>
                  </>
                )}
              </div>

              {/* Upload feedback */}
              {uploadMsg && (
                <div className={`text-sm p-3 rounded-lg ${
                  uploadMsg.includes("Error") ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"
                }`}>
                  {uploadMsg}
                </div>
              )}

              {/* Guidelines */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-gray-700">Recomendaciones para mejores resultados:</p>
                <div className="grid grid-cols-2 gap-2 text-xs text-gray-500">
                  <div className="flex items-start gap-1.5">
                    <Check className="h-3.5 w-3.5 text-green-500 mt-0.5 shrink-0" />
                    <span>Foto frontal bien iluminada</span>
                  </div>
                  <div className="flex items-start gap-1.5">
                    <Check className="h-3.5 w-3.5 text-green-500 mt-0.5 shrink-0" />
                    <span>Perfil izquierdo y derecho</span>
                  </div>
                  <div className="flex items-start gap-1.5">
                    <Check className="h-3.5 w-3.5 text-green-500 mt-0.5 shrink-0" />
                    <span>Sin lentes oscuros ni gorras</span>
                  </div>
                  <div className="flex items-start gap-1.5">
                    <Check className="h-3.5 w-3.5 text-green-500 mt-0.5 shrink-0" />
                    <span>Fondo neutro preferible</span>
                  </div>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-200">
              <Button
                variant="outline"
                onClick={() => {
                  setShowUploadModal(false);
                  setSelectedPerson(null);
                }}
              >
                Cerrar
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
