'use strict';
// SSH_ASKPASS helper for stored ssh passwords: ssh runs it with the prompt as argument and reads the answer
// from its stdout. It prints TERMCLAW_SSH_PASSWORD (set only in the environment of that ssh process) for
// password prompts and fails every other prompt (e.g. an unknown host key), like BatchMode does.
const fs = require('fs');
const path = require('path');

const WIN_SCRIPT = [
  '@echo off',
  'setlocal EnableDelayedExpansion',
  'set "p=%~1"',
  // Substitution is case-insensitive: unchanged text means the prompt does not mention a password.
  'if /i "!p:password=!"=="!p!" exit /b 1',
  'if not defined TERMCLAW_SSH_PASSWORD exit /b 1',
  'echo(!TERMCLAW_SSH_PASSWORD!',
  '',
].join('\r\n');

const POSIX_SCRIPT = [
  '#!/bin/sh',
  'case "$1" in',
  '  *[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]*) [ -n "$TERMCLAW_SSH_PASSWORD" ] || exit 1; printf \'%s\n\' "$TERMCLAW_SSH_PASSWORD" ;;',
  '  *) exit 1 ;;',
  'esac',
  '',
].join('\n');

// Writes the helper into dir (the app's data folder) and returns its path; '' when that fails.
function install(dir, platform = process.platform) {
  const win = platform === 'win32';
  const file = path.join(dir, win ? 'ssh-askpass.cmd' : 'ssh-askpass.sh');
  const text = win ? WIN_SCRIPT : POSIX_SCRIPT;
  try {
    let cur = null;
    try { cur = fs.readFileSync(file, 'utf8'); } catch {}
    if (cur !== text) fs.writeFileSync(file, text, { mode: 0o700 });
    if (!win) fs.chmodSync(file, 0o700);
    return file;
  } catch {
    return '';
  }
}

module.exports = { install, WIN_SCRIPT, POSIX_SCRIPT };
