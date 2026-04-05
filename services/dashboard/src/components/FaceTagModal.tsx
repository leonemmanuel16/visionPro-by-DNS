"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { X, UserPlus } from "lucide-react";

interface BBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface FaceTagModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (personId: string, isNew: boolean) => void;
  faceBbox?: BBox;
  sourceType: "event" | "unknown_face";
  sourceId: string;
}

const ROLES = ["Empleado", "Visitante", "Guardia", "Contratista", "Proveedor", "VIP", "Restringido"];
const DEPARTMENTS = ["Sistemas", "Administracion", "Seguridad", "Ingenieria", "Ventas", "Recursos Humanos", "Direccion", "Externo"];

export function FaceTagModal({
  isOpen,
  onClose,
  onSave,
  faceBbox,
  sourceType,
  sourceId,
}: FaceTagModalProps) {
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [persons, setPersons] = useState<any[]>([]);
  const [selectedPersonId, setSelectedPersonId] = useState("");
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState("Empleado");
  const [newDept, setNewDept] = useState("Sistemas");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      api.get<any[]>("/persons").then((d) => {
        if (d && Array.isArray(d)) setPersons(d);
      }).catch(() => {});
      // Reset state on open
      setError("");
      setSaving(false);
      setSelectedPersonId("");
      setNewName("");
      setNewRole("Empleado");
      setNewDept("Sistemas");
      setMode("existing");
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setError("");
    setSaving(true);

    try {
      let targetPersonId = "";
      let isNew = false;

      if (mode === "existing") {
        if (!selectedPersonId) {
          setError("Selecciona una persona");
          setSaving(false);
          return;
        }
        targetPersonId = selectedPersonId;
      } else {
        if (!newName.trim()) {
          setError("El nombre es obligatorio");
          setSaving(false);
          return;
        }
        // Create new person
        const result = await api.post<any>("/persons", {
          name: newName.trim(),
          role: newRole,
          department: newDept,
        });
        if (!result?.id) {
          setError("Error al crear la persona");
          setSaving(false);
          return;
        }
        targetPersonId = result.id;
        isNew = true;
        setPersons((prev) => [...prev, result]);
      }

      // Tag the face via the appropriate endpoint
      const endpoint =
        sourceType === "event"
          ? `/events/${sourceId}/tag-face`
          : `/unknown-faces/${sourceId}/tag-face`;

      await api.post(endpoint, {
        person_id: targetPersonId,
        bbox: faceBbox || null,
      });

      onSave(targetPersonId, isNew);
    } catch (e: any) {
      setError(e?.message || "Error al etiquetar el rostro");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Etiquetar Rostro</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-gray-100 text-gray-500"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Bbox info */}
          {faceBbox && (
            <div className="text-xs text-gray-400 bg-gray-50 rounded-lg px-3 py-2">
              Region: ({faceBbox.x1}, {faceBbox.y1}) - ({faceBbox.x2}, {faceBbox.y2})
            </div>
          )}

          {error && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
              {error}
            </div>
          )}

          {/* Tab toggle */}
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => setMode("existing")}
              className={`flex-1 text-xs font-medium py-2 rounded-md transition-colors ${
                mode === "existing"
                  ? "bg-white text-blue-600 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              Persona Existente
            </button>
            <button
              onClick={() => setMode("new")}
              className={`flex-1 text-xs font-medium py-2 rounded-md transition-colors ${
                mode === "new"
                  ? "bg-white text-blue-600 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              Nueva Persona
            </button>
          </div>

          {mode === "existing" ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Seleccionar Persona <span className="text-red-500">*</span>
              </label>
              {persons.length > 0 ? (
                <select
                  value={selectedPersonId}
                  onChange={(e) => setSelectedPersonId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                >
                  <option value="">-- Seleccionar --</option>
                  {persons.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.role ? ` - ${p.role}` : ""}
                      {p.department ? ` (${p.department})` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-sm text-gray-400">
                  No hay personas registradas. Crea una nueva.
                </p>
              )}
              <p className="text-xs text-gray-400 mt-1">
                El rostro seleccionado se asociara a esta persona para mejorar el reconocimiento.
              </p>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Nombre Completo <span className="text-red-500">*</span>
                </label>
                <Input
                  placeholder="Ej: Juan Perez"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Rol</label>
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value)}
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
                    value={newDept}
                    onChange={(e) => setNewDept(e.target.value)}
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

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-200">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || (mode === "existing" ? !selectedPersonId : !newName.trim())}
          >
            {saving ? (
              <span className="flex items-center gap-1">
                <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                Guardando...
              </span>
            ) : (
              <>
                <UserPlus className="h-4 w-4 mr-1" />
                {mode === "existing" ? "Asociar Rostro" : "Crear y Asociar"}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
