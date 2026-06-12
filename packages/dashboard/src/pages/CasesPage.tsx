import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  deleteCase,
  errorMessage,
  exportCase,
  getCase,
  getProviders,
  listCases,
  listRuns,
  startRun,
} from '../api/client';
import type { CaseSummary, ProvidersResponse, Verdict } from '../api/types';
import { Badge, VerdictBadge } from '../components/Badge';
import { Modal } from '../components/Modal';
import { defaultRunOptions, RunOptions, runOptionsToRequest } from '../components/RunOptions';
import { useRunToasts } from '../state/runToasts';

interface ExportState {
  name: string;
  specTs: string;
}

export function CasesPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [stepCounts, setStepCounts] = useState<Record<string, number>>({});
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportState, setExportState] = useState<ExportState | null>(null);

  const load = useCallback(async () => {
    const providersDone = getProviders(projectId)
      .then((providerList) => {
        setProviders(providerList);
        setProvidersError(null);
      })
      .catch((err: unknown) => {
        setProviders(null);
        setProvidersError(errorMessage(err));
      });
    try {
      const [caseList, runs] = await Promise.all([listCases(projectId), listRuns(projectId)]);
      setCases(caseList);
      setError(null);

      const latest: Record<string, Verdict> = {};
      for (const run of [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
        if (run.verdict) latest[run.case] = run.verdict;
      }
      setVerdicts(latest);

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
    await providersDone;
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
              <th>Last verdict</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((c) => (
              <CaseRow
                key={c.name}
                projectId={projectId}
                summary={c}
                stepCount={stepCounts[c.name]}
                verdict={verdicts[c.name]}
                providers={providers}
                onChanged={load}
                onExport={(specTs) => setExportState({ name: c.name, specTs })}
              />
            ))}
          </tbody>
        </table>
      )}
      {exportState && (
        <ExportModal state={exportState} onClose={() => setExportState(null)} />
      )}
    </div>
  );
}

function CaseRow({
  projectId,
  summary,
  stepCount,
  verdict,
  providers,
  onChanged,
  onExport,
}: {
  projectId: string;
  summary: CaseSummary;
  stepCount: number | undefined;
  verdict: Verdict | undefined;
  providers: ProvidersResponse | null;
  onChanged: () => Promise<void>;
  onExport: (specTs: string) => void;
}) {
  const navigate = useNavigate();
  const { trackRun } = useRunToasts();
  const [options, setOptions] = useState(defaultRunOptions);
  const [provider, setProvider] = useState('');
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const selectedProvider = provider || providers?.default || '';

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setRowError(null);
    try {
      await fn();
    } catch (err) {
      setRowError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const runsPath = `/p/${encodeURIComponent(projectId)}/runs`;

  const runReplay = () =>
    act(async () => {
      const { runId } = await startRun(projectId, {
        case: summary.name,
        mode: 'replay',
        ...runOptionsToRequest(options, 'replay'),
      });
      trackRun({ projectId, runId, caseName: summary.name });
      navigate(runsPath);
    });

  const record = () =>
    act(async () => {
      const { runId } = await startRun(projectId, {
        case: summary.name,
        mode: 'record',
        ...runOptionsToRequest(options, 'record'),
        ...(selectedProvider ? { provider: selectedProvider } : {}),
      });
      trackRun({ projectId, runId, caseName: summary.name });
      navigate(runsPath);
    });

  const doExport = () =>
    act(async () => {
      const { specTs } = await exportCase(projectId, summary.name);
      onExport(specTs);
    });

  const doDelete = () =>
    act(async () => {
      if (!window.confirm(`Delete case "${summary.name}"?`)) return;
      await deleteCase(projectId, summary.name);
      await onChanged();
    });

  return (
    <tr>
      <td>
        <Link
          className="link"
          to={`/p/${encodeURIComponent(projectId)}/cases/${encodeURIComponent(summary.name)}/edit`}
        >
          {summary.name}
        </Link>
      </td>
      <td className="url-cell" title={summary.url}>
        {summary.url}
      </td>
      <td>{stepCount ?? '…'}</td>
      <td>{summary.hasReplay ? <Badge tone="blue">replay</Badge> : <span className="muted">-</span>}</td>
      <td>
        <VerdictBadge verdict={verdict} />
      </td>
      <td className="actions-cell">
        <RunOptions value={options} onChange={setOptions} disabled={busy} />
        <button
          type="button"
          className="btn"
          disabled={busy || !summary.hasReplay}
          title={summary.hasReplay ? 'Replay the recorded steps' : 'No replay recorded yet'}
          onClick={() => void runReplay()}
        >
          Run
        </button>
        <select
          className="select"
          value={selectedProvider}
          onChange={(e) => setProvider(e.target.value)}
          disabled={busy || !providers}
        >
          {providers?.providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          disabled={busy || !providers}
          title={
            !providers
              ? 'Providers unavailable'
              : summary.hasReplay
                ? 'Record again, replacing the existing replay'
                : 'Record a new replay'
          }
          onClick={() => void record()}
        >
          {summary.hasReplay ? 'Re-record' : 'Record'}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void doExport()}>
          Export
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy}
          onClick={() => void doDelete()}
        >
          Delete
        </button>
        {rowError && <span className="message message-error">{rowError}</span>}
      </td>
    </tr>
  );
}

function ExportModal({ state, onClose }: { state: ExportState; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(state.specTs);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Modal title={`Export: ${state.name}`} onClose={onClose}>
      <pre className="code-block">{state.specTs}</pre>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </Modal>
  );
}
