"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Loader2, WifiOff, VideoOff } from "lucide-react";
import { getGo2rtcUrl } from "@/lib/urls";

interface VideoPlayerProps {
  cameraName: string;
  isOnline?: boolean;
  className?: string;
}

/**
 * VideoPlayer with sequential stream candidate fallback.
 *
 * For each camera (e.g. cam_abc123), tries streams in order:
 *   1. cam_abc123_h264      (main transcoded to H.264 — best browser compat)
 *   2. cam_abc123_sub_h264  (sub transcoded to H.264 — lighter)
 *   3. cam_abc123_sub       (raw sub — may be H.264 already)
 *   4. cam_abc123           (raw main — may be H.265, MSE only)
 *
 * For each candidate: WebRTC first, then HLS fallback.
 * If all fail: "Stream no disponible".
 */
export function VideoPlayer({ cameraName, isOnline = true, className }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [errorMsg, setErrorMsg] = useState("Stream no disponible");
  const [activeStream, setActiveStream] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const go2rtcUrl = getGo2rtcUrl();

  // Generate ordered candidate list
  const getCandidates = useCallback((base: string): string[] => {
    return [
      `${base}_h264`,       // Main transcoded H.264
      `${base}_sub_h264`,   // Sub transcoded H.264
      `${base}_sub`,        // Raw sub-stream
      base,                 // Raw main stream
    ];
  }, []);

  useEffect(() => {
    if (!isOnline || !videoRef.current) {
      setLoading(false);
      return;
    }

    const video = videoRef.current;
    let currentPc: RTCPeerConnection | null = null;
    cancelledRef.current = false;

    async function tryWebRTC(streamName: string): Promise<boolean> {
      return new Promise((resolve) => {
        if (cancelledRef.current) { resolve(false); return; }

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        currentPc = pc;

        let resolved = false;
        const done = (success: boolean) => {
          if (!resolved) {
            resolved = true;
            if (!success) pc.close();
            resolve(success);
          }
        };

        // Timeout: 6s per candidate
        const timer = setTimeout(() => done(false), 6000);

        pc.ontrack = (event) => {
          if (video && !cancelledRef.current) {
            video.srcObject = event.streams[0];
            // Wait for actual video data
            video.onloadeddata = () => {
              clearTimeout(timer);
              setLoading(false);
              setError(false);
              setActiveStream(streamName);
              done(true);
            };
          }
        };

        pc.oniceconnectionstatechange = () => {
          if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
            clearTimeout(timer);
            done(false);
          }
        };

        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });

        pc.createOffer()
          .then((offer) => pc.setLocalDescription(offer).then(() => offer))
          .then((offer) =>
            fetch(`${go2rtcUrl}/api/webrtc?src=${encodeURIComponent(streamName)}`, {
              method: "POST",
              headers: { "Content-Type": "application/sdp" },
              body: offer.sdp,
            })
          )
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.text();
          })
          .then((sdp) => pc.setRemoteDescription({ type: "answer", sdp }))
          .catch(() => {
            clearTimeout(timer);
            done(false);
          });
      });
    }

    async function tryHLS(streamName: string): Promise<boolean> {
      return new Promise((resolve) => {
        if (cancelledRef.current) { resolve(false); return; }

        import("hls.js")
          .then(({ default: Hls }) => {
            if (!Hls.isSupported() || !video || cancelledRef.current) {
              resolve(false);
              return;
            }

            let resolved = false;
            const done = (success: boolean) => {
              if (!resolved) {
                resolved = true;
                if (!success) hls.destroy();
                resolve(success);
              }
            };

            const timer = setTimeout(() => done(false), 8000);

            const hls = new Hls({
              liveDurationInfinity: true,
              enableWorker: true,
              lowLatencyMode: true,
            });

            hls.loadSource(
              `${go2rtcUrl}/api/stream.m3u8?src=${encodeURIComponent(streamName)}`
            );
            hls.attachMedia(video);

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              if (!cancelledRef.current) {
                video.play().catch(() => {});
                setLoading(false);
                setError(false);
                setActiveStream(streamName);
                clearTimeout(timer);
                done(true);
              }
            });

            hls.on(Hls.Events.ERROR, (_event: any, data: any) => {
              if (data.fatal) {
                clearTimeout(timer);
                done(false);
              }
            });
          })
          .catch(() => resolve(false));
      });
    }

    async function tryAllCandidates() {
      const candidates = getCandidates(cameraName);

      for (const candidate of candidates) {
        if (cancelledRef.current) break;

        if (process.env.NODE_ENV === "development") {
          console.log(`[VideoPlayer] Trying WebRTC: ${candidate}`);
        }

        // Try WebRTC first
        const webrtcOk = await tryWebRTC(candidate);
        if (webrtcOk || cancelledRef.current) return;

        if (process.env.NODE_ENV === "development") {
          console.log(`[VideoPlayer] Trying HLS: ${candidate}`);
        }

        // Try HLS fallback
        const hlsOk = await tryHLS(candidate);
        if (hlsOk || cancelledRef.current) return;
      }

      // All candidates exhausted
      if (!cancelledRef.current) {
        setErrorMsg("Stream no disponible — Verifique la conexión RTSP de la cámara");
        setError(true);
        setLoading(false);
      }
    }

    tryAllCandidates();

    return () => {
      cancelledRef.current = true;
      currentPc?.close();
    };
  }, [cameraName, isOnline, go2rtcUrl, getCandidates]);

  if (!isOnline) {
    return (
      <div className={`flex items-center justify-center bg-gray-200 rounded-lg ${className}`}>
        <div className="text-center text-gray-400">
          <WifiOff className="mx-auto h-8 w-8 mb-2" />
          <p className="text-sm">Cámara Offline</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`relative bg-black rounded-lg overflow-hidden ${className}`}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100">
          <div className="text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-blue-500" />
            <p className="text-xs text-gray-400 mt-2">Conectando...</p>
          </div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100">
          <div className="text-center text-gray-400">
            <VideoOff className="mx-auto h-6 w-6 mb-1" />
            <p className="text-sm">{errorMsg}</p>
          </div>
        </div>
      )}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full h-full object-contain"
      />
      {activeStream && process.env.NODE_ENV === "development" && (
        <div className="absolute bottom-1 left-1 text-[10px] bg-black/50 text-green-400 px-1.5 py-0.5 rounded font-mono">
          {activeStream}
        </div>
      )}
    </div>
  );
}
