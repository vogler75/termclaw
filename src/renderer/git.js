// Git tab of a project, in the style of GitHub Desktop: repository and branch pickers, push / pull / fetch
// (ff-only, rebase, merge, force-with-lease), GitHub/GitLab/Bitbucket links & gh PR/check status,
// stash manager, amend, merge/rebase/conflict actions, syntax-highlighted diffs, and searchable history.
import { h, clear, toast, confirmDialog, prompt, modal, contextMenu, timeAgo } from './ui.js';
import * as files from './files.js';
import { detectFormat, tokenizeLine } from './file-viewer.js';

const call = (m, ...a) => window.termclaw.call(m, ...a);
const POLL_MS = 6000;
const RESCAN_MS = 30000;
const PR_TTL_MS = 30000;
const MAX_LINES = 6000;

const projects = new Map(); // projectId -> per-project view state (kept while switching tabs)
let mounted = null; // { ctx, projectId, root, els, timer }
let summaryListener = null;

// Summary of all repositories in a project: { clean: true|false|null, dirtyRepos: [names], totalChanges }.
export function summarizeRepos(repos) {
  if (!repos || !repos.length) return { clean: null, dirtyRepos: [], totalChanges: 0 };
  const dirty = repos.filter((r) => (r.changes || 0) > 0);
  return {
    clean: dirty.length === 0,
    dirtyRepos: dirty.map((r) => r.name),
    totalChanges: dirty.reduce((sum, r) => sum + (r.changes || 0), 0),
  };
}
export const isClean = (repos) => summarizeRepos(repos).clean;
export function onSummary(fn) { summaryListener = fn; }
export const mountedProject = () => (mounted ? mounted.projectId : null);
const report = (projectId, d) => { if (summaryListener && d.repos) summaryListener(projectId, summarizeRepos(d.repos)); };

function loadPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function savePref(key, val) { try { localStorage.setItem(key, val); } catch {} }

function pstate(projectId) {
  let d = projects.get(projectId);
  if (!d) {
    d = {
      repos: null, roots: [], scanErr: '', scanning: false, lastScanAt: 0,
      repo: loadRepo(projectId), state: null, stateErr: '', loading: false,
      tab: 'changes', selFile: null, diff: null, diffErr: '', unchecked: new Map(), // repo -> Set of paths
      selCommit: null, commitInfo: null, commitFile: null, commitDiff: null,
      historyFilter: '', amend: false, wrap: loadPref('gitWrap', '0') === '1',
      pr: null, prAt: 0, prRepoKey: '',
      busy: '',
    };
    projects.set(projectId, d);
  }
  return d;
}

function loadRepo(projectId) { try { return JSON.parse(localStorage.getItem('gitRepo') || '{}')[projectId] || null; } catch { return null; } }
function saveRepo(projectId, repo) {
  try { const all = JSON.parse(localStorage.getItem('gitRepo') || '{}'); all[projectId] = repo; localStorage.setItem('gitRepo', JSON.stringify(all)); } catch {}
}

export function mount(ctx, el, projectId) {
  if (mounted) clearInterval(mounted.timer);
  const root = h('div', { class: 'gitv' });
  el.appendChild(root);
  mounted = { ctx, projectId, root, els: null, timer: setInterval(poll, POLL_MS) };
  build();
  const d = pstate(projectId);
  if (!d.repos) scan(false); else { draw(); refresh({ silent: true }); }
}

export function unmount() {
  if (!mounted) return;
  clearInterval(mounted.timer);
  closePopover();
  mounted = null;
}

const cur = () => (mounted ? pstate(mounted.projectId) : null);
const project = () => mounted && mounted.ctx.project(mounted.projectId);
const unchecked = (d) => { if (!d.unchecked.has(d.repo)) d.unchecked.set(d.repo, new Set()); return d.unchecked.get(d.repo); };
const sep = (repo) => (/^[A-Za-z]:[\\/]/.test(repo || '') ? '\\' : '/');
const add = (el, ...c) => el.append(...c.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false));
const ago = (t) => (t ? timeAgo(t) + ' ago' : '');

// ---------- loading ----------

async function scan(force, { silent = false } = {}) {
  const d = cur();
  if (!d) return;
  const pid = mounted.projectId;
  if (!silent) { d.scanning = true; d.scanErr = ''; draw(); }
  try {
    const r = await call('gitRepos', pid, force);
    if (!mounted || mounted.projectId !== pid) return;
    d.repos = r.repos;
    d.roots = r.roots;
    d.lastScanAt = Date.now();
    if (!d.repo || !r.repos.some((x) => x.path === d.repo)) d.repo = r.repos.length ? (r.repos.find((x) => x.changes) || r.repos[0]).path : null;
    report(pid, d);
  } catch (e) {
    if (!mounted || mounted.projectId !== pid) return;
    if (!silent) d.scanErr = e.message;
  }
  d.scanning = false;
  draw();
  if (!silent && d.repo) refresh();
}

async function refresh({ silent = false } = {}) {
  const d = cur();
  if (!d || !d.repo) return;
  const pid = mounted.projectId;
  const repo = d.repo;
  if (!silent) { d.loading = true; draw(); }
  try {
    const st = await call('gitState', pid, repo);
    if (cur() !== d || d.repo !== repo) return;
    d.state = st;
    d.stateErr = '';
    const r = d.repos && d.repos.find((x) => x.path === repo);
    if (r) Object.assign(r, { head: st.branch.head, ahead: st.branch.ahead, behind: st.branch.behind, changes: st.files.length });
    report(pid, d);
    if (d.selFile && !st.files.some((f) => f.path === d.selFile)) { d.selFile = null; d.diff = null; }
    if (!d.selFile && st.files.length) d.selFile = st.files[0].path;
    if (d.tab === 'changes' && d.selFile) loadDiff();
    if (d.tab === 'history' && !d.selCommit && st.log.length) selectCommit(st.log[0].hash);
    maybeLoadPr(pid, repo, st);
  } catch (e) {
    if (cur() !== d) return;
    d.stateErr = e.message;
  }
  d.loading = false;
  draw();
}

async function maybeLoadPr(pid, repo, st) {
  const d = pstate(pid);
  if (!st || !st.web || st.web.provider !== 'github' || st.branch.detached) {
    if (d.pr) { d.pr = null; drawToolbar(d); }
    return;
  }
  const key = `${repo}\n${st.branch.head}`;
  if (d.prRepoKey === key && Date.now() - d.prAt < PR_TTL_MS) return;
  d.prRepoKey = key;
  d.prAt = Date.now();
  try {
    const res = await call('gitPrStatus', pid, repo);
    if (!mounted || mounted.projectId !== pid || d.prRepoKey !== key) return;
    d.pr = res;
    drawToolbar(d);
  } catch {}
}

function poll() {
  const d = cur();
  if (!d || d.busy || d.loading || !document.hasFocus() || popover) return;
  refresh({ silent: true });
  // Periodically refresh sibling repository counts so multi-repo status never goes stale.
  if (d.repos && d.repos.length > 1 && Date.now() - d.lastScanAt >= RESCAN_MS) {
    scan(true, { silent: true });
  }
}

async function loadDiff() {
  const d = cur();
  const f = d && d.state && d.state.files.find((x) => x.path === d.selFile);
  if (!f) return;
  const key = d.repo + '\n' + f.path;
  try {
    const r = await call('gitDiff', mounted.projectId, d.repo, { ...f, initial: !!d.state.branch.initial });
    if (cur() !== d || d.repo + '\n' + d.selFile !== key) return;
    d.diff = { key, ...r };
    d.diffErr = '';
  } catch (e) {
    if (cur() !== d) return;
    d.diff = null;
    d.diffErr = e.message;
  }
  drawRight();
}

async function selectCommit(hash) {
  const d = cur();
  d.selCommit = hash;
  d.commitInfo = null;
  d.commitFile = null;
  d.commitDiff = null;
  draw();
  try {
    const info = await call('gitCommitInfo', mounted.projectId, d.repo, hash);
    if (cur() !== d || d.selCommit !== hash) return;
    d.commitInfo = info;
    if (info.files.length) return selectCommitFile(info.files[0]);
  } catch (e) {
    if (cur() === d) toast(e.message, { error: true });
  }
  drawRight();
}

async function selectCommitFile(f) {
  const d = cur();
  d.commitFile = f;
  d.commitDiff = null;
  drawRight();
  try {
    const r = await call('gitCommitDiff', mounted.projectId, d.repo, d.selCommit, f);
    if (cur() !== d || d.commitFile !== f) return;
    d.commitDiff = r;
  } catch (e) {
    if (cur() === d) d.commitDiff = { error: e.message };
  }
  drawRight();
}

// Runs an action, then reloads the repository; returns true on success.
async function act(action, args, label) {
  const d = cur();
  if (!d || !d.repo || d.busy) return false;
  d.busy = label;
  draw();
  try {
    const r = await call('gitAction', mounted.projectId, d.repo, action, args || {});
    toast(r && r.output && action !== 'commit' ? r.output.split('\n').slice(-2).join(' · ') : `${label}: done`);
    return true;
  } catch (e) {
    toast(e.message, { error: true, ms: 9000 });
    return false;
  } finally {
    if (cur() === d) {
      d.busy = '';
      d.prAt = 0; // force PR status re-check after push/checkout
      await refresh({ silent: true });
      draw();
    }
  }
}

// ---------- popovers ----------

let popover = null;
function closePopover() {
  if (!popover) return;
  popover.el.remove();
  document.removeEventListener('mousedown', popover.off, true);
  document.removeEventListener('keydown', popover.key, true);
  popover = null;
}
function openPopover(anchor, content, width = 360) {
  closePopover();
  const r = anchor.getBoundingClientRect();
  const el = h('div', { class: 'git-pop', style: { left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) + 'px', top: r.bottom + 4 + 'px', width: width + 'px' } }, content);
  document.body.appendChild(el);
  const off = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
  setTimeout(() => { document.addEventListener('mousedown', off, true); document.addEventListener('keydown', key, true); }, 0);
  popover = { el, off, key };
  const inp = el.querySelector('input');
  if (inp) setTimeout(() => inp.focus(), 20);
}

function repoPicker(anchor) {
  const d = cur();
  const filter = h('input', { placeholder: 'Filter repositories' });
  const list = h('div', { class: 'git-pop-list' });
  const rel = (p) => {
    const root = d.roots.find((r) => p.startsWith(r.replace(/[\\/]+$/, '')));
    return root ? p.slice(root.replace(/[\\/]+$/, '').length).replace(/^[\\/]/, '') || p : p;
  };
  const fill = () => {
    clear(list);
    const q = filter.value.trim().toLowerCase();
    const items = (d.repos || []).filter((r) => !q || r.path.toLowerCase().includes(q));
    if (!items.length) list.appendChild(h('div', { class: 'git-empty-row' }, d.repos && d.repos.length ? 'No match' : 'No repositories found'));
    for (const r of items) {
      list.appendChild(h('div', { class: 'git-pop-item' + (r.path === d.repo ? ' sel' : ''), title: r.path, onclick: () => { closePopover(); selectRepo(r.path); } },
        h('div', { class: 'git-pop-main' }, h('b', null, r.name), h('span', { class: 'muted' }, rel(r.path) !== r.name ? rel(r.path) : '')),
        h('span', { class: 'muted' }, r.head || ''),
        r.changes ? h('span', { class: 'git-count' }, r.changes) : null,
        r.ahead ? h('span', { class: 'muted' }, '↑' + r.ahead) : null));
    }
  };
  filter.addEventListener('input', fill);
  fill();
  openPopover(anchor, [
    h('div', { class: 'git-pop-head' }, filter),
    list,
    h('div', { class: 'git-pop-foot' },
      h('span', { class: 'muted', title: d.roots.join('\n') }, 'In ' + d.roots.join(', ')),
      h('div', { class: 'spacer' }),
      h('button', { onclick: () => { closePopover(); mounted.ctx.editProject(project()); } }, 'Folders…'),
      h('button', { onclick: () => { closePopover(); scan(true); } }, 'Rescan')),
  ], 420);
}

function selectRepo(path) {
  const d = cur();
  if (d.repo === path) return;
  d.repo = path;
  saveRepo(mounted.projectId, path);
  Object.assign(d, { state: null, stateErr: '', selFile: null, diff: null, selCommit: null, commitInfo: null, commitFile: null, commitDiff: null, pr: null, prAt: 0, amend: false });
  mounted.els.summary.value = '';
  mounted.els.desc.value = '';
  draw();
  refresh();
}

function branchPicker(anchor) {
  const d = cur();
  const st = d.state;
  if (!st) return;
  const filter = h('input', { placeholder: 'Filter branches' });
  const list = h('div', { class: 'git-pop-list' });
  const localNames = new Set(st.branches.local.map((b) => b.name));
  const track = (b) => [b.ahead ? '↑' + b.ahead : '', b.behind ? '↓' + b.behind : '', b.gone ? 'upstream gone' : ''].filter(Boolean).join(' ');
  const curHead = st.branch.head;
  const fill = () => {
    clear(list);
    const q = filter.value.trim().toLowerCase();
    const loc = st.branches.local.filter((b) => !q || b.name.toLowerCase().includes(q));
    const rem = st.branches.remote.filter((b) => !localNames.has(b.name.split('/').slice(1).join('/')) && (!q || b.name.toLowerCase().includes(q)));
    if (loc.length) list.appendChild(h('div', { class: 'git-pop-sect' }, 'Branches'));
    for (const b of loc) {
      list.appendChild(h('div', {
        class: 'git-pop-item' + (b.current ? ' sel' : ''),
        title: `${b.name}${b.upstream ? ' → ' + b.upstream : ''}\n${b.subject}\n(Right-click for merge, rebase, rename, delete)`,
        onclick: () => { closePopover(); if (!b.current) checkout(b.name, false); },
        oncontextmenu: (e) => {
          e.preventDefault();
          const items = [];
          if (!b.current) {
            items.push(
              { label: `Switch to “${b.name}”`, action: () => { closePopover(); checkout(b.name, false); } },
              { label: `Merge “${b.name}” into ${curHead}…`, action: () => { closePopover(); mergeBranch(b.name); } },
              { label: `Rebase ${curHead} onto “${b.name}”…`, action: () => { closePopover(); rebaseBranch(b.name); } },
              '-',
            );
          }
          items.push({ label: `Rename “${b.name}”…`, action: () => { closePopover(); renameBranch(b.name); } });
          if (!b.current) {
            items.push(
              { label: `Delete “${b.name}”…`, action: () => { closePopover(); deleteBranch(b.name, false); } },
              { label: `Force delete “${b.name}”…`, action: () => { closePopover(); deleteBranch(b.name, true); } },
            );
          }
          contextMenu(e.clientX, e.clientY, items);
        },
      }, h('span', { class: 'git-check' }, b.current ? '✓' : ''), h('div', { class: 'git-pop-main' }, h('span', null, b.name)), h('span', { class: 'muted' }, track(b)), h('span', { class: 'muted' }, ago(b.date))));
    }
    if (rem.length) list.appendChild(h('div', { class: 'git-pop-sect' }, 'Remote branches'));
    for (const b of rem) {
      list.appendChild(h('div', {
        class: 'git-pop-item',
        title: b.subject,
        onclick: () => { closePopover(); checkout(b.name, true); },
        oncontextmenu: (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: `Checkout “${b.name}”`, action: () => { closePopover(); checkout(b.name, true); } },
            { label: `Merge “${b.name}” into ${curHead}…`, action: () => { closePopover(); mergeBranch(b.name); } },
            { label: `Rebase ${curHead} onto “${b.name}”…`, action: () => { closePopover(); rebaseBranch(b.name); } },
          ]);
        },
      }, h('span', { class: 'git-check' }), h('div', { class: 'git-pop-main' }, h('span', null, b.name)), h('span', { class: 'muted' }, ago(b.date))));
    }
    if (!loc.length && !rem.length) list.appendChild(h('div', { class: 'git-empty-row' }, st.branch.initial ? 'No commits yet' : 'No match'));
  };
  filter.addEventListener('input', fill);
  fill();
  openPopover(anchor, [
    h('div', { class: 'git-pop-head' }, filter, h('button', { onclick: () => { closePopover(); newBranch(filter.value.trim()); } }, 'New branch')),
    list,
  ], 420);
}

function stashPicker(anchor) {
  const d = cur();
  const st = d.state;
  if (!st) return;
  const list = h('div', { class: 'git-pop-list' });
  const items = st.stashList || [];
  if (!items.length) {
    list.appendChild(h('div', { class: 'git-empty-row' }, 'No stashes in this repository.'));
  } else {
    for (const s of items) {
      list.appendChild(h('div', { class: 'git-pop-item git-stash-row', title: `${s.ref}: ${s.message}` },
        h('div', { class: 'git-pop-main' },
          h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--accent)' } }, s.ref),
          h('span', null, s.message)),
        h('span', { class: 'muted' }, ago(s.date)),
        h('button', { title: 'Preview stash diff', onclick: (e) => { e.stopPropagation(); closePopover(); previewStash(s); } }, 'Diff'),
        h('button', { title: 'Pop stash (apply and remove)', onclick: (e) => { e.stopPropagation(); closePopover(); act('stashApply', { ref: s.ref, pop: true }, 'Pop stash'); } }, 'Pop'),
        h('button', { title: 'Apply stash (keep in list)', onclick: (e) => { e.stopPropagation(); closePopover(); act('stashApply', { ref: s.ref, pop: false }, 'Apply stash'); } }, 'Apply'),
        h('button', { class: 'danger', title: 'Drop stash permanently', onclick: async (e) => {
          e.stopPropagation();
          closePopover();
          if (await confirmDialog('Drop stash', `Permanently drop ${s.ref} (“${s.message}”)?`, 'Drop')) act('stashDrop', { ref: s.ref }, 'Drop stash');
        } }, '✕')));
    }
  }
  openPopover(anchor, [
    h('div', { class: 'git-pop-head' },
      h('b', { style: { flex: '1' } }, `Stashes (${items.length})`),
      h('button', {
        class: 'primary',
        disabled: !st.files.length,
        title: st.files.length ? 'Save current uncommitted changes into a new stash' : 'No local changes to stash',
        onclick: () => { closePopover(); createStash(); },
      }, '+ Stash changes…')),
    list,
  ], 520);
}

async function createStash() {
  const msg = await prompt('Stash message (optional)', '');
  if (msg === null) return;
  act('stashPush', { message: msg, includeUntracked: true }, 'Stash');
}

async function previewStash(s) {
  const d = cur();
  if (!d) return;
  try {
    const r = await call('gitStashShow', mounted.projectId, d.repo, s.ref);
    modal({
      title: `${s.ref} — ${s.message}`,
      width: '900px',
      okText: null,
      cancelText: 'Close',
      body: h('div', { style: { maxHeight: '68vh', overflow: 'auto', display: 'flex', flexDirection: 'column' } }, renderDiff(r.diff, r.truncated, '')),
      extraButtons: [
        h('button', { onclick: () => { document.querySelector('.modal-bg')?.remove(); act('stashApply', { ref: s.ref, pop: false }, 'Apply stash'); } }, 'Apply'),
        h('button', { class: 'primary', onclick: () => { document.querySelector('.modal-bg')?.remove(); act('stashApply', { ref: s.ref, pop: true }, 'Pop stash'); } }, 'Pop stash'),
      ],
    });
  } catch (e) {
    toast(e.message, { error: true });
  }
}

async function prPicker(anchor) {
  const d = cur();
  if (!d || !d.repo) return;
  const list = h('div', { class: 'git-pop-list' }, h('div', { class: 'git-empty-row' }, 'Loading pull requests…'));
  openPopover(anchor, [
    h('div', { class: 'git-pop-head' },
      h('b', { style: { flex: '1' } }, 'Open Pull Requests'),
      d.state && d.state.web && d.state.web.newPrUrl ? h('button', { onclick: () => { closePopover(); call('openExternal', d.state.web.newPrUrl); } }, '+ New PR') : null),
    list,
  ], 480);
  try {
    const r = await call('gitPrList', mounted.projectId, d.repo);
    clear(list);
    if (r.error) { list.appendChild(h('div', { class: 'git-empty-row bad' }, r.error)); return; }
    if (!r.prs || !r.prs.length) { list.appendChild(h('div', { class: 'git-empty-row' }, 'No open pull requests.')); return; }
    for (const p of r.prs) {
      list.appendChild(h('div', { class: 'git-pop-item', title: `${p.branch} · by ${p.author}` },
        h('div', { class: 'git-pop-main', style: { cursor: 'pointer' }, onclick: () => { closePopover(); if (p.url) call('openExternal', p.url); } },
          h('span', null, h('b', null, `#${p.number} `), p.title, p.isDraft ? h('span', { class: 'tag', style: { marginLeft: '6px' } }, 'draft') : null),
          h('span', { class: 'muted' }, `${p.branch}${p.author ? ' · ' + p.author : ''}${p.updatedAt ? ' · ' + ago(p.updatedAt) : ''}`)),
        h('button', { title: `Checkout PR #${p.number} locally`, onclick: (e) => { e.stopPropagation(); closePopover(); act('prCheckout', { number: p.number }, `Checkout PR #${p.number}`); } }, 'Checkout'),
        p.url ? h('button', { class: 'icon', title: 'Open on GitHub', onclick: (e) => { e.stopPropagation(); closePopover(); call('openExternal', p.url); } }, '↗') : null));
    }
  } catch (e) {
    clear(list);
    list.appendChild(h('div', { class: 'git-empty-row bad' }, e.message));
  }
}

async function checkout(name, remote) {
  const d = cur();
  if (d.state && d.state.files.length && !(await confirmDialog('Switch branch', h('div', null,
    h('p', null, `There are ${d.state.files.length} changed files. Git takes them along to “${remote ? name.split('/').slice(1).join('/') : name}” if they do not conflict; otherwise it refuses to switch.`),
    h('p', { class: 'muted' }, 'Tip: use Stashes in the toolbar to save your changes cleanly before switching.')), 'Switch'))) return;
  act('checkout', { name, remote }, 'Switch branch');
}

async function newBranch(initial) {
  const d = cur();
  const name = await prompt(`New branch (from ${d.state ? d.state.branch.head : 'HEAD'})`, initial || '');
  if (name) act('createBranch', { name: name.replace(/\s+/g, '-') }, 'New branch');
}

async function mergeBranch(name) {
  const d = cur();
  if (!(await confirmDialog('Merge branch', `Merge “${name}” into “${d.state.branch.head}”?`, 'Merge'))) return;
  act('mergeBranch', { name }, `Merge ${name}`);
}

async function rebaseBranch(name) {
  const d = cur();
  if (!(await confirmDialog('Rebase branch', `Rebase “${d.state.branch.head}” onto “${name}”?`, 'Rebase'))) return;
  act('rebaseBranch', { name }, `Rebase onto ${name}`);
}

async function renameBranch(oldName) {
  const next = await prompt(`Rename branch “${oldName}”`, oldName);
  if (next && next.trim() && next.trim() !== oldName) act('renameBranch', { oldName, newName: next.trim().replace(/\s+/g, '-') }, 'Rename branch');
}

async function deleteBranch(name, force = false) {
  const msg = force
    ? `Force delete local branch “${name}”? Any unmerged commits on this branch will be lost.`
    : `Delete the local branch “${name}”? Git refuses when it has commits that are not merged.`;
  if (!(await confirmDialog(force ? 'Force delete branch' : 'Delete branch', msg, force ? 'Force delete' : 'Delete'))) return;
  act('deleteBranch', { name, force }, 'Delete branch');
}

// ---------- sync button ----------

function syncInfo(st) {
  if (!st) return { label: 'Fetch origin', action: null };
  const b = st.branch;
  const remote = (st.remotes.find((r) => r.name === 'origin') || st.remotes[0] || {}).name;
  if (!remote) return { label: 'No remote', sub: 'nothing to push to', action: null };
  if (b.detached) return { label: 'Fetch ' + remote, sub: 'detached HEAD', action: 'fetch' };
  if (!b.upstream) return { label: 'Publish branch', sub: `push to ${remote}`, action: 'push', icon: '↑' };
  const up = b.upstream.split('/')[0];
  if (b.behind && b.ahead) return { label: 'Pull (rebase) ' + up, sub: `${b.behind} behind, ${b.ahead} ahead`, action: 'pull', args: { mode: 'rebase' }, icon: '⇅' };
  if (b.behind) return { label: 'Pull ' + up, sub: `${b.behind} behind`, action: 'pull', args: { mode: 'ff' }, icon: '↓' };
  if (b.ahead) return { label: 'Push ' + up, sub: `${b.ahead} commit${b.ahead > 1 ? 's' : ''} ahead`, action: 'push', icon: '↑' };
  return { label: 'Fetch ' + up, sub: 'up to date', action: 'fetch', icon: '⟳' };
}

const ACTION_LABEL = { push: 'Push', pull: 'Pull', fetch: 'Fetch' };

function syncMenu(e) {
  const d = cur();
  const r = e.currentTarget.getBoundingClientRect();
  const b = d && d.state && d.state.branch;
  contextMenu(r.left, r.bottom + 2, [
    { label: 'Fetch (all remotes)', action: () => act('fetch', {}, 'Fetch') },
    '-',
    { label: 'Pull (fast-forward only)', action: () => act('pull', { mode: 'ff' }, 'Pull') },
    { label: 'Pull (rebase)', action: () => act('pull', { mode: 'rebase' }, 'Pull (rebase)') },
    { label: 'Pull (merge)', action: () => act('pull', { mode: 'merge' }, 'Pull (merge)') },
    '-',
    { label: 'Push', action: () => act('push', {}, 'Push') },
    ...(b && b.upstream ? [{
      label: 'Force push (--force-with-lease)…',
      action: async () => {
        if (await confirmDialog('Force push', `Force push “${b.head}” to ${b.upstream} using --force-with-lease?`, 'Force push')) {
          act('push', { force: true }, 'Force push');
        }
      },
    }] : []),
  ]);
}

// ---------- layout ----------

function build() {
  const summary = h('input', { class: 'git-summary', placeholder: 'Summary (required)', oninput: () => drawCommitBox(), onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit(); } });
  const desc = h('textarea', { class: 'git-desc', placeholder: 'Description', rows: 3, onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit(); } });
  const amendCheck = h('input', {
    type: 'checkbox',
    onchange: () => {
      const d = cur();
      if (!d) return;
      d.amend = amendCheck.checked;
      if (d.amend && d.state && d.state.log.length && !summary.value.trim()) {
        summary.value = d.state.log[0].subject || '';
      }
      drawCommitBox();
    },
  });
  const amendRow = h('label', { class: 'git-amend-row' }, amendCheck, 'Amend last unpushed commit');
  const commitBtn = h('button', { class: 'primary git-commit-btn', onclick: () => commit() }, 'Commit');
  const els = {
    toolbar: h('div', { class: 'git-toolbar' }),
    banner: h('div', { class: 'git-banner' }),
    opBanner: h('div', { class: 'git-op-banner' }),
    tabs: h('div', { class: 'git-tabs' }),
    listHead: h('div', { class: 'git-list-head' }),
    list: h('div', { class: 'git-list' }),
    commitBox: h('div', { class: 'git-commitbox' }, summary, desc, amendRow, commitBtn),
    right: h('div', { class: 'git-right' }),
    summary, desc, amendCheck, amendRow, commitBtn,
  };
  const left = h('div', { class: 'git-left' }, els.tabs, els.listHead, els.list, els.commitBox);
  const savedW = Number(loadPref('gitW', '0'));
  if (savedW >= 240 && savedW <= 640) left.style.width = savedW + 'px';
  const splitter = h('div', { class: 'git-splitter' });
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = left.getBoundingClientRect().width;
    const move = (ev) => { left.style.width = Math.max(240, Math.min(640, startW + (ev.clientX - startX))) + 'px'; };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      savePref('gitW', String(Math.round(left.getBoundingClientRect().width)));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  mounted.els = els;
  mounted.root.append(els.toolbar, els.banner, els.opBanner, h('div', { class: 'git-body' }, left, splitter, els.right));
}

function draw() {
  if (!mounted) return;
  const d = cur();
  drawToolbar(d);
  drawBanner(d);
  const empty = !d.repo;
  mounted.root.classList.toggle('git-norepo', empty);
  drawLeft(d);
  drawCommitBox();
  drawRight();
}

function prChip(d) {
  const pr = d.pr && d.pr.pr;
  if (!pr) return null;
  const ch = pr.checks;
  let chkEl = null;
  if (ch && ch.total) {
    const cls = ch.failed ? 'bad' : ch.pending ? 'warn' : 'ok';
    const ico = ch.failed ? '✗' : ch.pending ? '◌' : '✓';
    chkEl = h('span', { class: cls, style: { marginLeft: '4px' } }, `${ico} ${ch.passed}/${ch.total}`);
  }
  const tip = [
    `PR #${pr.number}: ${pr.title}`,
    pr.isDraft ? 'Draft' : pr.state,
    pr.reviewDecision ? `Review: ${pr.reviewDecision}` : '',
    ch ? `Checks: ${ch.passed} passed, ${ch.failed} failed, ${ch.pending} pending` : '',
  ].filter(Boolean).join('\n');
  return h('button', {
    class: 'git-pr-btn',
    title: tip,
    onclick: () => pr.url && call('openExternal', pr.url),
  }, `#${pr.number}`, pr.isDraft ? ' (draft)' : '', chkEl);
}

function drawToolbar(d) {
  const st = d.state;
  const repo = d.repos && d.repos.find((r) => r.path === d.repo);
  const otherDirty = (d.repos || []).filter((r) => r.path !== d.repo && (r.changes || 0) > 0);
  const s = syncInfo(st);
  const b = st && st.branch;
  const web = st && st.web;
  const isDefaultBranch = b && ['main', 'master', 'develop'].includes(b.head);
  const hasPr = !!(d.pr && d.pr.pr);
  add(clear(mounted.els.toolbar),
    h('button', {
      class: 'git-tool',
      title: (d.repo || '') + (otherDirty.length ? `\nOther repos with changes: ${otherDirty.map((x) => `${x.name} (${x.changes})`).join(', ')}` : ''),
      onclick: (e) => repoPicker(e.currentTarget),
    },
    h('span', { class: 'git-tool-label' }, 'Current repository', otherDirty.length ? h('span', { class: 'warn', style: { marginLeft: '6px' } }, `· ${otherDirty.length} other dirty`) : null),
    h('span', { class: 'git-tool-value' }, d.scanning && !repo ? 'Searching…' : repo ? repo.name : 'None', ' ▾')),
    h('button', { class: 'git-tool', disabled: !st, title: b && b.upstream ? `${b.head} → ${b.upstream}` : '', onclick: (e) => branchPicker(e.currentTarget) },
      h('span', { class: 'git-tool-label' }, 'Current branch'),
      h('span', { class: 'git-tool-value' }, b ? (b.detached ? 'detached at ' + b.oid.slice(0, 7) : b.head) : '–', ' ▾')),
    h('span', { class: 'split-btn' },
      h('button', { class: 'git-tool', disabled: !s.action || !!d.busy, onclick: () => act(s.action, s.args || {}, ACTION_LABEL[s.action]) },
        h('span', { class: 'git-tool-label' }, d.busy ? d.busy + '…' : s.sub || ''),
        h('span', { class: 'git-tool-value' }, s.icon ? s.icon + ' ' : '', s.label)),
      h('button', { class: 'git-tool git-tool-more', disabled: !st || !!d.busy, title: 'Fetch, pull (ff/rebase/merge) or push', onclick: syncMenu }, '▾')),
    st ? h('button', {
      class: 'git-tb-btn',
      title: 'View, create, pop, apply or drop stashes',
      onclick: (e) => stashPicker(e.currentTarget),
    }, st.stashes ? `Stashes (${st.stashes}) ▾` : 'Stash ▾') : null,
    prChip(d),
    web && web.provider === 'github' && d.pr && d.pr.available ? h('button', {
      class: 'git-tb-btn',
      title: 'Browse and checkout open GitHub Pull Requests',
      onclick: (e) => prPicker(e.currentTarget),
    }, 'PRs ▾') : null,
    web && web.newPrUrl && !hasPr && !isDefaultBranch && b && b.upstream ? h('button', {
      class: 'git-tb-btn',
      title: `Create a ${web.prLabel} for “${b.head}” on ${web.label}`,
      onclick: () => call('openExternal', web.newPrUrl),
    }, `Create ${web.prLabel} ↗`) : null,
    h('div', { class: 'spacer' }),
    d.loading || d.scanning ? h('span', { class: 'muted' }, 'Loading…')
      : web ? h('button', {
        class: 'git-tb-btn git-remote-btn',
        title: `Open ${web.repoUrl} on ${web.label}`,
        onclick: () => call('openExternal', web.branchUrl || web.repoUrl),
      }, `${web.label} ↗`)
      : st ? h('span', { class: 'muted' }, (st.remotes[0] || {}).url || 'no remote') : null,
    h('button', { class: 'icon', title: 'Refresh (searches the folders again)', onclick: () => scan(true) }, '⟳'));
}

function drawBanner(d) {
  const msg = d.scanErr || d.stateErr;
  clear(mounted.els.banner);
  mounted.els.banner.style.display = msg ? '' : 'none';
  if (msg) add(mounted.els.banner, h('span', null, msg), h('button', { class: 'icon', onclick: () => (d.scanErr ? scan(true) : refresh()) }, 'Retry'));

  const op = d.state && d.state.inProgress;
  clear(mounted.els.opBanner);
  mounted.els.opBanner.style.display = op ? '' : 'none';
  if (op) {
    const conflicts = d.state.files.filter((f) => f.status === 'conflict').length;
    add(mounted.els.opBanner,
      h('span', null, `⚠ ${op[0].toUpperCase() + op.slice(1)} in progress${conflicts ? ` · ${conflicts} conflict${conflicts > 1 ? 's' : ''} remaining` : ' · ready to continue'}`),
      h('button', { class: 'primary', disabled: !!d.busy || conflicts > 0, onclick: () => act('continueOp', { op }, `Continue ${op}`) }, `Continue ${op}`),
      h('button', { class: 'danger', disabled: !!d.busy, onclick: async () => { if (await confirmDialog(`Abort ${op}`, `Abort the in-progress ${op}?`, 'Abort')) act('abortOp', { op }, `Abort ${op}`); } }, 'Abort'));
  }
}

function drawLeft(d) {
  const st = d.state;
  const els = mounted.els;
  clear(els.tabs);
  clear(els.listHead);
  clear(els.list);
  if (!d.repo) {
    els.tabs.style.display = 'none';
    els.listHead.style.display = 'none';
    add(els.list, h('div', { class: 'git-none' },
      d.scanning ? 'Searching for git repositories…' : h('div', null,
        h('div', null, 'No git repositories found in'),
        h('div', { class: 'mono' }, (d.roots || []).join(', ') || '…'),
        h('div', { class: 'muted', style: { margin: '8px 0' } }, 'TermClaw looks for .git folders up to the configured depth (hidden folders and node_modules are skipped).'),
        h('div', { class: 'row' }, h('button', { onclick: () => mounted.ctx.editProject(project()) }, 'Configure folders…'), h('button', { onclick: () => scan(true) }, 'Search again')))));
    return;
  }
  els.tabs.style.display = '';
  els.listHead.style.display = '';
  const n = st ? st.files.length : 0;
  add(els.tabs,
    h('div', { class: 'git-tab' + (d.tab === 'changes' ? ' active' : ''), onclick: () => { d.tab = 'changes'; draw(); if (d.selFile) loadDiff(); } }, 'Changes', n ? h('span', { class: 'git-count' }, n) : null),
    h('div', { class: 'git-tab' + (d.tab === 'history' ? ' active' : ''), onclick: () => { d.tab = 'history'; draw(); if (!d.selCommit && st && st.log.length) selectCommit(st.log[0].hash); } }, 'History'));
  if (!st) { add(els.list, h('div', { class: 'git-none muted' }, d.stateErr ? '' : 'Loading…')); return; }
  if (d.tab === 'changes') drawChanges(d, st); else drawHistory(d, st);
}

const STATUS_ICON = { modified: ['M', 'mod'], new: ['+', 'add'], deleted: ['−', 'del'], renamed: ['→', 'ren'], copied: ['C', 'ren'], conflict: ['!', 'del'] };
const statusIcon = (status) => { const [t, c] = STATUS_ICON[status] || ['M', 'mod']; return h('span', { class: 'git-st git-st-' + c, title: status }, t); };

function fileLabel(p, orig) {
  const i = p.lastIndexOf('/');
  return h('span', { class: 'git-path', title: orig ? `${orig} → ${p}` : p },
    orig ? h('span', { class: 'muted' }, orig.split('/').pop() + ' → ') : null,
    i >= 0 ? h('span', { class: 'muted' }, p.slice(0, i + 1)) : null, p.slice(i + 1));
}

function fullPath(d, relPath) {
  const s = sep(d.repo);
  return d.repo.replace(/[\\/]+$/, '') + s + (s === '\\' ? relPath.replace(/\//g, '\\') : relPath);
}

function openInExplorer(d, relPath) {
  const s = sep(d.repo);
  const full = fullPath(d, relPath);
  const dir = full.slice(0, full.lastIndexOf(s)) || d.repo;
  files.openBrowser(mounted.ctx, mounted.projectId, dir, full);
}

function drawChanges(d, st) {
  const els = mounted.els;
  const off = unchecked(d);
  for (const p of [...off]) if (!st.files.some((f) => f.path === p)) off.delete(p);
  const checkedCount = st.files.filter((f) => !off.has(f.path)).length;
  const all = h('input', { type: 'checkbox', checked: checkedCount === st.files.length && st.files.length > 0, disabled: !st.files.length, title: 'Select all',
    onchange: (e) => { if (e.target.checked) off.clear(); else st.files.forEach((f) => off.add(f.path)); draw(); } });
  all.indeterminate = checkedCount > 0 && checkedCount < st.files.length;
  add(els.listHead, all, h('span', null, st.files.length ? `${st.files.length} changed file${st.files.length > 1 ? 's' : ''}` : 'No local changes'), h('div', { class: 'spacer' }),
    st.files.length ? h('button', { class: 'icon', title: 'More', onclick: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      contextMenu(r.left, r.bottom + 2, [
        { label: 'Stash all changes…', action: () => createStash() },
        { label: 'Discard all changes…', action: () => discard(st.files) },
      ]);
    } }, '⋯') : null);
  if (!st.files.length) {
    add(els.list, h('div', { class: 'git-none' },
      h('div', { class: 'muted' }, `Branch ${st.branch.head}${st.branch.upstream ? ` · ${st.branch.ahead ? st.branch.ahead + ' to push' : st.branch.behind ? st.branch.behind + ' to pull' : 'up to date with ' + st.branch.upstream}` : ' · not published'}`)));
    return;
  }
  for (const f of st.files) {
    const cb = h('input', { type: 'checkbox', checked: !off.has(f.path), onclick: (e) => e.stopPropagation(), onchange: (e) => { if (e.target.checked) off.delete(f.path); else off.add(f.path); draw(); } });
    add(els.list, h('div', {
      class: 'git-row' + (d.selFile === f.path ? ' sel' : ''),
      onclick: () => { d.selFile = f.path; d.diff = null; d.diffErr = ''; drawLeft(d); drawRight(); loadDiff(); },
      oncontextmenu: (e) => { e.preventDefault(); fileMenu(e, f, st); },
    }, cb, fileLabel(f.path, f.orig), statusIcon(f.status)));
  }
}

function fileMenu(e, f, st) {
  const d = cur();
  const checked = st.files.filter((x) => !unchecked(d).has(x.path));
  const full = fullPath(d, f.path);
  const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
  const ext = /\.([^./]+)$/.exec(f.path.split('/').pop());
  contextMenu(e.clientX, e.clientY, [
    ...(f.status === 'conflict' ? [
      { label: 'Conflict: Use Ours (current branch)', action: () => act('resolveConflict', { file: f.path, side: 'ours' }, 'Use Ours') },
      { label: 'Conflict: Use Theirs (incoming)', action: () => act('resolveConflict', { file: f.path, side: 'theirs' }, 'Use Theirs') },
      { label: 'Conflict: Mark as resolved', action: () => act('resolveConflict', { file: f.path, side: 'mark' }, 'Mark resolved') },
      '-',
    ] : [
      { label: 'Discard changes…', action: () => discard([f]) },
      ...(checked.length > 1 ? [{ label: `Discard ${checked.length} selected changes…`, action: () => discard(checked) }] : []),
      '-',
    ]),
    { label: 'Add to .gitignore', action: () => ignore(f, ignorePattern('/' + f.path)) },
    ...(ext ? [{ label: `Add all *.${ext[1]} files to .gitignore`, action: () => ignore(f, '*.' + ignorePattern(ext[1]), (x) => x.path.endsWith('.' + ext[1])) }] : []),
    ...(dir ? [{ label: `Add folder ${dir}/ to .gitignore`, action: () => ignore(f, ignorePattern('/' + dir) + '/', (x) => x.path.startsWith(dir + '/')) }] : []),
    '-',
    { label: 'Open in File Explorer', action: () => openInExplorer(d, f.path) },
    { label: 'Copy file path', action: () => navigator.clipboard.writeText(full) },
    { label: 'Copy relative path', action: () => navigator.clipboard.writeText(f.path) },
  ]);
}

function ignorePattern(p) {
  return p.replace(/[\\*?[\]]/g, (c) => '\\' + c).replace(/^([#!])/, '\\$1').replace(/^\/([#!])/, '/\\$1').replace(/ +$/, (sp) => sp.replace(/ /g, '\\ '));
}

async function ignore(f, pattern, matches = (x) => x.path === f.path) {
  const d = cur();
  const tracked = d.state.files.filter((x) => matches(x) && x.x !== '?');
  if (tracked.length && !(await confirmDialog('Add to .gitignore', h('div', null,
    h('p', null, h('span', { class: 'mono' }, pattern), ' is added to .gitignore.'),
    h('p', null, `${tracked.length === 1 ? `“${tracked[0].path}” is tracked by git` : `${tracked.length} matching files are tracked by git`}: ${tracked.length === 1 ? 'it is removed from the repository with the next commit and stays' : 'they are removed from the repository with the next commit and stay'} on disk.`)), 'Add and untrack'))) return;
  act('ignore', { patterns: [pattern], untrack: tracked.map((x) => x.path) }, 'Add to .gitignore');
}

async function discard(list) {
  const d = cur();
  const del = list.filter((f) => f.x === '?' || f.x === 'A');
  const body = h('div', null,
    h('p', null, list.length === 1 ? `Discard the changes to “${list[0].path}”?` : `Discard the changes to ${list.length} files?`),
    list.length > 1 ? h('div', { class: 'git-confirm-list mono' }, list.slice(0, 30).map((f) => h('div', null, f.path)), list.length > 30 ? h('div', { class: 'muted' }, `… and ${list.length - 30} more`) : null) : null,
    h('p', { class: 'warn' }, del.length ? `The changes are lost. ${del.length} new file${del.length > 1 ? 's are' : ' is'} deleted permanently (there is no recycle bin on the project machine).` : 'The changes are lost; this cannot be undone.'));
  if (!(await confirmDialog('Discard changes', body, 'Discard'))) return;
  act('discard', { files: list.map((f) => ({ path: f.path, orig: f.orig, x: f.x, status: f.status })), initial: !!(d.state && d.state.branch.initial) }, 'Discard');
}

const baseName = (p) => (p || '').split('/').pop();
function defaultSummary(f) {
  if (f.status === 'new') return `Create ${baseName(f.path)}`;
  if (f.status === 'deleted') return `Delete ${baseName(f.path)}`;
  if (f.status === 'renamed') return `Rename ${baseName(f.orig)} to ${baseName(f.path)}`;
  return `Update ${baseName(f.path)}`;
}

function canAmendLast(st) {
  if (!st || !st.log.length || st.branch.detached) return false;
  const head = st.log[0];
  if (head.parents.length > 1) return false;
  if (st.unpushed && !st.unpushed.includes(head.hash)) return false;
  return true;
}

function drawCommitBox() {
  if (!mounted) return;
  const d = cur();
  const els = mounted.els;
  const st = d.state;
  els.commitBox.style.display = d.repo && d.tab === 'changes' ? '' : 'none';
  if (!st) { els.commitBtn.disabled = true; return; }
  const canAmend = canAmendLast(st);
  if (!canAmend && d.amend) d.amend = false;
  els.amendRow.style.display = canAmend ? '' : 'none';
  els.amendCheck.checked = d.amend;
  const off = unchecked(d);
  const sel = st.files.filter((f) => !off.has(f.path));
  const n = sel.length;
  const auto = !d.amend && n === 1 ? defaultSummary(sel[0]) : '';
  if (els.summary.value === '' || els.summary.value === mounted.autoSummary) {
    els.summary.value = auto;
    mounted.autoSummary = auto;
  }
  els.commitBtn.disabled = (!n && !d.amend) || !els.summary.value.trim() || !!d.busy || st.branch.detached;
  els.commitBtn.textContent = d.busy === 'Commit' ? 'Committing…'
    : d.amend ? `Amend commit on ${st.branch.head}`
    : `Commit ${n ? n + ' file' + (n > 1 ? 's' : '') + ' ' : ''}to ${st.branch.detached ? '(detached)' : st.branch.head}`;
  els.commitBtn.title = st.branch.detached ? 'Not on a branch' : (!n && !d.amend) ? 'Select files to commit' : !els.summary.value.trim() ? 'Enter a summary' : 'Ctrl+Enter';
}

async function commit() {
  const d = cur();
  const st = d && d.state;
  const els = mounted && mounted.els;
  if (!st || els.commitBtn.disabled) return;
  const off = unchecked(d);
  const sel = st.files.filter((f) => !off.has(f.path));
  const ok = await act('commit', {
    files: sel.map((f) => ({ path: f.path, orig: f.orig })),
    all: sel.length === st.files.length,
    summary: els.summary.value.trim(),
    description: els.desc.value,
    amend: d.amend,
  }, 'Commit');
  if (ok && mounted && cur() === d) {
    els.summary.value = '';
    els.desc.value = '';
    d.amend = false;
    off.clear();
    drawCommitBox();
  }
}

function refBadges(refs) {
  return refs.filter((r) => r !== 'HEAD').map((r) => {
    const tag = r.startsWith('tag: ');
    const name = r.replace(/^HEAD -> /, '').replace(/^tag: /, '');
    return h('span', { class: 'git-ref' + (tag ? ' tag' : r.startsWith('HEAD -> ') ? ' head' : '') }, tag ? '🏷 ' + name : name);
  });
}

function drawHistory(d, st) {
  const els = mounted.els;
  const unpushed = new Set(st.unpushed || []);
  const filterInput = h('input', {
    class: 'git-history-filter',
    value: d.historyFilter,
    placeholder: `Filter ${st.log.length} commits…`,
    oninput: () => {
      d.historyFilter = filterInput.value;
      fillHistoryRows();
    },
  });
  add(els.listHead, filterInput);

  const fillHistoryRows = () => {
    clear(els.list);
    const q = d.historyFilter.trim().toLowerCase();
    const list = q
      ? st.log.filter((c) => `${c.subject} ${c.author} ${c.hash} ${(c.refs || []).join(' ')}`.toLowerCase().includes(q))
      : st.log;
    if (!list.length) {
      add(els.list, h('div', { class: 'git-none muted' }, st.log.length ? 'No commits match filter.' : 'No commits yet.'));
      return;
    }
    list.forEach((c) => {
      const isHead = st.log[0] && st.log[0].hash === c.hash;
      add(els.list, h('div', {
        class: 'git-row git-commit' + (d.selCommit === c.hash ? ' sel' : ''),
        onclick: () => selectCommit(c.hash),
        oncontextmenu: (e) => {
          e.preventDefault();
          const canUndo = isHead && (st.unpushed ? unpushed.has(c.hash) : true) && c.parents.length === 1;
          contextMenu(e.clientX, e.clientY, [
            ...(canUndo ? [{ label: 'Undo commit (changes go back to the list)', action: () => act('undoCommit', {}, 'Undo commit') }] : []),
            { label: 'Revert changes in commit…', action: async () => { if (await confirmDialog('Revert commit', `Create a new commit that reverts “${c.subject}”?`, 'Revert')) act('revertCommit', { hash: c.hash }, 'Revert'); } },
            ...(st.web && st.web.commitBase ? ['-', { label: `View on ${st.web.label} ↗`, action: () => call('openExternal', st.web.commitBase + c.hash) }] : []),
            '-',
            { label: 'Copy SHA', action: () => navigator.clipboard.writeText(c.hash) },
            { label: 'Copy summary', action: () => navigator.clipboard.writeText(c.subject) },
          ]);
        },
      },
      h('div', { class: 'git-commit-main' },
        h('div', { class: 'git-commit-subject', title: c.subject }, c.subject || '(no message)'),
        h('div', { class: 'git-commit-meta' }, unpushed.has(c.hash) ? h('span', { class: 'git-unpushed', title: 'Not pushed yet' }, '↑') : null, c.author, ' · ', ago(c.date), refBadges(c.refs)))));
    });
  };
  fillHistoryRows();
}

// ---------- right pane: diff ----------

function diffCounts(text) {
  let added = 0, removed = 0, inHunk = false;
  for (const raw of String(text || '').split('\n')) {
    if (raw.startsWith('diff --git ')) { inHunk = false; continue; }
    if (raw.startsWith('@@ ')) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (raw.startsWith('+')) added++;
    else if (raw.startsWith('-')) removed++;
  }
  return { added, removed };
}

function drawRight() {
  if (!mounted) return;
  const d = cur();
  const el = clear(mounted.els.right);
  if (!d.repo || !d.state) return;
  if (d.tab === 'changes') {
    const f = d.state.files.find((x) => x.path === d.selFile);
    if (!f) {
      add(el, h('div', { class: 'git-none' }, d.state.files.length ? 'Select a file to see its changes' : h('div', null, h('div', { class: 'git-clean-title' }, 'No local changes'),
        h('div', { class: 'muted' }, 'There are no uncommitted changes in this repository.'))));
      return;
    }
    const counts = d.diff && d.diff.key === d.repo + '\n' + f.path ? diffCounts(d.diff.diff) : null;
    add(el, h('div', { class: 'git-diff-head' },
      statusIcon(f.status),
      fileLabel(f.path, f.orig),
      counts && (counts.added || counts.removed) ? h('span', { class: 'diff-stat mono' },
        counts.added ? h('span', { class: 'ok' }, '+' + counts.added) : null,
        counts.added && counts.removed ? ' ' : null,
        counts.removed ? h('span', { class: 'bad' }, '-' + counts.removed) : null) : null,
      h('div', { class: 'spacer' }),
      f.status === 'conflict' ? [
        h('button', { onclick: () => act('resolveConflict', { file: f.path, side: 'ours' }, 'Use Ours') }, 'Use Ours'),
        h('button', { onclick: () => act('resolveConflict', { file: f.path, side: 'theirs' }, 'Use Theirs') }, 'Use Theirs'),
        h('button', { class: 'primary', onclick: () => act('resolveConflict', { file: f.path, side: 'mark' }, 'Mark resolved') }, 'Mark Resolved'),
      ] : null,
      h('button', { class: d.wrap ? 'active' : '', title: 'Toggle word wrap', onclick: () => { d.wrap = !d.wrap; savePref('gitWrap', d.wrap ? '1' : '0'); drawRight(); } }, 'Wrap'),
      f.status !== 'deleted' ? h('button', { title: 'Open this file in the File Explorer', onclick: () => openInExplorer(d, f.path) }, 'Open file') : null));
    if (d.diffErr) add(el, h('div', { class: 'git-none bad' }, d.diffErr));
    else if (!d.diff || d.diff.key !== d.repo + '\n' + f.path) add(el, h('div', { class: 'git-none muted' }, 'Loading diff…'));
    else add(el, renderDiff(d.diff.diff, d.diff.truncated, f.path, d.wrap));
    return;
  }
  // history
  const c = d.commitInfo;
  if (!d.selCommit) { add(el, h('div', { class: 'git-none muted' }, 'Select a commit')); return; }
  if (!c) { add(el, h('div', { class: 'git-none muted' }, 'Loading…')); return; }
  const st = d.state;
  add(el, h('div', { class: 'git-commit-head' },
    h('div', { class: 'row' },
      h('div', { class: 'git-commit-title', style: { flex: '1' } }, c.subject),
      st.web && st.web.commitBase ? h('button', { title: `View commit on ${st.web.label}`, onclick: () => call('openExternal', st.web.commitBase + c.hash) }, `${st.web.label} ↗`) : null),
    c.body ? h('div', { class: 'git-commit-body' }, c.body) : null,
    h('div', { class: 'git-commit-meta' }, h('b', null, c.author), ` <${c.email}> · ${new Date(c.date).toLocaleString()} · `,
      h('span', { class: 'mono git-sha', title: 'Copy SHA', onclick: () => { navigator.clipboard.writeText(c.hash); toast('SHA copied'); } }, c.hash.slice(0, 10)),
      c.parents.length > 1 ? ' · merge commit (changes against the first parent)' : '', refBadges(c.refs))));
  const fl = h('div', { class: 'git-commit-files' },
    h('div', { class: 'git-list-head' }, `${c.files.length} changed file${c.files.length === 1 ? '' : 's'}`),
    c.files.map((f) => h('div', { class: 'git-row' + (d.commitFile === f ? ' sel' : ''), onclick: () => selectCommitFile(f) }, fileLabel(f.path, f.orig), statusIcon(f.status))));
  const diffBox = h('div', { class: 'git-commit-diff' });
  if (d.commitFile) {
    if (!d.commitDiff) add(diffBox, h('div', { class: 'git-none muted' }, 'Loading diff…'));
    else if (d.commitDiff.error) add(diffBox, h('div', { class: 'git-none bad' }, d.commitDiff.error));
    else add(diffBox, renderDiff(d.commitDiff.diff, d.commitDiff.truncated, d.commitFile.path, d.wrap));
  }
  add(el, h('div', { class: 'git-commit-split' }, fl, diffBox));
}

// Unified diff → rows with old / new line numbers.
export function parseDiff(text) {
  const rows = [];
  const notes = [];
  let o = 0;
  let n = 0;
  let inHunk = false;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) { inHunk = false; continue; }
    if (!inHunk) {
      if (line.startsWith('Binary files')) notes.push('Binary file changed');
      else if (line.startsWith('rename from ')) notes.push('Renamed from ' + line.slice(12));
      else if (line.startsWith('new file mode')) notes.push('New file');
      else if (line.startsWith('deleted file mode')) notes.push('File deleted');
      else if (line.startsWith('old mode ')) notes.push('Mode ' + line.slice(9));
      else if (line.startsWith('new mode ')) notes[notes.length - 1] = (notes[notes.length - 1] || '') + ' → ' + line.slice(9);
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (m) { o = Number(m[1]); n = Number(m[2]); inHunk = true; rows.push({ t: 'hunk', text: line }); continue; }
    if (!inHunk) continue;
    if (line.startsWith('+')) rows.push({ t: 'add', n: n++, text: line.slice(1) });
    else if (line.startsWith('-')) rows.push({ t: 'del', o: o++, text: line.slice(1) });
    else if (line.startsWith(' ')) rows.push({ t: 'ctx', o: o++, n: n++, text: line.slice(1) });
    else if (line.startsWith('\\')) rows.push({ t: 'note', text: line.slice(2) });
  }
  return { rows, notes };
}

function renderDiff(text, truncated, filePath = '', wrap = false) {
  const { rows, notes } = parseDiff(text);
  const fmtId = filePath ? detectFormat(filePath).id : 'text';
  const box = h('div', { class: 'git-diff' + (wrap ? ' wrap' : '') });
  if (notes.length) add(box, h('div', { class: 'git-diff-notes' }, notes.join(' · ')));
  if (!rows.length) {
    add(box, h('div', { class: 'git-none muted' }, notes.some((x) => /Binary/.test(x)) ? 'Binary file — no text diff.' : 'No content changes.'));
    return box;
  }
  const frag = document.createDocumentFragment();
  for (const r of rows.slice(0, MAX_LINES)) {
    const codeSpan = document.createElement('span');
    codeSpan.className = 'git-code';
    const prefix = r.t === 'add' ? '+' : r.t === 'del' ? '-' : r.t === 'ctx' ? ' ' : '';
    if (prefix) codeSpan.appendChild(document.createTextNode(prefix));
    if ((r.t === 'add' || r.t === 'del' || r.t === 'ctx') && fmtId !== 'text') {
      for (const tok of tokenizeLine(r.text, fmtId)) {
        if (!tok.text) continue;
        if (tok.cls) {
          const sp = document.createElement('span');
          sp.className = tok.cls;
          sp.textContent = tok.text;
          codeSpan.appendChild(sp);
        } else {
          codeSpan.appendChild(document.createTextNode(tok.text));
        }
      }
    } else {
      codeSpan.appendChild(document.createTextNode(r.text));
    }
    frag.appendChild(h('div', { class: 'git-dl git-dl-' + r.t },
      h('span', { class: 'git-ln' }, r.o ?? ''), h('span', { class: 'git-ln' }, r.n ?? ''), codeSpan));
  }
  box.appendChild(h('div', { class: 'git-diff-lines' }, frag));
  if (rows.length > MAX_LINES || truncated) add(box, h('div', { class: 'git-diff-notes' }, 'The diff is too large to show completely.'));
  return box;
}
