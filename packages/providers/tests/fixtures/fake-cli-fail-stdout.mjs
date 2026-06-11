// Failing fake agent CLI that reports its error on stdout only (like
// `claude -p --output-format stream-json`), with silent stderr.
process.stdout.write('{"type":"result","is_error":true,"result":"Failed to authenticate. API Error: 401"}\n');
process.exitCode = 1;
