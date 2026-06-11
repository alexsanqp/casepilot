// Failing fake agent CLI: prints to stderr and exits non-zero.
// exitCode (not process.exit) so the piped stderr is flushed before exit.
process.stderr.write('boom: fake CLI failure for testing\n');
process.exitCode = 2;
