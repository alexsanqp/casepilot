import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CaseYamlEditor } from '../components/CaseYamlEditor';

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
  const { projectId = '' } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const casesPath = `/p/${encodeURIComponent(projectId)}/cases`;

  return (
    <div>
      <div className="page-header">
        <h1>New case</h1>
      </div>
      <div className="editor">
        <label className="field">
          <span>Name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-case"
          />
        </label>
        <CaseYamlEditor
          projectId={projectId}
          caseName={name}
          initialYaml={TEMPLATE}
          onSaved={(saved) => navigate(`${casesPath}/${encodeURIComponent(saved)}`)}
          onCancel={() => navigate(casesPath)}
        />
      </div>
    </div>
  );
}
