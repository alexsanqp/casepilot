import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { deleteCase, errorMessage, exportCase, startRun } from '../api/client';
import type { ProvidersResponse } from '../api/types';
import { useRunToasts } from '../state/runToasts';
import { defaultRunOptions, RunOptions, runOptionsToRequest } from './RunOptions';

export function CaseActions({
  projectId,
  caseName,
  hasReplay,
  providers,
  onExport,
  onDeleted,
  onStarted,
}: {
  projectId: string;
  caseName: string;
  hasReplay: boolean;
  providers: ProvidersResponse | null;
  onExport: (specTs: string) => void;
  onDeleted: () => void | Promise<void>;
  onStarted?: () => void;
}) {
  const navigate = useNavigate();
  const { trackRun } = useRunToasts();
  const [options, setOptions] = useState(defaultRunOptions);
  const [provider, setProvider] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const selectedProvider = provider || providers?.default || '';

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const started = (runId: string) => {
    trackRun({ projectId, runId, caseName });
    if (onStarted) onStarted();
    else navigate(`/p/${encodeURIComponent(projectId)}/cases/${encodeURIComponent(caseName)}`);
  };

  const runReplay = () =>
    act(async () => {
      const { runId } = await startRun(projectId, {
        case: caseName,
        mode: 'replay',
        ...runOptionsToRequest(options, 'replay'),
      });
      started(runId);
    });

  const record = () =>
    act(async () => {
      const { runId } = await startRun(projectId, {
        case: caseName,
        mode: 'record',
        ...runOptionsToRequest(options, 'record'),
        ...(selectedProvider ? { provider: selectedProvider } : {}),
      });
      started(runId);
    });

  const doExport = () =>
    act(async () => {
      const { specTs } = await exportCase(projectId, caseName);
      onExport(specTs);
    });

  const doDelete = () =>
    act(async () => {
      if (!window.confirm(`Delete case "${caseName}"?`)) return;
      await deleteCase(projectId, caseName);
      await onDeleted();
    });

  return (
    <div className="case-actions">
      <RunOptions value={options} onChange={setOptions} disabled={busy} />
      <button
        type="button"
        className="btn"
        disabled={busy || !hasReplay}
        title={hasReplay ? 'Replay the recorded steps' : 'No replay recorded yet'}
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
            : hasReplay
              ? 'Record again, replacing the existing replay'
              : 'Record a new replay'
        }
        onClick={() => void record()}
      >
        {hasReplay ? 'Re-record' : 'Record'}
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
      {actionError && <span className="message message-error">{actionError}</span>}
    </div>
  );
}
