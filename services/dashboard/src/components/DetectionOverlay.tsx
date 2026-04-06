"use client";

interface PersonAttributes {
  upper_color: string;
  upper_rgb: number[];
  lower_color: string;
  lower_rgb: number[];
  headgear: string;
  vehicle_color?: string;
  vehicle_rgb?: number[];
  vehicle_type?: string;
  license_plate?: string;
}

interface Detection {
  id: string;
  label: string;
  confidence: number;
  bbox: { x: number; y: number; w: number; h: number }; // percentages 0-100
  personName?: string; // if face recognized
  trackId?: number;
  attributes?: PersonAttributes;
}

interface DetectionOverlayProps {
  detections: Detection[];
  showLabels?: boolean;
  showConfidence?: boolean;
  className?: string;
}

const HEADGEAR_ICONS: Record<string, string> = {
  gorra: "\u{1F9E2}",    // cap emoji
  sombrero: "\u{1F3A9}", // top hat emoji
  casco: "\u{26D1}",     // helmet emoji
};

const LABEL_COLORS: Record<string, { border: string; bg: string; text: string }> = {
  // Personas
  person: { border: "#3b82f6", bg: "rgba(59,130,246,0.15)", text: "#2563eb" },
  face: { border: "#06b6d4", bg: "rgba(6,182,212,0.15)", text: "#0891b2" },
  // Vehiculos
  car: { border: "#f59e0b", bg: "rgba(245,158,11,0.15)", text: "#d97706" },
  truck: { border: "#f97316", bg: "rgba(249,115,22,0.15)", text: "#ea580c" },
  bus: { border: "#ef4444", bg: "rgba(239,68,68,0.15)", text: "#dc2626" },
  motorcycle: { border: "#e11d48", bg: "rgba(225,29,72,0.15)", text: "#be123c" },
  bicycle: { border: "#14b8a6", bg: "rgba(20,184,166,0.15)", text: "#0d9488" },
  // Animales
  dog: { border: "#a855f7", bg: "rgba(168,85,247,0.15)", text: "#9333ea" },
  cat: { border: "#ec4899", bg: "rgba(236,72,153,0.15)", text: "#db2777" },
  horse: { border: "#f43f5e", bg: "rgba(244,63,94,0.15)", text: "#e11d48" },
  bird: { border: "#8b5cf6", bg: "rgba(139,92,246,0.15)", text: "#7c3aed" },
  cow: { border: "#d946ef", bg: "rgba(217,70,239,0.15)", text: "#c026d3" },
  sheep: { border: "#c084fc", bg: "rgba(192,132,252,0.15)", text: "#a855f7" },
  bear: { border: "#b91c1c", bg: "rgba(185,28,28,0.15)", text: "#991b1b" },
  default: { border: "#6b7280", bg: "rgba(107,114,128,0.15)", text: "#4b5563" },
};

export function DetectionOverlay({
  detections,
  showLabels = true,
  showConfidence = true,
  className = "",
}: DetectionOverlayProps) {
  return (
    <div className={`absolute inset-0 pointer-events-none ${className}`}>
      {detections.map((det) => {
        const colors = LABEL_COLORS[det.label] || LABEL_COLORS.default;
        const isRecognized = !!det.personName;
        const attrs = det.attributes;
        const headgearIcon = attrs?.headgear ? HEADGEAR_ICONS[attrs.headgear] : null;

        return (
          <div
            key={det.id}
            className="absolute"
            style={{
              left: `${det.bbox.x}%`,
              top: `${det.bbox.y}%`,
              width: `${det.bbox.w}%`,
              height: `${det.bbox.h}%`,
            }}
          >
            {/* Bounding box */}
            <div
              className="absolute inset-0 rounded-sm"
              style={{
                border: `2px solid ${isRecognized ? "#3b82f6" : colors.border}`,
                backgroundColor: isRecognized ? "rgba(59,130,246,0.08)" : colors.bg,
              }}
            />

            {/* Corner markers for better visibility */}
            {[
              { top: -1, left: -1 },
              { top: -1, right: -1 },
              { bottom: -1, left: -1 },
              { bottom: -1, right: -1 },
            ].map((pos, i) => (
              <div
                key={i}
                className="absolute"
                style={{
                  ...pos,
                  width: 8,
                  height: 8,
                  borderColor: isRecognized ? "#3b82f6" : colors.border,
                  borderWidth: 3,
                  borderStyle: "solid",
                  borderTopStyle: pos.top !== undefined ? "solid" : "none",
                  borderBottomStyle: pos.bottom !== undefined ? "solid" : "none",
                  borderLeftStyle: pos.left !== undefined ? "solid" : "none",
                  borderRightStyle: pos.right !== undefined ? "solid" : "none",
                }}
              />
            ))}

            {/* Top label (name or label) */}
            {showLabels && (
              <div
                className="absolute left-0 flex items-center gap-1 px-1.5 py-0.5 rounded-b-sm"
                style={{
                  bottom: "100%",
                  backgroundColor: isRecognized ? "#3b82f6" : colors.border,
                  maxWidth: "250%",
                }}
              >
                {headgearIcon && (
                  <span className="text-[10px]">{headgearIcon}</span>
                )}
                {isRecognized ? (
                  <span className="text-[10px] font-bold text-white truncate">
                    {det.personName}
                  </span>
                ) : (
                  <>
                    <span className="text-[10px] font-medium text-white capitalize">
                      {det.label}
                    </span>
                    {showConfidence && (
                      <span className="text-[9px] text-white/80">
                        {Math.round(det.confidence * 100)}%
                      </span>
                    )}
                  </>
                )}
                {det.trackId !== undefined && (
                  <span className="text-[9px] text-white/70">#{det.trackId}</span>
                )}
              </div>
            )}

            {/* Bottom label: clothing colors (persons) */}
            {attrs && attrs.upper_rgb && attrs.lower_rgb && (attrs.upper_color !== "desconocido" || attrs.lower_color !== "desconocido") && (
              <div
                className="absolute left-0 flex items-center gap-1 px-1.5 py-0.5 rounded-t-sm"
                style={{
                  top: "100%",
                  backgroundColor: "rgba(0,0,0,0.7)",
                  maxWidth: "250%",
                }}
              >
                <div
                  className="w-2.5 h-2.5 rounded-full border border-white/40"
                  style={{ backgroundColor: `rgb(${attrs.upper_rgb.join(",")})` }}
                  title={`Superior: ${attrs.upper_color}`}
                />
                <span className="text-[9px] text-white/80">{attrs.upper_color}</span>
                <span className="text-[8px] text-white/40">|</span>
                <div
                  className="w-2.5 h-2.5 rounded-full border border-white/40"
                  style={{ backgroundColor: `rgb(${attrs.lower_rgb.join(",")})` }}
                  title={`Inferior: ${attrs.lower_color}`}
                />
                <span className="text-[9px] text-white/80">{attrs.lower_color}</span>
              </div>
            )}

            {/* Bottom label: vehicle attributes */}
            {attrs && attrs.vehicle_type && attrs.vehicle_color && (
              <div
                className="absolute left-0 flex items-center gap-1 px-1.5 py-0.5 rounded-t-sm"
                style={{
                  top: "100%",
                  backgroundColor: "rgba(0,0,0,0.7)",
                  maxWidth: "300%",
                }}
              >
                {attrs.vehicle_rgb && (
                  <div
                    className="w-2.5 h-2.5 rounded-full border border-white/40"
                    style={{ backgroundColor: `rgb(${attrs.vehicle_rgb.join(",")})` }}
                  />
                )}
                <span className="text-[9px] text-white/80">
                  {attrs.vehicle_type} {attrs.vehicle_color}
                </span>
                {attrs.license_plate && (
                  <>
                    <span className="text-[8px] text-white/40">|</span>
                    <span className="text-[9px] font-bold text-yellow-300">
                      {attrs.license_plate}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
