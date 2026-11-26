// Monitor tab of a project: basic information, CPU, memory, disk and network I/O, disk usage per mount
// point and the running programs of a Linux machine. The main process samples /proc while this tab is
// visible and sends a snapshot every couple of seconds; rates and histories are drawn here.
import { h, clear, toast } from './ui.js';
import { fmtSize } from './files.js';

const call = (m, ...a) => window.termclaw.call(m, ...a);
const HIST = 60; // samples kept for the charts (2 s apart = 2 minutes)

const snaps = new Map(); // projectId -> snapshot
const hist = new Map(); // projectId -> { cpu, mem, dr, dw, rx, tx }
function loadLimit(key, allowed, def) {
  try {
    const raw = localStorage.getItem('monLimit:' + key) ?? (key === 'procs' ? localStorage.getItem('monProcLimit') : null);
    if (raw != null && raw !== '') {
      const n = Number(raw);
      if (allowed.includes(n)) return n;
    }
  } catch {}
  return def;
}
const view = {
  filters: { mounts: '', disks: '', net: '', procs: '' },
  sorts: {
    mounts: { key: 'pct', dir: -1 },
    disks: { key: 'util', dir: -1 },
    net: { key: 'rxBps', dir: -1 },
    procs: { key: 'cpu', dir: -1 },
  },
  allMounts: false,
  limits: {
    mounts: loadLimit('mounts', [5, 10, 20, 0], 10),
    disks: loadLimit('disks', [5, 10, 20, 0], 10),
    net: loadLimit('net', [5, 10, 20, 0], 10),
    procs: loadLimit('procs', [10, 20, 50, 100, 0], 20),
  },
};
let mounted = null; // { ctx, projectId, root }

window.termclaw.on('monitor:update', ({ projectId, snap }) => {
  snaps.set(projectId, snap);
  if (snap.ok && snap.cpu && snap.cpu.total != null) {
    const hs = hist.get(projectId) || { cpu: [], mem: [], dr: [], dw: [], rx: [], tx: [] };
    const sum = (l, k) => l.reduce((a, x) => a + (x[k] || 0), 0);
    const push = (a, v) => { a.push(v); if (a.length > HIST) a.shift(); };
    push(hs.cpu, snap.cpu.total);
    push(hs.mem, snap.mem.total ? ((snap.mem.total - snap.mem.available) / snap.mem.total) * 100 : 0);
    push(hs.dr, sum(snap.disks, 'readBps'));
    push(hs.dw, sum(snap.disks, 'writeBps'));
    push(hs.rx, sum(snap.net, 'rxBps'));
    push(hs.tx, sum(snap.net, 'txBps'));
    hist.set(projectId, hs);
  }
  draw();
});

export function mount(ctx, el, projectId) {
  if (mounted && mounted.projectId !== projectId) call('monitorUnwatch', mounted.projectId);
  const watching = mounted && mounted.projectId === projectId;
  mounted = { ctx, projectId, root: h('div', { class: 'monitor' }) };
  el.appendChild(mounted.root);
  if (!watching) call('monitorWatch', projectId).then((snap) => { if (!snaps.has(projectId) || !snaps.get(projectId).updatedAt) snaps.set(projectId, snap); draw(); }).catch((e) => toast(e.message, { error: true }));
  draw();
}

// Called when the project view no longer shows the Monitor tab.
export function unmount() {
  if (!mounted) return;
  call('monitorUnwatch', mounted.projectId);
  mounted = null;
}
export const mountedProject = () => (mounted ? mounted.projectId : null);

// ---------- formatting ----------

const pct = (v) => (v == null ? '–' : v < 10 ? v.toFixed(1) + '%' : Math.round(v) + '%');
const rate = (v) => (v == null ? '–' : fmtSize(Math.round(v)) + '/s');
const level = (v) => (v > 90 ? 'bad' : v > 75 ? 'warn' : '');

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const hrs = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} d ${hrs} h` : hrs ? `${hrs} h ${m} min` : `${m} min`;
}

// Line chart of the last samples; max fixes the scale (100 for percentages), otherwise it follows the data.
function spark(values, { w = 200, hgt = 34, max, cls = '' } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  svg.setAttribute('class', 'dk-spark mon-spark ' + cls);
  svg.setAttribute('preserveAspectRatio', 'none');
  if (values.length > 1) {
    const top = max || Math.max(1, ...values);
    const x = (i) => (i / (HIST - 1)) * w + (HIST - values.length) * (w / (HIST - 1));
    const pts = values.map((v, i) => [x(i), hgt - 1 - (Math.min(v, top) / top) * (hgt - 2)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const area = document.createElementNS(ns, 'path');
    area.setAttribute('d', `${line} L${pts[pts.length - 1][0].toFixed(1)} ${hgt} L${pts[0][0].toFixed(1)} ${hgt} Z`);
    area.setAttribute('class', 'area');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', line);
    path.setAttribute('class', 'line');
    svg.append(area, path);
  }
  return svg;
}

const bar = (value, total, cls) => h('div', { class: 'dk-bar' }, h('span', { class: cls || level(total ? (value / total) * 100 : 0), style: { width: total ? Math.min(100, (value / total) * 100) + '%' : '0' } }));

function card(title, big, sub, ...extra) {
  return h('div', { class: 'dk-card' }, h('div', { class: 'dk-card-title' }, title), h('div', { class: 'dk-big' }, big), h('div', { class: 'dk-sub' }, sub), ...extra);
}

// ---------- drawing ----------

function sortTh(tableKey, label, key, firstDir = -1, cls = '') {
  const cur = view.sorts[tableKey];
  const active = cur.key === key;
  return h('th', {
    class: (cls ? cls + ' ' : '') + 'dk-sortable' + (active ? ' sorted' : ''),
    title: 'Sort by ' + label.toLowerCase(),
    onclick: () => { view.sorts[tableKey] = active ? { key, dir: -cur.dir } : { key, dir: firstDir }; draw(); },
  }, label, h('span', { class: 'dk-arrow' }, active ? (cur.dir > 0 ? ' ▲' : ' ▼') : ''));
}

function sortBy(list, tableKey, getters, tieBreak) {
  const { key, dir } = view.sorts[tableKey];
  const get = getters[key] || Object.values(getters)[0];
  return [...list].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1;
    const d = typeof x === 'number' && typeof y === 'number'
      ? x - y
      : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
    return d * dir || tieBreak(a, b);
  });
}

function filterInput(tableKey, placeholder, cls = 'mon-filter-sm') {
  return h('input', {
    class: 'mon-filter ' + cls,
    'data-filter': tableKey,
    placeholder,
    value: view.filters[tableKey] || '',
    oninput: (e) => { view.filters[tableKey] = e.target.value; draw(); },
  });
}

function panel(title, body, right = null) {
  return h('section', { class: 'mon-panel' },
    h('div', { class: 'mon-panel-head' }, h('span', { class: 'mon-panel-title' }, title), right),
    h('div', { class: 'mon-panel-body' }, body));
}

function draw() {
  if (!mounted || !mounted.root.isConnected) return;
  const { ctx, projectId, root } = mounted;
  const p = ctx.project(projectId);
  const snap = snaps.get(projectId);
  const scroll = root.scrollTop;
  const focus = document.activeElement && document.activeElement.classList.contains('mon-filter') ? document.activeElement : null;
  const focusKey = focus ? focus.dataset.filter : null;
  const caret = focus ? [focus.selectionStart, focus.selectionEnd] : null;
  clear(root);
  if (!p) return;
  const where = p.type === 'ssh' ? (ctx.S.config.hosts.find((x) => x.id === p.hostId) || {}).name || p.host : p.type === 'wsl' ? `WSL ${p.wslDistro || ''}`.trim() : 'this computer';
  if (!snap || (snap.loading && !snap.ok)) {
    root.appendChild(h('div', { class: 'empty' }, h('div', null, `Connecting to ${where}…`)));
    return;
  }
  if (!snap.ok) {
    root.appendChild(h('div', { class: 'card dk-error' },
      h('div', { class: 'bad', style: { fontWeight: 600, marginBottom: '6px' } }, `Cannot monitor ${where}`),
      h('div', { class: 'mono', style: { whiteSpace: 'pre-wrap', marginBottom: '8px' } }, snap.error),
      h('button', { onclick: () => call('monitorRefresh', projectId).then((s) => { snaps.set(projectId, { ...s, loading: true }); draw(); }).catch((e) => toast(e.message, { error: true })) }, 'Retry')));
    return;
  }
  const hs = hist.get(projectId) || { cpu: [], mem: [], dr: [], dw: [], rx: [], tx: [] };
  const { info, cpu, mem } = snap;
  const memUsed = mem.total - mem.available;
  const memCache = (mem.cached || 0) + (mem.buffers || 0);
  const memRatio = mem.total ? (memUsed / mem.total) * 100 : 0;
  const sum = (l, k) => l.reduce((a, x) => a + (x[k] || 0), 0);

  // Header
  root.appendChild(h('div', { class: 'dk-head mon-head' },
    h('span', { class: 'dot waiting', title: 'Live updates every 2 s' }),
    h('span', { class: 'title' }, info.hostname || where),
    h('span', { class: 'tag' }, where),
    info.os ? h('span', { class: 'muted' }, info.os) : null,
    info.uptime ? h('span', { class: 'muted' }, `· up ${fmtUptime(info.uptime)}`) : null,
    h('span', { style: { flex: 1 } }),
    h('span', { class: 'muted mono', style: { fontSize: '11px' } }, `updated ${new Date(snap.updatedAt).toLocaleTimeString()}`),
    h('button', { class: 'icon', title: 'Refresh now', onclick: () => call('monitorRefresh', projectId).catch((e) => toast(e.message, { error: true })) }, '⟳')));

  // Top KPI cards: CPU, Memory, Disk I/O, Network I/O
  const loadTxt = info.load ? info.load.map((x) => x.toFixed(2)).join('  ') : '–';
  const memStacked = h('div', { class: 'dk-bar' },
    h('span', { class: level(memRatio) || 'mem', style: { width: mem.total ? Math.min(100, (memUsed / mem.total) * 100) + '%' : '0' }, title: `Used ${fmtSize(memUsed)}` }),
    h('span', { class: 'mem-other', style: { width: mem.total ? Math.min(100 - Math.min(100, (memUsed / mem.total) * 100), (memCache / mem.total) * 100) + '%' : '0' }, title: `Cache/Buffers ${fmtSize(memCache)}` }));
  root.appendChild(h('div', { class: 'dk-cards' },
    card('CPU', h('span', { class: level(cpu.total || 0) }, pct(cpu.total)),
      `user ${pct(cpu.user)} · sys ${pct(cpu.system)} · iowait ${pct(cpu.iowait)}${cpu.steal ? ` · steal ${pct(cpu.steal)}` : ''}`,
      spark(hs.cpu, { max: 100 }),
      h('div', { class: 'mon-cores' }, cpu.cores.map((c, i) => h('div', { class: 'mon-core', title: `cpu${i}: ${pct(c)}` }, h('span', { class: level(c || 0), style: { height: Math.max(2, c || 0) + '%' } }))))),
    card('Memory', h('span', { class: level(memRatio) }, pct(memRatio)),
      `${fmtSize(memUsed)} / ${fmtSize(mem.total)} · cache ${fmtSize(memCache)}`,
      spark(hs.mem, { max: 100, cls: 'mem' }),
      memStacked,
      h('div', { class: 'dk-sub' }, mem.swapTotal ? `swap ${fmtSize(mem.swapUsed)} / ${fmtSize(mem.swapTotal)}` : 'no swap')),
    card('Disk I/O', rate(sum(snap.disks, 'readBps') + sum(snap.disks, 'writeBps')),
      `read ${rate(sum(snap.disks, 'readBps'))} · write ${rate(sum(snap.disks, 'writeBps'))}`,
      spark(hs.dr.map((v, i) => v + (hs.dw[i] || 0)), { cls: 'io' })),
    card('Network I/O', rate(sum(snap.net, 'rxBps') + sum(snap.net, 'txBps')),
      `in ${rate(sum(snap.net, 'rxBps'))} · out ${rate(sum(snap.net, 'txBps'))}`,
      spark(hs.rx.map((v, i) => v + (hs.tx[i] || 0)), { cls: 'net' }))));

  // System information as a compact 3-column grid inside a full-width card
  const infoRows = [
    ['Host', info.hostname],
    ['System', info.os],
    ['Kernel', info.kernel],
    ['Architecture', info.arch],
    ['CPU', info.cpuModel ? `${info.cpuModel}${info.cores ? ` (${info.cores} logical cores)` : ''}` : info.cores ? `${info.cores} logical cores` : ''],
    ['Uptime', fmtUptime(info.uptime)],
    ['Load average', `${loadTxt}  (1 / 5 / 15 min)`],
    ['Tasks', `${snap.procs.total} processes${info.running ? ` · ${info.running[0]} running of ${info.running[1]} threads` : ''}`],
    ['Logged in as', info.user],
  ].filter(([, v]) => v);
  const sysPanel = panel('System information', h('div', { class: 'mon-sys-grid' },
    infoRows.map(([k, v]) => h('div', { class: 'mon-sys-item' },
      h('span', { class: 'mon-sys-k' }, k),
      h('span', { class: 'mon-sys-v mono', title: v }, v)))));

  const countLabel = (shown, total) => (shown < total ? `${shown} of ${total}` : `${total}`);
  const limitSel = (key, choices, label) => h('select', {
    class: 'mon-limit',
    title: `Number of ${label} shown`,
    onchange: (e) => {
      view.limits[key] = Number(e.target.value) || 0;
      try { localStorage.setItem('monLimit:' + key, String(view.limits[key])); } catch {}
      draw();
    },
  }, ...choices.map((n) => h('option', { value: n, selected: view.limits[key] === n }, n ? `Top ${n}` : 'All')));
  const sliceLimit = (arr, key) => (view.limits[key] > 0 ? arr.slice(0, view.limits[key]) : arr);

  // Disk usage per mount point (filterable, sortable & limited)
  const mq = view.filters.mounts.trim().toLowerCase();
  const baseMounts = snap.mounts.filter((m) => view.allMounts || !/^(\/boot|\/snap|\/var\/lib\/(docker|containers|snapd))(\/|$)/.test(m.mount));
  const mountsMatched = sortBy(
    baseMounts.filter((m) => !mq || m.mount.toLowerCase().includes(mq) || m.fs.toLowerCase().includes(mq) || m.type.toLowerCase().includes(mq)),
    'mounts',
    { mount: (m) => m.mount, fs: (m) => m.fs, type: (m) => m.type, total: (m) => m.total, used: (m) => m.used, free: (m) => m.free, pct: (m) => m.pct },
    (a, b) => a.mount.localeCompare(b.mount),
  );
  const mounts = sliceLimit(mountsMatched, 'mounts');
  const mountsPanel = panel(baseMounts.length ? `Disk usage (${countLabel(mounts.length, baseMounts.length)})` : 'Disk usage', mounts.length
    ? h('table', { class: 'mon-table' },
      h('thead', null, h('tr', null,
        sortTh('mounts', 'Mount point', 'mount', 1), sortTh('mounts', 'Volume', 'fs', 1), sortTh('mounts', 'Type', 'type', 1),
        sortTh('mounts', 'Size', 'total', -1, 'num'), sortTh('mounts', 'Used', 'used', -1, 'num'), sortTh('mounts', 'Free', 'free', -1, 'num'),
        sortTh('mounts', 'Use', 'pct', -1))),
      h('tbody', null, mounts.map((m) => h('tr', null,
        h('td', { class: 'mono' }, m.mount), h('td', { class: 'mono muted' }, m.fs), h('td', { class: 'muted' }, m.type),
        h('td', { class: 'num' }, fmtSize(m.total)), h('td', { class: 'num' }, fmtSize(m.used)), h('td', { class: 'num' }, fmtSize(m.free)),
        h('td', { class: 'mon-use' }, h('div', { class: 'row' }, h('span', { class: 'mon-pct ' + level(m.pct) }, m.pct + '%'), bar(m.used, m.total, level(m.pct))))))))
    : h('div', { class: 'mon-empty muted' }, baseMounts.length ? 'No mount matches.' : 'Reading mounts…'),
  h('div', { class: 'row', style: { gap: '8px' } },
    h('label', { class: 'row mon-opt' }, h('input', { type: 'checkbox', checked: view.allMounts, onchange: (e) => { view.allMounts = e.target.checked; draw(); } }), 'Show all'),
    limitSel('mounts', [5, 10, 20, 0], 'mounts'),
    filterInput('mounts', 'Filter mounts…')));

  // Disk I/O (filterable, sortable & limited)
  const dq = view.filters.disks.trim().toLowerCase();
  const disksMatched = sortBy(
    snap.disks.filter((d) => !dq || d.name.toLowerCase().includes(dq)),
    'disks',
    { name: (d) => d.name, readBps: (d) => d.readBps, writeBps: (d) => d.writeBps, readIops: (d) => d.readIops, writeIops: (d) => d.writeIops, util: (d) => d.util },
    (a, b) => a.name.localeCompare(b.name),
  );
  const disks = sliceLimit(disksMatched, 'disks');
  const diskIoPanel = panel(snap.disks.length ? `Disk I/O (${countLabel(disks.length, snap.disks.length)})` : 'Disk I/O', disks.length
    ? h('table', { class: 'mon-table' },
      h('thead', null, h('tr', null,
        sortTh('disks', 'Device', 'name', 1), sortTh('disks', 'Read', 'readBps', -1, 'num'), sortTh('disks', 'Write', 'writeBps', -1, 'num'),
        sortTh('disks', 'R IOPS', 'readIops', -1, 'num'), sortTh('disks', 'W IOPS', 'writeIops', -1, 'num'), sortTh('disks', 'Busy', 'util', -1, 'num'))),
      h('tbody', null, disks.map((d) => h('tr', null,
        h('td', { class: 'mono' }, d.name), h('td', { class: 'num' }, rate(d.readBps)), h('td', { class: 'num' }, rate(d.writeBps)),
        h('td', { class: 'num muted' }, d.readIops == null ? '–' : Math.round(d.readIops)), h('td', { class: 'num muted' }, d.writeIops == null ? '–' : Math.round(d.writeIops)),
        h('td', { class: 'mon-use' }, h('div', { class: 'row' }, h('span', { class: 'mon-pct ' + level(d.util || 0) }, pct(d.util)), bar(d.util || 0, 100, level(d.util || 0))))))))
    : h('div', { class: 'mon-empty muted' }, snap.disks.length ? 'No device matches.' : 'No block devices reported by this machine.'),
  h('div', { class: 'row', style: { gap: '6px' } },
    limitSel('disks', [5, 10, 20, 0], 'devices'),
    filterInput('disks', 'Filter devices…')));

  // Network I/O (filterable, sortable & limited)
  const nq = view.filters.net.trim().toLowerCase();
  const netsMatched = sortBy(
    snap.net.filter((n) => !nq || n.name.toLowerCase().includes(nq)),
    'net',
    { name: (n) => n.name, rxBps: (n) => n.rxBps, txBps: (n) => n.txBps, rxTotal: (n) => n.rxTotal, txTotal: (n) => n.txTotal },
    (a, b) => a.name.localeCompare(b.name),
  );
  const nets = sliceLimit(netsMatched, 'net');
  const netIoPanel = panel(snap.net.length ? `Network I/O (${countLabel(nets.length, snap.net.length)})` : 'Network I/O', nets.length
    ? h('table', { class: 'mon-table' },
      h('thead', null, h('tr', null,
        sortTh('net', 'Interface', 'name', 1), sortTh('net', 'In', 'rxBps', -1, 'num'), sortTh('net', 'Out', 'txBps', -1, 'num'),
        sortTh('net', 'Rx total', 'rxTotal', -1, 'num'), sortTh('net', 'Tx total', 'txTotal', -1, 'num'))),
      h('tbody', null, nets.map((n) => h('tr', null,
        h('td', { class: 'mono' }, n.name), h('td', { class: 'num' }, rate(n.rxBps)), h('td', { class: 'num' }, rate(n.txBps)),
        h('td', { class: 'num muted' }, fmtSize(n.rxTotal)), h('td', { class: 'num muted' }, fmtSize(n.txTotal))))))
    : h('div', { class: 'mon-empty muted' }, snap.net.length ? 'No interface matches.' : 'No network interfaces.'),
  h('div', { class: 'row', style: { gap: '6px' } },
    limitSel('net', [5, 10, 20, 0], 'interfaces'),
    filterInput('net', 'Filter interfaces…')));

  // Programs (limit + filter + sort)
  const pq = view.filters.procs.trim().toLowerCase();
  const matched = sortBy(
    snap.procs.list.filter((r) => !pq || r.cmd.toLowerCase().includes(pq) || r.user.toLowerCase().includes(pq) || String(r.pid) === pq),
    'procs',
    { pid: (r) => r.pid, user: (r) => r.user, cpu: (r) => r.cpu, mem: (r) => r.mem, threads: (r) => r.threads, cmd: (r) => r.cmd },
    (a, b) => a.pid - b.pid,
  );
  const rows = sliceLimit(matched, 'procs');
  const procsPanel = panel(`Programs (${countLabel(rows.length, snap.procs.total)})`,
    rows.length
      ? h('table', { class: 'mon-table mon-procs' },
        h('thead', null, h('tr', null,
          sortTh('procs', 'PID', 'pid', 1), sortTh('procs', 'User', 'user', 1), sortTh('procs', 'CPU', 'cpu', -1, 'num'),
          sortTh('procs', 'Memory', 'mem', -1, 'num'), sortTh('procs', 'Threads', 'threads', -1, 'num'), sortTh('procs', 'Command', 'cmd', 1))),
        h('tbody', null, rows.map((r) => h('tr', { class: r.state === 'Z' ? 'dk-stopped' : '' },
          h('td', { class: 'mono muted' }, r.pid),
          h('td', { class: 'muted' }, r.user),
          h('td', { class: 'num ' + level(r.cpu || 0) }, pct(r.cpu)),
          h('td', { class: 'num ' + level(r.memPct || 0), title: r.memPct == null ? '' : pct(r.memPct) + ' of memory' }, fmtSize(r.mem)),
          h('td', { class: 'num muted' }, r.threads || ''),
          h('td', { class: 'mono mon-cmd', title: r.cmd }, r.cmd)))))
      : h('div', { class: 'mon-empty muted' }, 'No program matches.'),
    h('div', { class: 'row', style: { gap: '6px' } }, limitSel('procs', [10, 20, 50, 100, 0], 'processes'), filterInput('procs', 'Filter by command, user or PID…', 'mon-filter-lg')));

  root.append(sysPanel, mountsPanel, diskIoPanel, netIoPanel, procsPanel);

  root.scrollTop = scroll;
  if (focusKey) { const n = root.querySelector(`.mon-filter[data-filter="${focusKey}"]`); if (n) { n.focus(); try { n.setSelectionRange(caret[0], caret[1]); } catch {} } }
}
