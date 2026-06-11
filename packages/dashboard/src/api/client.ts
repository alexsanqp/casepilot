import type {
  CaseDetail,
  CaseSummary,
  ExportResponse,
  Health,
  ProvidersResponse,
  RunDetail,
  RunSummary,
  StartRunRequest,
  StartRunResponse,
} from './types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>;
      const detail = record['error'] ?? record['message'];
      if (typeof detail === 'string' && detail.length > 0) message = detail;
    }
  } catch {
    // non-JSON error body, keep status text
  }
  return new ApiError(res.status, message);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function requestText(path: string): Promise<string> {
  const res = await fetch(path);
  if (!res.ok) throw await toApiError(res);
  return res.text();
}

const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const getHealth = (): Promise<Health> => requestJson('/api/health');

export const listCases = (): Promise<CaseSummary[]> => requestJson('/api/cases');

export const getCase = (name: string): Promise<CaseDetail> =>
  requestJson(`/api/cases/${encodeURIComponent(name)}`);

export const saveCase = (name: string, specYaml: string): Promise<unknown> =>
  requestJson(`/api/cases/${encodeURIComponent(name)}`, { method: 'PUT', ...json({ specYaml }) });

export const deleteCase = (name: string): Promise<unknown> =>
  requestJson(`/api/cases/${encodeURIComponent(name)}`, { method: 'DELETE' });

export const exportCase = (name: string): Promise<ExportResponse> =>
  requestJson(`/api/cases/${encodeURIComponent(name)}/export`, { method: 'POST' });

export const getProviders = (): Promise<ProvidersResponse> => requestJson('/api/providers');

export const startRun = (req: StartRunRequest): Promise<StartRunResponse> =>
  requestJson('/api/runs', { method: 'POST', ...json(req) });

export const listRuns = (): Promise<RunSummary[]> => requestJson('/api/runs');

export const getRun = (id: string): Promise<RunDetail> =>
  requestJson(`/api/runs/${encodeURIComponent(id)}`);

export const getTranscript = (id: string): Promise<string> =>
  requestText(`/api/runs/${encodeURIComponent(id)}/transcript`);

export const videoUrl = (id: string): string => `/api/runs/${encodeURIComponent(id)}/video`;

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
