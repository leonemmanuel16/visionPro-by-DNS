"use client";

import { useEffect, useRef, useCallback, useState } from "react";

interface WebGLDewarperProps {
  videoElement: HTMLVideoElement | null;
  mode: "panoramic" | "quad" | "interactive";
  initialYaw?: number;
  initialPitch?: number;
  initialFov?: number;
  centerX?: number;
  centerY?: number;
  radius?: number;
  className?: string;
}

// Vertex shader — simple fullscreen quad
const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_texCoord;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_position * 0.5 + 0.5;
}`;

// Fragment shader — equidistant fisheye → rectilinear (flat) projection
// For ceiling-mounted fisheye cameras (Hikvision, Dahua, etc.)
//
// Coordinate system:
//   Fisheye optical axis = +Z (pointing DOWN from ceiling to floor)
//   Center of fisheye image = theta=0 (looking straight down)
//   Edge of fisheye circle = theta=PI/2 (looking at horizon)
//
// Virtual camera:
//   yaw = rotation around Z (which wall to look at)
//   pitch = tilt from Z toward horizon (0°=floor, 90°=horizon)
//   fov = field of view of the flat output
const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_video;
uniform float u_yaw;      // radians — which direction to look
uniform float u_pitch;    // radians — tilt (0=down, PI/2=horizon)
uniform float u_fov;      // radians — output field of view
uniform float u_centerX;  // fisheye center in texture (0-1)
uniform float u_centerY;  // fisheye center in texture (0-1)
uniform float u_radius;   // fisheye circle radius in Y texture coords (height-normalized)
uniform float u_aspect;   // output width/height ratio
uniform float u_srcAspect; // source video width/height (e.g. 1.778 for 16:9)

const float PI = 3.14159265359;

void main() {
  // Output pixel to normalized [-1, 1]
  float x = (v_texCoord.x - 0.5) * 2.0;
  float y = (0.5 - v_texCoord.y) * 2.0;  // flip Y so up is positive

  // Ray in virtual camera space (pinhole model, looking along +Z)
  float f = 1.0 / tan(u_fov * 0.5);
  vec3 ray = normalize(vec3(x * u_aspect, y, f));

  // Rotate ray: first pitch around X axis (tilt from Z toward XY plane)
  // For ceiling mount: pitch=0 looks straight down, pitch=PI/2 looks at walls
  float cp = cos(u_pitch), sp = sin(u_pitch);
  vec3 pitched = vec3(
    ray.x,
    ray.y * cp - ray.z * sp,
    ray.y * sp + ray.z * cp
  );

  // Then yaw around Z axis (rotate in the XY plane)
  float cy = cos(u_yaw), sy = sin(u_yaw);
  vec3 dir = vec3(
    pitched.x * cy - pitched.y * sy,
    pitched.x * sy + pitched.y * cy,
    pitched.z
  );

  // Convert 3D direction to equidistant fisheye coordinates
  // theta = angle from +Z axis (optical axis, pointing down)
  float theta = acos(clamp(dir.z, -1.0, 1.0));
  // phi = angle in XY plane
  float phi = atan(dir.y, dir.x);

  // Equidistant projection: distance from center proportional to theta
  // For 180° fisheye: theta goes from 0 to PI/2, mapping to 0 to radius
  float r = (theta / (PI * 0.5)) * u_radius;

  // Map to texture coordinates
  // The fisheye circle is circular in pixel space, but the source image is
  // typically 16:9, so in texture coords X needs scaling by 1/srcAspect.
  // u_radius is the circle radius normalized by image HEIGHT.
  float u = u_centerX + r * cos(phi) / u_srcAspect;
  float v = u_centerY + r * sin(phi);

  // Bounds check
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0 || theta > PI * 0.5 * 1.1) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
  } else {
    fragColor = texture(u_video, vec2(u, v));
  }
}`;

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("Shader compile error:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vs = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vs || !fs) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("Program link error:", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

/**
 * Single WebGL dewarped canvas view.
 * Renders one perspective from the fisheye video.
 */
function DewarperCanvas({
  videoElement,
  yaw,
  pitch,
  fov,
  centerX,
  centerY,
  radius,
  interactive = false,
  className = "",
}: {
  videoElement: HTMLVideoElement | null;
  yaw: number;
  pitch: number;
  fov: number;
  centerX: number;
  centerY: number;
  radius: number;
  interactive?: boolean;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<WebGL2RenderingContext | null>(null);
  const programRef = useRef<WebGLProgram | null>(null);
  const textureRef = useRef<WebGLTexture | null>(null);
  const animRef = useRef<number>(0);
  const [currentYaw, setCurrentYaw] = useState(yaw);
  const [currentPitch, setCurrentPitch] = useState(pitch);
  const [currentFov, setCurrentFov] = useState(fov);
  const draggingRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });

  // Update from props when not interactive
  useEffect(() => {
    if (!interactive) {
      setCurrentYaw(yaw);
      setCurrentPitch(pitch);
      setCurrentFov(fov);
    }
  }, [yaw, pitch, fov, interactive]);

  // Initialize WebGL
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false });
    if (!gl) {
      console.error("WebGL2 not supported");
      return;
    }
    glRef.current = gl;

    const program = createProgram(gl);
    if (!program) return;
    programRef.current = program;

    // Fullscreen quad vertices
    const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Create video texture
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    textureRef.current = texture;

    return () => {
      cancelAnimationFrame(animRef.current);
      gl.deleteProgram(program);
      gl.deleteTexture(texture);
      gl.deleteBuffer(vbo);
      gl.deleteVertexArray(vao);
      glRef.current = null;
      programRef.current = null;
    };
  }, []);

  // Render loop
  useEffect(() => {
    if (!videoElement || !glRef.current || !programRef.current || !textureRef.current) return;

    const gl = glRef.current;
    const program = programRef.current;
    const texture = textureRef.current;

    const render = () => {
      const canvas = canvasRef.current;
      if (!canvas || !gl || videoElement.readyState < 2) {
        animRef.current = requestAnimationFrame(render);
        return;
      }

      // Resize canvas to match display size
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio, 1.5);
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      gl.viewport(0, 0, w, h);
      gl.useProgram(program);

      // Upload video frame as texture
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);

      // Set uniforms
      // Source video aspect ratio — fisheye circle is circular in pixels,
      // but texture coords are normalized, so X needs compensation
      const srcAspect = videoElement.videoWidth / (videoElement.videoHeight || 1) || 16 / 9;

      gl.uniform1i(gl.getUniformLocation(program, "u_video"), 0);
      gl.uniform1f(gl.getUniformLocation(program, "u_yaw"), currentYaw * Math.PI / 180);
      gl.uniform1f(gl.getUniformLocation(program, "u_pitch"), currentPitch * Math.PI / 180);
      gl.uniform1f(gl.getUniformLocation(program, "u_fov"), currentFov * Math.PI / 180);
      gl.uniform1f(gl.getUniformLocation(program, "u_centerX"), centerX);
      gl.uniform1f(gl.getUniformLocation(program, "u_centerY"), centerY);
      gl.uniform1f(gl.getUniformLocation(program, "u_radius"), radius);
      gl.uniform1f(gl.getUniformLocation(program, "u_aspect"), w / h);
      gl.uniform1f(gl.getUniformLocation(program, "u_srcAspect"), srcAspect);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      animRef.current = requestAnimationFrame(render);
    };

    animRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animRef.current);
  }, [videoElement, currentYaw, currentPitch, currentFov, centerX, centerY, radius]);

  // Interactive mouse drag for pan/tilt
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!interactive) return;
    draggingRef.current = true;
    lastMouseRef.current = { x: e.clientX, y: e.clientY };
  }, [interactive]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!interactive || !draggingRef.current) return;
    const dx = e.clientX - lastMouseRef.current.x;
    const dy = e.clientY - lastMouseRef.current.y;
    lastMouseRef.current = { x: e.clientX, y: e.clientY };

    setCurrentYaw((prev) => prev + dx * 0.3);
    setCurrentPitch((prev) => Math.max(-89, Math.min(89, prev + dy * 0.3)));
  }, [interactive]);

  const handleMouseUp = useCallback(() => {
    draggingRef.current = false;
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!interactive) return;
    e.preventDefault();
    setCurrentFov((prev) => Math.max(30, Math.min(120, prev + e.deltaY * 0.1)));
  }, [interactive]);

  return (
    <canvas
      ref={canvasRef}
      className={`${className} ${interactive ? "cursor-grab active:cursor-grabbing" : ""}`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
    />
  );
}

/**
 * WebGLDewarper — Renders dewarped views of a fisheye video using WebGL2 shaders.
 */
export function WebGLDewarper({
  videoElement,
  mode,
  initialYaw = 0,
  initialPitch = 70,
  initialFov = 90,
  centerX = 0.50,
  centerY = 0.50,
  radius = 0.48,  // Hikvision ceiling fisheye: circle fills ~96% of frame height
  className = "",
}: WebGLDewarperProps) {
  if (!videoElement) {
    return (
      <div className={`flex items-center justify-center bg-gray-900 rounded-lg aspect-video ${className}`}>
        <p className="text-sm text-gray-500">Esperando video...</p>
      </div>
    );
  }

  if (mode === "quad") {
    return (
      <div className={`grid grid-cols-2 gap-2 ${className}`}>
        {[
          { yaw: 0, pitch: 60, label: "Vista 1 — Norte" },
          { yaw: 90, pitch: 60, label: "Vista 2 — Este" },
          { yaw: 180, pitch: 60, label: "Vista 3 — Sur" },
          { yaw: 270, pitch: 60, label: "Vista 4 — Oeste" },
        ].map((q, i) => (
          <div key={i} className="relative rounded-lg overflow-hidden border border-gray-200">
            <DewarperCanvas
              videoElement={videoElement}
              yaw={q.yaw}
              pitch={q.pitch}
              fov={60}
              centerX={centerX}
              centerY={centerY}
              radius={radius}
              className="w-full aspect-[4/3] bg-gray-900"
            />
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2">
              <span className="text-[11px] font-medium text-white">{q.label}</span>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (mode === "panoramic") {
    return (
      <div className={`relative rounded-lg overflow-hidden border border-gray-200 ${className}`}>
        <DewarperCanvas
          videoElement={videoElement}
          yaw={0}
          pitch={60}
          fov={160}
          centerX={centerX}
          centerY={centerY}
          radius={radius}
          className="w-full aspect-[2/1] bg-gray-900"
        />
        <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded">
          Panorámica 360°
        </div>
      </div>
    );
  }

  // Interactive mode
  return (
    <div className={`relative rounded-lg overflow-hidden border border-gray-200 ${className}`}>
      <DewarperCanvas
        videoElement={videoElement}
        yaw={initialYaw}
        pitch={initialPitch}
        fov={initialFov}
        centerX={centerX}
        centerY={centerY}
        radius={radius}
        interactive
        className="w-full aspect-video bg-gray-900"
      />
      <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded">
        Interactivo — Arrastra para girar, scroll para zoom
      </div>
    </div>
  );
}
