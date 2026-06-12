const ansiPattern = /\u001b\[[0-9;?]*[a-zA-Z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ansiPattern, '');
}
