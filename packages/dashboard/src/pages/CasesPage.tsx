import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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

interface ExportState {
  name: string;
  specTs: string;
}

export function CasesPage() {
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [stepCounts, setStepCounts] = useState<Record<string, number>>({});
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportState, setExportState] = useState<ExportState | null>(null);

  const load = useCallback(async () => {
    try {
      const [caseList, runs, providerList] = await Promise.all([
        listCases(),
        listRuns(),
        getProviders(),
      ]);
      setCases(caseList);
      setProviders(providerList);
      setError(null);

      const latest: Record<string, Verdict> = {};
      for (const run of [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
        if (run.verdict) latest[run.case] = run.verdict;
      }
      setVerdicts(latest);

      const counts = await Promise.all(
        caseList.map(async (c) => {
          try {
            const detail = await getCase(c.name);
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
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="page-header">
        <h1>Cases</h1>
        <Link className="btn btn-primary" to="/cases/new">
          New case
        </Link>
      </div>
      {error && <p className="message message-error">{error}</p>}
      {!cases && !error && <p className="muted">Loading cases…</p>}
      {cases && cases.length === 0 && <p className="muted">No cases yet. Create one to start.</p>}
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
  summary,
  stepCount,
  verdict,
  providers,
  onChanged,
  onExport,
}: {
  summary: CaseSummary;
  stepCount: number | undefined;
  verdict: Verdict | undefined;
  providers: ProvidersResponse | null;
  onChanged: () => Promise<void>;
  onExport: (specTs: string) => void;
}) {
  const navigate = useNavigate();
  const [video, setVideo] = useState(false);
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

  const runReplay = () =>
    act(async () => {
      await startRun({ case: summary.name, mode: 'replay', video });
      navigate('/runs');
    });

  const record = () =>
    act(async () => {
      await startRun({
        case: summary.name,
        mode: 'record',
        video,
        ...(selectedProvider ? { provider: selectedProvider } : {}),
      });
      navigate('/runs');
    });

  const doExport = () =>
    act(async () => {
      const { specTs } = await exportCase(summary.name);
      onExport(specTs);
    });

  const doDelete = () =>
    act(async () => {
      if (!window.confirm(`Delete case "${summary.name}"?`)) return;
      await deleteCase(summary.name);
      await onChanged();
    });

  return (
    <tr>
      <td>
        <Link className="link" to={`/cases/${encodeURIComponent(summary.name)}/edit`}>
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
        <label className="toggle" title="Record a video of the run">
          <input type="checkbox" checked={video} onChange={(e) => setVideo(e.target.checked)} />
          video
        </label>
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
        <button type="button" className="btn" disabled={busy} onClick={() => void record()}>
          Record
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
