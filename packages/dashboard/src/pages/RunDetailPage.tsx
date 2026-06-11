import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { errorMessage, getCase, getRun, getTranscript } from '../api/client';
import type { ReplayFile, RunResult } from '../api/types';
import { ModeBadge } from '../components/Badge';
import { StepTable } from '../components/StepTable';
import { VideoPlayer } from '../components/VideoPlayer';
import { usePolling } from '../hooks/usePolling';
import { runDuration } from '../lib/format';

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const runId = id ?? '';

  const fetchRun = useCallback(() => getRun(runId), [runId]);
  const [intervalMs, setIntervalMs] = useState<number | null>(2000);
  const { data: run, error, loading } = usePolling(fetchRun, intervalMs);

  useEffect(() => {
    setIntervalMs(run?.status === 'running' ? 2000 : null);
  }, [run]);

  if (!runId) return <p className="message message-error">Missing run id.</p>;

  return (
    <div>
      <div className="page-header">
        <h1>
          Run <code>{runId}</code>
        </h1>
        <Link className="link" to="/runs">
          ← All runs
        </Link>
      </div>
      {error && <p className="message message-error">{error}</p>}
      {loading && !run && <p className="muted">Loading run…</p>}
      {run?.status === 'running' && <p className="running-text">Run in progress…</p>}
      {run?.status === 'error' && (
        <div className="banner banner-fail">
          <strong>ERROR</strong>
          <p>{run.error ?? 'Run failed with an unknown error.'}</p>
        </div>
      )}
      {run?.result && <RunResultView runId={runId} result={run.result} />}
    </div>
  );
}

function RunResultView({ runId, result }: { runId: string; result: RunResult }) {
  return (
    <div className="run-detail">
      <div className={`banner ${result.verdict === 'passed' ? 'banner-pass' : 'banner-fail'}`}>
        <strong>{result.verdict === 'passed' ? 'PASS' : 'FAIL'}</strong>
        <span className="banner-meta">
          {result.case} · <ModeBadge mode={result.mode} /> ·{' '}
          {runDuration(result.startedAt, result.finishedAt)}
        </span>
        <p>{result.explanation}</p>
      </div>

      <section>
        <h2>Steps</h2>
        <StepTable steps={result.steps} />
      </section>

      {result.artifacts.videoPath && (
        <section>
          <h2>Video</h2>
          <VideoPlayer runId={runId} />
        </section>
      )}

      <TranscriptSection runId={runId} />
      <ReplaySection caseName={result.case} />
    </div>
  );
}

function TranscriptSection({ runId }: { runId: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);

  const load = () => {
    if (requested) return;
    setRequested(true);
    getTranscript(runId)
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

function ReplaySection({ caseName }: { caseName: string }) {
  const [replay, setReplay] = useState<ReplayFile | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);

  const load = () => {
    if (requested) return;
    setRequested(true);
    getCase(caseName)
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
