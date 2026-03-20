"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getToken, removeTokens } from "@/lib/auth";
import { api } from "@/lib/api";

interface User {
  id: string;
  username: string;
  email: string;
  role: string;
}

export function useAuth() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setLoading(false);
      router.push("/login");
      return;
    }

    api.get<User>("/auth/me")
      .then(setUser)
      .catch(() => {
        removeTokens();
        router.push("/login");
      })
      .finally(() => setLoading(false));
  }, [router]);

  const logout = () => {
    removeTokens();
    router.push("/login");
  };

  return { user, loading, logout, isAuthenticated: !!user };
}
