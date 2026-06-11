import type { ReplayStep, RunStepResult, StepStatus } from '../api/types';
import { Badge, type BadgeTone } from './Badge';
import { formatDuration } from '../lib/format';

const statusTone: Record<StepStatus, BadgeTone> = {
  passed: 'green',
  failed: 'red',
  healed: 'amber',
};

function describeStep(step: ReplayStep): string {
  if (step.kind === 'act') {
    return step.value !== undefined ? `${step.action} "${step.value}"` : step.action;
  }
  return step.text !== undefined ? `${step.assert} "${step.text}"` : step.assert;
}

export function StepTable({ steps }: { steps: RunStepResult[] }) {
  if (steps.length === 0) return <p className="muted">No steps executed.</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>#</th>
          <th>Kind</th>
          <th>Action / Assert</th>
          <th>Selector</th>
          <th>Status</th>
          <th>Error</th>
          <th>Time</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((s) => (
          <tr key={s.index}>
            <td>{s.index}</td>
            <td>{s.step.kind}</td>
            <td>{describeStep(s.step)}</td>
            <td>
              {s.step.selector ? (
                <code className="selector" title={s.step.selector}>
                  {s.step.selector}
                </code>
              ) : (
                <span className="muted">-</span>
              )}
            </td>
            <td>
              <Badge tone={statusTone[s.status]}>{s.status}</Badge>
            </td>
            <td className="error-cell">{s.error ?? ''}</td>
            <td>{formatDuration(s.durationMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
