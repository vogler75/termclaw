// Files on a project's machine: drop files onto a terminal to upload them into the shell's directory,
// and a file browser to look around, upload and download.
import { h, clear, toast, modal, confirmDialog, prompt, fmtTime } from './ui.js';

const call = (m, ...a) => window.termclaw.call(m, ...a);
const base = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;

export function fmtSize(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}

// Progress toast for a transfer; returns {jobId, done(text?)}.
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

// Paste into a terminal of copied files (paths) or image data without a file (images: screenshot, copied
// picture), which is saved as a file first. The paths are typed in, so agents (Claude Code, Copilot, …)
// pick images up. A remote shell gets images in /tmp on its machine and other files in its directory, like a drop.
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

// File browser for a project (starts in dir, else the project directory).
export async function openBrowser(ctx, projectId, dir) {
  // projectId can be "<project id>@<host id>": the machine of a session on another dev host.
  const [pid, hid] = String(projectId).split('@');
  const p = ctx.S.config.projects.find((x) => x.id === pid);
  const onHost = hid ? ctx.S.config.hosts.find((x) => x.id === hid) : null;
  let cur = null; // {path, entries}
  let selected = new Set();
  let anchor = null;
  const pathInput = h('input', { class: 'mono', style: { flex: '1' }, onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); load(pathInput.value.trim()); } } });
  const list = h('div', { class: 'file-list' });
  const status = h('div', { class: 'muted', style: { fontSize: '12px', minHeight: '16px' } });
  const parent = (d) => (d.includes('\\') && !d.startsWith('/') ? d.replace(/[\\][^\\]*[\\]?$/, '') || d : d.replace(/\/[^/]*\/?$/, '') || '/');
  const join = (d, n) => (d.includes('\\') && !d.startsWith('/') ? d.replace(/[\\]$/, '') + '\\' + n : (d.endsWith('/') ? d : d + '/') + n);

  async function load(d) {
    status.textContent = 'Loading…';
    try {
      cur = await call('filesList', projectId, d);
      selected = new Set();
      anchor = null;
      pathInput.value = cur.path;
      render();
      status.textContent = `${cur.entries.length} items`;
    } catch (e) { status.textContent = ''; toast(e.message, { error: true, ms: 8000 }); }
  }

  function render() {
    clear(list);
    const rows = [{ name: '..', type: 'dir', up: true }, ...cur.entries];
    list.appendChild(h('table', { class: 'list files' },
      h('tr', null, h('th', null, 'Name'), h('th', { style: { textAlign: 'right' } }, 'Size'), h('th', null, 'Modified')),
      rows.map((e, i) => h('tr', {
        class: selected.has(e.name) ? 'sel' : '',
        onclick: (ev) => {
          if (e.up) return;
          if (ev.shiftKey && anchor != null) {
            const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
            if (!ev.ctrlKey && !ev.metaKey) selected.clear();
            rows.slice(a, b + 1).forEach((r) => { if (!r.up) selected.add(r.name); });
          } else if (ev.ctrlKey || ev.metaKey) { selected.has(e.name) ? selected.delete(e.name) : selected.add(e.name); anchor = i; } else { selected = new Set([e.name]); anchor = i; }
          render();
        },
        ondblclick: () => (e.up ? load(parent(cur.path)) : e.type === 'dir' ? load(join(cur.path, e.name)) : download([e])),
      },
      h('td', null, h('span', { class: 'ficon' }, e.type === 'dir' ? '📁' : '📄'), e.name),
      h('td', { class: 'mono', style: { textAlign: 'right' } }, e.type === 'file' ? fmtSize(e.size) : ''),
      h('td', { class: 'muted' }, e.mtime ? fmtTime(e.mtime) : '')))));
    status.textContent = selected.size ? `${selected.size} selected` : `${cur.entries.length} items`;
  }

  async function download(entries) {
    if (!entries.length) { toast('Select files or folders first'); return; }
    const j = job(`Downloading ${entries.length === 1 ? entries[0].name : entries.length + ' items'}`);
    try {
      const r = await call('filesDownload', projectId, entries.map((e) => ({ path: join(cur.path, e.name), type: e.type, size: e.size })), j.jobId);
      if (r) {
        const t = toast(`Downloaded to ${r.saved.length === 1 ? r.saved[0] : base(r.saved[0].replace(/[\\/][^\\/]*$/, ''))} — click to show`, { ms: 8000 });
        t.style.cursor = 'pointer';
        t.onclick = () => call('showInFolder', r.saved[0]);
      }
    } catch (e) { toast('Download failed: ' + e.message, { error: true, ms: 10000 }); } finally { j.finish(); }
  }

  const doUpload = async (paths) => { if (paths.length && (await upload(projectId, paths, cur.path, cur.path))) load(cur.path); };

  // Drop files from the Explorer / Finder onto the list to upload them here.
  const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  list.addEventListener('dragover', (e) => { if (!isFiles(e)) return; e.preventDefault(); list.classList.add('drop-files'); });
  list.addEventListener('dragleave', (e) => { if (!list.contains(e.relatedTarget)) list.classList.remove('drop-files'); });
  list.addEventListener('drop', (e) => {
    list.classList.remove('drop-files');
    if (!isFiles(e)) return;
    e.preventDefault();
    doUpload([...e.dataTransfer.files].map((f) => window.termclaw.pathForFile(f)).filter(Boolean));
  });

  const btn = (label, title, onclick) => h('button', { title, onclick }, label);
  modal({
    title: `Files — ${p ? p.name : ''}${onHost ? ' · ' + onHost.name : ''}`,
    width: '860px',
    body: h('div', { class: 'file-browser' },
      h('div', { class: 'row' },
        btn('↑', 'Parent folder', () => load(parent(cur.path))),
        btn('⌂', onHost ? 'Workspace folder of the host' : 'Project folder', () => load('')),
        pathInput,
        btn('⟳', 'Refresh', () => load(cur.path))),
      list,
      h('div', { class: 'row' },
        btn('Download', 'Download the selected files and folders to this computer', () => download(cur.entries.filter((e) => selected.has(e.name)))),
        btn('Upload…', 'Upload files from this computer into this folder (or drop them onto the list)', async () => doUpload(await call('filesPickUpload'))),
        btn('New folder…', 'Create a folder here', async () => {
          const name = await prompt('New folder');
          if (!name) return;
          try { await call('filesMkdir', projectId, cur.path, name); load(cur.path); } catch (e) { toast(e.message, { error: true }); }
        }),
        h('div', { class: 'spacer' }),
        status)),
    okText: null,
    cancelText: 'Close',
  });
  load(dir || '');
}
