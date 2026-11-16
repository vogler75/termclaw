'use strict';
// Usage limits of the coding agents on a project's machine: how much of the 5-hour and weekly windows
// is used and when they reset. Nothing is asked from the providers; the app only reads what the agents
// already keep on the machine:
// - Claude Code hands its rate limits to its status line command (rate_limits in the JSON on stdin, for
//   subscription logins, Claude Code 2.1.80 or newer). A small status line script stores that JSON and
//   then runs the user's own status line. It is installed on request (installClaude).
// - Codex writes its rate limits into the session files under ~/.codex/sessions; the newest one is read.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Target, parseSections } = require('./coding-agents/target');
const { resolveTarget } = require('./connect');

const DIR = '.termclaw/usage';
const SCRIPT_REL = `${DIR}/claude-statusline.sh`;
const USER_REL = `${DIR}/claude-statusline-user`;
const SETTINGS = { base: 'home', rel: '.claude/settings.json' };
const STATUS_COMMAND = `sh "$HOME/${SCRIPT_REL}"`;
const isManaged = (command) => typeof command === 'string' && command.includes(SCRIPT_REL);
const CACHE_MS = 60000;
// A snapshot older than this says little about the windows of today.
const STALE_MS = 6 * 3600e3;

// Status line command for Claude Code: keeps the latest payload with rate limits, then prints the user's
// own status line (their former command, kept in a file next to this script).
const STATUSLINE_SCRIPT = `#!/bin/sh
# Installed by TermClaw (usage display). Stores Claude Code's rate limits, then runs your own status line.
dir="$HOME/${DIR}"
payload=$(cat)
case "$payload" in
  *'"rate_limits"'*)
    printf '%s' "$payload" > "$dir/claude.json.$$" 2>/dev/null && mv -f "$dir/claude.json.$$" "$dir/claude.json" 2>/dev/null
    ;;
esac
if [ -s "$dir/claude-statusline-user" ]; then
  printf '%s' "$payload" | sh "$dir/claude-statusline-user"
fi
exit 0
`;

// Prints what is known on the machine, one marker line each.
const COLLECT_SCRIPT = `u="$HOME/${DIR}/claude.json"
if [ -s "$u" ]; then
  n=$(date +%s)
  m=$(stat -c %Y "$u" 2>/dev/null || stat -f %m "$u" 2>/dev/null)
  echo "@@CLAUDE_AGE $((n - \${m:-$n}))"
  printf '@@CLAUDE '; tr -d '\\n\\r' < "$u"; echo
fi
[ -f "$HOME/${SCRIPT_REL}" ] && grep -q '${SCRIPT_REL}' "$HOME/.claude/settings.json" 2>/dev/null && echo '@@CLAUDE_HOOK 1'
d="\${CODEX_HOME:-$HOME/.codex}/sessions"
if [ -d "$d" ]; then
  fl=$(find "$d" -name 'rollout-*.jsonl' -mtime -14 2>/dev/null)
  if [ -n "$fl" ]; then
    for r in $(ls -t $fl 2>/dev/null | head -n 8); do
      l=$(grep '"rate_limits"' "$r" 2>/dev/null | tail -n 1)
      if [ -n "$l" ]; then printf '@@CODEX %s\\n' "$l"; break; fi
    done
  fi
fi
echo '@@DONE'
`;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Reset time in ms from epoch seconds, epoch ms or an ISO string.
function resetMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string' && v.trim()) { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
}

function windowLabel(minutes) {
  if (!minutes) return '';
  if (minutes === 300) return '5 h';
  if (minutes === 10080) return 'week';
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

// A window whose reset time has passed starts again at 0; the stored percentage no longer applies.
function finishWindow(w, now) {
  if (w.resetsAt && w.resetsAt <= now) return { ...w, usedPercent: null, resetsAt: null, reset: true };
  return w;
}

// Claude Code status line payload → windows. capturedAt = when the payload was stored.
function parseClaude(text, capturedAt, now = Date.now()) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  const rl = data && data.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const windows = [];
  for (const [key, label] of [['five_hour', '5 h'], ['seven_day', 'week']]) {
    const w = rl[key];
    if (!w || typeof w !== 'object') continue;
    const used = num(w.used_percentage) ?? num(w.utilization);
    if (used === null) continue;
    windows.push(finishWindow({ label, usedPercent: Math.max(0, Math.min(100, used)), resetsAt: resetMs(w.resets_at) }, now));
  }
  if (!windows.length) return null;
  return { id: 'claude', name: 'Claude Code', windows, capturedAt, stale: now - capturedAt > STALE_MS };
}

function findRateLimits(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 5) return null;
  if (o.rate_limits && typeof o.rate_limits === 'object') return o.rate_limits;
  for (const v of Object.values(o)) { const r = findRateLimits(v, depth + 1); if (r) return r; }
  return null;
}

// One line of a Codex session file (a token_count event with rate_limits) → windows.
function parseCodex(line, now = Date.now()) {
  let data;
  try { data = JSON.parse(line); } catch { return null; }
  const rl = findRateLimits(data);
  if (!rl) return null;
  const capturedAt = resetMs(data.timestamp) || now;
  const windows = [];
  for (const key of ['primary', 'secondary']) {
    const w = rl[key];
    if (!w || typeof w !== 'object') continue;
    const used = num(w.used_percent) ?? num(w.usedPercent);
    if (used === null) continue;
    const minutes = num(w.window_minutes) ?? num(w.windowDurationMins) ?? (key === 'primary' ? 300 : 10080);
    // Older Codex versions give the seconds until the reset, counted from the event.
    const inSec = num(w.resets_in_seconds);
    const resetsAt = resetMs(w.resets_at ?? w.resetsAt) || (inSec !== null ? capturedAt + inSec * 1000 : null);
    windows.push(finishWindow({ label: windowLabel(minutes), usedPercent: Math.max(0, Math.min(100, used)), resetsAt }, now));
  }
  if (!windows.length) return null;
  return { id: 'codex', name: 'Codex', windows, capturedAt, stale: now - capturedAt > STALE_MS };
}

// Output of COLLECT_SCRIPT → {providers, claudeHook}.
function parseCollect(out, now = Date.now()) {
  const providers = [];
  let age = 0;
  let claudeHook = false;
  for (const raw of String(out || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('@@CLAUDE_AGE ')) age = Math.max(0, Number(line.slice(13)) || 0);
    else if (line.startsWith('@@CLAUDE_HOOK')) claudeHook = true;
    else if (line.startsWith('@@CLAUDE ')) { const p = parseClaude(line.slice(9), now - age * 1000, now); if (p) providers.push(p); }
    else if (line.startsWith('@@CODEX ')) { const p = parseCodex(line.slice(8), now); if (p) providers.push(p); }
  }
  return { providers, claudeHook };
}

// The fullest window of all providers that is still running: what the chip in the project bar shows.
function tightest(providers) {
  let best = null;
  for (const p of providers || []) {
    if (p.stale) continue;
    for (const w of p.windows) if (w.usedPercent !== null && (!best || w.usedPercent > best.usedPercent)) best = { provider: p.name, ...w };
  }
  return best;
}

// settings.json of Claude Code with the status line pointing to the script. Returns the new text and the
// user's former command (null when there was none or it already was ours).
function applyStatusLine(text) {
  let cfg = {};
  if (text && text.trim()) {
    try { cfg = JSON.parse(text); } catch { throw new Error('~/.claude/settings.json is not valid JSON; fix it first'); }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('~/.claude/settings.json is not a JSON object');
  }
  const cur = cfg.statusLine && typeof cfg.statusLine === 'object' ? cfg.statusLine : null;
  const former = cur && typeof cur.command === 'string' && !isManaged(cur.command) ? cur.command : null;
  cfg.statusLine = { ...(cur || {}), type: 'command', command: STATUS_COMMAND };
  return { text: JSON.stringify(cfg, null, 2) + '\n', former, already: !!cur && isManaged(cur.command) };
}

// Puts the user's former command back (or removes the status line when there was none).
function removeStatusLine(text, former) {
  let cfg;
  try { cfg = JSON.parse(text); } catch { return null; }
  const cur = cfg && cfg.statusLine;
  if (!cur || !isManaged(cur.command)) return null;
  if (former && former.trim()) cfg.statusLine = { ...cur, command: former.trim() };
  else delete cfg.statusLine;
  return JSON.stringify(cfg, null, 2) + '\n';
}

// Newest Codex session file with rate limits, read with Node (local Windows projects).
function collectLocalCodex(home = os.homedir(), now = Date.now()) {
  const root = path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'sessions');
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(f, depth + 1); } else if (/^rollout-.*\.jsonl$/.test(e.name)) {
        try { const st = fs.statSync(f); if (now - st.mtimeMs < 14 * 86400e3) files.push({ f, m: st.mtimeMs }); } catch {}
      }
    }
  };
  walk(root, 0);
  for (const { f } of files.sort((a, b) => b.m - a.m).slice(0, 8)) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const lines = text.split('\n').filter((l) => l.includes('"rate_limits"'));
    const p = lines.length ? parseCodex(lines[lines.length - 1], now) : null;
    if (p) return p;
  }
  return null;
}

class UsageManager extends EventEmitter {
  constructor({ store, audit }) {
    super();
    this.store = store;
    this.audit = audit || { add() {} };
    this.cache = new Map(); // machine key -> {at, snap, pending}
  }

  _host(project) { return project.hostId ? this.store.getHost(project.hostId) : null; }

  // Projects on the same machine and account share one reading.
  machine(project) {
    const host = this._host(project);
    if (project.type === 'ssh') {
      const t = resolveTarget(project, host);
      const dest = `${t.user ? t.user + '@' : ''}${t.hostname}${t.port && Number(t.port) !== 22 ? ':' + t.port : ''}`;
      return { key: 'ssh:' + dest, label: host ? host.name : dest };
    }
    if (project.type === 'wsl') return { key: 'wsl:' + (project.wslDistro || ''), label: 'WSL' + (project.wslDistro ? ' ' + project.wslDistro : '') };
    return { key: 'local', label: 'this computer' };
  }

  async get(projectId, { force = false } = {}) {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error('unknown project');
    const m = this.machine(project);
    const c = this.cache.get(m.key);
    if (c && c.pending) return c.pending;
    if (c && c.snap && !force && Date.now() - c.at < CACHE_MS) return c.snap;
    const pending = this._collect(project, m).then((snap) => { this.cache.set(m.key, { at: Date.now(), snap }); return snap; }, (e) => { this.cache.delete(m.key); throw e; });
    this.cache.set(m.key, { ...(c || {}), pending });
    return pending;
  }

  async _collect(project, m) {
    const target = new Target(project, this._host(project));
    const base = { machine: m.label, at: Date.now(), providers: [], claudeHook: false, claudeSupported: target.kind === 'posix', error: null };
    if (target.kind !== 'posix') {
      // Windows: Codex's files are read directly on this computer; a Windows machine over SSH is not read.
      if (target.remoteWindows) return { ...base, error: 'Usage is read on Linux, macOS and WSL machines and on this computer.' };
      const codex = collectLocalCodex();
      return { ...base, providers: codex ? [codex] : [], tightest: tightest(codex ? [codex] : []) };
    }
    const r = await target.run(COLLECT_SCRIPT, { timeout: 30000 });
    if (!r.out.includes('@@DONE')) return { ...base, error: (r.err || r.out || 'no answer from the machine').trim().split('\n').pop().slice(0, 200) };
    const parsed = parseCollect(r.out);
    return { ...base, ...parsed, tightest: tightest(parsed.providers) };
  }

  // Installs the status line script for Claude Code on the project's machine (posix only).
  async installClaude(projectId) {
    const project = this.store.getProject(projectId);
    const target = new Target(project, this._host(project));
    if (target.kind !== 'posix') throw new Error('Claude Code usage is read on Linux, macOS and WSL machines.');
    const read = await target.run(target.readSnippet('settings', SETTINGS), { timeout: 30000 });
    if (read.code !== 0) throw new Error((read.err || 'could not read ~/.claude/settings.json').trim().slice(0, 300));
    const { text, former, already } = applyStatusLine(parseSections(read.out).file.settings || '');
    const script = [
      target.strict(true),
      target.writeSnippet({ base: 'home', rel: SCRIPT_REL }, STATUSLINE_SCRIPT),
      `chmod +x ${target.pathExpr({ base: 'home', rel: SCRIPT_REL })}`,
      // The former command is only replaced by a newer one, so installing twice keeps it.
      ...(former ? [target.writeSnippet({ base: 'home', rel: USER_REL }, former + '\n')] : []),
      ...(already ? [] : [target.writeSnippet(SETTINGS, text)]),
    ].join('\n');
    const r = await target.run(script, { timeout: 30000 });
    if (r.code !== 0) throw new Error((r.err || r.out || 'failed').trim().slice(0, 300));
    this.audit.add({ source: 'app', action: 'usage.claude-on', detail: `${project.name} (${this.machine(project).label})${former ? ', kept the existing status line' : ''}` });
    return this.get(projectId, { force: true });
  }

  async removeClaude(projectId) {
    const project = this.store.getProject(projectId);
    const target = new Target(project, this._host(project));
    if (target.kind !== 'posix') return this.get(projectId, { force: true });
    const read = await target.run([target.readSnippet('settings', SETTINGS), target.readSnippet('former', { base: 'home', rel: USER_REL })].join('\n'), { timeout: 30000 });
    const files = parseSections(read.out).file;
    const text = removeStatusLine(files.settings || '', files.former || '');
    // Without a readable settings file the status line would keep pointing to a script that is gone.
    if (!text && (files.settings || '').includes(SCRIPT_REL)) throw new Error('~/.claude/settings.json is not valid JSON; remove the statusLine entry there by hand');
    const script = [
      target.strict(true),
      ...(text ? [target.writeSnippet(SETTINGS, text)] : []),
      target.removeDirSnippet({ base: 'home', rel: DIR }),
    ].join('\n');
    const r = await target.run(script, { timeout: 30000 });
    if (r.code !== 0) throw new Error((r.err || r.out || 'failed').trim().slice(0, 300));
    this.audit.add({ source: 'app', action: 'usage.claude-off', detail: `${project.name} (${this.machine(project).label})` });
    return this.get(projectId, { force: true });
  }
}

module.exports = {
  UsageManager, parseClaude, parseCodex, parseCollect, tightest, applyStatusLine, removeStatusLine, collectLocalCodex, windowLabel,
  STATUSLINE_SCRIPT, COLLECT_SCRIPT, STATUS_COMMAND,
};
