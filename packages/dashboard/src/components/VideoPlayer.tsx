import { videoUrl } from '../api/client';

export function VideoPlayer({ runId }: { runId: string }) {
  const src = videoUrl(runId);
  return (
    <div className="video-player">
      <video controls src={src} />
      <a className="link" href={src} download={`${runId}.webm`}>
        Download video
      </a>
    </div>
  );
}
