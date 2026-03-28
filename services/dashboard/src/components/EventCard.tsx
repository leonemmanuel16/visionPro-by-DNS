"use client";

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { getApiUrl } from "@/lib/urls";

interface EventCardProps {
  id: string;
  camera_name: string;
  event_type: string;
  label?: string;
  confidence?: number;
  occurred_at: string;
  thumbnail_path?: string;
  metadata?: {
    person_name?: string;
    person_id?: string;
    face_detected?: boolean;
    upper_color?: string;
    lower_color?: string;
    headgear?: string;
    vehicle_color?: string;
    vehicle_moving?: boolean;
  };
}

const typeColors: Record<string, "default" | "warning" | "destructive" | "success"> = {
  person: "default",
  vehicle: "secondary" as any,
  car: "secondary" as any,
  truck: "warning",
  zone_crossing: "destructive",
  animal: "success",
};

const VEHICLE_TYPES = new Set(["car", "truck", "bus", "motorcycle", "bicycle"]);

export function EventCard({
  id,
  camera_name,
  event_type,
  label,
  confidence,
  occurred_at,
  thumbnail_path,
  metadata,
}: EventCardProps) {
  const personName = metadata?.person_name;
  const isVehicle = VEHICLE_TYPES.has(event_type);
  const hasPersonAttrs = metadata?.upper_color || metadata?.lower_color || metadata?.headgear;
  const hasVehicleAttrs = metadata?.vehicle_color;

  return (
    <Link href={`/dashboard/events/${id}`}>
      <div className="flex items-center gap-4 rounded-lg border border-gray-200 bg-white p-3 hover:border-blue-400 transition-colors">
        {/* Thumbnail */}
        <div className="h-16 w-24 flex-shrink-0 rounded bg-gray-100 overflow-hidden">
          {thumbnail_path ? (
            <img
              src={`${getApiUrl()}/api/v1/events/${id}/thumbnail`}
              alt={label || event_type}
              className="h-full w-full object-cover"
              onError={(e) => {
                const img = e.target as HTMLImageElement;
                if (!img.dataset.retried) {
                  img.dataset.retried = "1";
                  img.src = `${getApiUrl()}/api/v1/events/${id}/snapshot`;
                }
              }}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-gray-400 text-xs">
              No image
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant={typeColors[event_type] || "default"}>
              {label || event_type}
            </Badge>
            {personName && (
              <Badge variant="success">
                {personName}
              </Badge>
            )}
            {!personName && metadata?.face_detected && (
              <Badge variant="warning">
                Desconocido
              </Badge>
            )}
            {/* Vehicle color badge */}
            {isVehicle && hasVehicleAttrs && (
              <span className="text-[10px] px-1.5 py-0.5 bg-blue-50 border border-blue-200 rounded text-blue-700 capitalize">
                {metadata!.vehicle_color}
              </span>
            )}
            {/* Vehicle motion indicator */}
            {isVehicle && metadata?.vehicle_moving && (
              <span className="text-[10px] px-1.5 py-0.5 bg-green-50 border border-green-200 rounded text-green-700">
                En movimiento
              </span>
            )}
            {confidence && (
              <span className="text-xs text-gray-500">
                {(confidence * 100).toFixed(0)}%
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <p className="text-sm text-gray-700 truncate">{camera_name}</p>
            {hasPersonAttrs && (
              <div className="flex items-center gap-1">
                {metadata?.upper_color && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 rounded text-gray-600 capitalize">
                    Camisa {metadata.upper_color}
                  </span>
                )}
                {metadata?.headgear && metadata.headgear !== "ninguno" && metadata.headgear !== "none" && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 rounded text-gray-600 capitalize">
                    {metadata.headgear}
                  </span>
                )}
              </div>
            )}
          </div>
          <p className="text-xs text-gray-400">
            {formatDistanceToNow(new Date(occurred_at), { addSuffix: true })}
          </p>
        </div>
      </div>
    </Link>
  );
}
