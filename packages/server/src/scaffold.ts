import path from 'node:path';
import { mkdir, stat, writeFile } from 'node:fs/promises';

const CONFIG_TEMPLATE = `# casepilot provider configuration
# Uncomment and adjust one or more providers, then set defaultProvider.
#
# defaultProvider: lmstudio
#
providers: []
#
# providers:
#   - id: lmstudio
#     kind: chat
#     type: openai-compatible
#     baseUrl: http://127.0.0.1:1234/v1
#     model: qwen2.5-coder-32b-instruct
#   - id: claude-code
#     kind: agent
#     type: claude-code
`;

const EXAMPLE_CASE = `name: example
url: https://example.com/
steps:
  - Click the "More information..." link
expect:
  - The page url contains "iana.org"
`;

// Ignore generated run/suite artifacts and the auth/ secrets dir at the repo
// root. (auth/ is also self-protected by an auth/.gitignore written on first
// profile save, in case this root file is removed.)
const GITIGNORE_TEMPLATE = `runs/
suites/
auth/
`;

export const CONFIG_FILE_NAME = 'casepilot.config.yaml';

export interface ScaffoldOutcome {
  created: string[];
  skipped: string[];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function scaffoldWorkspace(workspace: string): Promise<ScaffoldOutcome> {
  const created: string[] = [];
  const skipped: string[] = [];
  await mkdir(path.join(workspace, 'cases'), { recursive: true });

  const files: Array<[string, string]> = [
    [path.join(workspace, CONFIG_FILE_NAME), CONFIG_TEMPLATE],
    [path.join(workspace, '.gitignore'), GITIGNORE_TEMPLATE],
    [path.join(workspace, 'cases', 'example.case.yaml'), EXAMPLE_CASE],
  ];
  for (const [filePath, content] of files) {
    if (await exists(filePath)) {
      skipped.push(filePath);
      continue;
    }
    await writeFile(filePath, content, 'utf8');
    created.push(filePath);
  }
  return { created, skipped };
}

/** Scaffold only when the directory is not yet a casepilot workspace. */
export async function ensureWorkspaceScaffold(workspace: string): Promise<ScaffoldOutcome> {
  if (await exists(path.join(workspace, CONFIG_FILE_NAME))) {
    return { created: [], skipped: [] };
  }
  return scaffoldWorkspace(workspace);
}
