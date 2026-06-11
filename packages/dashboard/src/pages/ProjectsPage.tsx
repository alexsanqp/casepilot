import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { addProject, errorMessage, removeProject } from '../api/client';
import type { Project } from '../api/types';
import { formatTime } from '../lib/format';
import { useProjects } from '../state/projects';

function AddProjectForm({ onAdded }: { onAdded: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedPath = path.trim();
    if (!trimmedName || !trimmedPath) {
      setError('Both name and absolute path are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addProject(trimmedName, trimmedPath);
      setName('');
      setPath('');
      await onAdded();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="add-project-form" onSubmit={(e) => void submit(e)}>
      <label className="field">
        <span>Name</span>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-project"
          disabled={busy}
        />
      </label>
      <label className="field">
        <span>Absolute path</span>
        <input
          className="input"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="C:\projects\my-project"
          disabled={busy}
        />
      </label>
      <div className="editor-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Adding…' : 'Add project'}
        </button>
      </div>
      {error && <p className="message message-error">{error}</p>}
    </form>
  );
}

function ProjectCard({
  project,
  onRemoved,
}: {
  project: Project;
  onRemoved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (
      !window.confirm(
        `Remove project "${project.name}" from the registry? The files on disk are not deleted.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await removeProject(project.id);
      await onRemoved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="project-card">
      <div className="project-card-head">
        <Link className="project-name" to={`/p/${encodeURIComponent(project.id)}/cases`}>
          {project.name}
        </Link>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy}
          onClick={() => void remove()}
        >
          Remove
        </button>
      </div>
      <div className="project-path" title={project.path}>
        {project.path}
      </div>
      <div className="project-meta">
        <span>
          {project.caseCount} {project.caseCount === 1 ? 'case' : 'cases'}
        </span>
        <span className="muted">
          Last run: {project.lastRunAt ? formatTime(project.lastRunAt) : 'never'}
        </span>
      </div>
      {error && <p className="message message-error">{error}</p>}
    </div>
  );
}

export function ProjectsPage() {
  const { projects, error, refresh } = useProjects();

  if (projects && projects.length === 0) {
    return (
      <div className="hero">
        <h1>Welcome to Casepilot</h1>
        <p className="muted">
          No projects yet. Register a project directory to start managing its test cases.
        </p>
        <AddProjectForm onAdded={refresh} />
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>Projects</h1>
      </div>
      {error && <p className="message message-error">{error}</p>}
      {!projects && !error && <p className="muted">Loading projects…</p>}
      {projects && projects.length > 0 && (
        <div className="project-grid">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} onRemoved={refresh} />
          ))}
        </div>
      )}
      {projects && (
        <section className="add-project-section">
          <h2>Add project</h2>
          <AddProjectForm onAdded={refresh} />
        </section>
      )}
    </div>
  );
}
