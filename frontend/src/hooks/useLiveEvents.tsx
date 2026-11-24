import React, { createContext, useContext, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getSseStreamUrl } from '@/api/client';

export interface LiveEvent {
  event_type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

interface LiveEventsContextValue {
  connected: boolean;
  events: LiveEvent[];
}

const LiveEventsContext = createContext<LiveEventsContextValue>({ connected: false, events: [] });

export function LiveEventsProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<LiveEvent[]>([]);

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }
    const url = getSseStreamUrl();
    if (!url) return;

    let es: EventSource | null = null;
    let closed = false;
    let retryTimer: number | undefined;

    const connect = () => {
      if (closed) return;
      es = new EventSource(url);

      es.addEventListener('connected', (evt) => {
        setConnected(true);
        try {
          const parsed = JSON.parse((evt as MessageEvent).data);
          if (Array.isArray(parsed.recent)) {
            setEvents(parsed.recent.slice(0, 20));
          }
        } catch {
          // ignore parse errors
        }
      });

      es.addEventListener('update', (evt) => {
        try {
          const item = JSON.parse((evt as MessageEvent).data) as LiveEvent;
          setEvents((prev) => [item, ...prev].slice(0, 30));
          queryClient.invalidateQueries({ queryKey: ['analytics'] });
          queryClient.invalidateQueries({ queryKey: ['responses'] });
          queryClient.invalidateQueries({ queryKey: ['pipeline'] });
          queryClient.invalidateQueries({ queryKey: ['quality'] });
          queryClient.invalidateQueries({ queryKey: ['notifications'] });
          queryClient.invalidateQueries({ queryKey: ['surveys'] });
        } catch {
          // ignore
        }
      });

      es.addEventListener('reconnect', () => {
        es?.close();
        if (!closed) {
          retryTimer = window.setTimeout(connect, 8000);
        }
      });

      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!closed) {
          retryTimer = window.setTimeout(connect, 5000);
        }
      };
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      es?.close();
      setConnected(false);
    };
  }, [enabled, queryClient]);

  return (
    <LiveEventsContext.Provider value={{ connected, events }}>
      {children}
    </LiveEventsContext.Provider>
  );
}

export function useLiveEventsContext(): LiveEventsContextValue {
  return useContext(LiveEventsContext);
}
