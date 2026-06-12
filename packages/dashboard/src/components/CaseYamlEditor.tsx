import { useState } from 'react';
import { errorMessage, saveCase } from '../api/client';

export function CaseYamlEditor({
  projectId,
  caseName,
  initialYaml,
  onSaved,
  onCancel,
}: {
  projectId: string;
  caseName: string;
  initialYaml: string;
  onSaved: (name: string) => void;
  onCancel: () => void;
}) {
  const [yaml, setYaml] = useState(initialYaml);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const trimmed = caseName.trim();
    if (!trimmed) {
      setError('Case name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveCase(projectId, trimmed, yaml);
      onSaved(trimmed);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="editor">
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
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
