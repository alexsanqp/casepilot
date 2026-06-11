import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { errorMessage, getCase, saveCase } from '../api/client';

const TEMPLATE = `name: my-case
url: https://example.com
steps:
  - Click the "Sign in" button
  - Type "user@example.com" into the email field
  - Submit the form
expect:
  - The dashboard heading is visible
  - The URL contains "/dashboard"
`;

export function CaseEditorPage() {
  const { name: routeName } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const isNew = routeName === undefined;

  const [name, setName] = useState(routeName ?? '');
  const [yaml, setYaml] = useState(isNew ? TEMPLATE : '');
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (routeName === undefined) return;
    let cancelled = false;
    getCase(routeName)
      .then((detail) => {
        if (cancelled) return;
        setYaml(detail.specYaml);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(errorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [routeName]);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Case name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveCase(trimmed, yaml);
      navigate('/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1>{isNew ? 'New case' : `Edit case: ${routeName}`}</h1>
      </div>
      {loading && <p className="muted">Loading case…</p>}
      {!loading && (
        <div className="editor">
          <label className="field">
            <span>Name</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!isNew}
              placeholder="my-case"
            />
          </label>
          <label className="field">
            <span>Spec YAML</span>
            <textarea
              className="textarea"
              value={yaml}
              onChange={(e) => setYaml(e.target.value)}
              rows={20}
              spellCheck={false}
            />
          </label>
          {error && <p className="message message-error">{error}</p>}
          <div className="editor-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn" onClick={() => navigate('/')}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
