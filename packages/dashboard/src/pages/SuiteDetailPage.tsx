import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getSuite, suiteReportUrl } from '../api/client';
import type { SuiteCaseResult, SuiteResult } from '../api/types';
import { Badge } from '../components/Badge';
import { usePolling } from '../hooks/usePolling';
import { formatDuration, shortId } from '../lib/format';

function suitePassed(result: SuiteResult): boolean {
  return result.failed === 0 && result.ran >= 1;
}

export function SuiteDetailPage() {
  const { projectId = '', suiteId = '' } = useParams<{ projectId: string; suiteId: string }>();

  const fetchSuite = useCallback(() => getSuite(projectId, suiteId), [projectId, suiteId]);
  const [intervalMs, setIntervalMs] = useState<number | null>(2000);
  const { data: suite, error, loading } = usePolling(fetchSuite, intervalMs);

  useEffect(() => {
    setIntervalMs(suite?.status === 'running' ? 2000 : null);
  }, [suite]);

  if (!suiteId) return <p className="message message-error">Missing suite id.</p>;

  return (
    <div>
      <div className="page-header">
        <h1>
          Suite <code>{shortId(suiteId)}</code>
        </h1>
        <span className="header-links">
          <Link className="link" to={`/p/${encodeURIComponent(projectId)}/cases`}>
            ← cases
          </Link>
        </span>
      </div>
      {error && <p className="message message-error">{error}</p>}
      {loading && !suite && <p className="muted">Loading suite…</p>}
      {suite?.status === 'running' && (
        <p className="running-text">
          Suite in progress…
          {suite.result ? ` (${suite.result.ran}/${suite.result.total})` : ''}
        </p>
      )}
      {suite?.status === 'error' && (
        <div className="banner banner-fail">
          <strong>ERROR</strong>
          <p>{suite.error ?? 'Suite failed with an unknown error.'}</p>
        </div>
      )}
      {suite?.result && <SuiteResultView projectId={projectId} suiteId={suiteId} result={suite.result} />}
    </div>
  );
}

function SuiteResultView({
  projectId,
  suiteId,
  result,
}: {
  projectId: string;
  suiteId: string;
  result: SuiteResult;
}) {
  const passed = suitePassed(result);

  return (
    <div className="run-detail">
      <div className={`banner ${passed ? 'banner-pass' : 'banner-fail'}`}>
        <strong>{passed ? 'PASS' : 'FAIL'}</strong>
        <span className="banner-meta">
          {result.passed} passed · {result.failed} failed · {result.skipped} skipped ·{' '}
          {formatDuration(durationOf(result))}
        </span>
        <p>
          {result.ran}/{result.total} ran
        </p>
        <p>
          <a className="btn" href={suiteReportUrl(projectId, suiteId, 'junit')} download>
            Download JUnit
          </a>{' '}
          <a className="btn" href={suiteReportUrl(projectId, suiteId, 'json')} download>
            Download JSON
          </a>
        </p>
      </div>

      <section>
        <h2>Cases</h2>
        {result.cases.length === 0 ? (
          <p className="muted">No cases were selected.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Case</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Reason</th>
                <th>Run</th>
              </tr>
            </thead>
            <tbody>
              {result.cases.map((c) => (
                <SuiteCaseRow key={c.caseName} projectId={projectId} caseResult={c} />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function SuiteCaseRow({
  projectId,
  caseResult,
}: {
  projectId: string;
  caseResult: SuiteCaseResult;
}) {
  return (
    <tr>
      <td>
        <Link
          className="link"
          to={`/p/${encodeURIComponent(projectId)}/cases/${encodeURIComponent(caseResult.caseName)}`}
        >
          {caseResult.caseName}
        </Link>
      </td>
      <td>
        <CaseStatusBadge status={caseResult.status} />
      </td>
      <td>{formatDuration(caseResult.durationMs)}</td>
      <td className="url-cell" title={caseResult.reason ?? ''}>
        {caseResult.reason ?? <span className="muted">-</span>}
      </td>
      <td>
        {caseResult.runId ? (
          <Link
            className="link"
            to={`/p/${encodeURIComponent(projectId)}/cases/${encodeURIComponent(
              caseResult.caseName,
            )}/runs/${encodeURIComponent(caseResult.runId)}`}
          >
            <code>{shortId(caseResult.runId)}</code>
          </Link>
        ) : (
          <span className="muted">-</span>
        )}
      </td>
    </tr>
  );
}

function CaseStatusBadge({ status }: { status: SuiteCaseResult['status'] }) {
  if (status === 'passed') return <Badge tone="green">PASS</Badge>;
  if (status === 'failed') return <Badge tone="red">FAIL</Badge>;
  return <Badge tone="gray">SKIP</Badge>;
}

function durationOf(result: SuiteResult): number {
  const start = Date.parse(result.startedAt);
  const end = Date.parse(result.finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return Number.NaN;
  return end - start;
}
