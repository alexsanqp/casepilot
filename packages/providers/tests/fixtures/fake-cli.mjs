// Fake agent CLI: echoes one JSONL line with its argv, captured stdin, and, if
// present, the parsed --mcp-config file contents (read now because the provider
// deletes it).
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const idx = args.indexOf('--mcp-config');
let mcpConfig = null;
if (idx !== -1 && args[idx + 1]) {
  mcpConfig = JSON.parse(readFileSync(args[idx + 1], 'utf8'));
}
let stdin = '';
try {
  // With stdio[0]='ignore' this reads EOF immediately; with 'pipe' it gets the payload.
  for await (const chunk of process.stdin) stdin += chunk;
} catch {
  stdin = '';
}
// No process.exit: it can truncate piped stdout on Windows before the flush.
process.stdout.write(`${JSON.stringify({ type: 'fake-cli', args, stdin, mcpConfig })}\n`);
