const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, 'g');

/** Playwright error messages carry ANSI styling; stored artifacts must be plain text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}
