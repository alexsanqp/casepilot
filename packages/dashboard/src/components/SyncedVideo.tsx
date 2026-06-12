import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { optimizedVideoUrl, videoUrl } from '../api/client';
import type { RunStepResult, StepStatus } from '../api/types';
import { describeStep } from '../lib/steps';

export interface SyncedVideoHandle {
  seekTo: (offsetMs: number) => void;
}

const markerClass: Record<StepStatus, string> = {
  passed: 'timeline-marker-passed',
  failed: 'timeline-marker-failed',
  healed: 'timeline-marker-healed',
};

export const SyncedVideo = forwardRef<
  SyncedVideoHandle,
  {
    projectId: string;
    runId: string;
    steps: RunStepResult[];
    activeIndex: number | null;
    onMarkerClick: (step: RunStepResult) => void;
    hasOptimized?: boolean;
  }
>(function SyncedVideo({ projectId, runId, steps, activeIndex, onMarkerClick, hasOptimized }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [showOptimized, setShowOptimized] = useState(false);
  const src = showOptimized ? optimizedVideoUrl(projectId, runId) : videoUrl(projectId, runId);

  const seekTo = (offsetMs: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    video.currentTime = Math.min(Math.max(offsetMs / 1000, 0), video.duration);
  };

  useImperativeHandle(ref, () => ({ seekTo }));

  return (
    <div className="video-player">
      {hasOptimized && (
        <div className="video-source-toggle">
          <button
            type="button"
            className={`btn ${showOptimized ? '' : 'btn-primary'}`}
            onClick={() => setShowOptimized(false)}
          >
            original
          </button>
          <button
            type="button"
            className={`btn ${showOptimized ? 'btn-primary' : ''}`}
            onClick={() => setShowOptimized(true)}
          >
            optimized
          </button>
        </div>
      )}
      <video
        ref={videoRef}
        controls
        src={src}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          setDurationMs(Number.isFinite(d) && d > 0 ? d * 1000 : null);
        }}
      />
      {!showOptimized && durationMs !== null && steps.length > 0 && (
        <div className="timeline" role="list" aria-label="Step timeline">
          {steps.map((s) => (
            <button
              key={s.index}
              type="button"
              role="listitem"
              className={`timeline-marker ${markerClass[s.status]} ${
                s.index === activeIndex ? 'timeline-marker-active' : ''
              }`}
              style={{ left: `${Math.min(s.offsetMs / durationMs, 1) * 100}%` }}
              title={`#${s.index} ${describeStep(s.step)} (${s.status})`}
              onClick={() => {
                seekTo(s.offsetMs);
                onMarkerClick(s);
              }}
            />
          ))}
        </div>
      )}
      <a className="link" href={src} download={showOptimized ? `${runId}.optimized.webm` : `${runId}.webm`}>
        Download video
      </a>
    </div>
  );
});
