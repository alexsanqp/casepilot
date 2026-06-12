export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}

export function runDuration(startedAt: string, finishedAt?: string): string {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return '-';
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (Number.isNaN(end)) return '-';
  return formatDuration(end - start);
}

export function relativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  return new Date(ts).toLocaleString();
}
