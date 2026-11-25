'use strict';
// Session type "agent": OpenCode in server mode, controlled over its HTTP API instead of terminal text.
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { BaseSession } = require('./sessions');
const { OpenCodeClient, LocalOpenCodeServer, findOpencode, freePort, normalizeTokens, computeUsage, simplifyMessages, messagesToText } = require('./opencode');
const { resolveTarget, sshBaseArgs, sshDest, batchOpts, authEnv, specEnv, projectDir, posixDir, shq, tmuxName, SSH_BIN } = require('./connect');
const { Target } = require('./coding-agents/target');

const READ_ACTIONS = new Set(['read', 'glob', 'grep', 'list', 'ls', 'find', 'search', 'webfetch', 'websearch', 'fetch', 'think', 'todoread', 'question']);

function toolBrief(input) {
  if (!input) return '';
  if (typeof input === 'string') return input.slice(0, 60);
  for (const k of ['filePath', 'file_path', 'path', 'command', 'cmd', 'pattern', 'query', 'url', 'description']) {
    if (typeof input[k] === 'string' && input[k]) return input[k].slice(0, 60);
  }
  return '';
}

const SLASH_BUILTINS = [
  { name: 'model', description: 'Choose the model for this session' },
  { name: 'compact', description: 'Summarize the conversation to free up context' },
  { name: 'new', description: 'Start a new conversation' },
  { name: 'stop', description: 'Interrupt the current run' },
  { name: 'shell', description: 'Run a shell command in the project (also: !command)', args: '<command>' },
  { name: 'login', description: 'Log in to a provider (opens a terminal)' },
  { name: 'help', description: 'Show available commands' },
];

class AgentSession extends BaseSession {
  constructor(mgr, project, opts) {
    super(mgr, project, { ...opts, kind: 'agent' });
    // Stable per-session values so a restarted app can re-attach to a still running remote server.
    this.agentKey = opts.agentKey || crypto.randomBytes(18).toString('base64url');
    this.remotePort = opts.remotePort || 20000 + Math.floor(Math.random() * 30000);
    this.agentSessionId = opts.agentSessionId || null;
    this.chosenModel = opts.model || null; // {providerID, id, variant} picked by the user
    this.approval = ['ask', 'reads', 'all'].includes(opts.approval) ? opts.approval : 'ask';
    this.messages = [];
    this.live = '';
    this.liveState = null; // { text, thought, tools: Map, compaction }
    this.usage = null;
    this.contextLimit = 0;
    this.activity = null;
    this.plan = [];
    this.title = '';
    this.agentsList = [];
    this.activeAgent = '';
    this.permission = null;
    this.pendingPermissions = [];
    this.question = null;
    this.pendingQuestions = [];
    this.procs = [];
    this.client = null;
    this.server = null;
    this.log = [];
    if (this.disconnected) this.status = 'disconnected'; else this.start();
  }

  _log(line) {
    this.log.push(`${new Date().toLocaleTimeString()} ${line}`);
    if (this.log.length > 200) this.log.shift();
    this.mgr.emit('agent-log', this, line);
  }

  getLog() { return [...this.log]; }

  _setActivity(phase, detail = '', extra = {}) {
    if (!phase || phase === 'idle') {
      if (!this.activity) return;
      this.activity = null;
      this._emitUpdate(true);
      return;
    }
    const startedAt = this.activity && this.activity.phase !== 'connecting' && phase !== 'connecting'
      ? this.activity.startedAt
      : Date.now();
    this.activity = { phase, detail, startedAt, ...extra };
    this._emitUpdate();
  }

  _emitUpdate(now) {
    if (now) { clearTimeout(this._updTimer); this._updTimer = null; this.mgr.emit('updated', this); return; }
    if (this._updTimer) return;
    this._updTimer = setTimeout(() => { this._updTimer = null; this.mgr.emit('updated', this); }, 150);
  }

  _ensureLive() {
    if (!this.liveState) this.liveState = { text: '', thought: '', tools: new Map(), compaction: '' };
    return this.liveState;
  }

  _emitLive(now) {
    clearTimeout(this._liveTimer);
    const fire = () => {
      const ls = this.liveState;
      const payload = ls && (ls.text || ls.thought || ls.tools.size || ls.compaction)
        ? { text: ls.text, thought: ls.thought, tools: [...ls.tools.values()], compaction: ls.compaction }
        : null;
      this.live = ls ? ls.text : '';
      this.mgr.emit('agent-live', this, payload);
    };
    if (now) fire(); else this._liveTimer = setTimeout(fire, 80);
  }

  async start() {
    this.setStatus('starting');
    this._setActivity('connecting', 'Starting OpenCode server…');
    this.error = null;
    try {
      await this._connect();
      this.client.on('event', (ev) => this._onEvent(ev));
      this.client.on('stream-error', (e) => this._log('event stream: ' + e.message));
      if (this.agentSessionId) {
        try { await this.client.getSession(this.agentSessionId); } catch { this.agentSessionId = null; }
      }
      if (!this.agentSessionId) {
        const s = await this.client.createSession();
        this.agentSessionId = s.id;
        this.mgr.persistOpen(this.projectId);
      }
      if (this.command) await this.client.setInstructions(this.agentSessionId, 'termclaw-start', this.command).catch(() => {});
      if (this.chosenModel) {
        const m = this.chosenModel;
        await this.client.setModel(this.agentSessionId, m, m.variant || undefined)
          .catch((e) => this._log(`could not apply model ${m.providerID}/${m.id}: ${e.message}`));
      }
      const active = await this.client.active().catch(() => ({}));
      const busy = !!active[this.agentSessionId];
      this.setStatus(busy ? 'working' : 'waiting', 'api');
      this._setActivity(busy ? 'thinking' : 'idle', busy ? 'Working…' : '');
      await this.refreshModel();
      await this._refreshAgents();
      await this._syncPending();
      await this.refresh();
      this._log('connected to OpenCode at ' + this.client.url);
    } catch (e) {
      if (this.disconnected) return;
      this.error = e.message;
      this._setActivity('idle');
      this._log('error: ' + e.message);
      this.setStatus('error', e.message);
      this._emitUpdate(true);
    }
  }

  async _connect() {
    const project = this.project;
    const host = project.hostId ? this.mgr.store.getHost(project.hostId) : null;
    const agentCmd = project.agentCommand || 'opencode';
    const dir = projectDir(project, host);

    if (project.type === 'local') {
      const bin = findOpencode(this.mgr.store.settings.opencodePath || (agentCmd !== 'opencode' ? agentCmd : ''));
      const cwd = dir ? dir.replace(/^~(?=$|[\\/])/, os.homedir()) : os.homedir();
      this.server = new LocalOpenCodeServer({ bin, cwd });
      this.server.on('exit', (code) => { this._log('opencode exited ' + code); if (!this._closed) this.setStatus('error', 'OpenCode exited'); });
      this.client = await this.server.start();
      return;
    }

    // Remote (ssh) or WSL: run `opencode serve` inside tmux on the target, reach it through localhost.
    const name = tmuxName(project, this.name) + '-oc';
    this.tmuxName = name;
    const target = new Target(project, host);
    const started = await this._startRemote(target, name, agentCmd, dir, false);

    if (project.type === 'wsl') {
      // WSL2 forwards localhost ports to Windows.
      this.client = new OpenCodeClient({ url: `http://127.0.0.1:${this.remotePort}`, password: this.agentKey });
    } else {
      const t = resolveTarget(project, host);
      const base = [...sshBaseArgs(project, t)];
      const localPort = await freePort();
      const fwd = spawn(SSH_BIN, ['-N', ...batchOpts(project, host), '-o', 'ExitOnForwardFailure=yes', ...base,
        '-L', `127.0.0.1:${localPort}:127.0.0.1:${this.remotePort}`, sshDest(t)], { windowsHide: true, stdio: 'ignore', env: specEnv({ env: authEnv(project, host) }) });
      this.procs.push(fwd);
      fwd.on('exit', () => { if (!this._closed) { this._log('ssh forward closed'); this.setStatus('error', 'Connection lost'); } });
      this.client = new OpenCodeClient({ url: `http://127.0.0.1:${localPort}`, password: this.agentKey });
    }
    try {
      await this.client.waitReady(started === 'running' ? 8000 : 45000);
    } catch (e) {
      if (started === 'running') {
        // A tmux session from an earlier run (other port or password): replace it once.
        this._log('existing OpenCode tmux session not reachable, restarting it');
        await this._startRemote(target, name, agentCmd, dir, true);
        try { await this.client.waitReady(45000); } catch (e2) { throw new Error(await this._remoteFailure(target, name, e2)); }
      } else {
        throw new Error(await this._remoteFailure(target, name, e));
      }
    }
    this.client.streamEvents();
  }

  // Starts `opencode serve` in a tmux session on the target. Resolves the binary with the user's
  // PATH (npm, nvm, ~/.opencode/bin, ...) so tmux does not depend on it, checks for OpenCode v2 and
  // tmux, and logs the server output to a file for error reports. Returns 'started' or 'running'.
  async _startRemote(target, name, agentCmd, dir, restart) {
    const d = posixDir(dir);
    const log = `$HOME/.cache/termclaw/${name}.log`;
    const script = [
      target.preamble(),
      `BIN=$(command -v ${shq(agentCmd)} 2>/dev/null)`,
      `case "$BIN" in '') echo "@@ERR notfound"; exit 0 ;; /mnt/[a-z]/*) echo "@@ERR windows $BIN"; exit 0 ;; esac`,
      'echo "@@BIN $BIN"',
      'echo "@@VERSION $("$BIN" --version 2>&1 </dev/null | head -n 1)"',
      'command -v tmux >/dev/null 2>&1 || { echo "@@ERR notmux"; exit 0; }',
      `mkdir -p "$HOME/.cache/termclaw"`,
      restart ? `tmux kill-session -t ${shq('=' + name)} 2>/dev/null; sleep 0.5` : ':',
      `if tmux has-session -t ${shq('=' + name)} 2>/dev/null; then echo "@@RUNNING"; else`,
      `  tmux new-session -d -s ${shq(name)} "${d ? `cd ${d.replace(/"/g, '\\"')} && ` : ''}OPENCODE_SERVER_PASSWORD=${shq(this.agentKey)} exec \\"$BIN\\" serve --hostname 127.0.0.1 --port ${this.remotePort} > \\"${log}\\" 2>&1" && echo "@@STARTED" || echo "@@ERR tmuxfail"`,
      'fi',
    ].join('\n');
    const r = await target.run(script, { timeout: 60000 });
    const line = (tag) => (r.out.split(/\r?\n/).find((l) => l.startsWith(tag)) || '').slice(tag.length).trim();
    const where = this.project.type === 'wsl' ? `in WSL (${this.project.wslDistro || 'default distribution'})` : 'on the remote host';
    const err = r.out.split(/\r?\n/).find((l) => l.startsWith('@@ERR '));
    if (err) {
      const [, kind, extra] = /^@@ERR (\S+)\s*(.*)$/.exec(err);
      if (kind === 'notfound') throw new Error(`"${agentCmd}" was not found ${where}. Install OpenCode v2 there (Agents ▾ → Install OpenCode) or set the agent command in the project settings.`);
      if (kind === 'windows') throw new Error(`Only the Windows OpenCode was found (${extra}). Install OpenCode for Linux inside WSL (Agents ▾ → Install OpenCode).`);
      if (kind === 'notmux') throw new Error(`tmux is not installed ${where}; agent sessions run OpenCode inside tmux.`);
      throw new Error(`Could not start the tmux session ${where}.`);
    }
    if (!r.out.includes('@@BIN ')) throw new Error(`Could not run commands ${where}: ${(r.err || r.out).trim().slice(0, 300)}`);
    const version = line('@@VERSION ');
    const major = Number((/(\d+)\.\d+/.exec(version) || [])[1]);
    if (major && major < 2) throw new Error(`OpenCode ${version} found ${where}; agent sessions need OpenCode v2 (Agents ▾ → Install OpenCode installs v2).`);
    this._log(`OpenCode ${version} at ${line('@@BIN ')} ${r.out.includes('@@RUNNING') ? '(already running)' : '(started)'}`);
    return r.out.includes('@@RUNNING') ? 'running' : 'started';
  }

  // Builds an error message with the end of the server log and whether the tmux session still runs.
  async _remoteFailure(target, name, err) {
    const r = await target.run([
      `if tmux has-session -t ${shq('=' + name)} 2>/dev/null; then echo "@@ALIVE"; fi`,
      `tail -n 15 "$HOME/.cache/termclaw/${name}.log" 2>/dev/null`,
    ].join('\n'), { timeout: 30000 }).catch(() => ({ out: '' }));
    const alive = r.out.includes('@@ALIVE');
    const log = r.out.replace('@@ALIVE', '').trim();
    return `OpenCode did not answer on port ${this.remotePort} (${err.message}). ` +
      (alive ? 'The server is running but not reachable through the tunnel.' : 'The server process exited.') +
      (log ? `\nServer log (~/.cache/termclaw/${name}.log):\n${log}` : '');
  }

  _run(file, args) {
    return new Promise((resolve, reject) => {
      const p = spawn(file, args, { windowsHide: true });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${file} failed (${code}): ${out.trim().slice(0, 300)}`))));
    });
  }

  _onEvent(ev) {
    const data = ev.data || ev.properties || {};
    const sid = data.sessionID || (data.info && data.info.sessionID);
    if (sid !== this.agentSessionId) return;
    const t = ev.type || '';
    this.lastOutputAt = Date.now();
    switch (t) {
      case 'session.execution.started':
        this.liveState = { text: '', thought: '', tools: new Map(), compaction: '' };
        this.setStatus('working', 'api');
        this._setActivity('thinking', 'Waiting for model…');
        this._emitLive(true);
        break;
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.interrupted':
        this.liveState = null;
        this._emitLive(true);
        if (!this.permission && !this.question) this._setActivity('idle');
        this.setStatus('waiting', t.split('.').pop());
        this.refresh();
        break;
      case 'session.step.started':
        this._ensureLive();
        if (this.status !== 'working' && !this.permission && !this.question) this.setStatus('working', 'step');
        if (!this.activity || this.activity.phase === 'retry') this._setActivity('thinking', 'Thinking…');
        break;
      case 'session.step.ended':
        this._mergeStepUsage(data.tokens, data.cost, true);
        this.refreshSoon();
        break;
      case 'session.step.failed':
        this._log('step failed: ' + ((data.error && data.error.message) || 'error'));
        this.refreshSoon();
        break;
      case 'session.reasoning.started':
        this._ensureLive();
        this._setActivity('reasoning', 'Reasoning…');
        this._emitLive();
        break;
      case 'session.reasoning.delta':
        this._ensureLive().thought += data.delta || '';
        this._setActivity('reasoning', 'Reasoning…');
        this._emitLive();
        break;
      case 'session.reasoning.ended': {
        const ls = this._ensureLive();
        if (data.text && !ls.thought) ls.thought = data.text;
        this._emitLive();
        this.refreshSoon();
        break;
      }
      case 'session.text.started':
        this._ensureLive();
        this._setActivity('responding', 'Writing response…');
        this._emitLive();
        break;
      case 'session.text.delta':
        this._ensureLive().text += data.delta || '';
        this._setActivity('responding', 'Writing response…');
        this._emitLive();
        break;
      case 'session.text.ended': {
        const ls = this._ensureLive();
        if (data.text && !ls.text) ls.text = data.text;
        this._emitLive();
        this.refreshSoon();
        break;
      }
      case 'session.tool.input.started': {
        const ls = this._ensureLive();
        const id = data.callID || ('call-' + Date.now());
        ls.tools.set(id, { id, name: data.name || 'tool', status: 'streaming', input: '', result: '', startedAt: Date.now() });
        this._setActivity('tool', `Preparing ${data.name || 'tool'}…`);
        this._emitLive();
        break;
      }
      case 'session.tool.input.delta': {
        const ls = this._ensureLive();
        const tool = ls.tools.get(data.callID);
        if (tool && tool.status === 'streaming') tool.input = (typeof tool.input === 'string' ? tool.input : '') + (data.delta || '');
        this._emitLive();
        break;
      }
      case 'session.tool.input.ended': {
        const ls = this._ensureLive();
        const tool = ls.tools.get(data.callID);
        if (tool && tool.status === 'streaming' && data.text !== undefined) tool.input = data.text;
        this._emitLive();
        break;
      }
      case 'session.tool.called': {
        const ls = this._ensureLive();
        const id = data.callID || ('call-' + Date.now());
        const prev = ls.tools.get(id);
        const name = (prev && prev.name) || data.name || 'tool';
        const tool = { id, name, status: 'running', input: data.input, result: '', startedAt: Date.now() };
        ls.tools.set(id, tool);
        const subj = toolBrief(data.input);
        this._setActivity('tool', `Running ${name}${subj && !name.includes(subj) ? ': ' + subj : ''}`);
        this._emitLive(true);
        break;
      }
      case 'session.tool.progress': {
        const ls = this._ensureLive();
        const tool = ls.tools.get(data.callID);
        if (tool && data.metadata && typeof data.metadata.output === 'string') {
          tool.result = data.metadata.output.slice(-4000);
          this._emitLive();
        }
        break;
      }
      case 'session.tool.success': {
        const ls = this._ensureLive();
        const tool = ls.tools.get(data.callID);
        if (tool) {
          tool.status = 'completed';
          tool.completedAt = Date.now();
          tool.result = (data.content || []).map((x) => x.text || '').join('\n').slice(0, 4000);
          if (data.metadata && typeof data.metadata.diff === 'string' && data.metadata.diff) {
            tool.diffs = [{ path: toolBrief(tool.input), unified: data.metadata.diff.slice(0, 12000) }];
          }
        }
        this._updateToolActivity();
        this._emitLive(true);
        this.refreshSoon();
        break;
      }
      case 'session.tool.failed': {
        const ls = this._ensureLive();
        const tool = ls.tools.get(data.callID);
        if (tool) {
          tool.status = 'error';
          tool.completedAt = Date.now();
          tool.result = data.error ? (data.error.message || JSON.stringify(data.error)) : 'error';
        }
        this._updateToolActivity();
        this._emitLive(true);
        this.refreshSoon();
        break;
      }
      case 'session.compaction.started':
        this._ensureLive().compaction = '';
        this._setActivity('compacting', 'Compacting context…');
        this._emitLive(true);
        break;
      case 'session.compaction.delta':
        this._ensureLive().compaction += data.text || data.delta || '';
        this._setActivity('compacting', 'Compacting context…');
        this._emitLive();
        break;
      case 'session.compaction.ended':
      case 'session.compaction.failed':
        if (this.liveState) this.liveState.compaction = '';
        this._emitLive(true);
        this.refreshSoon();
        break;
      case 'session.shell.started':
        this._setActivity('shell', 'Running shell command…');
        break;
      case 'session.shell.ended':
        this.refreshSoon();
        break;
      case 'session.retry.scheduled':
        this._setActivity('retry', (data.error && data.error.message) || 'Retrying…', { attempt: data.attempt || 1, nextAt: data.at || 0 });
        this._log(`retry #${data.attempt || 1}: ${(data.error && data.error.message) || ''}`);
        break;
      case 'session.usage.updated':
        this._mergeSessionUsage(data.tokens, data.cost);
        break;
      case 'session.renamed':
        this.title = data.title || '';
        this._emitUpdate(true);
        break;
      case 'session.agent.selected':
        this.activeAgent = data.agent || '';
        this._emitUpdate(true);
        break;
      case 'session.model.selected':
        this.refreshModel();
        break;
      case 'todo.updated':
        this.plan = (data.todos || []).map((x) => ({
          content: x.content || x.title || '',
          status: x.status || 'pending',
          priority: x.priority || '',
        }));
        this._emitUpdate(true);
        break;
      case 'permission.v2.asked':
      case 'permission.asked':
        this._onPermissionAsked(data);
        break;
      case 'permission.v2.replied':
      case 'permission.replied':
        this._onPermissionResolved(data.requestID || data.id);
        break;
      case 'question.v2.asked':
      case 'question.asked':
        this._onQuestionAsked(data);
        break;
      case 'question.v2.replied':
      case 'question.replied':
      case 'question.v2.rejected':
      case 'question.rejected':
        this._onQuestionResolved(data.requestID || data.id);
        break;
      case 'session.inbox.delivered':
      case 'session.tool.ended':
        this.refreshSoon();
        break;
      default:
        break;
    }
  }

  _updateToolActivity() {
    if (!this.liveState) return;
    const active = [...this.liveState.tools.values()].find((t) => t.status === 'running' || t.status === 'streaming');
    if (active) {
      const subj = toolBrief(active.input);
      this._setActivity('tool', `${active.status === 'streaming' ? 'Preparing' : 'Running'} ${active.name}${subj && !active.name.includes(subj) ? ': ' + subj : ''}`);
    } else {
      this._setActivity('thinking', 'Processing tool result…');
    }
  }

  _mergeStepUsage(tokens, cost, countTurn) {
    const tok = normalizeTokens(tokens);
    if (!tok && typeof cost !== 'number') return;
    const prev = this.usage || {};
    const used = tok ? (tok.input + tok.cacheRead + tok.cacheWrite + tok.output + tok.reasoning) : (prev.used || 0);
    const prevCost = prev.cost && typeof prev.cost.amount === 'number' ? prev.cost.amount : 0;
    const nextCost = typeof cost === 'number' ? prevCost + cost : prevCost;
    this.usage = {
      ...prev,
      used,
      size: this.contextLimit || prev.size || 0,
      inputTokens: (prev.inputTokens || 0) + (tok ? tok.input : 0),
      outputTokens: (prev.outputTokens || 0) + (tok ? tok.output : 0),
      reasoningTokens: (prev.reasoningTokens || 0) + (tok ? tok.reasoning : 0),
      cacheReadTokens: (prev.cacheReadTokens || 0) + (tok ? tok.cacheRead : 0),
      cacheWriteTokens: (prev.cacheWriteTokens || 0) + (tok ? tok.cacheWrite : 0),
      totalTokens: (prev.totalTokens || 0) + (tok ? tok.total : 0),
      turns: (prev.turns || 0) + (countTurn ? 1 : 0),
      ...(typeof cost === 'number' || prev.cost ? { cost: { amount: nextCost, currency: 'USD' } } : {}),
    };
    this._emitUpdate();
  }

  _mergeSessionUsage(tokens, cost) {
    const tok = normalizeTokens(tokens);
    if (!tok && typeof cost !== 'number') return;
    const prev = this.usage || {};
    this.usage = {
      ...prev,
      size: this.contextLimit || prev.size || 0,
      ...(tok ? {
        inputTokens: Math.max(prev.inputTokens || 0, tok.input),
        outputTokens: Math.max(prev.outputTokens || 0, tok.output),
        reasoningTokens: Math.max(prev.reasoningTokens || 0, tok.reasoning),
        cacheReadTokens: Math.max(prev.cacheReadTokens || 0, tok.cacheRead),
        cacheWriteTokens: Math.max(prev.cacheWriteTokens || 0, tok.cacheWrite),
        totalTokens: Math.max(prev.totalTokens || 0, tok.total),
        used: prev.used || (tok.input + tok.cacheRead + tok.cacheWrite),
      } : {}),
      ...(typeof cost === 'number' ? { cost: { amount: cost, currency: 'USD' } } : {}),
    };
    this._emitUpdate();
  }

  // ---------- permissions & questions ----------
  _normalizePermission(raw) {
    const id = raw.id || raw.requestID;
    const action = raw.action || raw.permission || 'tool';
    const patterns = Array.isArray(raw.resources) ? raw.resources : (Array.isArray(raw.patterns) ? raw.patterns : []);
    const title = patterns.length ? `${action}: ${patterns.join(', ')}` : action;
    const kind = READ_ACTIONS.has(String(action).toLowerCase()) ? 'read' : 'execute';
    return {
      id,
      title,
      kind,
      action,
      input: patterns.length ? { action, resources: patterns, ...(raw.metadata || {}) } : (raw.metadata || null),
      options: [
        { id: 'once', name: 'Allow once', kind: 'allow_once' },
        { id: 'always', name: 'Always allow', kind: 'allow_always' },
        { id: 'reject', name: 'Deny', kind: 'reject_once' },
      ],
    };
  }

  _autoApproveKind(kind) {
    return this.approval === 'all' || (this.approval === 'reads' && kind === 'read');
  }

  _onPermissionAsked(raw) {
    const req = this._normalizePermission(raw);
    if (!req.id) return;
    if (this._autoApproveKind(req.kind)) {
      this._log(`auto-approved (${this.approval}): ${req.title}`);
      if (this.client && this.agentSessionId) {
        this.client.replyPermission(this.agentSessionId, req.id, 'once').catch((e) => this._log('auto-approve failed: ' + e.message));
      }
      return;
    }
    if (!this.pendingPermissions.some((x) => x.id === req.id)) this.pendingPermissions.push(req);
    this.permission = this.pendingPermissions[0] || null;
    this.setStatus('waiting', 'permission');
    this._setActivity('permission', `Waiting for permission: ${req.title}`);
    this._emitUpdate(true);
    this.mgr.emit('agent-permission', this, this.permission);
  }

  _onPermissionResolved(requestId) {
    this.pendingPermissions = this.pendingPermissions.filter((x) => x.id !== requestId);
    this.permission = this.pendingPermissions[0] || null;
    this.mgr.emit('agent-permission', this, this.permission);
    if (this.permission) {
      this._setActivity('permission', `Waiting for permission: ${this.permission.title}`);
    } else if (this.liveState) {
      this.setStatus('working', 'permission answered');
      this._setActivity('thinking', 'Continuing…');
    } else if (!this.question) {
      this._setActivity('idle');
    }
    this._emitUpdate(true);
  }

  setApproval(policy) {
    this.approval = ['ask', 'reads', 'all'].includes(policy) ? policy : 'ask';
    this.mgr.persistOpen(this.projectId);
    this._emitUpdate(true);
    if (this.permission && this._autoApproveKind(this.permission.kind)) {
      this.answerPermission('once').catch(() => {});
    }
  }

  async answerPermission(optionId) {
    const req = this.permission;
    if (!req) throw new Error('No pending permission request');
    const reply = ['once', 'always', 'reject'].includes(optionId) ? optionId : 'reject';
    if (this.client && this.agentSessionId) {
      await this.client.replyPermission(this.agentSessionId, req.id, reply);
    }
    this._onPermissionResolved(req.id);
  }

  _onQuestionAsked(raw) {
    const id = raw.id || raw.requestID;
    if (!id) return;
    const req = { id, questions: Array.isArray(raw.questions) ? raw.questions : [] };
    if (!this.pendingQuestions.some((x) => x.id === req.id)) this.pendingQuestions.push(req);
    this.question = this.pendingQuestions[0] || null;
    this.setStatus('waiting', 'question');
    this._setActivity('question', 'Waiting for your answer…');
    this._emitUpdate(true);
    this.mgr.emit('agent-question', this, this.question);
  }

  _onQuestionResolved(requestId) {
    this.pendingQuestions = this.pendingQuestions.filter((x) => x.id !== requestId);
    this.question = this.pendingQuestions[0] || null;
    this.mgr.emit('agent-question', this, this.question);
    if (this.question) {
      this._setActivity('question', 'Waiting for your answer…');
    } else if (this.liveState) {
      this.setStatus('working', 'question answered');
      this._setActivity('thinking', 'Continuing…');
    } else if (!this.permission) {
      this._setActivity('idle');
    }
    this._emitUpdate(true);
  }

  async answerQuestion(answers) {
    const req = this.question;
    if (!req) throw new Error('No pending question');
    if (this.client && this.agentSessionId) {
      await this.client.replyQuestion(this.agentSessionId, req.id, answers);
    }
    this._onQuestionResolved(req.id);
  }

  async rejectQuestion() {
    const req = this.question;
    if (!req) throw new Error('No pending question');
    if (this.client && this.agentSessionId) {
      await this.client.rejectQuestion(this.agentSessionId, req.id);
    }
    this._onQuestionResolved(req.id);
  }

  async _syncPending() {
    if (!this.client || !this.agentSessionId) return;
    const [perms, qs] = await Promise.all([
      this.client.permissions(this.agentSessionId).catch(() => []),
      this.client.questions(this.agentSessionId).catch(() => []),
    ]);
    for (const p of perms) this._onPermissionAsked(p);
    for (const q of qs) this._onQuestionAsked(q);
  }

  async _refreshAgents() {
    if (!this.client) return;
    const list = await this.client.agents().catch(() => []);
    this.agentsList = (list || []).filter((a) => a && a.name && a.mode !== 'subagent' && !a.hidden);
    if (!this.activeAgent && this.agentsList.length) this.activeAgent = this.agentsList[0].name;
    this._emitUpdate(true);
  }

  agentOptions() {
    if (this.agentsList.length < 2) return [];
    return [{
      id: 'agent',
      name: 'Agent',
      description: 'OpenCode agent mode (e.g. build / plan)',
      current: this.activeAgent || this.agentsList[0].name,
      options: this.agentsList.map((a) => ({ value: a.name, name: a.name })),
    }];
  }

  async setAgentOption(id, value) {
    if (!this.client || !this.agentSessionId) throw new Error(`Agent ${this.name} is not connected`);
    if (id !== 'agent') throw new Error('Unknown option ' + id);
    await this.client.setAgent(this.agentSessionId, value);
    this.activeAgent = value;
    this._log(`agent mode set to ${value}`);
    this._emitUpdate(true);
  }

  refreshSoon() {
    clearTimeout(this._rt);
    this._rt = setTimeout(() => this.refresh(), 250);
  }

  async refresh() {
    if (!this.client || !this.agentSessionId) return this.messages;
    try {
      const [raw, sess] = await Promise.all([
        this.client.messages(this.agentSessionId),
        this.client.getSession(this.agentSessionId).catch(() => null),
      ]);
      this.messages = simplifyMessages(raw);
      if (sess && sess.title) this.title = sess.title;
      if (sess && sess.agent) this.activeAgent = sess.agent;
      const computed = computeUsage(raw, sess, this.contextLimit);
      if (computed) this.usage = computed;
      this.mgr.emit('agent-messages', this, this.messages);
      this._emitUpdate(true);
    } catch (e) {
      this._log('refresh: ' + e.message);
    }
    return this.messages;
  }

  async send(text) {
    if (!this.client || !this.agentSessionId) throw new Error(`Agent ${this.name} is not connected`);
    // Slash commands and !shell also work when sent over MCP (e.g. by an orchestrator).
    if (/^[/!]\S/.test(text.trim())) {
      const r = await this.runSlash(text);
      if (r && r.handled === 'ui') throw new Error(`/${r.name} needs the app window and cannot be sent`);
      return;
    }
    this.hadInput = true;
    await this.client.prompt(this.agentSessionId, text);
    this.setStatus('working', 'input');
    this._setActivity('thinking', 'Sending prompt…');
    this.refreshSoon();
  }

  async interrupt() {
    if (this.client && this.agentSessionId) await this.client.interrupt(this.agentSessionId);
  }

  // Terminal-compatible no-ops so generic code paths work.
  write() {}
  resize() {}

  readOutput({ lines = 20 } = {}) {
    return { text: messagesToText(this.messages, lines), marker: this.messages.length };
  }

  lastAssistantText() {
    const a = [...this.messages].reverse().find((m) => m.role === 'assistant');
    return a ? a.text : '';
  }

  reconnect() {
    this.close({ keep: true });
    this._closed = false;
    this.disconnected = false;
    this.liveState = null;
    this.permission = null;
    this.pendingPermissions = [];
    this.question = null;
    this.pendingQuestions = [];
    this.start();
  }

  // The OpenCode server keeps running in tmux on the target; reconnect() attaches again.
  disconnect() {
    if (this.disconnected) return;
    this.close();
    this._setDisconnected();
  }

  // Current model of this OpenCode session (falls back to the server default).
  async refreshModel() {
    try {
      const s = await this.client.getSession(this.agentSessionId);
      if (s && s.title) this.title = s.title;
      if (s && s.agent) this.activeAgent = s.agent;
      let ref = s && s.model;
      if (!ref || !ref.id) {
        const d = (await this.client.api('GET', '/api/model/default')).data;
        ref = d ? { providerID: d.providerID, id: d.modelID || d.id } : null;
      }
      const models = await this.client.listModels().catch(() => []);
      const m = ref && models.find((x) => x.providerID === ref.providerID && x.id === ref.id);
      this.contextLimit = (m && m.contextLimit) || 0;
      if (this.usage && this.contextLimit) this.usage = { ...this.usage, size: this.contextLimit };
      this.modelRef = ref ? { providerID: ref.providerID, id: ref.id, variant: ref.variant && ref.variant !== 'default' ? ref.variant : '' } : null;
      this.model = ref ? `${ref.providerID}/${ref.id}${m && m.name ? ' (' + m.name + ')' : ''}${this.modelRef.variant ? ' · ' + this.modelRef.variant : ''}` : '';
    } catch { this.model = ''; }
    this._emitUpdate(true);
  }

  // Slash commands: built-ins handled by the app, OpenCode custom commands and skills.
  async slashCommands() {
    if (!this.client) throw new Error(`Agent ${this.name} is not connected`);
    const [commands, skills] = await Promise.all([this.client.commands().catch(() => []), this.client.skills().catch(() => [])]);
    return {
      builtin: SLASH_BUILTINS,
      commands: commands.map((c) => ({ name: c.name, description: c.description || '' })),
      skills,
    };
  }

  // Runs "/name args" (or "!cmd"). Returns {handled: 'ui', name} for commands the UI handles itself.
  async runSlash(input) {
    if (!this.client || !this.agentSessionId) throw new Error(`Agent ${this.name} is not connected`);
    const text = input.trim();
    if (text.startsWith('!')) return this._shell(text.slice(1).trim());
    const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
    if (!m) throw new Error('Not a slash command');
    const [, name, args] = m;
    this.hadInput = true;
    switch (name) {
      case 'model': case 'login': case 'help': return { handled: 'ui', name };
      case 'stop': await this.interrupt(); return { ok: true };
      case 'compact':
        this._setActivity('compacting', 'Compacting context…');
        await this.client.compact(this.agentSessionId);
        this.refreshSoon();
        return { ok: true };
      case 'shell': return this._shell(args.trim());
      case 'new': {
        const s = await this.client.createSession();
        this.agentSessionId = s.id;
        if (this.command) await this.client.setInstructions(s.id, 'termclaw-start', this.command).catch(() => {});
        if (this.chosenModel) await this.client.setModel(s.id, this.chosenModel, this.chosenModel.variant || undefined).catch(() => {});
        this.mgr.persistOpen(this.projectId);
        this.messages = [];
        this.usage = null;
        this.plan = [];
        this.title = '';
        this.liveState = null;
        this.permission = null;
        this.pendingPermissions = [];
        this.question = null;
        this.pendingQuestions = [];
        this._setActivity('idle');
        this._emitLive(true);
        this.mgr.emit('agent-messages', this, this.messages);
        await this.refreshModel();
        return { ok: true };
      }
      default: {
        const { commands, skills } = await this.slashCommands();
        if (commands.some((c) => c.name === name)) {
          await this.client.command(this.agentSessionId, name, args);
        } else {
          const skill = skills.find((s) => s.id === name || s.name === name);
          if (!skill) throw new Error(`Unknown command /${name}. Type / to see the available commands.`);
          await this.client.prompt(this.agentSessionId, args || `Use the ${skill.name} skill.`, { skills: [skill.id] });
        }
        this.setStatus('working', 'input');
        this._setActivity('thinking', `Running /${name}…`);
        this.refreshSoon();
        return { ok: true };
      }
    }
  }

  async _shell(command) {
    if (!command) throw new Error('Usage: /shell <command>  or  !<command>');
    this.hadInput = true;
    this._setActivity('shell', `$ ${command.slice(0, 60)}`);
    await this.client.shell(this.agentSessionId, command);
    this.refreshSoon();
    return { ok: true };
  }

  async listModels() {
    if (!this.client) throw new Error(`Agent ${this.name} is not connected`);
    return { current: this.modelRef || null, models: await this.client.listModels() };
  }

  // Switch the model of this session; remembered so it is applied again after a reconnect or restart.
  async changeModel(providerID, id, variant) {
    if (!this.client || !this.agentSessionId) throw new Error(`Agent ${this.name} is not connected`);
    await this.client.setModel(this.agentSessionId, { providerID, id }, variant || undefined);
    this.chosenModel = { providerID, id, variant: variant || '' };
    this.mgr.persistOpen(this.projectId);
    await this.refreshModel();
    this._log(`model set to ${providerID}/${id}${variant ? ' (' + variant + ')' : ''}`);
  }

  info() {
    return {
      ...super.info(),
      agentSessionId: this.agentSessionId,
      url: this.client && this.client.url,
      model: this.model || '',
      title: this.title || '',
      usage: this.usage || null,
      activity: this.activity || null,
      plan: this.plan || [],
      permission: this.permission || null,
      question: this.question || null,
      approval: this.approval || 'ask',
      agentOptions: this.agentOptions(),
    };
  }

  // Values persisted with the open-session list so the agent can be re-attached after restart.
  persistExtra() {
    return {
      agentKey: this.agentKey,
      remotePort: this.remotePort,
      agentSessionId: this.agentSessionId,
      model: this.chosenModel || null,
      approval: this.approval || 'ask',
    };
  }

  close({ killTmux = false } = {}) {
    this._closed = true;
    clearTimeout(this._rt);
    clearTimeout(this._updTimer);
    clearTimeout(this._liveTimer);
    if (this.client) this.client.close();
    if (this.server) this.server.stop();
    for (const p of this.procs) { try { p.kill(); } catch {} }
    this.procs = [];
    if (killTmux && this.tmuxName) {
      const project = this.project;
      const script = `tmux kill-session -t ${shq('=' + this.tmuxName)} 2>/dev/null; true`;
      try {
        if (project.type === 'wsl') spawn('wsl.exe', [...(project.wslDistro ? ['-d', project.wslDistro] : []), '--', 'bash', '-lc', script], { windowsHide: true, stdio: 'ignore' });
        else if (project.type === 'ssh') {
          const host = project.hostId ? this.mgr.store.getHost(project.hostId) : null;
          const target = resolveTarget(project, host);
          spawn('ssh', [...batchOpts(project, host), ...sshBaseArgs(project, target), sshDest(target), script], { windowsHide: true, stdio: 'ignore', env: specEnv({ env: authEnv(project, host) }) });
        }
      } catch {}
    }
  }
}

module.exports = { AgentSession };
