"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { setTokens } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "Invalid username or password");
      }

      const data = await res.json();
      setTokens(data.access_token, data.refresh_token);
      router.push("/dashboard");
    } catch (err: any) {
      if (err instanceof TypeError && err.message === "Failed to fetch") {
        // API not available — allow demo access with default credentials
        if (username === "admin" && password === "admin123") {
          setTokens("demo-access-token", "demo-refresh-token");
          router.push("/dashboard");
          return;
        }
        setError("Cannot connect to API server. Use admin/admin123 for demo mode, or start services with: docker compose up -d");
      } else {
        setError(err.message || "Login failed");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/dns-logo.png"
              alt="DNS Integradores TI"
              style={{ height: "120px", width: "auto" }}
              className="object-contain"
            />
          </div>
          <CardTitle className="text-lg text-gray-900">Vision Pro</CardTitle>
          <p className="text-sm text-gray-500">Sign in to your account</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            {error && (
              <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-600">
                {error}
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm text-gray-700">Username</label>
              <Input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
                required
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-gray-700">Password</label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in..." : "Sign In"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
