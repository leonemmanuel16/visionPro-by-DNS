"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, WifiOff } from "lucide-react";

interface VideoPlayerProps {
  cameraName: string;
  isOnline?: boolean;
  className?: string;
}

export function VideoPlayer({ cameraName, isOnline = true, className }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const go2rtcUrl = process.env.NEXT_PUBLIC_GO2RTC_URL || "http://localhost:1984";

  useEffect(() => {
    if (!isOnline || !videoRef.current) {
      setLoading(false);
      return;
    }

    const video = videoRef.current;
    let pc: RTCPeerConnection | null = null;

    async function startWebRTC() {
      try {
        pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });

        pc.ontrack = (event) => {
          if (video) {
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

        if (!res.ok) throw new Error("WebRTC negotiation failed");

        const answer = await res.text();
        await pc.setRemoteDescription({ type: "answer", sdp: answer });
      } catch (e) {
        console.warn("WebRTC failed, falling back to HLS:", e);
        fallbackToHLS();
      }
    }

    function fallbackToHLS() {
      import("hls.js").then(({ default: Hls }) => {
        if (!Hls.isSupported() || !video) {
          setError(true);
          setLoading(false);
          return;
        }

        const hls = new Hls({ liveDurationInfinity: true });
        hls.loadSource(
          `${go2rtcUrl}/api/stream.m3u8?src=${encodeURIComponent(cameraName)}`
        );
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(() => {});
          setLoading(false);
        });
        hls.on(Hls.Events.ERROR, () => {
          setError(true);
          setLoading(false);
        });
      });
    }

    startWebRTC();

    return () => {
      pc?.close();
    };
  }, [cameraName, isOnline, go2rtcUrl]);

  if (!isOnline) {
    return (
      <div className={`flex items-center justify-center bg-gray-200 rounded-lg ${className}`}>
        <div className="text-center text-gray-400">
          <WifiOff className="mx-auto h-8 w-8 mb-2" />
          <p className="text-sm">Camera Offline</p>
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
          <p className="text-sm text-gray-400">Stream unavailable</p>
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
