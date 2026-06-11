#!/usr/bin/env node
import { createActions } from './actions.js';
import { createProgram } from './program.js';

createProgram(createActions())
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    process.stderr.write(`casepilot: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
