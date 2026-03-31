"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface ActivityPoint {
  hour: string;
  count: number;
}

export function ActivityChartWidget() {
  const [activity, setActivity] = useState<ActivityPoint[]>([]);

  useEffect(() => {
    api.get<ActivityPoint[]>("/dashboard/activity").then(setActivity).catch(() => {});
    const interval = setInterval(() => {
      api.get<ActivityPoint[]>("/dashboard/activity").then(setActivity).catch(() => {});
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  if (activity.length === 0) {
    return <p className="text-sm text-gray-400 py-8 text-center">Sin datos de actividad</p>;
  }

  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={activity}>
          <XAxis dataKey="hour" stroke="#9ca3af" fontSize={11} />
          <YAxis stroke="#9ca3af" fontSize={11} />
          <Tooltip
            contentStyle={{
              backgroundColor: "#ffffff",
              border: "1px solid #e5e7eb",
              borderRadius: "8px",
              color: "#374151",
              fontSize: "12px",
            }}
          />
          <Bar dataKey="count" fill="#2563eb" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
