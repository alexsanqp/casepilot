import { useState } from 'react';
import type { RunStepResult, StepStatus } from '../api/types';
import { Badge, type BadgeTone } from './Badge';
import { Modal } from './Modal';
import { formatDuration } from '../lib/format';
import { describeStep } from '../lib/steps';

const statusTone: Record<StepStatus, BadgeTone> = {
  passed: 'green',
  failed: 'red',
  healed: 'amber',
};

function CameraIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

interface Lightbox {
  url: string;
  title: string;
}

export function StepTable({
  steps,
  activeIndex,
  onRowClick,
  screenshotUrlFor,
}: {
  steps: RunStepResult[];
  activeIndex?: number | null;
  onRowClick?: (step: RunStepResult) => void;
  screenshotUrlFor?: (fileName: string) => string;
}) {
  const [lightbox, setLightbox] = useState<Lightbox | null>(null);

  if (steps.length === 0) return <p className="muted">No steps executed.</p>;
  return (
    <>
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
          {steps.map((s) => {
            const screenshot = s.screenshot;
            return (
              <tr
                key={s.index}
                className={`${onRowClick ? 'clickable' : ''} ${
                  s.index === activeIndex ? 'active-row' : ''
                }`}
                onClick={onRowClick ? () => onRowClick(s) : undefined}
              >
                <td>{s.index}</td>
                <td>{s.step.kind}</td>
                <td>
                  {describeStep(s.step)}
                  {screenshot && screenshotUrlFor && (
                    <button
                      type="button"
                      className="icon-btn"
                      title="View screenshot"
                      aria-label={`View screenshot for step ${s.index}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setLightbox({
                          url: screenshotUrlFor(screenshot),
                          title: `Step ${s.index}: ${describeStep(s.step)}`,
                        });
                      }}
                    >
                      <CameraIcon />
                    </button>
                  )}
                </td>
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
            );
          })}
        </tbody>
      </table>
      {lightbox && (
        <Modal title={lightbox.title} onClose={() => setLightbox(null)}>
          <img className="lightbox-img" src={lightbox.url} alt={lightbox.title} />
        </Modal>
      )}
    </>
  );
}
