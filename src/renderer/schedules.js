// Scheduled prompts: a prompt sent to a session or an orchestrator at set times.
import { h, clear, toast, modal, field, confirmDialog, fmtTime, timeAgo } from './ui.js';

const DAYS = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['0', 'Sun']];
const OUTCOME = { sent: 'ok', skipped: 'warn', failed: 'bad' };
const pad = (n) => String(n).padStart(2, '0');

// Cron expression → the form's fields; anything the form cannot show stays a cron expression.
function toForm(cron) {
  const p = String(cron || '').trim().split(/\s+/);
  const num = (s) => /^\d+$/.test(s);
  if (p.length === 5 && p[2] === '*' && p[3] === '*' && num(p[0])) {
    if (p[1] === '*' && p[4] === '*') return { kind: 'hourly', minute: Number(p[0]) };
    if (num(p[1])) {
      const time = `${pad(p[1])}:${pad(p[0])}`;
      if (p[4] === '*') return { kind: 'daily', time };
      if (p[4] === '1-5') return { kind: 'weekdays', time };
      if (/^[0-7](,[0-7])*$/.test(p[4])) return { kind: 'weekly', time, days: p[4].split(',').map((d) => String(d % 7)) };
    }
  }
  return { kind: 'cron', cron: cron || '' };
}

function fromForm(f) {
  const [hh, mm] = (f.time || '09:00').split(':').map(Number);
  if (f.kind === 'hourly') return `${Math.max(0, Math.min(59, Number(f.minute) || 0))} * * * *`;
  if (f.kind === 'daily') return `${mm} ${hh} * * *`;
  if (f.kind === 'weekdays') return `${mm} ${hh} * * 1-5`;
  if (f.kind === 'weekly') return `${mm} ${hh} * * ${(f.days && f.days.length ? f.days : ['1']).join(',')}`;
  return String(f.cron || '').trim();
}

const targetValue = (t) => (!t ? '' : t.type === 'orchestrator' ? `o:${t.id}` : `s:${t.projectId}/${t.session}`);
function targetFromValue(v) {
  if (v.startsWith('o:')) return { type: 'orchestrator', id: v.slice(2) };
  const rest = v.slice(2);
  const i = rest.indexOf('/');
  return { type: 'session', projectId: rest.slice(0, i), session: rest.slice(i + 1) };
}

export function renderSchedules(ctx, main) {
  main.appendChild(h('div', { class: 'main-head' },
    h('span', { class: 'title' }, 'Scheduled prompts'),
    h('span', { class: 'muted' }, 'Send a prompt to a session or an orchestrator at set times, while the app is open'),
    h('div', { class: 'spacer' }),
    h('button', { class: 'primary', onclick: () => editSchedule(ctx, null) }, '+ Scheduled prompt')));
  main.appendChild(h('div', { class: 'content' }, h('div', { class: 'page', id: 'sched-page' })));
  renderList(ctx);
}

function lastRun(s) {
  const r = s.runs && s.runs.length ? s.runs[s.runs.length - 1] : null;
  if (s.running) return h('span', { class: 'warn' }, 'running…');
  if (!r) return h('span', { class: 'muted' }, 'never ran');
  return h('span', { title: `${fmtTime(r.at)}${r.detail ? '\n' + r.detail : ''}` },
    h('span', { class: OUTCOME[r.outcome] || '' }, r.outcome), h('span', { class: 'muted' }, ` · ${timeAgo(r.at)} ago${r.detail ? ' · ' + r.detail : ''}`));
}

function renderList(ctx) {
  const { S, call } = ctx;
  const page = document.getElementById('sched-page');
  if (!page) return;
  clear(page);
  const list = S.schedules || [];
  if (!list.length) {
    page.appendChild(h('div', { class: 'empty' },
      h('div', null, 'No scheduled prompts yet.'),
      h('div', { class: 'muted', style: { maxWidth: '560px', textAlign: 'center' } }, 'Examples: every night “update the dependencies and run the tests” to an agent session, every Monday “triage the open issues” to an orchestrator. The prompt is sent when the target is idle; an optional check command can skip a run.'),
      h('button', { class: 'primary', onclick: () => editSchedule(ctx, null) }, '+ Create scheduled prompt')));
    return;
  }
  page.appendChild(h('table', { class: 'list' },
    h('thead', null, h('tr', null, ['On', 'Name', 'Target', 'When', 'Next run', 'Last run', ''].map((t) => h('th', null, t)))),
    h('tbody', null, list.map((s) => h('tr', null,
      h('td', null, h('input', { type: 'checkbox', checked: s.enabled, title: s.enabled ? 'Turn off' : 'Turn on', onchange: (e) => call('schedEnable', s.id, e.target.checked) })),
      h('td', null, h('b', null, s.name), h('div', { class: 'muted sched-prompt', title: s.prompt }, s.prompt)),
      h('td', null, h('span', { class: 'tag' }, s.target && s.target.type === 'orchestrator' ? 'orchestrator' : 'session'), s.targetLabel),
      h('td', null, s.text, s.text !== s.cron ? null : h('span', { class: 'muted' }, ' (cron)')),
      h('td', null, s.enabled && s.nextAt ? fmtTime(s.nextAt) : h('span', { class: 'muted' }, 'off')),
      h('td', { style: { maxWidth: '320px' } }, lastRun(s)),
      h('td', { style: { whiteSpace: 'nowrap' } },
        h('button', { disabled: s.running, title: 'Send the prompt now', onclick: async () => {
          try { const r = await call('schedRun', s.id); toast(`${s.name}: ${r.outcome}${r.detail ? ' — ' + r.detail : ''}`, { error: r.outcome === 'failed' }); } catch (e) { toast(e.message, { error: true }); }
        } }, 'Run now'), ' ',
        h('button', { onclick: () => showRuns(s) }, 'History'), ' ',
        h('button', { onclick: () => editSchedule(ctx, s) }, 'Edit')))))));
}

export function onSchedulesChanged(ctx) {
  if (ctx.S.view === 'sched') renderList(ctx);
}

function showRuns(s) {
  const runs = [...(s.runs || [])].reverse();
  modal({
    title: `History: ${s.name}`,
    width: '640px',
    okText: null,
    cancelText: 'Close',
    body: runs.length ? h('table', { class: 'list' },
      h('thead', null, h('tr', null, ['Time', 'Result', 'Details'].map((t) => h('th', null, t)))),
      h('tbody', null, runs.map((r) => h('tr', null,
        h('td', { class: 'mono' }, fmtTime(r.at)),
        h('td', { class: OUTCOME[r.outcome] || '' }, r.outcome + (r.manual ? ' (manual)' : '')),
        h('td', null, r.detail || ''))))) : h('div', { class: 'muted' }, 'No runs yet. The last 20 runs are kept.'),
  });
}

function editSchedule(ctx, s) {
  const { S, call } = ctx;
  const x = s ? structuredClone(s) : { name: '', enabled: true, cron: '0 9 * * 1-5', prompt: '', target: null, busy: 'wait', busyWaitMin: 30, startIfStopped: false, precheck: '' };
  const f = toForm(x.cron);
  const name = h('input', { value: x.name, placeholder: 'e.g. Nightly dependency update' });
  const prompt = h('textarea', { style: { height: '120px' }, placeholder: 'The prompt that is sent, as you would type it' });
  prompt.value = x.prompt;

  // Targets: running sessions, the terminals configured for "Start all", the saved target, and the orchestrators.
  const sess = new Map();
  for (const v of S.sessions.values()) if (!v.shell) sess.set(`s:${v.projectId}/${v.name}`, v.kind);
  for (const p of S.config.projects) for (const t of p.terminals || []) if (t.name && !sess.has(`s:${p.id}/${t.name}`)) sess.set(`s:${p.id}/${t.name}`, null);
  const cur = targetValue(x.target);
  if (cur.startsWith('s:') && !sess.has(cur)) sess.set(cur, null);
  const label = (v) => { const t = targetFromValue(v); const p = ctx.project(t.projectId); return `${p ? p.name : '?'} / ${t.session}`; };
  const target = h('select', null,
    h('option', { value: '' }, 'Choose…'),
    h('optgroup', { label: 'Sessions' }, [...sess.entries()].map(([v, kind]) => h('option', { value: v, selected: v === cur }, label(v) + (kind === null ? ' (not open)' : kind !== 'terminal' ? ' (agent)' : '')))),
    h('optgroup', { label: 'Orchestrators' }, S.orchestrators.map((o) => h('option', { value: `o:${o.id}`, selected: `o:${o.id}` === cur }, o.name))));

  const kind = h('select', null, [['hourly', 'Every hour'], ['daily', 'Every day'], ['weekdays', 'Monday to Friday'], ['weekly', 'On these days'], ['cron', 'Cron expression']].map(([v, l]) => h('option', { value: v, selected: f.kind === v }, l)));
  const time = h('input', { type: 'time', value: f.time || '09:00', style: { width: '110px' } });
  const minute = h('input', { type: 'number', min: 0, max: 59, value: f.minute ?? 0, style: { width: '70px' } });
  const days = h('span', { class: 'row' }, DAYS.map(([v, l]) => h('label', { class: 'row' }, h('input', { type: 'checkbox', 'data-day': v, checked: (f.days || ['1']).includes(v) }), l)));
  const cron = h('input', { value: f.kind === 'cron' ? f.cron : x.cron, placeholder: 'minute hour day month weekday, e.g. 30 2 * * 1-5', class: 'mono' });
  const minuteRow = h('span', { class: 'row' }, 'at minute', minute);
  const timeRow = h('span', { class: 'row' }, 'at', time);
  const preview = h('div', { class: 'hint' });
  const form = () => ({ kind: kind.value, time: time.value, minute: minute.value, days: [...days.querySelectorAll('input')].filter((c) => c.checked).map((c) => c.dataset.day), cron: cron.value });
  let seq = 0;
  const update = async () => {
    const k = kind.value;
    minuteRow.style.display = k === 'hourly' ? '' : 'none';
    timeRow.style.display = ['daily', 'weekdays', 'weekly'].includes(k) ? '' : 'none';
    days.style.display = k === 'weekly' ? '' : 'none';
    cron.style.display = k === 'cron' ? '' : 'none';
    const mine = ++seq;
    let text;
    let bad = false;
    try {
      const r = await call('schedPreview', fromForm(form()));
      text = r.nextAt ? `${r.text} · next run ${fmtTime(r.nextAt)} (local time)` : 'This time never comes';
    } catch (e) {
      bad = true;
      text = e.message.replace(/^Error invoking remote method 'api': Error: /, '');
    }
    if (mine !== seq) return; // a newer input already asked again
    preview.className = bad ? 'hint bad' : 'hint';
    preview.textContent = text;
  };
  for (const el of [kind, time, minute, cron]) el.addEventListener('input', update);
  days.addEventListener('change', update);

  const busy = h('select', null, [['wait', 'Wait until it is idle, then send'], ['skip', 'Skip this run'], ['send', 'Send anyway']].map(([v, l]) => h('option', { value: v, selected: x.busy === v }, l)));
  const busyWait = h('input', { type: 'number', min: 1, max: 720, value: x.busyWaitMin || 30, style: { width: '70px' } });
  const busyWaitRow = h('span', { class: 'row' }, 'for at most', busyWait, 'min');
  busy.addEventListener('change', () => { busyWaitRow.style.display = busy.value === 'wait' ? '' : 'none'; });
  busyWaitRow.style.display = x.busy === 'wait' ? '' : 'none';
  const startIt = h('input', { type: 'checkbox', checked: !!x.startIfStopped });
  const precheck = h('input', { value: x.precheck || '', placeholder: 'optional, e.g. test -n "$(git -C ~/app status --porcelain)"', class: 'mono' });
  const precheckRows = field('Only if', precheck, 'A command on the project’s machine, run before each time. The prompt is only sent when it ends with exit code 0.');
  const enabled = h('input', { type: 'checkbox', checked: x.enabled !== false });
  const syncTarget = () => { const orch = target.value.startsWith('o:'); for (const el of precheckRows) if (el) el.style.display = orch ? 'none' : ''; };
  target.addEventListener('change', syncTarget);

  modal({
    title: s ? 'Edit scheduled prompt' : 'New scheduled prompt',
    width: '760px',
    body: h('div', { class: 'form' },
      field('Name', name),
      field('Send to', target, 'A terminal gets the prompt typed in with Enter; agent sessions and orchestrators get it as a message.'),
      field('Prompt', prompt),
      field('When', h('div', { class: 'row', style: { flexWrap: 'wrap' } }, kind, minuteRow, timeRow, days, cron)),
      preview,
      field('If it is busy', h('div', { class: 'row' }, busy, busyWaitRow)),
      field('Not running', h('label', { class: 'row' }, startIt, 'Start the session or orchestrator first (a session opens with its configured start command)')),
      ...precheckRows,
      field('Active', h('label', { class: 'row' }, enabled, 'Run at the set times'))),
    extraButtons: s ? [h('button', { class: 'danger', onclick: async () => {
      if (await confirmDialog('Delete scheduled prompt', `Delete “${s.name}”?`, 'Delete')) { await call('schedRemove', s.id); document.querySelector('.modal-bg')?.remove(); }
    } }, 'Delete')] : [],
    onOk: async () => {
      if (!target.value) throw new Error('Choose where the prompt goes');
      await call('schedSave', {
        id: x.id, name: name.value, enabled: enabled.checked, cron: fromForm(form()), prompt: prompt.value, target: targetFromValue(target.value),
        busy: busy.value, busyWaitMin: Number(busyWait.value) || 30, startIfStopped: startIt.checked, precheck: precheck.value,
      });
    },
  });
  syncTarget();
  update();
}
