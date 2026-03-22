"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, WifiOff, VideoOff } from "lucide-react";
import { getGo2rtcUrl } from "@/lib/urls";

interface VideoPlayerProps {
  cameraName: string;
  isOnline?: boolean;
  className?: string;
}

export function VideoPlayer({ cameraName, isOnline = true, className }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [errorMsg, setErrorMsg] = useState("Stream no disponible");

  const go2rtcUrl = getGo2rtcUrl();

  useEffect(() => {
    if (!isOnline || !videoRef.current) {
      setLoading(false);
      return;
    }

    const video = videoRef.current;
    let pc: RTCPeerConnection | null = null;
    let ws: WebSocket | null = null;
    let cancelled = false;

    // Try MSE first (supports H.265), then WebRTC, then HLS
    async function startMSE() {
      try {
        const wsProto = go2rtcUrl.startsWith("https") ? "wss" : "ws";
        const host = go2rtcUrl.replace(/^https?:\/\//, "");
        const wsUrl = `${wsProto}://${host}/api/ws?src=${encodeURIComponent(cameraName)}`;

        ws = new WebSocket(wsUrl);
        ws.binaryType = "arraybuffer";

        const mediaSource = new MediaSource();
        video.src = URL.createObjectURL(mediaSource);

        let sourceBuffer: SourceBuffer | null = null;
        let pendingBuffers: ArrayBuffer[] = [];

        mediaSource.addEventListener("sourceopen", () => {
          // Try H.265 first, fallback to H.264
          try {
            sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="hvc1.1.6.L93.B0"');
          } catch {
            try {
              sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.640028"');
            } catch {
              if (!cancelled) {
                console.warn("MSE: No compatible codec, trying WebRTC");
                ws?.close();
                startWebRTC();
                return;
              }
            }
          }

          if (sourceBuffer) {
            sourceBuffer.addEventListener("updateend", () => {
              if (pendingBuffers.length > 0 && sourceBuffer && !sourceBuffer.updating) {
                sourceBuffer.appendBuffer(pendingBuffers.shift()!);
              }
            });
          }
        });

        ws.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer && sourceBuffer) {
            if (sourceBuffer.updating || pendingBuffers.length > 0) {
              pendingBuffers.push(event.data);
              // Limit buffer to avoid memory leaks
              if (pendingBuffers.length > 100) pendingBuffers.shift();
            } else {
              try {
                sourceBuffer.appendBuffer(event.data);
                if (!cancelled) {
                  setLoading(false);
                  setError(false);
                }
              } catch {
                pendingBuffers.push(event.data);
              }
            }
          }
        };

        ws.onerror = () => {
          if (!cancelled) {
            console.warn("MSE WebSocket failed, trying WebRTC");
            startWebRTC();
          }
        };

        ws.onclose = (event) => {
          if (!cancelled && event.code !== 1000) {
            console.warn("MSE closed unexpectedly, trying WebRTC");
            startWebRTC();
          }
        };

        // Timeout: if no data in 5s, fallback
        setTimeout(() => {
          if (!cancelled && loading) {
            console.warn("MSE timeout, trying WebRTC");
            ws?.close();
            startWebRTC();
          }
        }, 5000);

      } catch (e) {
        if (!cancelled) {
          console.warn("MSE failed:", e);
          startWebRTC();
        }
      }
    }

    async function startWebRTC() {
      try {
        pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });

        pc.ontrack = (event) => {
          if (video && !cancelled) {
            video.srcObject = event.streams[0];
            setLoading(false);
            setError(false);
          }
        };

        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const res = await fetch(
          `${go2rtcUrl}/api/webrtc?src=${encodeURIComponent(cameraName)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/sdp" },
            body: offer.sdp,
          }
        );

        if (!res.ok) {
          if (res.status === 404) {
            if (!cancelled) {
              setErrorMsg("Stream no encontrado en go2rtc");
              setError(true);
              setLoading(false);
            }
            return;
          }
          throw new Error(`WebRTC ${res.status}`);
        }

        const answer = await res.text();
        await pc.setRemoteDescription({ type: "answer", sdp: answer });

        // Timeout for video track
        setTimeout(() => {
          if (!cancelled && loading) {
            console.warn("WebRTC timeout, trying HLS");
            pc?.close();
            fallbackToHLS();
          }
        }, 8000);

      } catch (e) {
        if (!cancelled) {
          console.warn("WebRTC failed, falling back to HLS:", e);
          fallbackToHLS();
        }
      }
    }

    function fallbackToHLS() {
      import("hls.js").then(({ default: Hls }) => {
        if (cancelled || !Hls.isSupported() || !video) {
          if (!cancelled) {
            setErrorMsg("Stream no disponible");
            setError(true);
            setLoading(false);
          }
          return;
        }

        const hls = new Hls({ liveDurationInfinity: true });
        hls.loadSource(
          `${go2rtcUrl}/api/stream.m3u8?src=${encodeURIComponent(cameraName)}`
        );
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (!cancelled) {
            video.play().catch(() => {});
            setLoading(false);
          }
        });
        hls.on(Hls.Events.ERROR, () => {
          if (!cancelled) {
            setErrorMsg("Stream no disponible");
            setError(true);
            setLoading(false);
          }
        });
      }).catch(() => {
        if (!cancelled) {
          setErrorMsg("Stream no disponible");
          setError(true);
          setLoading(false);
        }
      });
    }

    // Start with MSE (best H.265 support)
    startMSE();

    return () => {
      cancelled = true;
      pc?.close();
      ws?.close();
    };
  }, [cameraName, isOnline, go2rtcUrl]);

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
          <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
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
    </div>
  );
}
