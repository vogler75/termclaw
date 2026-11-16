'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseCron, nextRun, describeCron } = require('../src/main/cron');
const { ScheduleManager, terminalText } = require('../src/main/schedules');

const at = (...a) => new Date(...a);

test('cron: next run in local time for the common shapes', () => {
  const from = at(2026, 10, 16, 7, 30, 20); // Monday 16 November 2026, 07:30:20
  assert.deepStrictEqual(nextRun('0 * * * *', from), at(2026, 10, 16, 8, 0));
  assert.deepStrictEqual(nextRun('30 7 * * *', from), at(2026, 10, 17, 7, 30)); // the minute that is running does not count
  assert.deepStrictEqual(nextRun('31 7 * * *', from), at(2026, 10, 16, 7, 31));
  assert.deepStrictEqual(nextRun('0 9 * * 1-5', at(2026, 10, 20, 10, 0)), at(2026, 10, 23, 9, 0)); // Friday 10:00 → Monday
  assert.deepStrictEqual(nextRun('15 8 * * 3,0', from), at(2026, 10, 18, 8, 15)); // Wednesday
  assert.deepStrictEqual(nextRun('0 6 * * 7', from), at(2026, 10, 22, 6, 0)); // 7 = Sunday
  assert.deepStrictEqual(nextRun('*/15 * * * *', from), at(2026, 10, 16, 7, 45));
  assert.deepStrictEqual(nextRun('0 0 1 1 *', from), at(2027, 0, 1, 0, 0));
  assert.deepStrictEqual(nextRun('5/20 8-9 * * *', from), at(2026, 10, 16, 8, 5));
});

test('cron: day of month and day of week together match either one', () => {
  // the 1st of a month or any Monday
  assert.deepStrictEqual(nextRun('0 0 1 * 1', at(2026, 10, 24, 12, 0)), at(2026, 10, 30, 0, 0)); // Monday 30 November
  assert.deepStrictEqual(nextRun('0 0 1 * 1', at(2026, 10, 30, 12, 0)), at(2026, 11, 1, 0, 0)); // Tuesday 1 December
});

test('cron: errors and times that never come', () => {
  assert.throws(() => parseCron('* * * *'), /five fields/);
  assert.throws(() => parseCron('61 * * * *'), /minute must be 0–59/);
  assert.throws(() => parseCron('a * * * *'), /not a valid minute/);
  assert.throws(() => parseCron('*/0 * * * *'), /step 0/);
  assert.throws(() => parseCron('0 0 * * 8'), /day of week/);
  assert.strictEqual(nextRun('0 0 31 2 *', at(2026, 0, 1)), null);
});

test('cron: description', () => {
  assert.strictEqual(describeCron('5 * * * *'), 'every hour at :05');
  assert.strictEqual(describeCron('30 2 * * *'), 'every day at 02:30');
  assert.strictEqual(describeCron('0 9 * * 1-5'), 'weekdays at 09:00');
  assert.strictEqual(describeCron('0 9 * * 1,4'), 'Mon, Thu at 09:00');
  assert.strictEqual(describeCron('0 9 1 * *'), '0 9 1 * *');
});

test('terminal text: several lines are one bracketed paste, or joined when the program did not ask for it', () => {
  assert.strictEqual(terminalText({}, 'one line'), 'one line');
  assert.strictEqual(terminalText({ headless: { modes: { bracketedPasteMode: true } } }, 'a\nb'), '\x1b[200~a\rb\x1b[201~');
  assert.strictEqual(terminalText({ headless: { modes: { bracketedPasteMode: false } } }, 'a\n\n b \n'), 'a b');
});

// ---- manager with fakes ----
function setup({ sessions = [], orch = {}, precheck } = {}) {
  const store = { data: { schedules: [] }, saved: 0, save() { this.saved++; }, getProject: (id) => (id === 'p1' ? { id: 'p1', name: 'App', terminals: [{ name: 'nightly', command: 'claude', kind: 'terminal' }] } : null), getHost: () => null };
  const sm = {
    all: sessions,
    opened: [],
    list(pid) { return this.all.filter((s) => s.projectId === pid); },
    open(pid, o) { const s = fakeSession(o.name, 'starting'); this.all.push(s); this.opened.push(o); setTimeout(() => { s.status = 'waiting'; }, 15); return s; },
    reconnect(id) { const s = this.all.find((x) => x.id === id); setTimeout(() => { s.status = 'waiting'; }, 15); },
  };
  const om = {
    o: { id: 'o1', name: 'Nightly', state: 'idle', busy: false, ...orch },
    sent: [],
    get(id) { return id === 'o1' ? this.o : null; },
    describe(id) { return id === 'o1' ? { ...this.o } : null; },
    async start() { this.o.state = 'idle'; return { ...this.o }; },
    async send(id, text) { this.sent.push(text); },
  };
  const audit = { entries: [], add(e) { this.entries.push(e); } };
  const notes = [];
  let now = new Date(2026, 10, 16, 7, 30).getTime();
  const mgr = new ScheduleManager({ store, sessions: sm, orchestrators: om, audit, notify: (t, b) => notes.push([t, b]), precheck, now: () => now, pollMs: 5, startWaitMs: 500 });
  return { mgr, store, sm, om, audit, notes, setNow: (t) => { now = t; } };
}

function fakeSession(name, status, kind = 'agent') {
  return { id: 'id-' + name, projectId: 'p1', name, kind, status, sent: [], async send(t) { this.sent.push(t); this.status = 'working'; } };
}

const base = { name: 'Nightly', cron: '0 2 * * *', prompt: 'update the dependencies', target: { type: 'session', projectId: 'p1', session: 'dev' } };

test('schedules: save validates, plans the next run and describes the target', () => {
  const { mgr, store } = setup();
  assert.throws(() => mgr.save({ ...base, cron: 'nope' }), /five fields/);
  assert.throws(() => mgr.save({ ...base, prompt: ' ' }), /prompt is empty/);
  assert.throws(() => mgr.save({ ...base, target: { type: 'session', projectId: 'gone', session: 'x' } }), /Choose a session/);
  assert.throws(() => mgr.save({ ...base, target: { type: 'orchestrator', id: 'gone' } }), /Choose an orchestrator/);
  const s = mgr.save(base);
  assert.strictEqual(s.targetLabel, 'App/dev');
  assert.strictEqual(s.text, 'every day at 02:00');
  assert.strictEqual(s.nextAt, new Date(2026, 10, 17, 2, 0).getTime());
  assert.strictEqual(store.data.schedules.length, 1);
  mgr.setEnabled(s.id, false);
  assert.strictEqual(mgr.list()[0].nextAt, null);
});

test('schedules: tick sends when the time has come, once, and plans the next day', async () => {
  const dev = fakeSession('dev', 'waiting');
  const { mgr, setNow, audit } = setup({ sessions: [dev] });
  const s = mgr.save(base);
  mgr.tick();
  assert.deepStrictEqual(dev.sent, []);
  setNow(new Date(2026, 10, 17, 2, 0, 5).getTime());
  mgr.tick();
  mgr.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(dev.sent, ['update the dependencies']);
  const d = mgr.list()[0];
  assert.strictEqual(d.nextAt, new Date(2026, 10, 18, 2, 0).getTime());
  assert.strictEqual(d.runs.length, 1);
  assert.strictEqual(d.runs[0].outcome, 'sent');
  assert.ok(audit.entries.some((e) => e.source === 'schedule' && e.action === 'sent'));
  assert.ok(s.id);
});

test('schedules: a busy session is waited for, skipped or sent to, as configured', async () => {
  const dev = fakeSession('dev', 'working');
  const { mgr } = setup({ sessions: [dev] });
  const skip = mgr.save({ ...base, busy: 'skip' });
  assert.deepStrictEqual((await mgr.run(skip.id)).outcome, 'skipped');
  const send = mgr.save({ ...base, busy: 'send' });
  assert.strictEqual((await mgr.run(send.id)).outcome, 'sent');
  dev.sent.length = 0;
  dev.status = 'working';
  const wait = mgr.save({ ...base, busy: 'wait' });
  setTimeout(() => { dev.status = 'waiting'; }, 20);
  const r = await mgr.run(wait.id, { manual: true });
  assert.strictEqual(r.outcome, 'sent');
  assert.strictEqual(r.manual, true);
  assert.deepStrictEqual(dev.sent, ['update the dependencies']);
});

test('schedules: a session that is not open fails, or is started first with its configured terminal', async () => {
  const { mgr, sm, notes } = setup();
  const s = mgr.save({ ...base, target: { type: 'session', projectId: 'p1', session: 'nightly' } });
  const r = await mgr.run(s.id);
  assert.strictEqual(r.outcome, 'failed');
  assert.match(r.detail, /not open/);
  assert.strictEqual(notes.length, 1);
  mgr.save({ ...mgr.get(s.id), startIfStopped: true });
  const r2 = await mgr.run(s.id);
  assert.strictEqual(r2.outcome, 'sent');
  assert.strictEqual(r2.detail, 'session started');
  assert.deepStrictEqual(sm.opened[0], { name: 'nightly', command: 'claude', kind: 'terminal', exactName: true });
  assert.deepStrictEqual(sm.all[0].sent, ['update the dependencies']);
});

test('schedules: a failing precheck skips the run', async () => {
  const dev = fakeSession('dev', 'waiting');
  let code = 1;
  const { mgr } = setup({ sessions: [dev], precheck: async (_p, _h, cmd) => ({ code, out: '', err: cmd === 'check' ? 'nothing to do' : '' }) });
  const s = mgr.save({ ...base, precheck: 'check' });
  const r = await mgr.run(s.id);
  assert.strictEqual(r.outcome, 'skipped');
  assert.match(r.detail, /precheck ended with 1: nothing to do/);
  code = 0;
  assert.strictEqual((await mgr.run(s.id)).outcome, 'sent');
});

test('schedules: orchestrator targets — stopped fails or is started, busy is waited for', async () => {
  const { mgr, om } = setup({ orch: { state: 'stopped' } });
  const s = mgr.save({ ...base, target: { type: 'orchestrator', id: 'o1' }, precheck: 'ignored' });
  assert.strictEqual(mgr.get(s.id).precheck, '');
  assert.strictEqual(mgr.list()[0].targetLabel, 'Nightly');
  assert.match((await mgr.run(s.id)).detail, /stopped/);
  mgr.save({ ...mgr.get(s.id), startIfStopped: true });
  assert.strictEqual((await mgr.run(s.id)).detail, 'orchestrator started');
  om.o.busy = true;
  setTimeout(() => { om.o.busy = false; }, 20);
  assert.strictEqual((await mgr.run(s.id)).outcome, 'sent');
  assert.strictEqual(om.sent.length, 2);
});

test('schedules: a renamed session keeps its schedule; only the last 20 runs are kept', async () => {
  const dev = fakeSession('dev', 'waiting');
  const { mgr } = setup({ sessions: [dev] });
  const s = mgr.save({ ...base, busy: 'send' });
  mgr.sessionRenamed('p1', 'dev', 'developer');
  assert.strictEqual(mgr.get(s.id).target.session, 'developer');
  dev.name = 'developer';
  for (let i = 0; i < 23; i++) await mgr.run(s.id);
  assert.strictEqual(mgr.get(s.id).runs.length, 20);
});
