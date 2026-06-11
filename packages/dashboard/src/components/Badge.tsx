import type { ReactNode } from 'react';

export type BadgeTone = 'green' | 'red' | 'amber' | 'blue' | 'purple' | 'gray';

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function VerdictBadge({ verdict }: { verdict?: 'passed' | 'failed' }) {
  if (!verdict) return <span className="muted">-</span>;
  return verdict === 'passed' ? <Badge tone="green">PASS</Badge> : <Badge tone="red">FAIL</Badge>;
}

export function ModeBadge({ mode }: { mode: 'record' | 'replay' }) {
  return <Badge tone={mode === 'record' ? 'purple' : 'blue'}>{mode}</Badge>;
}
