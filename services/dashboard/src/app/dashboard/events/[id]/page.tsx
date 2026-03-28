"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Header } from "@/components/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { format } from "date-fns";
import Link from "next/link";
import { ArrowLeft, User, UserPlus, X, Camera, Clock, Tag, Target, Shirt } from "lucide-react";
import { getApiUrl } from "@/lib/urls";

const ROLES = ["Empleado", "Visitante", "Guardia", "Contratista", "Proveedor", "VIP", "Restringido"];
const DEPARTMENTS = ["Sistemas", "Administración", "Seguridad", "Ingeniería", "Ventas", "Recursos Humanos", "Dirección", "Externo"];

export default function EventDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [event, setEvent] = useState<any>(null);
  const [cameras, setCameras] = useState<{ id: string; name: string }[]>([]);

  // Identify modal state
  const [showIdentify, setShowIdentify] = useState(false);
  const [persons, setPersons] = useState<any[]>([]);
  const [identifyMode, setIdentifyMode] = useState<"existing" | "new">("existing");
  const [selectedPersonId, setSelectedPersonId] = useState("");
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState("Empleado");
  const [newDept, setNewDept] = useState("Sistemas");
  const [identifyError, setIdentifyError] = useState("");

  useEffect(() => {
    api.get(`/events/${id}`).then(setEvent).catch(console.error);
    api.get<any[]>("/cameras").then((d) => d && setCameras(d)).catch(() => {});
    api.get<any[]>("/persons").then((d) => d && setPersons(d)).catch(() => {});
  }, [id]);

  const getCameraName = (cameraId: string) =>
    cameras.find((c) => c.id === cameraId)?.name || cameraId;

  const personName = event?.metadata?.person_name;
  const personId = event?.metadata?.person_id;
  const faceDetected = event?.metadata?.face_detected;
  const isPerson = event?.event_type === "person" || event?.label?.startsWith("person");

  const handleIdentify = async () => {
    setIdentifyError("");
    try {
      let targetPersonId = "";

      if (identifyMode === "existing") {
        if (!selectedPersonId) { setIdentifyError("Selecciona una persona"); return; }
        targetPersonId = selectedPersonId;
      } else {
        if (!newName.trim()) { setIdentifyError("El nombre es obligatorio"); return; }
        const result = await api.post<any>("/persons", {
          name: newName.trim(),
          role: newRole,
          department: newDept,
        });
        if (!result?.id) { setIdentifyError("Error al crear persona"); return; }
        targetPersonId = result.id;
        setPersons((prev) => [...prev, result]);
      }

      // Navigate to the person's profile to upload photos
      router.push(`/dashboard/database/${targetPersonId}`);
    } catch (e: any) {
      setIdentifyError(e?.message || "Error");
    }
  };

  if (!event) return <div className="flex items-center justify-center h-screen text-gray-400">Cargando...</div>;

  return (
    <>
      <Header title="Detalle de Evento" />
      <div className="p-6 space-y-6">
        <Link href="/dashboard/events">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" /> Volver a Eventos
          </Button>
        </Link>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Snapshot */}
          <Card>
            <CardContent className="p-2">
              {event.snapshot_path ? (
                <img
                  src={`${getApiUrl()}/api/v1/events/${id}/snapshot`}
                  alt="Event snapshot"
                  className="w-full rounded-lg"
                />
              ) : (
                <div className="flex h-64 items-center justify-center rounded-lg bg-gray-100 text-gray-400">
                  Sin snapshot disponible
                </div>
              )}
            </CardContent>
          </Card>

          {/* Details */}
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Detalles del Evento</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between items-center">
                  <span className="text-gray-500 flex items-center gap-1"><Tag className="h-3.5 w-3.5" /> Tipo</span>
                  <Badge>{event.event_type}</Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Etiqueta</span>
                  <span className="font-medium">{event.label || "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500 flex items-center gap-1"><Target className="h-3.5 w-3.5" /> Confianza</span>
                  <span>{event.confidence ? `${(event.confidence * 100).toFixed(1)}%` : "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500 flex items-center gap-1"><Camera className="h-3.5 w-3.5" /> Cámara</span>
                  <Link href={`/dashboard/cameras/${event.camera_id}`} className="text-blue-600 hover:underline">
                    {getCameraName(event.camera_id)}
                  </Link>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500 flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> Hora</span>
                  <span>{format(new Date(event.occurred_at), "PPpp")}</span>
                </div>
              </CardContent>
            </Card>

            {/* Person Identification Card */}
            {isPerson && (
              <Card className={personName ? "border-green-200 bg-green-50/30" : faceDetected ? "border-orange-200 bg-orange-50/30" : ""}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <User className="h-4 w-4" />
                    Identificación de Persona
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {personName ? (
                    <>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-gray-900">{personName}</p>
                          <p className="text-xs text-gray-500">Persona identificada por reconocimiento facial</p>
                        </div>
                        <Badge variant="success">Identificado</Badge>
                      </div>
                      {personId && (
                        <Link href={`/dashboard/database/${personId}`}>
                          <Button size="sm" variant="outline" className="w-full">
                            <User className="h-3.5 w-3.5 mr-1" /> Ver Perfil de {personName}
                          </Button>
                        </Link>
                      )}
                    </>
                  ) : faceDetected ? (
                    <>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-gray-700">Rostro detectado — No identificado</p>
                          <p className="text-xs text-gray-500">Se detectó un rostro pero no coincide con nadie registrado</p>
                        </div>
                        <Badge variant="warning">Desconocido</Badge>
                      </div>
                      <Button size="sm" className="w-full" onClick={() => setShowIdentify(true)}>
                        <UserPlus className="h-3.5 w-3.5 mr-1" /> Crear Perfil de Persona
                      </Button>
                    </>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-gray-500">Persona detectada sin rostro visible</p>
                        <p className="text-xs text-gray-400">No se puede identificar sin reconocimiento facial</p>
                      </div>
                      <Badge variant="secondary">Sin rostro</Badge>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Person Attributes */}
            {isPerson && event.metadata && (event.metadata.upper_color || event.metadata.lower_color || event.metadata.headgear) && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Shirt className="h-4 w-4" />
                    Atributos de la Persona
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-3 gap-3 text-sm">
                    {event.metadata.upper_color && (
                      <div className="text-center p-2 bg-gray-50 rounded-lg">
                        <p className="text-xs text-gray-500 mb-1">Parte Superior</p>
                        <p className="font-medium capitalize">{event.metadata.upper_color}</p>
                      </div>
                    )}
                    {event.metadata.lower_color && (
                      <div className="text-center p-2 bg-gray-50 rounded-lg">
                        <p className="text-xs text-gray-500 mb-1">Parte Inferior</p>
                        <p className="font-medium capitalize">{event.metadata.lower_color}</p>
                      </div>
                    )}
                    {event.metadata.headgear && (
                      <div className="text-center p-2 bg-gray-50 rounded-lg">
                        <p className="text-xs text-gray-500 mb-1">Cabeza</p>
                        <p className="font-medium capitalize">
                          {event.metadata.headgear === "none" ? "Sin accesorio" :
                           event.metadata.headgear === "hat" ? "Gorra/Sombrero" :
                           event.metadata.headgear === "helmet" ? "Casco" :
                           event.metadata.headgear}
                        </p>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>

      {/* Identify/Create Person Modal */}
      {showIdentify && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between p-5 border-b border-gray-200">
              <h2 className="text-lg font-semibold">Crear Perfil de Persona</h2>
              <button onClick={() => { setShowIdentify(false); setIdentifyError(""); }} className="p-1 rounded-md hover:bg-gray-100 text-gray-500">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {identifyError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">{identifyError}</div>
              )}

              <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
                <button
                  onClick={() => setIdentifyMode("existing")}
                  className={`flex-1 text-xs font-medium py-2 rounded-md transition-colors ${
                    identifyMode === "existing" ? "bg-white text-blue-600 shadow-sm" : "text-gray-500"
                  }`}
                >
                  Persona Existente
                </button>
                <button
                  onClick={() => setIdentifyMode("new")}
                  className={`flex-1 text-xs font-medium py-2 rounded-md transition-colors ${
                    identifyMode === "new" ? "bg-white text-blue-600 shadow-sm" : "text-gray-500"
                  }`}
                >
                  Crear Nueva
                </button>
              </div>

              {identifyMode === "existing" ? (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Seleccionar Persona</label>
                  <select
                    value={selectedPersonId}
                    onChange={(e) => setSelectedPersonId(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                  >
                    <option value="">-- Seleccionar --</option>
                    {persons.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-400 mt-1">Te llevará al perfil para subir fotos de reconocimiento.</p>
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Nombre Completo *</label>
                    <Input placeholder="Ej: Juan Pérez" value={newName} onChange={(e) => setNewName(e.target.value)} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Rol</label>
                      <select value={newRole} onChange={(e) => setNewRole(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white">
                        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Departamento</label>
                      <select value={newDept} onChange={(e) => setNewDept(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white">
                        {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-200">
              <Button variant="outline" onClick={() => { setShowIdentify(false); setIdentifyError(""); }}>Cancelar</Button>
              <Button onClick={handleIdentify}>
                <UserPlus className="h-4 w-4 mr-1" />
                {identifyMode === "existing" ? "Ir al Perfil" : "Crear y Abrir Perfil"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
