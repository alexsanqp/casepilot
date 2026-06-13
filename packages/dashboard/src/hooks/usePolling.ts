import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api/client';

export interface PollingState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function usePolling<T>(fn: () => Promise<T>, intervalMs: number | null): PollingState<T> {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Monotonic generation counter: each refresh() captures its own generation.
  // After awaiting, a call only applies state if it is still the latest one,
  // preventing a slow earlier response from clobbering a newer one.
  const genRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // Mark unmounted and bump the generation so any in-flight resolve bails.
      mountedRef.current = false;
      genRef.current += 1;
    };
  }, []);

  const refresh = useCallback(async () => {
    const gen = ++genRef.current;
    try {
      const result = await fnRef.current();
      if (gen !== genRef.current || !mountedRef.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (gen !== genRef.current || !mountedRef.current) return;
      setError(errorMessage(err));
    } finally {
      if (gen === genRef.current && mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [fn, refresh]);

  useEffect(() => {
    if (intervalMs === null) return;
    const id = window.setInterval(() => void refresh(), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, refresh]);

  return { data, error, loading, refresh };
}
