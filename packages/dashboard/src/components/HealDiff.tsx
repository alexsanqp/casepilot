import type { ReplayStep } from '../api/types';

interface StepFields {
  head: string;
  headLabel: string;
  selector?: string;
  val?: string;
  valLabel: string;
}

function stepFields(step: ReplayStep): StepFields {
  if (step.kind === 'act') {
    return { head: step.action, headLabel: 'action', selector: step.selector, val: step.value, valLabel: 'value' };
  }
  return { head: step.assert, headLabel: 'assert', selector: step.selector, val: step.text, valLabel: 'text' };
}

function DiffRow({
  label,
  oldValue,
  newValue,
}: {
  label: string;
  oldValue?: string;
  newValue?: string;
}) {
  if (oldValue === undefined && newValue === undefined) return null;
  const changed = oldValue !== newValue;
  return (
    <div className="heal-diff-row">
      <span className="heal-diff-label">{label}</span>
      <code className={`heal-diff-cell ${changed ? 'heal-diff-old' : ''}`}>{oldValue ?? '-'}</code>
      <code className={`heal-diff-cell ${changed ? 'heal-diff-new' : ''}`}>{newValue ?? '-'}</code>
    </div>
  );
}

export function HealDiff({ oldStep, newStep }: { oldStep: ReplayStep; newStep: ReplayStep }) {
  const oldFields = stepFields(oldStep);
  const newFields = stepFields(newStep);
  const headLabel =
    oldFields.headLabel === newFields.headLabel
      ? oldFields.headLabel
      : `${oldFields.headLabel} → ${newFields.headLabel}`;
  const valLabel =
    oldFields.valLabel === newFields.valLabel
      ? oldFields.valLabel
      : `${oldFields.valLabel} / ${newFields.valLabel}`;

  return (
    <div className="heal-diff">
      <div className="heal-diff-row heal-diff-head">
        <span className="heal-diff-label" />
        <span>old</span>
        <span>new</span>
      </div>
      <DiffRow label={headLabel} oldValue={oldFields.head} newValue={newFields.head} />
      <DiffRow label="selector" oldValue={oldFields.selector} newValue={newFields.selector} />
      <DiffRow label={valLabel} oldValue={oldFields.val} newValue={newFields.val} />
    </div>
  );
}
