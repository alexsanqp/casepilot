import type {
  AddProjectResponse,
  CaseDetail,
  CaseSummary,
  ExportResponse,
  Health,
  ProjectsResponse,
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

const projectBase = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}`;

export const getHealth = (): Promise<Health> => requestJson('/api/health');

export const listProjects = (): Promise<ProjectsResponse> => requestJson('/api/projects');

export const addProject = (name: string, path: string): Promise<AddProjectResponse> =>
  requestJson('/api/projects', { method: 'POST', ...json({ name, path }) });

export const removeProject = (id: string): Promise<unknown> =>
  requestJson(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const listCases = (projectId: string): Promise<CaseSummary[]> =>
  requestJson(`${projectBase(projectId)}/cases`);

export const getCase = (projectId: string, name: string): Promise<CaseDetail> =>
  requestJson(`${projectBase(projectId)}/cases/${encodeURIComponent(name)}`);

export const saveCase = (projectId: string, name: string, specYaml: string): Promise<unknown> =>
  requestJson(`${projectBase(projectId)}/cases/${encodeURIComponent(name)}`, {
    method: 'PUT',
    ...json({ specYaml }),
  });

export const deleteCase = (projectId: string, name: string): Promise<unknown> =>
  requestJson(`${projectBase(projectId)}/cases/${encodeURIComponent(name)}`, { method: 'DELETE' });

export const exportCase = (projectId: string, name: string): Promise<ExportResponse> =>
  requestJson(`${projectBase(projectId)}/cases/${encodeURIComponent(name)}/export`, {
    method: 'POST',
  });

export const getProviders = (projectId: string): Promise<ProvidersResponse> =>
  requestJson(`${projectBase(projectId)}/providers`);

export const startRun = (projectId: string, req: StartRunRequest): Promise<StartRunResponse> =>
  requestJson(`${projectBase(projectId)}/runs`, { method: 'POST', ...json(req) });

export const listRuns = (projectId: string): Promise<RunSummary[]> =>
  requestJson(`${projectBase(projectId)}/runs`);

export const getRun = (projectId: string, id: string): Promise<RunDetail> =>
  requestJson(`${projectBase(projectId)}/runs/${encodeURIComponent(id)}`);

export const getTranscript = (projectId: string, id: string): Promise<string> =>
  requestText(`${projectBase(projectId)}/runs/${encodeURIComponent(id)}/transcript`);

export const videoUrl = (projectId: string, id: string): string =>
  `${projectBase(projectId)}/runs/${encodeURIComponent(id)}/video`;

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
