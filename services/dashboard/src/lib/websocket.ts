"use client";

import { getWsUrl } from "./urls";

type EventCallback = (data: any) => void;

class WebSocketClient {
  private ws: WebSocket | null = null;
  private listeners: Map<string, Set<EventCallback>> = new Map();
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private shouldReconnect = true;

  private get url(): string {
    return getWsUrl();
  }

  connect() {
    const token = localStorage.getItem("access_token");
    if (!token) return;

    try {
      this.ws = new WebSocket(`${this.url}?token=${token}`);

      this.ws.onopen = () => {
        this.reconnectDelay = 1000;
        this.emit("connected", {});
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.emit(data.type || "message", data);
        } catch {
          // ignore parse errors
        }
      };

      this.ws.onclose = () => {
        this.emit("disconnected", {});
        if (this.shouldReconnect) {
          setTimeout(() => this.connect(), this.reconnectDelay);
          this.reconnectDelay = Math.min(
            this.reconnectDelay * 2,
            this.maxReconnectDelay
          );
        }
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      // ignore connection errors, will retry
    }
  }

  disconnect() {
    this.shouldReconnect = false;
    this.ws?.close();
  }

  on(event: string, callback: EventCallback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  off(event: string, callback: EventCallback) {
    this.listeners.get(event)?.delete(callback);
  }

  private emit(event: string, data: any) {
    this.listeners.get(event)?.forEach((cb) => cb(data));
  }
}

export const wsClient = new WebSocketClient();
