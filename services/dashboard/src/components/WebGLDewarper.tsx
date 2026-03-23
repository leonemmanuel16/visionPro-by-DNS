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

// Fragment shader — equidistant fisheye → rectilinear projection
const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_video;
uniform float u_yaw;      // radians
uniform float u_pitch;    // radians
uniform float u_fov;      // radians (horizontal FOV)
uniform float u_centerX;  // fisheye center X (0-1)
uniform float u_centerY;  // fisheye center Y (0-1)
uniform float u_radius;   // fisheye radius (0-1)
uniform float u_aspect;   // output aspect ratio (w/h)

mat3 rotationY(float angle) {
  float c = cos(angle); float s = sin(angle);
  return mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c);
}

mat3 rotationX(float angle) {
  float c = cos(angle); float s = sin(angle);
  return mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c);
}

void main() {
  // Convert output pixel to normalized coords centered at 0
  float halfFov = u_fov * 0.5;
  float x = (v_texCoord.x - 0.5) * 2.0 * tan(halfFov) * u_aspect;
  float y = (v_texCoord.y - 0.5) * 2.0 * tan(halfFov);

  // Create 3D ray direction (pinhole camera model, looking down -Z)
  vec3 ray = normalize(vec3(x, -y, -1.0));

  // Rotate ray by yaw (around Y) and pitch (around X)
  ray = rotationY(u_yaw) * rotationX(u_pitch) * ray;

  // Convert to spherical coordinates
  float theta = acos(clamp(-ray.z, -1.0, 1.0)); // angle from optical axis (camera looks -Z)
  float phi = atan(ray.y, ray.x);                // azimuth

  // Map to fisheye texture coordinates (equidistant projection)
  float r = (theta / 3.14159265) * u_radius * 2.0;

  float u = u_centerX + r * cos(phi);
  float v = u_centerY + r * sin(phi);

  // Check bounds
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0 || r > u_radius) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
  } else {
    fragColor = texture(u_video, vec2(u, 1.0 - v));
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
      const dpr = Math.min(window.devicePixelRatio, 2);
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
      gl.uniform1i(gl.getUniformLocation(program, "u_video"), 0);
      gl.uniform1f(gl.getUniformLocation(program, "u_yaw"), currentYaw * Math.PI / 180);
      gl.uniform1f(gl.getUniformLocation(program, "u_pitch"), currentPitch * Math.PI / 180);
      gl.uniform1f(gl.getUniformLocation(program, "u_fov"), currentFov * Math.PI / 180);
      gl.uniform1f(gl.getUniformLocation(program, "u_centerX"), centerX);
      gl.uniform1f(gl.getUniformLocation(program, "u_centerY"), centerY);
      gl.uniform1f(gl.getUniformLocation(program, "u_radius"), radius);
      gl.uniform1f(gl.getUniformLocation(program, "u_aspect"), w / h);

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
  initialPitch = 0,
  initialFov = 90,
  centerX = 0.5,
  centerY = 0.5,
  radius = 0.5,
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
          { yaw: 0, label: "Vista 1 — Norte" },
          { yaw: 90, label: "Vista 2 — Este" },
          { yaw: 180, label: "Vista 3 — Sur" },
          { yaw: 270, label: "Vista 4 — Oeste" },
        ].map((q, i) => (
          <div key={i} className="relative rounded-lg overflow-hidden border border-gray-200">
            <DewarperCanvas
              videoElement={videoElement}
              yaw={q.yaw}
              pitch={0}
              fov={90}
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
          pitch={0}
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
