import type { ReplayStep } from '../api/types';

export function describeStep(step: ReplayStep): string {
  if (step.kind === 'act') {
    return step.value !== undefined ? `${step.action} "${step.value}"` : step.action;
  }
  return step.text !== undefined ? `${step.assert} "${step.text}"` : step.assert;
}
