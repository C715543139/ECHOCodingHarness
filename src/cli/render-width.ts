const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])`, 'gu');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function isCombining(code: number): boolean {
  return (
    (code >= 0x300 && code <= 0x36f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  );
}

function isWide(code: number): boolean {
  return (
    code === 0x1100 ||
    (code >= 0x1101 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

export function codePointWidth(code: number): number {
  if (code <= 31 || code === 127) return 0;
  if (isCombining(code)) return 0;
  return isWide(code) ? 2 : 1;
}

export function visibleWidth(text: string): number {
  let width = 0;
  for (const character of stripAnsi(text)) {
    width += codePointWidth(character.codePointAt(0) ?? 0);
  }
  return width;
}

export function wrapToWidth(text: string, width: number): readonly string[] {
  if (width < 1) return [text];
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    lines.push(...wrapParagraph(paragraph, width));
  }
  return lines;
}

function wrapParagraph(text: string, width: number): readonly string[] {
  if (text.length === 0) return [''];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (visibleWidth(remaining) <= width) {
      lines.push(remaining);
      break;
    }
    let taken = '';
    let takenWidth = 0;
    let breakAt = -1;
    for (const character of remaining) {
      const characterWidth = visibleWidth(character);
      if (taken.length > 0 && takenWidth + characterWidth > width) break;
      if (character === ' ') breakAt = taken.length;
      taken += character;
      takenWidth += characterWidth;
    }
    if (breakAt > 0) {
      lines.push(taken.slice(0, breakAt));
      remaining = remaining.slice(breakAt + 1);
    } else {
      lines.push(taken);
      remaining = remaining.slice(taken.length);
    }
  }
  return lines;
}
