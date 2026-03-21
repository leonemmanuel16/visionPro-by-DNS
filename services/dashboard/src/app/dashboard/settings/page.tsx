"use client";

import { useEffect, useState } from "react";
import { Header } from "@/components/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";

interface UserInfo {
  id: string;
  username: string;
  email: string;
  role: string;
}

export default function SettingsPage() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [newUser, setNewUser] = useState({ username: "", email: "", password: "", role: "viewer" });
  const [showCreate, setShowCreate] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    api.get<UserInfo>("/auth/me").then(setUser).catch(console.error);
  }, []);

  const handleCreateUser = async () => {
    try {
      await api.post("/auth/register", newUser);
      setMessage("User created successfully");
      setShowCreate(false);
      setNewUser({ username: "", email: "", password: "", role: "viewer" });
    } catch (e: any) {
      setMessage(`Error: ${e.message}`);
    }
  };

  return (
    <>
      <Header title="Settings" />
      <div className="p-6 space-y-6 max-w-2xl">
        {/* Current User */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your Account</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {user && (
              <>
                <div className="flex justify-between"><span className="text-gray-500">Username</span><span>{user.username}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Email</span><span>{user.email}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Role</span><Badge>{user.role}</Badge></div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Create User (admin only) */}
        {user?.role === "admin" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">User Management</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {message && (
                <div className="rounded-md bg-gray-100 p-3 text-sm text-blue-600">{message}</div>
              )}
              {showCreate ? (
                <div className="space-y-3">
                  <Input placeholder="Username" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} />
                  <Input placeholder="Email" type="email" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} />
                  <Input placeholder="Password" type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} />
                  <select
                    className="w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2 text-sm text-gray-700"
                    value={newUser.role}
                    onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                  >
                    <option value="viewer">Viewer</option>
                    <option value="operator">Operator</option>
                    <option value="admin">Admin</option>
                  </select>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
                    <Button onClick={handleCreateUser}>Create User</Button>
                  </div>
                </div>
              ) : (
                <Button variant="outline" onClick={() => setShowCreate(true)}>Create User</Button>
              )}
            </CardContent>
          </Card>
        )}

        {/* System Info */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">System Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-gray-500">Version</span><span>1.0.0</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Platform</span><span>DNS Vision Pro</span></div>
            <div className="flex justify-between"><span className="text-gray-500">License</span><span>Proprietary</span></div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
