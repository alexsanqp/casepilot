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

  const refresh = useCallback(async () => {
    try {
      const result = await fnRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
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
