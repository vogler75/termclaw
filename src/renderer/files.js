// File Explorer tab & file transfers for a project's machine (local, WSL, SSH).
// Also handles dropping/pasting files onto terminals.
import { h, clear, toast, confirmDialog, prompt, contextMenu, fmtTime } from './ui.js';
import { detectFormat, validateJson, renderCodeView, renderMarkdownPreview } from './file-viewer.js';

const call = (m, ...a) => window.termclaw.call(m, ...a);
const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
const isWinPath = (d) => /^[A-Za-z]:[\\/]/.test(d || '') || (String(d || '').includes('\\') && !String(d || '').startsWith('/'));
const parentDir = (d) => {
  if (!d) return '';
  if (isWinPath(d)) return d.replace(/[\\][^\\]*[\\]?$/, '') || d;
  return d.replace(/\/[^/]*\/?$/, '') || '/';
};
const joinPath = (d, n) => {
  if (!d) return n;
  if (isWinPath(d)) return d.replace(/[\\]$/, '') + '\\' + n;
  return (d.endsWith('/') ? d : d + '/') + n;
};
const resolveRel = (filePath, rel) => {
  const win = isWinPath(filePath);
  const sep = win ? '\\' : '/';
  const dir = parentDir(filePath);
  if (/^[/\\]/.test(rel) || /^[A-Za-z]:[\\/]/.test(rel)) return rel;
  const parts = dir.split(/[\\/]/).filter((x, i) => x || (i === 0 && !win));
  for (const seg of rel.split(/[\\/]/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (parts.length > (win ? 1 : 0)) parts.pop(); }
    else parts.push(seg);
  }
  return win ? parts.join(sep) : '/' + parts.filter(Boolean).join('/');
};

export function fmtSize(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}

// Progress toast for a transfer; returns {jobId, finish()}.
const jobs = new Map();
window.termclaw.on('files:progress', ({ jobId, done, total }) => {
  const j = jobs.get(jobId);
  if (j) j.el.textContent = `${j.label} ${total ? Math.round((done / total) * 100) + '%' : ''} (${fmtSize(done)}${total ? ' of ' + fmtSize(total) : ''})`;
});
function job(label) {
  const jobId = Math.random().toString(36).slice(2);
  const el = toast(label + '…', { ms: 24 * 3600 * 1000 });
  jobs.set(jobId, { el, label });
  return { jobId, finish: () => { jobs.delete(jobId); el.remove(); } };
}

// Uploads local paths into dir, asking before existing entries are overwritten. Returns true when done.
async function upload(projectId, paths, dir, where) {
  const names = paths.map(base);
  const existing = await call('filesExists', projectId, dir, names);
  if (existing.length && !(await confirmDialog('Replace files?', `Already in ${dir}: ${existing.join(', ')}. Replace?`, 'Replace'))) return false;
  const j = job(`Uploading ${names.length === 1 ? names[0] : names.length + ' items'} to ${where}`);
  try {
    await call('filesUpload', projectId, paths, dir, j.jobId);
    toast(`Uploaded ${names.length === 1 ? names[0] : names.length + ' items'} to ${where}`, { ms: 5000 });
    return true;
  } catch (e) {
    toast('Upload failed: ' + e.message, { error: true, ms: 10000 });
    return false;
  } finally { j.finish(); }
}

// Quoting for typing paths into a local shell.
const quoteLocal = (p, win) => (win ? `'${p.replace(/'/g, "''")}'` : `'${p.replace(/'/g, "'\\''")}'`);

// Files dropped onto a terminal: remote shells get the files in their current directory,
// local shells get the paths typed in (the files are already on this computer).
export async function dropOnTerminal(ctx, sessionId, paths) {
  let t;
  try { t = await call('filesDropTarget', sessionId); } catch (e) { toast(e.message, { error: true }); return; }
  if (!t.remote) {
    call('write', sessionId, paths.map((p) => quoteLocal(p, ctx.S.platform === 'win32')).join(' ') + ' ');
    return;
  }
  await upload(t.projectId, paths, t.dir, `${t.label}:${t.dir}`);
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i;
// Named after its content by the main process (saveImage): the same picture is uploaded only once.
const SAVED_IMAGE = /^paste-[0-9a-f]{16}\.\w+$/;

export async function pasteFiles(ctx, sessionId, { paths = [], images = [] }) {
  let t;
  try { t = await call('filesDropTarget', sessionId); } catch (e) { toast(e.message, { error: true }); return; }
  const local = [...paths];
  try {
    for (const f of images) local.push(await call('saveImage', new Uint8Array(await f.arrayBuffer()), f.type));
  } catch (e) { toast('Image paste failed: ' + e.message, { error: true, ms: 10000 }); return; }
  if (!local.length) return;
  if (!t.remote) {
    call('write', sessionId, local.map((p) => quoteLocal(p, ctx.S.platform === 'win32')).join(' ') + ' ');
    return;
  }
  const pics = local.filter((p) => IMAGE_FILE.test(p));
  const others = local.filter((p) => !IMAGE_FILE.test(p));
  if (pics.length) {
    const j = job(`Uploading ${pics.length === 1 ? 'the pasted image' : pics.length + ' pasted images'} to ${t.label}`);
    try {
      const there = new Set((await call('filesExists', t.projectId, '/tmp', pics.map(base))).filter((n) => SAVED_IMAGE.test(n)));
      const todo = pics.filter((p) => !there.has(base(p)));
      if (todo.length) await call('filesUpload', t.projectId, todo, '/tmp', j.jobId);
      call('write', sessionId, pics.map((p) => quoteLocal('/tmp/' + base(p), false)).join(' ') + ' ');
    } catch (e) {
      toast('Image paste failed: ' + e.message, { error: true, ms: 10000 });
    } finally { j.finish(); }
  }
  if (others.length) await upload(t.projectId, others, t.dir, `${t.label}:${t.dir}`);
}

// ---------- Embedded File Explorer tab ----------

const states = new Map(); // projectId -> per-project explorer state
let mounted = null; // { ctx, projectId, root, els }

function loadPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function savePref(key, val) { try { localStorage.setItem(key, val); } catch {} }

function pstate(projectId) {
  let d = states.get(projectId);
  if (!d) {
    d = {
      ref: projectId, // projectId or "<projectId>@<hostId>"
      cur: null, // { path, entries }
      loadingDir: false,
      dirErr: '',
      selected: new Set(),
      anchor: null,
      filter: '',
      showHidden: true,
      file: null, // { path, name, loading, error, data }
      mdMode: loadPref('filesMdMode', 'preview'), // preview | split | source
      svgMode: 'preview',
      prettyJson: false,
      wrap: loadPref('filesWrap', '0') === '1',
      search: '',
      matchIdx: 0,
      matches: [],
    };
    states.set(projectId, d);
  }
  return d;
}

const curState = () => (mounted ? pstate(mounted.projectId) : null);

function fileBadge(e) {
  if (e.type === 'dir') return { text: '📁', cls: 'ficon' };
  const name = e.name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|ico|svg)$/.test(name)) return { text: '🖼', cls: 'ficon' };
  const fmt = detectFormat(e.name);
  if (fmt.id === 'markdown') return { text: 'MD', cls: 'fbadge fbadge-md' };
  if (fmt.id === 'json') return { text: '{}', cls: 'fbadge fbadge-json' };
  if (fmt.id === 'yaml') return { text: 'YML', cls: 'fbadge fbadge-yml' };
  if (fmt.id === 'toml') return { text: 'CFG', cls: 'fbadge fbadge-cfg' };
  if (fmt.id === 'xml') return { text: '<>', cls: 'fbadge fbadge-xml' };
  if (fmt.id === 'shell') return { text: 'SH', cls: 'fbadge fbadge-sh' };
  if (fmt.id === 'code' || fmt.id === 'css' || fmt.id === 'sql') return { text: '‹›', cls: 'fbadge fbadge-code' };
  return { text: '📄', cls: 'ficon' };
}

// Entry point used by app.js, git.js, and context menus: opens the embedded Files tab directly.
export function openBrowser(ctx, ref, dir = '', file = '') {
  const [pid] = String(ref).split('@');
  const d = pstate(pid);
  const changedRef = d.ref !== ref;
  d.ref = ref;
  if (changedRef) { d.cur = null; d.file = null; d.selected.clear(); }
  d.pendingDir = dir || (changedRef ? '' : null);
  d.pendingFile = file || null;
  ctx.showFiles(pid);
  if (mounted && mounted.projectId === pid) {
    if (d.pendingDir !== null || !d.cur) {
      const target = d.pendingDir ?? '';
      d.pendingDir = null;
      loadDir(target);
    }
    if (d.pendingFile) {
      const targetFile = d.pendingFile;
      d.pendingFile = null;
      openFile(targetFile, base(targetFile));
    }
  }
}

export function mount(ctx, el, projectId) {
  const root = h('div', { class: 'filesv file-browser' });
  el.appendChild(root);
  mounted = { ctx, projectId, root, els: null };
  build();
  const d = pstate(projectId);
  if (d.pendingDir !== undefined && d.pendingDir !== null) {
    const target = d.pendingDir;
    d.pendingDir = null;
    loadDir(target);
  } else if (!d.cur) {
    loadDir('');
  } else {
    drawAll();
  }
  if (d.pendingFile) {
    const targetFile = d.pendingFile;
    d.pendingFile = null;
    openFile(targetFile, base(targetFile));
  }
}

export function unmount() {
  mounted = null;
}

// ---------- data loading ----------

async function loadDir(dir) {
  const d = curState();
  if (!d || !mounted) return;
  const pid = mounted.projectId;
  const ref = d.ref;
  d.loadingDir = true;
  d.dirErr = '';
  drawToolbar();
  drawList();
  try {
    const res = await call('filesList', ref, dir);
    if (!mounted || mounted.projectId !== pid || d.ref !== ref) return;
    d.cur = res;
    d.selected = new Set();
    d.anchor = null;
    d.dirErr = '';
  } catch (e) {
    if (!mounted || mounted.projectId !== pid) return;
    d.dirErr = e.message;
  }
  d.loadingDir = false;
  drawToolbar();
  drawList();
}

async function openFile(filePath, name) {
  const d = curState();
  if (!d || !mounted) return;
  const pid = mounted.projectId;
  const ref = d.ref;
  const fname = name || base(filePath);
  d.file = { path: filePath, name: fname, loading: true, error: '', data: null };
  d.prettyJson = false;
  d.matchIdx = 0;
  d.matches = [];
  drawViewer();
  try {
    const data = await call('filesRead', ref, filePath);
    if (!mounted || mounted.projectId !== pid || !d.file || d.file.path !== filePath) return;
    d.file = { path: data.path || filePath, name: fname, loading: false, error: '', data };
  } catch (e) {
    if (!mounted || mounted.projectId !== pid || !d.file || d.file.path !== filePath) return;
    d.file = { path: filePath, name: fname, loading: false, error: e.message, data: null };
  }
  drawViewer();
}

async function downloadEntries(entries) {
  const d = curState();
  if (!d || !d.cur) return;
  if (!entries.length) {
    if (d.file && d.file.path) {
      entries = [{ name: d.file.name, path: d.file.path, type: 'file', size: (d.file.data && d.file.data.size) || 0 }];
    } else {
      toast('Select files or folders first');
      return;
    }
  }
  const j = job(`Downloading ${entries.length === 1 ? entries[0].name : entries.length + ' items'}`);
  try {
    const items = entries.map((e) => ({ path: e.path || joinPath(d.cur.path, e.name), type: e.type, size: e.size || 0 }));
    const r = await call('filesDownload', d.ref, items, j.jobId);
    if (r) {
      const t = toast(`Downloaded to ${r.saved.length === 1 ? r.saved[0] : base(r.saved[0].replace(/[\\/][^\\/]*$/, ''))} — click to show`, { ms: 8000 });
      t.style.cursor = 'pointer';
      t.onclick = () => call('showInFolder', r.saved[0]);
    }
  } catch (e) {
    toast('Download failed: ' + e.message, { error: true, ms: 10000 });
  } finally {
    j.finish();
  }
}

async function uploadPaths(paths) {
  const d = curState();
  if (!d || !d.cur || !paths.length) return;
  if (await upload(d.ref, paths, d.cur.path, d.cur.path)) loadDir(d.cur.path);
}

async function createFolder() {
  const d = curState();
  if (!d || !d.cur) return;
  const name = await prompt('New folder');
  if (!name) return;
  try {
    await call('filesMkdir', d.ref, d.cur.path, name);
    loadDir(d.cur.path);
  } catch (e) {
    toast(e.message, { error: true });
  }
}

// ---------- layout & rendering ----------

function build() {
  const { root } = mounted;
  const toolbar = h('div', { class: 'files-toolbar' });
  const banner = h('div', { class: 'files-banner' });
  const filterInput = h('input', {
    class: 'files-filter',
    placeholder: 'Filter files…',
    oninput: () => {
      const d = curState();
      if (!d) return;
      d.filter = filterInput.value;
      drawList();
    },
  });
  const listHead = h('div', { class: 'files-list-head' }, filterInput);
  const list = h('div', { class: 'files-list file-list' });
  const foot = h('div', { class: 'files-foot' });
  const left = h('div', { class: 'files-left' }, listHead, list, foot);
  const savedW = Number(loadPref('filesW', '0'));
  if (savedW >= 200 && savedW <= 600) left.style.width = savedW + 'px';

  const splitter = h('div', { class: 'files-splitter' });
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = left.getBoundingClientRect().width;
    const move = (ev) => {
      const w = Math.max(200, Math.min(600, startW + (ev.clientX - startX)));
      left.style.width = w + 'px';
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      savePref('filesW', String(Math.round(left.getBoundingClientRect().width)));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  const viewHead = h('div', { class: 'files-view-head' });
  const viewBody = h('div', { class: 'files-view-body' });
  const right = h('div', { class: 'files-right' }, viewHead, viewBody);
  const body = h('div', { class: 'files-body' }, left, splitter, right);

  // Drag & drop files from Finder / Explorer onto the left pane to upload into the current directory.
  const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  left.addEventListener('dragover', (e) => { if (!isFiles(e)) return; e.preventDefault(); list.classList.add('drop-files'); });
  left.addEventListener('dragleave', (e) => { if (!left.contains(e.relatedTarget)) list.classList.remove('drop-files'); });
  left.addEventListener('drop', (e) => {
    list.classList.remove('drop-files');
    if (!isFiles(e)) return;
    e.preventDefault();
    uploadPaths([...e.dataTransfer.files].map((f) => window.termclaw.pathForFile(f)).filter(Boolean));
  });

  root.append(toolbar, banner, body);
  mounted.els = { toolbar, banner, filterInput, list, foot, viewHead, viewBody };
}

function drawAll() {
  drawToolbar();
  drawList();
  drawViewer();
}

function drawToolbar() {
  if (!mounted) return;
  const d = curState();
  const { toolbar, banner } = mounted.els;
  clear(toolbar);
  clear(banner);

  const [pid, hid] = String(d.ref).split('@');
  const onHost = hid ? mounted.ctx.S.config.hosts.find((x) => x.id === hid) : null;
  const pathInput = h('input', {
    class: 'mono files-path-input',
    value: (d.cur && d.cur.path) || '',
    placeholder: 'Directory path…',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); loadDir(pathInput.value.trim()); } },
  });

  const btn = (label, title, onclick, cls = '') => h('button', { class: cls, title, onclick }, label);
  toolbar.append(...[
    btn('↑', 'Parent folder', () => d.cur && loadDir(parentDir(d.cur.path))),
    btn('⌂', onHost ? `Workspace folder of ${onHost.name}` : 'Project folder', () => loadDir('')),
    onHost ? h('span', { class: 'tag files-host-tag', title: `Browsing host ${onHost.name}` },
      `⇄ ${onHost.name}`,
      pid !== '__hosts__' ? h('span', {
        class: 'files-host-reset',
        title: 'Switch back to project machine',
        onclick: () => { d.ref = pid; d.cur = null; d.file = null; loadDir(''); },
      }, ' ×') : null) : null,
    pathInput,
    btn('.*', d.showHidden ? 'Hide dotfiles' : 'Show dotfiles', () => { d.showHidden = !d.showHidden; drawToolbar(); drawList(); }, d.showHidden ? 'active' : ''),
    btn('⟳', 'Refresh folder', () => loadDir(d.cur ? d.cur.path : '')),
    h('span', { class: 'files-sep' }),
    btn('Upload…', 'Upload files from this computer into this folder (or drag & drop)', async () => uploadPaths(await call('filesPickUpload'))),
    btn('Download', 'Download selected files/folders (or the open file)', () => {
      const sel = d.cur ? d.cur.entries.filter((e) => d.selected.has(e.name)) : [];
      downloadEntries(sel);
    }),
    btn('New folder…', 'Create a new folder here', createFolder),
  ].filter(Boolean));

  if (d.dirErr) {
    banner.append(
      h('span', null, d.dirErr),
      h('button', { onclick: () => loadDir(d.cur ? d.cur.path : '') }, 'Retry'));
  }
}

function drawList() {
  if (!mounted) return;
  const d = curState();
  const { list, foot, filterInput } = mounted.els;
  if (filterInput.value !== d.filter) filterInput.value = d.filter;
  clear(list);
  clear(foot);

  if (d.loadingDir && !d.cur) {
    list.appendChild(h('div', { class: 'files-empty muted' }, 'Loading…'));
    return;
  }
  if (!d.cur) {
    list.appendChild(h('div', { class: 'files-empty muted' }, d.dirErr ? 'Could not read folder.' : 'No folder loaded.'));
    return;
  }

  const q = d.filter.trim().toLowerCase();
  const visible = d.cur.entries.filter((e) => (d.showHidden || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q)));
  const rows = [{ name: '..', type: 'dir', up: true }, ...visible];
  const openFilePath = d.file && d.file.path;

  const listEl = h('div', { class: 'files-rows' }, rows.map((e, i) => {
    const full = e.up ? '' : joinPath(d.cur.path, e.name);
    const isSel = d.selected.has(e.name);
    const isOpen = !e.up && e.type === 'file' && full === openFilePath;
    const badge = fileBadge(e);
    return h('div', {
      class: 'files-row' + (isSel ? ' sel' : '') + (isOpen ? ' viewing' : ''),
      title: e.up ? 'Go to parent folder' : `${e.name}${e.type === 'file' ? ' · ' + fmtSize(e.size) : ''}${e.mtime ? ' · ' + fmtTime(e.mtime) : ''}`,
      onclick: (ev) => {
        if (e.up) { loadDir(parentDir(d.cur.path)); return; }
        if (ev.shiftKey && d.anchor != null) {
          const [a, b] = [Math.min(d.anchor, i), Math.max(d.anchor, i)];
          if (!ev.ctrlKey && !ev.metaKey) d.selected.clear();
          rows.slice(a, b + 1).forEach((r) => { if (!r.up) d.selected.add(r.name); });
        } else if (ev.ctrlKey || ev.metaKey) {
          d.selected.has(e.name) ? d.selected.delete(e.name) : d.selected.add(e.name);
          d.anchor = i;
        } else {
          d.selected = new Set([e.name]);
          d.anchor = i;
          if (e.type === 'file') openFile(full, e.name);
        }
        drawList();
      },
      ondblclick: () => {
        if (e.up) loadDir(parentDir(d.cur.path));
        else if (e.type === 'dir') loadDir(full);
        else openFile(full, e.name);
      },
      oncontextmenu: (ev) => {
        if (e.up) return;
        ev.preventDefault();
        if (!d.selected.has(e.name)) { d.selected = new Set([e.name]); drawList(); }
        const sel = d.cur.entries.filter((x) => d.selected.has(x.name));
        contextMenu(ev.clientX, ev.clientY, [
          e.type === 'dir'
            ? { label: 'Open folder', action: () => loadDir(full) }
            : { label: 'View file', action: () => openFile(full, e.name) },
          { label: sel.length > 1 ? `Download ${sel.length} items…` : 'Download…', action: () => downloadEntries(sel) },
          { label: 'Copy path', action: () => { navigator.clipboard?.writeText(full); toast('Path copied'); } },
          '-',
          { label: 'Upload here…', action: async () => uploadPaths(await call('filesPickUpload')) },
          { label: 'New folder…', action: createFolder },
        ]);
      },
    },
    h('span', { class: badge.cls }, badge.text),
    h('span', { class: 'files-name' }, e.name),
    e.type === 'file' ? h('span', { class: 'files-size mono' }, fmtSize(e.size)) : null);
  }));

  list.appendChild(listEl);
  foot.append(
    h('span', null, d.selected.size ? `${d.selected.size} selected` : `${visible.length} item${visible.length === 1 ? '' : 's'}`),
    h('span', { class: 'muted' }, 'Drop files to upload'));
}

function drawViewer() {
  if (!mounted) return;
  const d = curState();
  const { viewHead, viewBody } = mounted.els;
  clear(viewHead);
  clear(viewBody);

  const f = d.file;
  if (!f) {
    viewBody.appendChild(h('div', { class: 'files-empty muted' },
      h('div', { style: { fontSize: '14px', color: 'var(--fg2)' } }, 'File Explorer'),
      h('div', null, 'Select a file on the left to view it (Markdown preview, YAML, JSON, code, images).'),
      h('div', null, 'Drag & drop files onto the left list to upload, or select items and click Download.')));
    return;
  }

  const fmt = detectFormat(f.name);
  const data = f.data;
  const isMd = fmt.id === 'markdown';
  const isSvg = fmt.id === 'xml' && f.name.toLowerCase().endsWith('.svg');
  const isJson = fmt.id === 'json' && f.name.toLowerCase().endsWith('.json');
  const jsonCheck = isJson && data && !data.binary ? validateJson(data.content) : null;
  const displayText = isJson && d.prettyJson && jsonCheck && jsonCheck.valid ? jsonCheck.pretty : (data ? data.content : '');

  // Header controls
  const headItems = [
    h('span', { class: 'files-view-name mono', title: f.path }, f.name),
    h('span', { class: 'tag' }, data && data.mime ? data.mime.split('/').pop().toUpperCase() : fmt.label),
    data ? h('span', { class: 'muted mono', style: { fontSize: '11px' } }, fmtSize(data.size)) : null,
    data && data.truncated ? h('span', { class: 'tag warn', title: 'File exceeds preview limit; showing first 512 KB' }, 'truncated') : null,
    jsonCheck ? h('span', { class: 'tag ' + (jsonCheck.valid ? 'ok' : 'bad'), title: jsonCheck.error || 'Valid JSON' }, jsonCheck.valid ? 'valid JSON' : 'invalid JSON') : null,
    h('div', { class: 'spacer' }),
  ];

  // VS Code-style Markdown preview toggle: Preview | Split | Source
  if (isMd && data && !data.binary) {
    const modeBtn = (m, label) => h('button', {
      class: d.mdMode === m ? 'active' : '',
      onclick: () => { d.mdMode = m; savePref('filesMdMode', m); drawViewer(); },
    }, label);
    headItems.push(h('div', { class: 'files-seg' }, modeBtn('preview', 'Preview'), modeBtn('split', 'Split'), modeBtn('source', 'Source')));
  }

  if (isSvg && data && !data.binary) {
    const modeBtn = (m, label) => h('button', {
      class: d.svgMode === m ? 'active' : '',
      onclick: () => { d.svgMode = m; drawViewer(); },
    }, label);
    headItems.push(h('div', { class: 'files-seg' }, modeBtn('preview', 'Preview'), modeBtn('source', 'Source')));
  }

  if (jsonCheck && jsonCheck.valid) {
    headItems.push(h('button', {
      class: d.prettyJson ? 'active' : '',
      title: 'Pretty-print JSON',
      onclick: () => { d.prettyJson = !d.prettyJson; drawViewer(); },
    }, 'Pretty'));
  }

  const showingSource = data && !data.binary && (!isMd || d.mdMode !== 'preview') && (!isSvg || d.svgMode === 'source');
  let matchCountEl = null;
  if (showingSource) {
    matchCountEl = h('span', { class: 'muted mono files-match-count' });
    const searchInput = h('input', {
      class: 'files-search',
      value: d.search,
      placeholder: 'Find…',
      oninput: () => { d.search = searchInput.value; d.matchIdx = 0; renderBodyOnly(); },
      onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); jumpMatch(e.shiftKey ? -1 : 1); }
        else if (e.key === 'Escape') { d.search = ''; searchInput.value = ''; renderBodyOnly(); }
      },
    });
    headItems.push(
      searchInput,
      matchCountEl,
      h('button', { class: d.wrap ? 'active' : '', title: 'Toggle word wrap', onclick: () => { d.wrap = !d.wrap; savePref('filesWrap', d.wrap ? '1' : '0'); drawViewer(); } }, 'Wrap'));
  }

  if (data && !data.binary) {
    headItems.push(h('button', {
      title: 'Copy file content',
      onclick: () => { navigator.clipboard?.writeText(displayText); toast('Copied to clipboard'); },
    }, 'Copy'));
  }
  headItems.push(
    h('button', { title: 'Download this file', onclick: () => downloadEntries([{ name: f.name, path: f.path, type: 'file', size: (data && data.size) || 0 }]) }, 'Download'),
    h('button', { class: 'icon', title: 'Reload file', onclick: () => openFile(f.path, f.name) }, '⟳'));

  viewHead.append(...headItems.filter(Boolean));

  function jumpMatch(delta) {
    if (!d.matches.length) return;
    d.matches[d.matchIdx]?.classList.remove('active');
    d.matchIdx = (d.matchIdx + delta + d.matches.length) % d.matches.length;
    const target = d.matches[d.matchIdx];
    if (target) { target.classList.add('active'); target.scrollIntoView({ block: 'center', inline: 'nearest' }); }
    if (matchCountEl) matchCountEl.textContent = `${d.matchIdx + 1}/${d.matches.length}`;
  }

  function renderBodyOnly() {
    clear(viewBody);
    d.matches = [];
    if (f.loading) { viewBody.appendChild(h('div', { class: 'files-empty muted' }, 'Loading…')); return; }
    if (f.error) { viewBody.appendChild(h('div', { class: 'files-empty bad' }, f.error)); return; }
    if (!data) return;

    if (data.dataUrl) {
      viewBody.appendChild(h('div', { class: 'files-img-wrap' },
        h('img', { src: data.dataUrl, alt: f.name, class: 'files-img' })));
      return;
    }
    if (data.binary) {
      viewBody.appendChild(h('div', { class: 'files-empty muted' },
        h('div', { style: { fontSize: '14px', color: 'var(--fg2)' } }, data.truncated ? 'File is too large to preview.' : 'Binary file cannot be previewed.'),
        h('div', null, `${f.name} · ${fmtSize(data.size)}`),
        h('button', { class: 'primary', onclick: () => downloadEntries([{ name: f.name, path: f.path, type: 'file', size: data.size }]) }, 'Download file')));
      return;
    }

    const mdOpts = {
      onOpenLink: (url) => call('openExternal', url),
      onOpenFile: (rel) => {
        const target = resolveRel(f.path, rel);
        openFile(target, base(target));
      },
    };

    if (isSvg && d.svgMode === 'preview') {
      const bytes = new TextEncoder().encode(data.content);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      viewBody.appendChild(h('div', { class: 'files-img-wrap' },
        h('img', { src: 'data:image/svg+xml;base64,' + btoa(bin), alt: f.name, class: 'files-img' })));
      return;
    }

    if (isMd && d.mdMode === 'preview') {
      viewBody.appendChild(h('div', { class: 'files-md-scroll' }, renderMarkdownPreview(data.content, mdOpts)));
      return;
    }

    if (isMd && d.mdMode === 'split') {
      const code = renderCodeView(data.content, 'markdown', { wrap: d.wrap, search: d.search });
      d.matches = code.matches;
      viewBody.appendChild(h('div', { class: 'files-split' },
        h('div', { class: 'files-split-pane' }, code.el),
        h('div', { class: 'files-split-pane files-md-scroll' }, renderMarkdownPreview(data.content, mdOpts))));
    } else {
      const code = renderCodeView(displayText, fmt.id, { wrap: d.wrap, search: d.search });
      d.matches = code.matches;
      viewBody.appendChild(h('div', { class: 'files-code-scroll' }, code.el));
    }

    if (matchCountEl) {
      if (d.search && d.matches.length) {
        d.matchIdx = Math.min(d.matchIdx, d.matches.length - 1);
        d.matches[d.matchIdx].classList.add('active');
        d.matches[d.matchIdx].scrollIntoView({ block: 'center', inline: 'nearest' });
        matchCountEl.textContent = `${d.matchIdx + 1}/${d.matches.length}`;
      } else {
        matchCountEl.textContent = d.search ? '0/0' : '';
      }
    }
  }

  renderBodyOnly();
}
