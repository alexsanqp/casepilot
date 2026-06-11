import { videoUrl } from '../api/client';

export function VideoPlayer({ projectId, runId }: { projectId: string; runId: string }) {
  const src = videoUrl(projectId, runId);
  return (
    <div className="video-player">
      <video controls src={src} />
      <a className="link" href={src} download={`${runId}.webm`}>
        Download video
      </a>
    </div>
  );
}
