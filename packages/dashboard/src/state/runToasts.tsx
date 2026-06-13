import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { listRuns } from '../api/client';
import type { Verdict } from '../api/types';
import { VerdictBadge } from '../components/Badge';

export interface TrackedRun {
  projectId: string;
  runId: string;
  caseName: string;
}

interface RunToast extends TrackedRun {
  verdict?: Verdict;
  failed: boolean;
}

interface RunToastsState {
  trackRun: (run: TrackedRun) => void;
}

const RunToastsContext = createContext<RunToastsState | null>(null);

export function RunToastsProvider({ children }: { children: ReactNode }) {
  const [tracked, setTracked] = useState<TrackedRun[]>([]);
  const [toasts, setToasts] = useState<RunToast[]>([]);
  const trackedRef = useRef(tracked);
  trackedRef.current = tracked;

  const trackRun = useCallback((run: TrackedRun) => {
    setTracked((prev) =>
      prev.some((t) => t.runId === run.runId && t.projectId === run.projectId)
        ? prev
        : [...prev, run],
    );
  }, []);

  const dismiss = useCallback((runId: string) => {
    setToasts((prev) => prev.filter((t) => t.runId !== runId));
  }, []);

  const hasTracked = tracked.length > 0;

  useEffect(() => {
    if (!hasTracked) return;
    const poll = async () => {
      // Derive the project set from the freshest snapshot. Iterating awaits below
      // may run while trackRun adds/removes entries, so each iteration re-reads
      // trackedRef.current rather than relying on a single stale capture.
      const projectIds = [...new Set(trackedRef.current.map((t) => t.projectId))];
      for (const projectId of projectIds) {
        let runs;
        try {
          runs = await listRuns(projectId);
        } catch {
          continue;
        }
        // Re-read AFTER the await so runs added/removed during this fetch are
        // reflected when deciding which tracked runs just finished.
        const pending = trackedRef.current;
        const byId = new Map(runs.map((r) => [r.runId, r]));
        const finished = pending.filter((t) => {
          if (t.projectId !== projectId) return false;
          const run = byId.get(t.runId);
          return run !== undefined && run.status !== 'running';
        });
        if (finished.length === 0) continue;
        setTracked((prev) => prev.filter((t) => !finished.some((f) => f.runId === t.runId)));
        setToasts((prev) => [
          ...prev,
          ...finished.map((t) => {
            const run = byId.get(t.runId);
            return { ...t, verdict: run?.verdict, failed: run?.status === 'error' };
          }),
        ]);
      }
    };
    const id = window.setInterval(() => void poll(), 3000);
    return () => window.clearInterval(id);
  }, [hasTracked]);

  const value = useMemo(() => ({ trackRun }), [trackRun]);

  return (
    <RunToastsContext.Provider value={value}>
      {children}
      {toasts.length > 0 && (
        <div className="toast-stack">
          {toasts.map((t) => (
            <div key={t.runId} className="toast" role="status">
              <div className="toast-body">
                <strong>{t.caseName}</strong>{' '}
                {t.failed ? <span className="message-error">error</span> : <VerdictBadge verdict={t.verdict} />}
                <div>
                  <Link
                    className="link"
                    to={`/p/${encodeURIComponent(t.projectId)}/cases/${encodeURIComponent(t.caseName)}/runs/${encodeURIComponent(t.runId)}`}
                    onClick={() => dismiss(t.runId)}
                  >
                    View run
                  </Link>
                </div>
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                aria-label="Dismiss"
                onClick={() => dismiss(t.runId)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </RunToastsContext.Provider>
  );
}

export function useRunToasts(): RunToastsState {
  const ctx = useContext(RunToastsContext);
  if (!ctx) throw new Error('useRunToasts must be used within RunToastsProvider');
  return ctx;
}
