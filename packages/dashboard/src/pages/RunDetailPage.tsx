import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  archiveUrl,
  errorMessage,
  getCase,
  getRun,
  getTranscript,
  listHeals,
  screenshotUrl,
  startRun,
} from '../api/client';
import type { ReplayFile, RunResult, RunStepResult } from '../api/types';
import { ModeBadge } from '../components/Badge';
import { useRunToasts } from '../state/runToasts';
import { StepTable } from '../components/StepTable';
import { SyncedVideo, type SyncedVideoHandle } from '../components/SyncedVideo';
import { usePolling } from '../hooks/usePolling';
import { runDuration } from '../lib/format';
import { stripAnsi } from '../lib/ansi';

export function RunDetailPage() {
  const { projectId = '', id } = useParams<{ projectId: string; id: string }>();
  const runId = id ?? '';

  const fetchRun = useCallback(() => getRun(projectId, runId), [projectId, runId]);
  const [intervalMs, setIntervalMs] = useState<number | null>(2000);
  const { data: run, error, loading } = usePolling(fetchRun, intervalMs);

  useEffect(() => {
    setIntervalMs(run?.status === 'running' ? 2000 : null);
  }, [run]);

  if (!runId) return <p className="message message-error">Missing run id.</p>;

  const caseName = run?.result?.case;

  return (
    <div>
      <div className="page-header">
        <h1>
          Run <code>{runId}</code>
        </h1>
        <span className="header-links">
          {caseName && (
            <Link
              className="link"
              to={`/p/${encodeURIComponent(projectId)}/cases/${encodeURIComponent(caseName)}`}
            >
              ← case {caseName}
            </Link>
          )}
          <Link className="link" to={`/p/${encodeURIComponent(projectId)}/runs`}>
            All runs
          </Link>
        </span>
      </div>
      {error && <p className="message message-error">{error}</p>}
      {loading && !run && <p className="muted">Loading run…</p>}
      {run?.status === 'running' && <p className="running-text">Run in progress…</p>}
      {run?.status === 'error' && (
        <div className="banner banner-fail">
          <strong>ERROR</strong>
          <p>{run.error ? stripAnsi(run.error) : 'Run failed with an unknown error.'}</p>
        </div>
      )}
      {run?.result && <RunResultView projectId={projectId} runId={runId} result={run.result} />}
    </div>
  );
}

function RunResultView({
  projectId,
  runId,
  result,
}: {
  projectId: string;
  runId: string;
  result: RunResult;
}) {
  const videoRef = useRef<SyncedVideoHandle>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const hasVideo = Boolean(result.artifacts.videoPath);

  const selectStep = (step: RunStepResult) => {
    setActiveIndex(step.index);
    videoRef.current?.seekTo(step.offsetMs);
  };

  return (
    <div className="run-detail">
      <div className={`banner ${result.verdict === 'passed' ? 'banner-pass' : 'banner-fail'}`}>
        <strong>{result.verdict === 'passed' ? 'PASS' : 'FAIL'}</strong>
        <span className="banner-meta">
          {result.case} · <ModeBadge mode={result.mode} /> ·{' '}
          {runDuration(result.startedAt, result.finishedAt)}
        </span>
        <p>{result.explanation}</p>
        <p>
          <a className="btn" href={archiveUrl(projectId, runId)} download>
            Download artifacts
          </a>
        </p>
      </div>

      {result.verdict === 'failed' && <FixPanel projectId={projectId} caseName={result.case} />}

      {hasVideo && (
        <section>
          <h2>Video</h2>
          <SyncedVideo
            ref={videoRef}
            projectId={projectId}
            runId={runId}
            steps={result.steps}
            activeIndex={activeIndex}
            onMarkerClick={(step) => setActiveIndex(step.index)}
            hasOptimized={Boolean(result.artifacts.optimizedVideoPath)}
          />
        </section>
      )}

      <section>
        <h2>Steps</h2>
        <StepTable
          steps={result.steps}
          activeIndex={activeIndex}
          onRowClick={hasVideo ? selectStep : undefined}
          screenshotUrlFor={(fileName) => screenshotUrl(projectId, runId, fileName)}
        />
      </section>

      <TranscriptSection projectId={projectId} runId={runId} />
      <ReplaySection projectId={projectId} caseName={result.case} />
    </div>
  );
}

function FixPanel({ projectId, caseName }: { projectId: string; caseName: string }) {
  const navigate = useNavigate();
  const { trackRun } = useRunToasts();
  const [pendingHeals, setPendingHeals] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listHeals(projectId)
      .then((res) => {
        if (!cancelled) setPendingHeals(res.heals.filter((h) => h.caseName === caseName).length);
      })
      .catch(() => {
        if (!cancelled) setPendingHeals(0);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, caseName]);

  const basePath = `/p/${encodeURIComponent(projectId)}`;
  const casePath = `${basePath}/cases/${encodeURIComponent(caseName)}`;

  const reRecord = async () => {
    setBusy(true);
    setError(null);
    try {
      const { runId } = await startRun(projectId, { case: caseName, mode: 'record' });
      trackRun({ projectId, runId, caseName });
      navigate(`${basePath}/runs`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="fix-panel">
      <h2>Fix this case</h2>
      <div className="fix-actions">
        <div className="fix-action">
          <Link className="btn" to={`${casePath}?edit=1`}>
            Edit case
          </Link>
          <span className="muted">Adjust the steps or expectations in the definition.</span>
        </div>
        <div className="fix-action">
          <button type="button" className="btn" disabled={busy} onClick={() => void reRecord()}>
            {busy ? 'Starting…' : 'Re-record'}
          </button>
          <span className="muted">Record a fresh replay with the default provider.</span>
        </div>
        {pendingHeals > 0 && (
          <div className="fix-action">
            <Link className="btn" to={`${basePath}/heals`}>
              Review {pendingHeals} pending heal{pendingHeals === 1 ? '' : 's'}
            </Link>
            <span className="muted">Approve selector fixes suggested during replay.</span>
          </div>
        )}
      </div>
      {error && <p className="message message-error">{error}</p>}
    </section>
  );
}

function TranscriptSection({ projectId, runId }: { projectId: string; runId: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);

  const load = () => {
    if (requested) return;
    setRequested(true);
    getTranscript(projectId, runId)
      .then(setText)
      .catch((err: unknown) => setError(errorMessage(err)));
  };

  return (
    <details className="collapsible" onToggle={(e) => e.currentTarget.open && load()}>
      <summary>Transcript</summary>
      {error && <p className="message message-error">{error}</p>}
      {!error && (text === null ? <p className="muted">Loading…</p> : <pre className="code-block">{text}</pre>)}
    </details>
  );
}

function ReplaySection({ projectId, caseName }: { projectId: string; caseName: string }) {
  const [replay, setReplay] = useState<ReplayFile | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);

  const load = () => {
    if (requested) return;
    setRequested(true);
    getCase(projectId, caseName)
      .then((detail) => {
        if (detail.replay) setReplay(detail.replay);
        else setMissing(true);
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  };

  return (
    <details className="collapsible" onToggle={(e) => e.currentTarget.open && load()}>
      <summary>Replay JSON</summary>
      {error && <p className="message message-error">{error}</p>}
      {missing && <p className="muted">No replay recorded for this case.</p>}
      {replay && <pre className="code-block">{JSON.stringify(replay, null, 2)}</pre>}
      {!error && !missing && !replay && requested && <p className="muted">Loading…</p>}
    </details>
  );
}
