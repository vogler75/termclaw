// Text of a terminal selection as it goes to the clipboard.
// Agent TUIs (Claude Code, Copilot, …) indent their output; the spaces every non-blank line shares are
// removed, so copied code and commands start in column 0 and keep their relative indentation.
export function stripGutter(sel) {
  const lines = String(sel || '').split('\n');
  let gutter = Infinity;
  for (const l of lines) {
    const text = l.replace(/\r$/, '');
    const indent = text.length - text.trimStart().length;
    if (indent === text.length) continue; // blank line: no evidence either way
    if (/^\s*\t/.test(text)) return sel; // tabs: leave untouched
    gutter = Math.min(gutter, indent);
    if (!gutter) return sel;
  }
  if (!Number.isFinite(gutter)) return sel;
  return lines.map((l) => l.slice(Math.min(gutter, l.length - l.trimStart().length))).join('\n');
}

// Lines a paste would send, not counting a trailing line break.
export function pasteLines(text) {
  return String(text || '').replace(/[\r\n]+$/, '').split(/\r\n|\r|\n/).length;
}
