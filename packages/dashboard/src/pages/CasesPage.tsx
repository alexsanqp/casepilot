import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { errorMessage, getCase, listCases, listRuns } from '../api/client';
import type { CaseLastRun, CaseSummary } from '../api/types';
import { Badge, VerdictBadge } from '../components/Badge';
import { CaseActions } from '../components/CaseActions';
import { ExportModal } from '../components/ExportModal';
import { useProviders } from '../hooks/useProviders';
import { relativeTime } from '../lib/format';

interface ExportState {
  name: string;
  specTs: string;
}

export function CasesPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [stepCounts, setStepCounts] = useState<Record<string, number>>({});
  const [fallbackLastRuns, setFallbackLastRuns] = useState<Record<string, CaseLastRun>>({});
  const { providers, providersError } = useProviders(projectId);
  const [error, setError] = useState<string | null>(null);
  const [exportState, setExportState] = useState<ExportState | null>(null);

  const load = useCallback(async () => {
    try {
      const [caseList, runs] = await Promise.all([listCases(projectId), listRuns(projectId)]);
      setCases(caseList);
      setError(null);

      const latest: Record<string, CaseLastRun> = {};
      for (const run of [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
        latest[run.case] = {
          id: run.runId,
          status: run.status,
          verdict: run.verdict,
          finishedAt: run.finishedAt,
        };
      }
      setFallbackLastRuns(latest);

      const counts = await Promise.all(
        caseList.map(async (c) => {
          try {
            const detail = await getCase(projectId, c.name);
            return [c.name, detail.spec.steps.length] as const;
          } catch {
            return [c.name, -1] as const;
          }
        }),
      );
      setStepCounts(Object.fromEntries(counts.filter(([, n]) => n >= 0)));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="page-header">
        <h1>Cases</h1>
        <Link className="btn btn-primary" to={`/p/${encodeURIComponent(projectId)}/cases/new`}>
          New case
        </Link>
      </div>
      {error && <p className="message message-error">{error}</p>}
      {providersError && (
        <p className="message message-warning">
          Providers unavailable, recording is disabled: {providersError}
        </p>
      )}
      {!cases && !error && <p className="muted">Loading cases…</p>}
      {cases && cases.length === 0 && (
        <div className="empty-state">
          <p className="muted">This project has no cases yet.</p>
          <Link className="btn btn-primary" to={`/p/${encodeURIComponent(projectId)}/cases/new`}>
            Create the first case
          </Link>
        </div>
      )}
      {cases && cases.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>URL</th>
              <th>Steps</th>
              <th>Replay</th>
              <th>Last run</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((c) => (
              <tr key={c.name}>
                <td>
                  <Link
                    className="link"
                    to={`/p/${encodeURIComponent(projectId)}/cases/${encodeURIComponent(c.name)}`}
                  >
                    {c.name}
                  </Link>
                </td>
                <td className="url-cell" title={c.url}>
                  {c.url}
                </td>
                <td>{stepCounts[c.name] ?? '…'}</td>
                <td>
                  {c.hasReplay ? <Badge tone="blue">replay</Badge> : <span className="muted">-</span>}
                </td>
                <td>
                  <LastRunCell
                    projectId={projectId}
                    caseName={c.name}
                    lastRun={c.lastRun ?? fallbackLastRuns[c.name]}
                  />
                </td>
                <td className="actions-cell">
                  <CaseActions
                    projectId={projectId}
                    caseName={c.name}
                    hasReplay={c.hasReplay}
                    providers={providers}
                    onExport={(specTs) => setExportState({ name: c.name, specTs })}
                    onDeleted={load}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {exportState && (
        <ExportModal
          name={exportState.name}
          specTs={exportState.specTs}
          onClose={() => setExportState(null)}
        />
      )}
    </div>
  );
}

function LastRunCell({
  projectId,
  caseName,
  lastRun,
}: {
  projectId: string;
  caseName: string;
  lastRun: CaseLastRun | undefined;
}) {
  if (!lastRun) return <span className="muted">-</span>;
  if (lastRun.status === 'running') return <span className="running-text">running…</span>;
  return (
    <span className="last-run-cell">
      <Link
        className="link"
        to={`/p/${encodeURIComponent(projectId)}/cases/${encodeURIComponent(caseName)}/runs/${encodeURIComponent(lastRun.id)}`}
        title="Open the last run"
      >
        <VerdictBadge verdict={lastRun.verdict} />
      </Link>
      {lastRun.finishedAt && <span className="muted">{relativeTime(lastRun.finishedAt)}</span>}
    </span>
  );
}
