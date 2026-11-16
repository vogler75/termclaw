// Usage limits of Claude Code and Codex on the project's machine: a chip in the project bar and a dialog.
import { h, clear, toast, modal, timeAgo, fmtTime } from './ui.js';

const snaps = new Map(); // projectId -> snapshot from the main process
const asked = new Map(); // projectId -> time of the last request
const REFRESH_MS = 120000;
const level = (pct) => (pct >= 95 ? 'bad' : pct >= 80 ? 'warn' : '');

function untilText(ts) {
  const min = Math.max(0, Math.round((ts - Date.now()) / 60000));
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ${min % 60} min`;
  return `${Math.round(min / 1440)} d`;
}

function chipContent(snap) {
  const t = snap && snap.tightest;
  if (!t) return { text: 'Usage', cls: '', title: 'Usage limits of Claude Code and Codex on this project’s machine' };
  const lines = [];
  for (const p of snap.providers) for (const w of p.windows) lines.push(`${p.name} ${w.label}: ${w.usedPercent === null ? 'reset' : Math.round(w.usedPercent) + ' % used'}${w.resetsAt ? ', resets in ' + untilText(w.resetsAt) : ''}${p.stale ? ' (old reading)' : ''}`);
  return { text: `Usage ${Math.round(t.usedPercent)} %`, cls: level(t.usedPercent), title: `${lines.join('\n')}\n\nFullest: ${t.provider} ${t.label} · ${snap.machine}` };
}

function paint(pid) {
  document.querySelectorAll(`[data-usage="${pid}"]`).forEach((el) => {
    const c = chipContent(snaps.get(pid));
    el.className = 'usage-chip ' + c.cls;
    el.title = c.title;
    el.querySelector('.usage-val').textContent = c.text;
  });
}

// Asks the main process when the last answer is older than two minutes (or force).
export async function refresh(ctx, pid, force = false) {
  if (!pid || ctx.S.config.settings.usage === false) return null;
  if (!force && Date.now() - (asked.get(pid) || 0) < REFRESH_MS) return snaps.get(pid) || null;
  asked.set(pid, Date.now());
  try {
    snaps.set(pid, await ctx.call('usageGet', pid, force));
  } catch (e) {
    snaps.set(pid, { providers: [], error: e.message, machine: '' });
  }
  paint(pid);
  return snaps.get(pid);
}

// Button for the project bar; null when the display is turned off in Settings.
export function chip(ctx, p) {
  if (ctx.S.config.settings.usage === false) return null;
  const c = chipContent(snaps.get(p.id));
  const el = h('button', { class: 'usage-chip ' + c.cls, 'data-usage': p.id, title: c.title, onclick: () => openDialog(ctx, p) },
    h('span', { class: 'usage-val' }, c.text));
  refresh(ctx, p.id);
  return el;
}

function providerCard(p) {
  return h('div', { class: 'usage-provider' },
    h('div', { class: 'row' }, h('b', null, p.name), h('span', { class: 'muted' }, `read ${timeAgo(p.capturedAt)} ago${p.stale ? ' — old, the windows may have moved on' : ''}`)),
    p.windows.map((w) => h('div', { class: 'usage-window' },
      h('span', { class: 'usage-label' }, w.label),
      h('div', { class: 'dk-bar usage-bar' }, h('span', { class: level(w.usedPercent || 0), style: { width: `${w.usedPercent || 0}%` } })),
      h('span', { class: 'usage-pct ' + level(w.usedPercent || 0) }, w.usedPercent === null ? 'reset' : `${Math.round(w.usedPercent)} %`),
      h('span', { class: 'muted', title: w.resetsAt ? fmtTime(w.resetsAt) : '' }, w.resetsAt ? `resets in ${untilText(w.resetsAt)}` : w.reset ? 'window has reset since the reading' : ''))));
}

function openDialog(ctx, p) {
  const body = h('div', { class: 'usage-dialog' });
  const act = async (fn, done) => {
    try { snaps.set(p.id, await fn()); paint(p.id); if (done) toast(done); } catch (e) { toast(e.message.replace(/^Error invoking remote method 'api': Error: /, ''), { error: true, ms: 8000 }); }
    fill();
  };
  const fill = () => {
    clear(body);
    const snap = snaps.get(p.id);
    if (!snap) { body.appendChild(h('div', { class: 'muted' }, 'Reading…')); return; }
    if (snap.error) body.appendChild(h('div', { class: 'bad' }, snap.error));
    for (const pr of snap.providers || []) body.appendChild(providerCard(pr));
    const has = (id) => (snap.providers || []).some((x) => x.id === id);
    if (snap.claudeSupported) {
      body.appendChild(h('div', { class: 'usage-provider' },
        has('claude') ? null : h('div', { class: 'row' }, h('b', null, 'Claude Code'), h('span', { class: 'muted' }, snap.claudeHook ? 'no reading yet' : 'not set up')),
        h('div', { class: 'muted' }, snap.claudeHook
          ? (has('claude') ? 'Claude Code hands its limits to the status line script TermClaw installed on this machine.' : 'The limits appear after the next answer of Claude Code on this machine. It reports them for subscription logins (Pro, Max, Team), from version 2.1.80.')
          : 'Claude Code reports its limits to its status line command. TermClaw can install a small script on this machine (~/.termclaw/usage) and enter it as statusLine in ~/.claude/settings.json. A status line you already use keeps running through it.'),
        h('div', { class: 'row' }, snap.claudeHook
          ? h('button', { onclick: () => act(() => ctx.call('usageClaudeOff', p.id), 'Removed; your former status line is back') }, 'Remove the script')
          : h('button', { class: 'primary', onclick: () => act(() => ctx.call('usageClaudeOn', p.id), 'Installed') }, 'Set up for Claude Code'))));
    }
    if (!has('codex') && !snap.error) body.appendChild(h('div', { class: 'usage-provider' },
      h('div', { class: 'row' }, h('b', null, 'Codex'), h('span', { class: 'muted' }, 'no reading')),
      h('div', { class: 'muted' }, 'Codex writes its limits into its session files (~/.codex/sessions); they show up here after it has answered once in the last two weeks. Nothing to set up.')));
  };
  fill();
  modal({
    title: `Usage limits · ${(snaps.get(p.id) || {}).machine || p.name}`,
    width: '620px',
    okText: null,
    cancelText: 'Close',
    body,
    extraButtons: [h('button', { onclick: () => act(() => ctx.call('usageGet', p.id, true)) }, '⟳ Read again')],
  });
  refresh(ctx, p.id, true).then(fill);
}
