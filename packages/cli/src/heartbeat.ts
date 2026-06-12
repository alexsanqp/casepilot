export const HEARTBEAT_INTERVAL_MS = 15_000;

export function formatHeartbeat(label: string, elapsedMs: number): string {
  return `[${label}] still working... ${Math.round(elapsedMs / 1000)}s elapsed`;
}

export interface HeartbeatOptions {
  label: string;
  write: (line: string) => void;
  intervalMs?: number;
  now?: () => number;
}

export function startHeartbeat({
  label,
  write,
  intervalMs = HEARTBEAT_INTERVAL_MS,
  now = Date.now,
}: HeartbeatOptions): () => void {
  const startedAt = now();
  const timer = setInterval(() => {
    write(formatHeartbeat(label, now() - startedAt));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
