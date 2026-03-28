"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Header } from "@/components/Header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { getApiUrl } from "@/lib/urls";
import {
  ArrowLeft,
  Save,
  Trash2,
  Upload,
  Camera,
  AlertTriangle,
  ToggleLeft,
  ToggleRight,
  Image as ImageIcon,
} from "lucide-react";

interface PersonDetail {
  id: string;
  name: string;
  role: string;
  department: string;
  notes: string;
  is_active: boolean;
  photo_count: number;
  created_at: string;
}

interface PersonPhoto {
  id: string;
  photo_path: string;
  source: string;
  created_at: string;
}

const ROLES = [
  "Empleado",
  "Visitante",
  "Guardia",
  "Contratista",
  "Proveedor",
  "VIP",
  "Restringido",
];

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

export default function PersonDetailPage() {
  const params = useParams();
  const router = useRouter();
  const personId = params.personId as string;

  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [photos, setPhotos] = useState<PersonPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Editable fields
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [department, setDepartment] = useState("");
  const [notes, setNotes] = useState("");
  const [isActive, setIsActive] = useState(true);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadPerson = useCallback(async () => {
    try {
      const data = await api.get<PersonDetail>(`/persons/${personId}`);
      setPerson(data);
      setName(data.name);
      setRole(data.role);
      setDepartment(data.department);
      setNotes(data.notes || "");
      setIsActive(data.is_active);
    } catch (err) {
      console.error("Error loading person:", err);
    }
  }, [personId]);

  const loadPhotos = useCallback(async () => {
    try {
      const data = await api.get<PersonPhoto[]>(
        `/persons/${personId}/photos`
      );
      setPhotos(data);
    } catch (err) {
      console.error("Error loading photos:", err);
    }
  }, [personId]);

  useEffect(() => {
    async function init() {
      setLoading(true);
      await Promise.all([loadPerson(), loadPhotos()]);
      setLoading(false);
    }
    init();
  }, [loadPerson, loadPhotos]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.put(`/persons/${personId}`, {
        name,
        role,
        department,
        notes,
        is_active: isActive,
      });
      await loadPerson();
    } catch (err) {
      console.error("Error saving person:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async () => {
    const newActive = !isActive;
    setIsActive(newActive);
    try {
      await api.put(`/persons/${personId}`, {
        name,
        role,
        department,
        notes,
        is_active: newActive,
      });
      await loadPerson();
    } catch (err) {
      console.error("Error toggling status:", err);
      setIsActive(!newActive);
    }
  };

  const handleDeletePerson = async () => {
    try {
      await api.del(`/persons/${personId}`);
      router.push("/dashboard/database");
    } catch (err) {
      console.error("Error deleting person:", err);
    }
  };

  const handleDeletePhoto = async (photoId: string) => {
    try {
      await api.del(`/persons/${personId}/photos/${photoId}`);
      setPhotos((prev) => prev.filter((p) => p.id !== photoId));
    } catch (err) {
      console.error("Error deleting photo:", err);
    }
  };

  const uploadFile = async (file: File) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const token =
        typeof window !== "undefined"
          ? localStorage.getItem("access_token")
          : null;

      await fetch(
        `${getApiUrl()}/api/v1/persons/${personId}/photos`,
        {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: formData,
        }
      );
      await loadPhotos();
    } catch (err) {
      console.error("Error uploading photo:", err);
    } finally {
      setUploading(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) uploadFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("es-MX", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header />
        <main className="max-w-5xl mx-auto p-6">
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
            <span className="ml-3 text-gray-500">Cargando persona...</span>
          </div>
        </main>
      </div>
    );
  }

  if (!person) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header />
        <main className="max-w-5xl mx-auto p-6">
          <div className="text-center py-20 text-gray-500">
            Persona no encontrada
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="max-w-5xl mx-auto p-6 space-y-6">
        {/* Back button and title */}
        <div className="flex items-center gap-4">
          <Link
            href="/dashboard/database"
            className="flex items-center gap-1 text-sm text-gray-500 hover:text-blue-600 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Volver a Base de Datos
          </Link>
        </div>

        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">{person.name}</h1>
          <Badge
            className={
              isActive
                ? "bg-green-100 text-green-700"
                : "bg-gray-100 text-gray-500"
            }
          >
            {isActive ? "Activo" : "Inactivo"}
          </Badge>
        </div>

        {/* Person Info Card */}
        <Card className="bg-white">
          <CardContent className="p-6 space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">
              Información Personal
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Nombre
                </label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Nombre completo"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Rol
                </label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="">Seleccionar rol</option>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Departamento
                </label>
                <select
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="">Seleccionar departamento</option>
                  {DEPARTMENTS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Notas
                </label>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Notas adicionales"
                />
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <Button
                onClick={handleSave}
                disabled={saving}
                className="bg-blue-600 hover:bg-blue-700 text-white"
              >
                <Save className="w-4 h-4 mr-2" />
                {saving ? "Guardando..." : "Guardar Cambios"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Photos Section */}
        <Card className="bg-white">
          <CardContent className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Camera className="w-5 h-5 text-gray-600" />
                <h2 className="text-lg font-semibold text-gray-900">
                  Fotos de Reconocimiento
                </h2>
                <Badge className="bg-gray-100 text-gray-600">
                  {photos.length}
                </Badge>
              </div>
              <Button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="bg-blue-600 hover:bg-blue-700 text-white"
              >
                <Upload className="w-4 h-4 mr-2" />
                {uploading ? "Subiendo..." : "Subir Foto"}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileSelect}
                className="hidden"
              />
            </div>

            {photos.length < 3 && (
              <div className="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 rounded-lg p-3">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                Minimo 3 fotos recomendadas para reconocimiento preciso
              </div>
            )}

            {/* Upload drop zone */}
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
                dragOver
                  ? "border-blue-500 bg-blue-50"
                  : "border-gray-300 bg-gray-50"
              }`}
            >
              <ImageIcon className="w-8 h-8 mx-auto text-gray-400 mb-2" />
              <p className="text-sm text-gray-500">
                Arrastra una foto aqui o{" "}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="text-blue-600 hover:underline font-medium"
                >
                  selecciona un archivo
                </button>
              </p>
              <p className="text-xs text-gray-400 mt-1">
                JPG, PNG. Maximo 5MB
              </p>
            </div>

            {/* Photo Grid */}
            {photos.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {photos.map((photo) => (
                  <div
                    key={photo.id}
                    className="group relative bg-gray-100 rounded-lg overflow-hidden border border-gray-200"
                  >
                    <div className="aspect-square relative">
                      <img
                        src={`${getApiUrl()}/api/v1/persons/${personId}/photos/${photo.id}/image`}
                        alt="Foto de reconocimiento"
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = "";
                          (e.target as HTMLImageElement).style.display = "none";
                        }}
                      />
                    </div>
                    <div className="p-2 space-y-1">
                      <Badge
                        className={
                          photo.source === "detection"
                            ? "bg-blue-100 text-blue-700 text-xs"
                            : "bg-green-100 text-green-700 text-xs"
                        }
                      >
                        {photo.source === "detection"
                          ? "Deteccion"
                          : "Subida"}
                      </Badge>
                      <p className="text-xs text-gray-400">
                        {formatDate(photo.created_at)}
                      </p>
                    </div>
                    <button
                      onClick={() => handleDeletePhoto(photo.id)}
                      className="absolute top-2 right-2 p-1.5 bg-red-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
                      title="Eliminar foto"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-gray-400">
                <ImageIcon className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p>No hay fotos registradas</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Status Toggle */}
        <Card className="bg-white">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Estado</h2>
                <p className="text-sm text-gray-500">
                  {isActive
                    ? "La persona esta activa en el sistema de reconocimiento"
                    : "La persona esta inactiva y no sera reconocida"}
                </p>
              </div>
              <button
                onClick={handleToggleActive}
                className="flex items-center gap-2"
              >
                {isActive ? (
                  <ToggleRight className="w-10 h-10 text-green-500" />
                ) : (
                  <ToggleLeft className="w-10 h-10 text-gray-400" />
                )}
              </button>
            </div>
          </CardContent>
        </Card>

        {/* Danger Zone */}
        <Card className="bg-white border-red-200">
          <CardContent className="p-6">
            <h2 className="text-lg font-semibold text-red-600 mb-2">
              Zona de Peligro
            </h2>
            <p className="text-sm text-gray-500 mb-4">
              Eliminar esta persona eliminara todas sus fotos y datos de
              reconocimiento. Esta accion no se puede deshacer.
            </p>
            {!showDeleteConfirm ? (
              <Button
                onClick={() => setShowDeleteConfirm(true)}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Eliminar Persona
              </Button>
            ) : (
              <div className="flex items-center gap-3">
                <span className="text-sm text-red-600 font-medium">
                  Estas seguro?
                </span>
                <Button
                  onClick={handleDeletePerson}
                  className="bg-red-600 hover:bg-red-700 text-white"
                >
                  Si, eliminar
                </Button>
                <Button
                  onClick={() => setShowDeleteConfirm(false)}
                  variant="outline"
                >
                  Cancelar
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
