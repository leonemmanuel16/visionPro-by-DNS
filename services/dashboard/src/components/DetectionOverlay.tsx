"use client";

interface PersonAttributes {
  upper_color: string;
  upper_rgb: number[];
  lower_color: string;
  lower_rgb: number[];
  headgear: string;
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
  person: { border: "#22c55e", bg: "rgba(34,197,94,0.15)", text: "#16a34a" },
  face: { border: "#3b82f6", bg: "rgba(59,130,246,0.15)", text: "#2563eb" },
  car: { border: "#f59e0b", bg: "rgba(245,158,11,0.15)", text: "#d97706" },
  truck: { border: "#f97316", bg: "rgba(249,115,22,0.15)", text: "#ea580c" },
  dog: { border: "#a855f7", bg: "rgba(168,85,247,0.15)", text: "#9333ea" },
  cat: { border: "#ec4899", bg: "rgba(236,72,153,0.15)", text: "#db2777" },
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

            {/* Bottom label: clothing colors */}
            {attrs && attrs.upper_rgb && attrs.lower_rgb && (attrs.upper_color !== "desconocido" || attrs.lower_color !== "desconocido") && (
              <div
                className="absolute left-0 flex items-center gap-1 px-1.5 py-0.5 rounded-t-sm"
                style={{
                  top: "100%",
                  backgroundColor: "rgba(0,0,0,0.7)",
                  maxWidth: "250%",
                }}
              >
                {/* Upper body color dot */}
                <div
                  className="w-2.5 h-2.5 rounded-full border border-white/40"
                  style={{ backgroundColor: `rgb(${attrs.upper_rgb.join(",")})` }}
                  title={`Superior: ${attrs.upper_color}`}
                />
                <span className="text-[9px] text-white/80">{attrs.upper_color}</span>
                <span className="text-[8px] text-white/40">|</span>
                {/* Lower body color dot */}
                <div
                  className="w-2.5 h-2.5 rounded-full border border-white/40"
                  style={{ backgroundColor: `rgb(${attrs.lower_rgb.join(",")})` }}
                  title={`Inferior: ${attrs.lower_color}`}
                />
                <span className="text-[9px] text-white/80">{attrs.lower_color}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
