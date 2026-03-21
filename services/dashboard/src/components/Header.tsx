"use client";

import { Bell, LogOut, User } from "lucide-react";
import { useRouter } from "next/navigation";
import { removeTokens } from "@/lib/auth";
import { Button } from "@/components/ui/button";

export function Header({ title }: { title?: string }) {
  const router = useRouter();

  const handleLogout = () => {
    removeTokens();
    router.push("/login");
  };

  return (
    <header className="flex h-16 items-center justify-between border-b border-gray-200 bg-white px-6">
      <h1 className="text-xl font-semibold text-gray-900">{title || "Dashboard"}</h1>
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-5 w-5" />
          <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white">
            0
          </span>
        </Button>
        <Button variant="ghost" size="icon">
          <User className="h-5 w-5" />
        </Button>
        <Button variant="ghost" size="icon" onClick={handleLogout}>
          <LogOut className="h-5 w-5" />
        </Button>
      </div>
    </header>
  );
}
