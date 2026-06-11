import {
  BrowserRouter,
  Link,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useMatch,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { getHealth } from './api/client';
import { usePolling } from './hooks/usePolling';
import { CaseEditorPage } from './pages/CaseEditorPage';
import { CasesPage } from './pages/CasesPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { RunsPage } from './pages/RunsPage';
import { ProjectsProvider, useProjects } from './state/projects';

function HealthIndicator() {
  const { data, error, loading } = usePolling(getHealth, 10_000);
  const state = loading && !data ? 'unknown' : !error && data?.ok ? 'ok' : 'down';
  const label =
    state === 'ok' ? `online · v${data?.version ?? '?'}` : state === 'down' ? 'offline' : 'checking…';
  return (
    <div className="health" title={error ?? undefined}>
      <span className={`health-dot health-${state}`} />
      <span>{label}</span>
    </div>
  );
}

function ProjectSwitcher({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { projects } = useProjects();
  const known = projects?.some((p) => p.id === projectId) ?? false;

  return (
    <select
      className="select project-switcher"
      value={projectId}
      aria-label="Switch project"
      onChange={(e) => {
        const id = e.target.value;
        navigate(id ? `/p/${encodeURIComponent(id)}/cases` : '/');
      }}
    >
      <option value="">All projects</option>
      {projectId && !known && <option value={projectId}>{projectId}</option>}
      {projects?.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

function Sidebar() {
  const match = useMatch('/p/:projectId/*');
  const projectId = match?.params.projectId ?? '';

  return (
    <aside className="sidebar">
      <div className="wordmark">
        Case<span>pilot</span>
      </div>
      <ProjectSwitcher projectId={projectId} />
      {projectId && (
        <nav className="nav">
          <NavLink to={`/p/${encodeURIComponent(projectId)}/cases`} end={false}>
            Cases
          </NavLink>
          <NavLink to={`/p/${encodeURIComponent(projectId)}/runs`} end={false}>
            Runs
          </NavLink>
        </nav>
      )}
      <HealthIndicator />
    </aside>
  );
}

function ProjectScopeLayout() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const { projects } = useProjects();
  const project = projects?.find((p) => p.id === projectId);

  return (
    <div>
      <nav className="crumbs">
        <Link className="link" to="/" title="Back to all projects">
          {project?.name ?? projectId}
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <ProjectsProvider>
        <div className="layout">
          <Sidebar />
          <main className="content">
            <Routes>
              <Route path="/" element={<ProjectsPage />} />
              <Route path="/p/:projectId" element={<ProjectScopeLayout />}>
                <Route index element={<Navigate to="cases" replace />} />
                <Route path="cases" element={<CasesPage />} />
                <Route path="cases/new" element={<CaseEditorPage />} />
                <Route path="cases/:name/edit" element={<CaseEditorPage />} />
                <Route path="runs" element={<RunsPage />} />
                <Route path="runs/:id" element={<RunDetailPage />} />
              </Route>
              <Route path="*" element={<p className="muted">Page not found.</p>} />
            </Routes>
          </main>
        </div>
      </ProjectsProvider>
    </BrowserRouter>
  );
}
