import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { approveHeal, errorMessage, listHeals, rejectHeal } from '../api/client';
import type { Heal, HealStatus } from '../api/types';
import { Badge, type BadgeTone } from '../components/Badge';
import { HealDiff } from '../components/HealDiff';
import { usePolling } from '../hooks/usePolling';
import { formatTime, shortId } from '../lib/format';

const statusTone: Record<HealStatus, BadgeTone> = {
  pending: 'amber',
  approved: 'green',
  rejected: 'red',
};

export function HealsPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const [showHistory, setShowHistory] = useState(false);
  const fetchHeals = useCallback(() => listHeals(projectId, showHistory), [projectId, showHistory]);
  const { data, error, loading, refresh } = usePolling(fetchHeals, 10_000);
  const heals = data?.heals ?? null;

  return (
    <div>
      <div className="page-header">
        <h1>Heals</h1>
        <label className="toggle">
          <input
            type="checkbox"
            checked={showHistory}
            onChange={(e) => setShowHistory(e.target.checked)}
          />
          History
        </label>
      </div>
      {error && <p className="message message-error">{error}</p>}
      {loading && !heals && <p className="muted">Loading heals…</p>}
      {heals && heals.length === 0 && (
        <p className="muted">{showHistory ? 'No heals recorded yet.' : 'No pending heals.'}</p>
      )}
      {heals && heals.length > 0 && (
        <div className="heal-list">
          {heals.map((heal) => (
            <HealCard
              key={heal.id}
              projectId={projectId}
              heal={heal}
              onResolved={() => void refresh()}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HealCard({
  projectId,
  heal,
  onResolved,
}: {
  projectId: string;
  heal: Heal;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolve = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onResolved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="heal-card">
      <div className="heal-card-head">
        <div className="heal-card-meta">
          <strong>{heal.caseName}</strong>
          <span className="muted">step #{heal.stepIndex}</span>
          <Link
            className="link"
            to={`/p/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(heal.runId)}`}
          >
            run <code>{shortId(heal.runId)}</code>
          </Link>
          <span className="muted">{formatTime(heal.createdAt)}</span>
        </div>
        {heal.status === 'pending' ? (
          <div className="heal-card-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              aria-label={`Approve heal ${heal.caseName} step ${heal.stepIndex}`}
              onClick={() => void resolve(() => approveHeal(projectId, heal.id))}
            >
              {busy ? 'Working…' : 'Approve'}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              aria-label={`Reject heal ${heal.caseName} step ${heal.stepIndex}`}
              onClick={() => void resolve(() => rejectHeal(projectId, heal.id))}
            >
              Reject
            </button>
          </div>
        ) : (
          <div className="heal-card-actions">
            <Badge tone={statusTone[heal.status]}>{heal.status}</Badge>
            {heal.resolvedAt && <span className="muted">{formatTime(heal.resolvedAt)}</span>}
          </div>
        )}
      </div>
      <HealDiff oldStep={heal.oldStep} newStep={heal.newStep} />
      {error && <p className="message message-error">{error}</p>}
    </div>
  );
}
