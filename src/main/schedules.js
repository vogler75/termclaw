'use strict';
// Scheduled prompts: at the times of a cron expression a prompt goes to a session (terminal or agent)
// or to an orchestrator. Runs while the app is open; times that pass while it is closed are skipped.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { parseCron, nextRun, describeCron } = require('./cron');
const { Target } = require('./coding-agents/target');

const RUNS_KEPT = 20;
const BUSY = ['wait', 'skip', 'send'];
const STOPPED = ['disconnected', 'error', 'exited'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A terminal takes every line break as Enter. A program that asked for bracketed paste (agents, modern
// shells) gets several lines as one block; for any other the lines are joined.
function terminalText(session, text) {
  if (!/[\r\n]/.test(text)) return text;
  const modes = session.headless && session.headless.modes;
  if (modes && modes.bracketedPasteMode) return `\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`;
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ');
}

class ScheduleManager extends EventEmitter {
  // opts.precheck(project, host, command) → {code, out, err}; opts.now, opts.pollMs and opts.startWaitMs for tests.
  constructor({ store, sessions, orchestrators, audit, notify, precheck, now, pollMs, startWaitMs }) {
    super();
    this.store = store;
    this.sessions = sessions;
    this.orchestrators = orchestrators;
    this.audit = audit || { add() {} };
    this.notify = notify || (() => {});
    this.precheck = precheck || ((project, host, command) => new Target(project, host).run(command, { timeout: 120000 }));
    this.now = now || (() => Date.now());
    this.pollMs = pollMs || 1000;
    this.startWaitMs = startWaitMs || 120000;
    this.next = new Map(); // id -> time of the next run
    this.running = new Set(); // ids with a run in progress
    this.timer = null;
  }

  get items() { return this.store.data.schedules || (this.store.data.schedules = []); }
  get(id) { return this.items.find((s) => s.id === id); }

  start() {
    for (const s of this.items) this._plan(s);
    this.timer = setInterval(() => this.tick(), 15000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  // After an import: plan every schedule again.
  replan() {
    this.next.clear();
    for (const s of this.items) this._plan(s);
    this._changed();
  }

  // A renamed session keeps its schedules.
  sessionRenamed(projectId, from, to) {
    let hit = false;
    for (const s of this.items) {
      const t = s.target;
      if (t && t.type === 'session' && t.projectId === projectId && t.session === from) { t.session = to; hit = true; }
    }
    if (hit) { this.store.save(); this._changed(); }
  }

  _plan(s) {
    let at = null;
    if (s.enabled) { try { const d = nextRun(s.cron, new Date(this.now())); at = d ? d.getTime() : null; } catch {} }
    if (at) this.next.set(s.id, at); else this.next.delete(s.id);
  }

  tick() {
    const now = this.now();
    for (const s of this.items) {
      const at = this.next.get(s.id);
      if (!s.enabled || !at || now < at) continue;
      this._plan(s);
      this.run(s.id).catch(() => {});
    }
  }

  targetLabel(t) {
    if (!t) return '?';
    if (t.type === 'orchestrator') {
      const o = this.orchestrators && this.orchestrators.get(t.id);
      return o ? o.name : 'deleted orchestrator';
    }
    const p = this.store.getProject(t.projectId);
    return `${p ? p.name : '?'}/${t.session}`;
  }

  describe(s) {
    return { ...s, text: describeCron(s.cron), nextAt: this.next.get(s.id) || null, targetLabel: this.targetLabel(s.target), running: this.running.has(s.id) };
  }

  list() { return this.items.map((s) => this.describe(s)); }

  preview(cron) {
    parseCron(cron);
    const d = nextRun(cron, new Date(this.now()));
    return { text: describeCron(cron), nextAt: d ? d.getTime() : null };
  }

  save(input) {
    const existing = input.id ? this.get(input.id) : null;
    const s = {
      id: (existing && existing.id) || crypto.randomUUID(),
      name: String(input.name || '').trim() || 'Scheduled prompt',
      enabled: input.enabled !== false,
      cron: String(input.cron || '').trim(),
      prompt: String(input.prompt || ''),
      target: null,
      busy: BUSY.includes(input.busy) ? input.busy : 'wait',
      busyWaitMin: Math.max(1, Math.min(720, Number(input.busyWaitMin) || 30)),
      startIfStopped: !!input.startIfStopped,
      precheck: String(input.precheck || '').trim(),
      runs: (existing && existing.runs) || [],
    };
    parseCron(s.cron);
    if (!nextRun(s.cron, new Date(this.now()))) throw new Error('Schedule: this time never comes');
    if (!s.prompt.trim()) throw new Error('The prompt is empty');
    const t = input.target || {};
    if (t.type === 'orchestrator') {
      if (!this.orchestrators.get(t.id)) throw new Error('Choose an orchestrator');
      s.target = { type: 'orchestrator', id: t.id };
      s.precheck = '';
    } else {
      if (!this.store.getProject(t.projectId) || !t.session) throw new Error('Choose a session');
      s.target = { type: 'session', projectId: t.projectId, session: String(t.session) };
    }
    if (existing) Object.assign(existing, s); else this.items.push(s);
    this._plan(s);
    this.store.save();
    this.audit.add({ source: 'schedule', action: existing ? 'update' : 'create', detail: `${s.name}: ${s.cron} → ${this.targetLabel(s.target)}` });
    this._changed();
    return this.describe(s);
  }

  setEnabled(id, on) {
    const s = this.get(id);
    if (!s) return;
    s.enabled = !!on;
    this._plan(s);
    this.store.save();
    this._changed();
  }

  remove(id) {
    const s = this.get(id);
    if (!s) return;
    this.store.data.schedules = this.items.filter((x) => x.id !== id);
    this.next.delete(id);
    this.store.save();
    this.audit.add({ source: 'schedule', action: 'delete', detail: s.name });
    this._changed();
  }

  _changed() { this.emit('changed', this.list()); }

  // Runs one schedule now; resolves to the recorded run {at, outcome: sent | skipped | failed, detail, manual}.
  async run(id, { manual = false } = {}) {
    const s = this.get(id);
    if (!s) throw new Error('unknown schedule');
    if (this.running.has(id)) return this._record(s, 'skipped', 'the previous run is still waiting for its target', manual);
    this.running.add(id);
    this._changed();
    let outcome = 'failed';
    let detail = '';
    try {
      [outcome, detail] = await this._deliver(s);
    } catch (e) {
      detail = e.message || String(e);
    } finally {
      this.running.delete(id);
    }
    return this._record(s, outcome, detail, manual);
  }

  _record(s, outcome, detail, manual) {
    const run = { at: this.now(), outcome, detail: String(detail || '').slice(0, 300), ...(manual ? { manual: true } : {}) };
    if (this.get(s.id)) {
      s.runs = [...(s.runs || []), run].slice(-RUNS_KEPT);
      this.store.save();
    }
    const label = `${s.name} → ${this.targetLabel(s.target)}`;
    this.audit.add({ source: 'schedule', action: outcome, detail: run.detail ? `${label}: ${run.detail}` : label, ...(outcome === 'failed' ? { error: run.detail || 'failed' } : {}) });
    if (outcome === 'failed') this.notify(`Scheduled prompt failed: ${s.name}`, run.detail);
    this._changed();
    return run;
  }

  async _deliver(s) {
    if (s.target.type === 'orchestrator') return this._toOrchestrator(s);
    const project = this.store.getProject(s.target.projectId);
    if (!project) throw new Error('the project no longer exists');
    if (s.precheck) {
      const host = project.hostId ? this.store.getHost(project.hostId) : null;
      const r = await this.precheck(project, host, s.precheck);
      if (r.code !== 0) return ['skipped', `precheck ended with ${r.code}${(r.err || r.out || '').trim() ? ': ' + (r.err || r.out).trim().split('\n').pop() : ''}`];
    }
    return this._toSession(s, project);
  }

  _findSession(s) {
    return this.sessions.list(s.target.projectId).find((x) => x.name === s.target.session) || null;
  }

  // Waits until test() is true; false after the timeout.
  async _until(test, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (test()) return true;
      await sleep(this.pollMs);
    }
    return test();
  }

  async _toSession(s, project) {
    let sess = this._findSession(s);
    let started = false;
    if (!sess || STOPPED.includes(sess.status)) {
      if (!s.startIfStopped) throw new Error(sess ? `the session is ${sess.status}` : 'the session is not open');
      if (sess) this.sessions.reconnect(sess.id);
      else {
        // One of the project's configured terminals with this name, else its default session.
        const tpl = (project.terminals || []).find((t) => t.name === s.target.session) || {};
        this.sessions.open(project.id, { ...tpl, name: s.target.session, exactName: true });
      }
      started = true;
      const ready = await this._until(() => { const x = this._findSession(s); return !x || x.status === 'waiting' || x.status === 'error' || x.status === 'exited'; }, this.startWaitMs);
      sess = this._findSession(s);
      if (!sess || !ready || sess.status !== 'waiting') throw new Error(`the session did not get ready${sess && sess.error ? ': ' + sess.error : ''}`);
    }
    if (sess.status !== 'waiting' && s.busy !== 'send') {
      if (s.busy === 'skip') return ['skipped', 'the session is busy'];
      const idle = await this._until(() => { const x = this._findSession(s); return !x || x.status !== 'working' && x.status !== 'starting'; }, s.busyWaitMin * 60000);
      sess = this._findSession(s);
      if (!sess) throw new Error('the session was closed while waiting');
      if (!idle) return ['skipped', `the session was still busy after ${s.busyWaitMin} min`];
      if (sess.status !== 'waiting') throw new Error(`the session is ${sess.status}`);
    }
    await sess.send(sess.kind === 'terminal' ? terminalText(sess, s.prompt) : s.prompt);
    return ['sent', started ? 'session started' : ''];
  }

  async _toOrchestrator(s) {
    const orch = this.orchestrators;
    const state = () => { const o = orch.describe(s.target.id); return o || null; };
    let o = state();
    if (!o) throw new Error('the orchestrator no longer exists');
    let started = false;
    if (o.state === 'stopped' || o.state === 'error') {
      if (!s.startIfStopped) throw new Error(`the orchestrator is ${o.state === 'error' ? 'in an error state' : 'stopped'}`);
      o = await orch.start(s.target.id);
      started = true;
      if (!o || o.state === 'error' || o.state === 'stopped') throw new Error(`the orchestrator did not start${o && o.error ? ': ' + o.error : ''}`);
    }
    const busy = (x) => !!x && (x.busy || x.state === 'running' || x.state === 'starting');
    if (busy(o) && s.busy !== 'send') {
      if (s.busy === 'skip') return ['skipped', 'the orchestrator is busy'];
      const idle = await this._until(() => !busy(state()), s.busyWaitMin * 60000);
      o = state();
      if (!o) throw new Error('the orchestrator was deleted while waiting');
      if (!idle) return ['skipped', `the orchestrator was still busy after ${s.busyWaitMin} min`];
      if (o.state === 'stopped' || o.state === 'error') throw new Error('the orchestrator stopped while waiting');
    }
    await orch.send(s.target.id, s.prompt);
    return ['sent', started ? 'orchestrator started' : ''];
  }
}

module.exports = { ScheduleManager, terminalText };
