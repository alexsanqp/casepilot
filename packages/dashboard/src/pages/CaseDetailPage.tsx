import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { errorMessage, getCase, listRuns } from '../api/client';
import type { CaseDetail } from '../api/types';
import { Badge, ModeBadge, VerdictBadge } from '../components/Badge';
import { CaseActions } from '../components/CaseActions';
import { CaseYamlEditor } from '../components/CaseYamlEditor';
import { ExportModal } from '../components/ExportModal';
import { usePolling } from '../hooks/usePolling';
import { useProviders } from '../hooks/useProviders';
import { formatTime, runDuration, shortId } from '../lib/format';

export function CaseDetailPage() {
  const { projectId = '', name = '' } = useParams<{ projectId: string; name: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(searchParams.get('edit') === '1');
  const [exportSpec, setExportSpec] = useState<string | null>(null);
  const { providers, providersError } = useProviders(projectId);

  const load = useCallback(async () => {
    try {
      setDetail(await getCase(projectId, name));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [projectId, name]);

  useEffect(() => {
    void load();
  }, [load]);

  const fetchRuns = useCallback(
    async () => (await listRuns(projectId, name)).filter((r) => r.case === name),
    [projectId, name],
  );
  const [runsInterval, setRunsInterval] = useState<number | null>(2000);
  const { data: runs, error: runsError, refresh: refreshRuns } = usePolling(fetchRuns, runsInterval);

  useEffect(() => {
    setRunsInterval(runs?.some((r) => r.status === 'running') ? 2000 : null);
  }, [runs]);

  const closeEditor = () => {
    setEditing(false);
    if (searchParams.has('edit')) setSearchParams({}, { replace: true });
  };

  if (!name) return <p className="message message-error">Missing case name.</p>;

  return (
    <div className="case-detail">
      <div className="page-header">
        <h1>{name}</h1>
        <CaseActions
          projectId={projectId}
          caseName={name}
          hasReplay={Boolean(detail?.replay)}
          providers={providers}
          onExport={setExportSpec}
          onDeleted={() => navigate(`/p/${encodeURIComponent(projectId)}/cases`)}
          onStarted={() => {
            setRunsInterval(2000);
            void refreshRuns();
          }}
        />
      </div>
      {detail && (
        <p className="case-meta" title={detail.spec.url}>
          {detail.spec.url}
        </p>
      )}
      {error && <p className="message message-error">{error}</p>}
      {providersError && (
        <p className="message message-warning">
          Providers unavailable, recording is disabled: {providersError}
        </p>
      )}
      {!detail && !error && <p className="muted">Loading case…</p>}

      {detail && (
        <section>
          <div className="section-head">
            <h2>Definition</h2>
            {!editing && (
              <button type="button" className="btn" onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
          </div>
          {editing ? (
            <CaseYamlEditor
              projectId={projectId}
              caseName={name}
              initialYaml={detail.specYaml}
              onSaved={() => {
                closeEditor();
                void load();
              }}
              onCancel={closeEditor}
            />
          ) : (
            <div className="spec-columns">
              <div>
                <h3 className="spec-title">Steps</h3>
                <ol className="spec-list">
                  {detail.spec.steps.map((step, i) => {
                    if (typeof step === 'string') return <li key={i}>{step}</li>;
                    const expects =
                      step.expect === undefined
                        ? []
                        : Array.isArray(step.expect)
                          ? step.expect
                          : [step.expect];
                    return (
                      <li key={i}>
                        {step.do}
                        {expects.length > 0 && (
                          <ul className="spec-step-expect">
                            {expects.map((e, j) => (
                              <li key={j}>{e}</li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </div>
              <div>
                <h3 className="spec-title">Expect</h3>
                <ul className="spec-list">
                  {detail.spec.expect.map((expectation, i) => (
                    <li key={i}>{expectation}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </section>
      )}

      {detail && (
        <section>
          <h2>Replay</h2>
          {detail.replay ? (
            <div className="replay-meta">
              <Badge tone="blue">recorded</Badge>
              <span>{detail.replay.steps.length} steps</span>
              <span>{detail.replay.meta.healCount} heals</span>
              <span>provider {detail.replay.providerUsed}</span>
              <span className="muted">recorded {formatTime(detail.replay.recordedAt)}</span>
            </div>
          ) : (
            <p className="muted">No replay recorded yet. Record one to enable runs.</p>
          )}
        </section>
      )}

      <section>
        <h2>Run history</h2>
        {runsError && <p className="message message-error">{runsError}</p>}
        {runs && runs.length === 0 && <p className="muted">No runs for this case yet.</p>}
        {runs && runs.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Mode</th>
                <th>Provider</th>
                <th>Status</th>
                <th>Verdict</th>
                <th>Duration</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {[...runs]
                .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
                .map((r) => (
                  <tr
                    key={r.runId}
                    aria-label={`run ${r.runId}`}
                    className={r.status === 'running' ? 'clickable row-running' : 'clickable'}
                    onClick={() =>
                      navigate(
                        `/p/${encodeURIComponent(projectId)}/cases/${encodeURIComponent(name)}/runs/${encodeURIComponent(r.runId)}`,
                      )
                    }
                  >
                    <td>
                      <code>{shortId(r.runId)}</code>
                    </td>
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
      </section>

      {exportSpec !== null && (
        <ExportModal name={name} specTs={exportSpec} onClose={() => setExportSpec(null)} />
      )}
    </div>
  );
}
