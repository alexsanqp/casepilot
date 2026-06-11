import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { listRuns } from '../api/client';
import { ModeBadge, VerdictBadge } from '../components/Badge';
import { usePolling } from '../hooks/usePolling';
import { formatTime, runDuration, shortId } from '../lib/format';

export function RunsPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const fetchRuns = useCallback(() => listRuns(projectId), [projectId]);
  const [intervalMs, setIntervalMs] = useState<number | null>(2000);
  const { data: runs, error, loading, refresh } = usePolling(fetchRuns, intervalMs);

  useEffect(() => {
    setIntervalMs(runs?.some((r) => r.status === 'running') ? 2000 : null);
  }, [runs]);

  return (
    <div>
      <div className="page-header">
        <h1>Runs</h1>
        <button type="button" className="btn" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {error && <p className="message message-error">{error}</p>}
      {loading && !runs && <p className="muted">Loading runs…</p>}
      {runs && runs.length === 0 && <p className="muted">No runs yet.</p>}
      {runs && runs.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Case</th>
              <th>Mode</th>
              <th>Provider</th>
              <th>Status</th>
              <th>Verdict</th>
              <th>Duration</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr
                key={r.runId}
                className="clickable"
                onClick={() =>
                  navigate(
                    `/p/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(r.runId)}`,
                  )
                }
              >
                <td>
                  <code>{shortId(r.runId)}</code>
                </td>
                <td>{r.case}</td>
                <td>
                  <ModeBadge mode={r.mode} />
                </td>
                <td>{r.provider}</td>
                <td>
                  {r.status === 'running' ? (
                    <span className="running-text">running…</span>
                  ) : (
                    r.status
                  )}
                </td>
                <td>
                  <VerdictBadge verdict={r.verdict} />
                </td>
                <td>{runDuration(r.startedAt, r.finishedAt)}</td>
                <td>{formatTime(r.startedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
