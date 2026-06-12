import type { HealPolicy, RunMode, StartRunRequest, Viewport } from '../api/types';

const VIEWPORT_PRESETS = ['1920x1080', '1366x768', '1280x720'] as const;
const CUSTOM = 'custom';

export interface RunOptionsValue {
  video: boolean;
  optimizeVideo: boolean;
  screenshots: boolean;
  viewport: string;
  customViewport: string;
  healPolicy: HealPolicy;
  baseUrl: string;
}

export const defaultRunOptions: RunOptionsValue = {
  video: false,
  optimizeVideo: false,
  screenshots: false,
  viewport: VIEWPORT_PRESETS[0],
  customViewport: '',
  healPolicy: 'review',
  baseUrl: '',
};

function parseViewport(value: string): Viewport | undefined {
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) return undefined;
  return { width, height };
}

export function runOptionsToRequest(
  options: RunOptionsValue,
  mode: RunMode,
): Pick<StartRunRequest, 'video' | 'optimizeVideo' | 'screenshots' | 'viewport' | 'healPolicy' | 'baseUrl'> {
  const raw = options.viewport === CUSTOM ? options.customViewport : options.viewport;
  const viewport = parseViewport(raw);
  const baseUrl = options.baseUrl.trim();
  return {
    video: options.video,
    optimizeVideo: options.video && options.optimizeVideo,
    screenshots: options.screenshots,
    ...(viewport ? { viewport } : {}),
    ...(mode === 'replay' ? { healPolicy: options.healPolicy } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export function RunOptions({
  value,
  onChange,
  disabled,
}: {
  value: RunOptionsValue;
  onChange: (value: RunOptionsValue) => void;
  disabled?: boolean;
}) {
  const set = (patch: Partial<RunOptionsValue>) => onChange({ ...value, ...patch });

  return (
    <details className="run-options">
      <summary className="btn">Options</summary>
      <div className="run-options-panel">
        <label className="toggle" title="Record a video of the run">
          <input
            type="checkbox"
            checked={value.video}
            disabled={disabled}
            onChange={(e) => set({ video: e.target.checked })}
          />
          video
        </label>
        <label className="toggle" title="Also write an idle-trimmed copy of the run video">
          <input
            type="checkbox"
            checked={value.optimizeVideo}
            disabled={disabled || !value.video}
            onChange={(e) => set({ optimizeVideo: e.target.checked })}
          />
          optimize video
        </label>
        <label className="toggle" title="Capture a screenshot per step">
          <input
            type="checkbox"
            checked={value.screenshots}
            disabled={disabled}
            onChange={(e) => set({ screenshots: e.target.checked })}
          />
          screenshots
        </label>
        <label className="field">
          <span>Viewport</span>
          <select
            className="select"
            value={value.viewport}
            disabled={disabled}
            onChange={(e) => set({ viewport: e.target.value })}
          >
            {VIEWPORT_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {preset}
              </option>
            ))}
            <option value={CUSTOM}>custom</option>
          </select>
        </label>
        {value.viewport === CUSTOM && (
          <label className="field">
            <span>Custom WxH</span>
            <input
              className="input"
              value={value.customViewport}
              placeholder="1600x900"
              disabled={disabled}
              onChange={(e) => set({ customViewport: e.target.value })}
            />
          </label>
        )}
        <label className="field" title="Target base URL; relative case urls resolve against it (default: workspace baseUrl)">
          <span>Base URL</span>
          <input
            className="input"
            value={value.baseUrl}
            placeholder="workspace default"
            disabled={disabled}
            onChange={(e) => set({ baseUrl: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Heal policy (replay)</span>
          <select
            className="select"
            value={value.healPolicy}
            disabled={disabled}
            onChange={(e) => set({ healPolicy: e.target.value as HealPolicy })}
          >
            <option value="review">review</option>
            <option value="auto">auto</option>
          </select>
        </label>
      </div>
    </details>
  );
}
