"use client";

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";

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
      <div className="flex items-center gap-4 rounded-lg border border-slate-700/50 bg-slate-900 p-3 hover:border-cyan-500/50 transition-colors">
        {/* Thumbnail */}
        <div className="h-16 w-24 flex-shrink-0 rounded bg-slate-800 overflow-hidden">
          {thumbnail_path ? (
            <img
              src={`${process.env.NEXT_PUBLIC_API_URL}/api/v1/events/${id}/snapshot`}
              alt={label || event_type}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-slate-600 text-xs">
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
              <span className="text-xs text-slate-500">
                {(confidence * 100).toFixed(0)}%
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-slate-300 truncate">{camera_name}</p>
          <p className="text-xs text-slate-500">
            {formatDistanceToNow(new Date(occurred_at), { addSuffix: true })}
          </p>
        </div>
      </div>
    </Link>
  );
}
