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
}

const typeColors: Record<string, "default" | "warning" | "destructive" | "success"> = {
  person: "default",
  vehicle: "secondary" as any,
  car: "secondary" as any,
  truck: "warning",
  zone_crossing: "destructive",
  animal: "success",
};

export function EventCard({
  id,
  camera_name,
  event_type,
  label,
  confidence,
  occurred_at,
  thumbnail_path,
}: EventCardProps) {
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
                // Fallback: try snapshot if thumbnail fails
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
          <div className="flex items-center gap-2">
            <Badge variant={typeColors[event_type] || "default"}>
              {label || event_type}
            </Badge>
            {confidence && (
              <span className="text-xs text-gray-500">
                {(confidence * 100).toFixed(0)}%
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-gray-700 truncate">{camera_name}</p>
          <p className="text-xs text-gray-400">
            {formatDistanceToNow(new Date(occurred_at), { addSuffix: true })}
          </p>
        </div>
      </div>
    </Link>
  );
}
