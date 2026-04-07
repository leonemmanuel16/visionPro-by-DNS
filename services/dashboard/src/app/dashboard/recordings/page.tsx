"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useCameras } from "@/hooks/useCameras";
import { api } from "@/lib/api";
import { getApiUrl } from "@/lib/urls";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  ChevronLeft,
  ChevronRight,
  Camera,
  Calendar,
  Clock,
  HardDrive,
  Download,
  Search,
  Maximize2,
  Volume2,
  VolumeX,
} from "lucide-react";

interface Segment {
  filename: string;
  time: string;
  size_mb: number;
  duration_min: number;
  modified: string;
}

interface RecordingsData {
  cameras: Record<string, Record<string, Segment[]>>;
  total_files: number;
  total_size_gb: number;
}

interface RecordingStatus {
  active: boolean;
  cameras_recording?: number;
  total_files?: number;
  total_size_gb?: number;
  disk_total_gb?: number;
  disk_free_gb?: number;
  disk_used_pct?: number;
  retention_hours?: number;
  segment_minutes?: number;
}

export default function RecordingsPage() {
  const { cameras } = useCameras();
  const [recordings, setRecordings] = useState<RecordingsData | null>(null);
  const [status, setStatus] = useState<RecordingStatus | null>(null);
  const [selectedCam, setSelectedCam] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>(
    new Date().toISOString().slice(0, 10)
  );
  const [currentSegment, setCurrentSegment] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Calendar state
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  // Load recordings and status
  useEffect(() => {
    api.get<RecordingsData>("/recordings").then(setRecordings).catch(() => {});
    api.get<RecordingStatus>("/recordings/status").then(setStatus).catch(() => {});
  }, []);

  // Reload recordings when date changes
  useEffect(() => {
    if (selectedCam) {
      api
        .get<RecordingsData>(`/recordings?camera_id=${selectedCam}&date=${selectedDate}`)
        .then(setRecordings)
        .catch(() => {});
    }
  }, [selectedCam, selectedDate]);

  // Auto-select first camera
  useEffect(() => {
    if (!selectedCam && recordings?.cameras) {
      const firstCam = Object.keys(recordings.cameras)[0];
      if (firstCam) setSelectedCam(firstCam);
    }
  }, [recordings, selectedCam]);

  // Camera name mapping
  const camNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    cameras.forEach((c) => {
      const streamName = `cam_${c.id.replace(/-/g, "").slice(0, 12)}`;
      map[streamName] = c.name;
    });
    return map;
  }, [cameras]);

  // Get segments for selected camera + date
  const segments = useMemo(() => {
    if (!recordings?.cameras || !selectedCam) return [];
    const camData = recordings.cameras[selectedCam];
    if (!camData) return [];
    return camData[selectedDate] || [];
  }, [recordings, selectedCam, selectedDate]);

  // Available dates for selected camera
  const availableDates = useMemo(() => {
    if (!recordings?.cameras || !selectedCam) return new Set<string>();
    const camData = recordings.cameras[selectedCam];
    return new Set(camData ? Object.keys(camData) : []);
  }, [recordings, selectedCam]);

  // All camera stream names that have recordings
  const recordedCameras = useMemo(() => {
    if (!recordings?.cameras) return [];
    return Object.keys(recordings.cameras);
  }, [recordings]);

  // Play a segment
  const playSegment = useCallback(
    (filename: string) => {
      if (!selectedCam || !videoRef.current) return;
      const url = `${getApiUrl()}/api/v1/recordings/${selectedCam}/${selectedDate}/${filename}`;
      videoRef.current.src = url;
      videoRef.current.load();
      videoRef.current.play().catch(() => {});
      setCurrentSegment(filename);
      setIsPlaying(true);
    },
    [selectedCam, selectedDate]
  );

  // Play next/prev segment
  const playAdjacentSegment = useCallback(
    (direction: 1 | -1) => {
      if (!currentSegment) {
        if (segments.length > 0) playSegment(segments[0].filename);
        return;
      }
      const idx = segments.findIndex((s) => s.filename === currentSegment);
      const nextIdx = idx + direction;
      if (nextIdx >= 0 && nextIdx < segments.length) {
        playSegment(segments[nextIdx].filename);
      }
    },
    [currentSegment, segments, playSegment]
  );

  // Auto-play next segment when current ends
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const handleEnded = () => playAdjacentSegment(1);
    const handleTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      setDuration(video.duration || 0);
    };
    video.addEventListener("ended", handleEnded);
    video.addEventListener("timeupdate", handleTimeUpdate);
    return () => {
      video.removeEventListener("ended", handleEnded);
      video.removeEventListener("timeupdate", handleTimeUpdate);
    };
  }, [playAdjacentSegment]);

  // Toggle play/pause
  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  // Toggle fullscreen
  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  // Format time
  const formatTime = (secs: number) => {
    if (!secs || isNaN(secs)) return "00:00";
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  // Current segment display time
  const segmentTimeDisplay = useMemo(() => {
    if (!currentSegment) return "--:--:--";
    const time = currentSegment.replace(".mp4", "").replace(/-/g, ":");
    return time;
  }, [currentSegment]);

  // Calendar rendering
  const calendarDays = useMemo(() => {
    const { year, month } = calendarMonth;
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const days: (number | null)[] = [];
    for (let i = 0; i < firstDay; i++) days.push(null);
    for (let i = 1; i <= daysInMonth; i++) days.push(i);
    return days;
  }, [calendarMonth]);

  const monthNames = [
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
  ];

  // Download current segment
  const downloadSegment = () => {
    if (!selectedCam || !currentSegment) return;
    const url = `${getApiUrl()}/api/v1/recordings/${selectedCam}/${selectedDate}/${currentSegment}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selectedCam}_${selectedDate}_${currentSegment}`;
    a.click();
  };

  return (
    <div className="flex h-full">
      {/* ── LEFT: Camera List ── */}
      <div className="w-52 border-r border-gray-200 bg-white flex flex-col shrink-0">
        <div className="p-3 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <Camera className="h-4 w-4" />
            Camaras
          </h2>
          <p className="text-[10px] text-gray-400 mt-0.5">
            {recordedCameras.length} con grabaciones
          </p>
        </div>
        <div className="flex-1 overflow-y-auto">
          {recordedCameras.map((camStream) => {
            const displayName = camNameMap[camStream] || camStream;
            const isSelected = selectedCam === camStream;
            const cam = cameras.find(
              (c) => `cam_${c.id.replace(/-/g, "").slice(0, 12)}` === camStream
            );
            return (
              <button
                key={camStream}
                onClick={() => {
                  setSelectedCam(camStream);
                  setCurrentSegment(null);
                  setIsPlaying(false);
                }}
                className={`w-full flex items-center gap-2 px-3 py-2.5 text-left border-b border-gray-100 transition-colors ${
                  isSelected
                    ? "bg-blue-50 border-l-2 border-l-blue-600"
                    : "hover:bg-gray-50"
                }`}
              >
                <div
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    cam?.is_online ? "bg-green-500" : "bg-gray-300"
                  }`}
                />
                <span
                  className={`text-xs truncate ${
                    isSelected ? "font-semibold text-blue-700" : "text-gray-700"
                  }`}
                >
                  {displayName}
                </span>
              </button>
            );
          })}
          {recordedCameras.length === 0 && (
            <div className="p-4 text-center">
              <HardDrive className="h-8 w-8 mx-auto text-gray-300 mb-2" />
              <p className="text-xs text-gray-400">Sin grabaciones</p>
              <p className="text-[10px] text-gray-400 mt-1">
                El servicio de grabacion esta iniciando...
              </p>
            </div>
          )}
        </div>

        {/* Disk status */}
        {status && status.active && (
          <div className="p-3 border-t border-gray-200 bg-gray-50">
            <div className="flex items-center gap-2 text-[10px] text-gray-500 mb-1">
              <HardDrive className="h-3 w-3" />
              <span>Almacenamiento</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-1.5 mb-1">
              <div
                className={`h-1.5 rounded-full ${
                  (status.disk_used_pct || 0) > 85 ? "bg-red-500" : "bg-blue-500"
                }`}
                style={{ width: `${Math.min(status.disk_used_pct || 0, 100)}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-gray-400">
              <span>{status.total_size_gb} GB usado</span>
              <span>{status.disk_free_gb} GB libre</span>
            </div>
            <div className="text-[10px] text-gray-400 mt-1">
              Retencion: {status.retention_hours}h
            </div>
          </div>
        )}
      </div>

      {/* ── CENTER: Video Player ── */}
      <div className="flex-1 flex flex-col bg-gray-900" ref={containerRef}>
        {/* Video area */}
        <div className="flex-1 relative flex items-center justify-center bg-black">
          {currentSegment ? (
            <video
              ref={videoRef}
              className="max-w-full max-h-full"
              muted={isMuted}
              onClick={togglePlay}
              playsInline
            />
          ) : (
            <div className="text-center text-gray-500">
              <Camera className="h-16 w-16 mx-auto mb-3 text-gray-600" />
              <p className="text-sm">Selecciona una camara y un segmento</p>
              <p className="text-xs text-gray-600 mt-1">
                para reproducir la grabacion
              </p>
            </div>
          )}

          {/* Current time overlay */}
          {currentSegment && (
            <div className="absolute top-3 left-3 bg-black/70 backdrop-blur rounded-lg px-3 py-1.5 text-white text-xs font-mono">
              {selectedDate} {segmentTimeDisplay}
            </div>
          )}

          {/* Camera name overlay */}
          {selectedCam && (
            <div className="absolute top-3 right-3 bg-black/70 backdrop-blur rounded-lg px-3 py-1.5 text-white text-xs font-medium">
              {camNameMap[selectedCam] || selectedCam}
            </div>
          )}
        </div>

        {/* Playback controls */}
        <div className="bg-gray-800 border-t border-gray-700 px-4 py-2">
          {/* Progress bar */}
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] text-gray-400 font-mono w-10">
              {formatTime(currentTime)}
            </span>
            <div className="flex-1 relative">
              <input
                type="range"
                min={0}
                max={duration || 100}
                value={currentTime}
                onChange={(e) => {
                  if (videoRef.current) {
                    videoRef.current.currentTime = parseFloat(e.target.value);
                  }
                }}
                className="w-full h-1.5 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-blue-500"
              />
            </div>
            <span className="text-[10px] text-gray-400 font-mono w-10 text-right">
              {formatTime(duration)}
            </span>
          </div>

          {/* Control buttons */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                onClick={() => playAdjacentSegment(-1)}
                className="p-1.5 text-gray-400 hover:text-white rounded hover:bg-gray-700 transition-colors"
                title="Segmento anterior"
              >
                <SkipBack className="h-4 w-4" />
              </button>
              <button
                onClick={togglePlay}
                className="p-2 bg-blue-600 hover:bg-blue-700 text-white rounded-full transition-colors"
                title={isPlaying ? "Pausar" : "Reproducir"}
              >
                {isPlaying ? (
                  <Pause className="h-5 w-5" />
                ) : (
                  <Play className="h-5 w-5 ml-0.5" />
                )}
              </button>
              <button
                onClick={() => playAdjacentSegment(1)}
                className="p-1.5 text-gray-400 hover:text-white rounded hover:bg-gray-700 transition-colors"
                title="Siguiente segmento"
              >
                <SkipForward className="h-4 w-4" />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsMuted(!isMuted)}
                className="p-1.5 text-gray-400 hover:text-white rounded hover:bg-gray-700 transition-colors"
              >
                {isMuted ? (
                  <VolumeX className="h-4 w-4" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
              </button>
              <button
                onClick={downloadSegment}
                disabled={!currentSegment}
                className="p-1.5 text-gray-400 hover:text-white rounded hover:bg-gray-700 transition-colors disabled:opacity-30"
                title="Descargar segmento"
              >
                <Download className="h-4 w-4" />
              </button>
              <button
                onClick={toggleFullscreen}
                className="p-1.5 text-gray-400 hover:text-white rounded hover:bg-gray-700 transition-colors"
                title="Pantalla completa"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Timeline bar — segments visualization */}
        <div className="bg-gray-800 border-t border-gray-700 px-4 py-2">
          <div className="flex items-center gap-1 overflow-x-auto pb-1">
            {/* 24 hour slots */}
            {Array.from({ length: 24 }, (_, hour) => {
              const hourStr = hour.toString().padStart(2, "0");
              // Find segments in this hour
              const hourSegments = segments.filter((s) =>
                s.time.startsWith(hourStr + ":")
              );
              const hasData = hourSegments.length > 0;
              const isCurrent =
                currentSegment &&
                currentSegment.startsWith(hourStr + "-");
              return (
                <div key={hour} className="flex flex-col items-center min-w-[40px]">
                  <span className="text-[9px] text-gray-500 mb-0.5">
                    {hourStr}:00
                  </span>
                  <button
                    onClick={() => {
                      if (hourSegments.length > 0) {
                        playSegment(hourSegments[0].filename);
                      }
                    }}
                    disabled={!hasData}
                    className={`w-full h-3 rounded-sm transition-colors ${
                      isCurrent
                        ? "bg-blue-500"
                        : hasData
                        ? "bg-green-600 hover:bg-green-500 cursor-pointer"
                        : "bg-gray-700"
                    }`}
                    title={
                      hasData
                        ? `${hourSegments.length} segmentos (${hourSegments
                            .reduce((a, s) => a + s.size_mb, 0)
                            .toFixed(0)} MB)`
                        : "Sin grabacion"
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── RIGHT: Calendar + Segments ── */}
      <div className="w-64 border-l border-gray-200 bg-white flex flex-col shrink-0">
        {/* Calendar */}
        <div className="p-3 border-b border-gray-200">
          <div className="flex items-center justify-between mb-2">
            <button
              onClick={() =>
                setCalendarMonth((prev) => {
                  const d = new Date(prev.year, prev.month - 1);
                  return { year: d.getFullYear(), month: d.getMonth() };
                })
              }
              className="p-1 hover:bg-gray-100 rounded"
            >
              <ChevronLeft className="h-4 w-4 text-gray-500" />
            </button>
            <span className="text-sm font-medium text-gray-900">
              {monthNames[calendarMonth.month]} {calendarMonth.year}
            </span>
            <button
              onClick={() =>
                setCalendarMonth((prev) => {
                  const d = new Date(prev.year, prev.month + 1);
                  return { year: d.getFullYear(), month: d.getMonth() };
                })
              }
              className="p-1 hover:bg-gray-100 rounded"
            >
              <ChevronRight className="h-4 w-4 text-gray-500" />
            </button>
          </div>

          {/* Day headers */}
          <div className="grid grid-cols-7 gap-0.5 mb-1">
            {["Do", "Lu", "Ma", "Mi", "Ju", "Vi", "Sa"].map((d) => (
              <div
                key={d}
                className="text-center text-[10px] font-medium text-gray-400 py-0.5"
              >
                {d}
              </div>
            ))}
          </div>

          {/* Calendar days */}
          <div className="grid grid-cols-7 gap-0.5">
            {calendarDays.map((day, i) => {
              if (day === null) return <div key={`empty-${i}`} />;
              const dateStr = `${calendarMonth.year}-${(calendarMonth.month + 1)
                .toString()
                .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
              const hasRecording = availableDates.has(dateStr);
              const isSelected = dateStr === selectedDate;
              const isToday = dateStr === new Date().toISOString().slice(0, 10);

              return (
                <button
                  key={dateStr}
                  onClick={() => {
                    setSelectedDate(dateStr);
                    setCurrentSegment(null);
                  }}
                  className={`text-center py-1 text-xs rounded transition-colors ${
                    isSelected
                      ? "bg-blue-600 text-white font-bold"
                      : isToday
                      ? "bg-blue-100 text-blue-700 font-medium"
                      : hasRecording
                      ? "bg-green-50 text-green-700 hover:bg-green-100 font-medium"
                      : "text-gray-400 hover:bg-gray-50"
                  }`}
                >
                  {day}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-3 mt-2 text-[10px] text-gray-400">
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 rounded bg-green-200" />
              Con grabacion
            </div>
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 rounded bg-blue-600" />
              Seleccionado
            </div>
          </div>
        </div>

        {/* Time picker */}
        <div className="p-3 border-b border-gray-200">
          <div className="flex items-center gap-2 text-xs text-gray-700 mb-2">
            <Clock className="h-3.5 w-3.5" />
            <span className="font-medium">Ajustar hora</span>
          </div>
          <div className="flex items-center gap-1">
            <input
              type="time"
              className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-xs"
              onChange={(e) => {
                const [hh, mm] = e.target.value.split(":");
                // Find closest segment to this time
                const target = `${hh}-${mm}`;
                const closest = segments.find((s) =>
                  s.filename.startsWith(target)
                );
                if (closest) playSegment(closest.filename);
                else {
                  // Find segment that contains this time
                  const hhNum = parseInt(hh);
                  const mmNum = parseInt(mm);
                  for (const seg of segments) {
                    const [sh, sm] = seg.time.split(":").map(Number);
                    if (
                      sh === hhNum &&
                      sm <= mmNum &&
                      mmNum < sm + seg.duration_min
                    ) {
                      playSegment(seg.filename);
                      break;
                    }
                  }
                }
              }}
            />
            <button
              className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded hover:bg-blue-700"
              onClick={() => {
                // Reload recordings for this camera/date
                if (selectedCam) {
                  api
                    .get<RecordingsData>(
                      `/recordings?camera_id=${selectedCam}&date=${selectedDate}`
                    )
                    .then(setRecordings)
                    .catch(() => {});
                }
              }}
            >
              <Search className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Segment list */}
        <div className="flex-1 overflow-y-auto">
          <div className="p-3">
            <h3 className="text-xs font-semibold text-gray-700 mb-2">
              Segmentos — {selectedDate}
            </h3>
            {segments.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-4">
                Sin grabaciones para esta fecha
              </p>
            ) : (
              <div className="space-y-1">
                {segments.map((seg) => {
                  const isCurrent = currentSegment === seg.filename;
                  return (
                    <button
                      key={seg.filename}
                      onClick={() => playSegment(seg.filename)}
                      className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-xs transition-colors ${
                        isCurrent
                          ? "bg-blue-100 border border-blue-300 text-blue-800"
                          : "hover:bg-gray-50 text-gray-700"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {isCurrent && isPlaying ? (
                          <Pause className="h-3 w-3 text-blue-600" />
                        ) : (
                          <Play className="h-3 w-3 text-gray-400" />
                        )}
                        <span className="font-mono">{seg.time}</span>
                      </div>
                      <span className="text-gray-400">
                        {seg.size_mb} MB
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
