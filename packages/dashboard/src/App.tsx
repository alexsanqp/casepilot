import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom';
import { getHealth } from './api/client';
import { usePolling } from './hooks/usePolling';
import { CaseEditorPage } from './pages/CaseEditorPage';
import { CasesPage } from './pages/CasesPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { RunsPage } from './pages/RunsPage';

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

export function App() {
  return (
    <BrowserRouter>
      <div className="layout">
        <aside className="sidebar">
          <div className="wordmark">
            Case<span>pilot</span>
          </div>
          <nav className="nav">
            <NavLink to="/" end>
              Cases
            </NavLink>
            <NavLink to="/runs" end={false}>
              Runs
            </NavLink>
          </nav>
          <HealthIndicator />
        </aside>
        <main className="content">
          <Routes>
            <Route path="/" element={<CasesPage />} />
            <Route path="/cases/new" element={<CaseEditorPage />} />
            <Route path="/cases/:name/edit" element={<CaseEditorPage />} />
            <Route path="/runs" element={<RunsPage />} />
            <Route path="/runs/:id" element={<RunDetailPage />} />
            <Route path="*" element={<p className="muted">Page not found.</p>} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
