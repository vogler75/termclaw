'use strict';
// Agent Client Protocol (ACP): JSON-RPC 2.0 over the agent's stdin/stdout, one JSON message per line.
// AcpSession is a session type with the same interface as the OpenCode HTTP agent session, so the
// chat view, model picker, slash commands, MCP tools and orchestrators work with any ACP agent.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const os = require('os');
const { BaseSession } = require('./sessions');
const { findOpencode } = require('./opencode');
const { resolveTarget, sshBaseArgs, sshDest, batchOpts, authEnv, specEnv, projectDir, posixDir, shq, SSH_BIN } = require('./connect');
const { Target } = require('./coding-agents/target');

const IS_WIN = process.platform === 'win32';

// Agents with an ACP mode (verified: `opencode acp`, `copilot --acp`).
const ACP_AGENTS = {
  opencode: { name: 'OpenCode', bin: 'opencode', args: ['acp'], login: ['auth', 'login'] },
  copilot: { name: 'GitHub Copilot', bin: 'copilot', args: ['--acp'], login: ['login'] },
  // Any other ACP agent: the project's acpCommands.custom is the full command line.
  custom: { name: 'Other ACP agent', bin: '', args: [], login: null },
};

const BUILTINS = [
  { name: 'model', description: 'Choose the model for this session' },
  { name: 'new', description: 'Start a new conversation' },
  { name: 'stop', description: 'Cancel the current turn' },
  { name: 'login', description: 'Log in to the agent (opens a terminal)' },
  { name: 'help', description: 'Show available commands' },
];

// Splits a command line into program and arguments ("quoted parts" stay together).
function splitCommand(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

class AcpConnection extends EventEmitter {
  constructor(proc) {
    super();
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.stderr = '';
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      buf += d;
      let n;
      while ((n = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, n).trim();
        buf = buf.slice(n + 1);
        if (line) this._onLine(line);
      }
    });
    proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    // 'close' fires after stdout/stderr are fully read, so stderr is complete for error messages.
    proc.on('close', (code) => {
      for (const p of this.pending.values()) { const e = new Error(`agent exited (${code})`); e.exitCode = code; p.reject(e); }
      this.pending.clear();
      this.emit('exit', code);
    });
    proc.stdin.on('error', () => {});
  }

  _write(msg) {
    if (this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; } // ignore non-protocol output
    if (msg.method && msg.id !== undefined) return this._onRequest(msg);
    if (msg.method) return this.emit('notification', msg.method, msg.params || {});
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      const e = new Error(msg.error.message || 'ACP error');
      e.code = msg.error.code;
      e.data = msg.error.data;
      p.reject(e);
    } else p.resolve(msg.result);
  }

  async _onRequest(msg) {
    const h = this.handlers.get(msg.method);
    if (!h) return this._write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not supported: ${msg.method}` } });
    try {
      this._write({ jsonrpc: '2.0', id: msg.id, result: (await h(msg.params || {})) ?? null });
    } catch (e) {
      this._write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } });
    }
  }

  onRequest(method, handler) { this.handlers.set(method, handler); }

  request(method, params, { timeout = 0 } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let t = null;
      if (timeout) t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this._write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) { this._write({ jsonrpc: '2.0', method, params }); }
}

class AcpSession extends BaseSession {
  constructor(mgr, project, opts) {
    super(mgr, project, { ...opts, kind: 'acp' });
    this.acpAgent = ACP_AGENTS[opts.acpAgent] ? opts.acpAgent : 'opencode';
    this.acpSessionId = opts.acpSessionId || null;
    this.chosenModel = opts.model || null;
    this.messages = [];
    this.log = [];
    this.commands = [];
    this.configOptions = [];
    this.models = null; // {availableModels, currentModelId} (Copilot style)
    this.permission = null; // pending permission request shown in the UI
    this.approval = ['ask', 'reads', 'all'].includes(opts.approval) ? opts.approval : 'ask';
    this.activity = null;
    this.plan = [];
    this.title = '';
    this.inFlight = 0;
    this.queue = Promise.resolve();
    if (this.disconnected) this.status = 'disconnected'; else this.start();
  }

  get agentDef() {
    if (this.acpAgent !== 'custom') return ACP_AGENTS[this.acpAgent];
    const [bin, ...args] = splitCommand((this.project.acpCommands || {}).custom || '');
    return { name: bin ? bin.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '') : 'ACP agent', bin: bin || '', args, login: null, custom: true };
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
      this._emitUsage(true);
      return;
    }
    const startedAt = this.activity && this.activity.phase !== 'connecting' && phase !== 'connecting'
      ? this.activity.startedAt
      : Date.now();
    this.activity = { phase, detail, startedAt, ...extra };
    this._emitUsage();
  }

  // ---------- process ----------
  _spawnSpec() {
    const project = this.project;
    const host = project.hostId ? this.mgr.store.getHost(project.hostId) : null;
    const def = this.agentDef;
    const cmd = def.custom ? def.bin : (project.acpCommands && project.acpCommands[this.acpAgent]) || def.bin;
    if (!cmd) throw new Error('No ACP command configured. Set it in the project settings (type "Other ACP agent").');
    const dir = projectDir(project, host);

    if (project.type === 'local') {
      const cwd = dir ? dir.replace(/^~(?=$|[\\/])/, os.homedir()) : os.homedir();
      let bin = cmd;
      if (this.acpAgent === 'opencode' && cmd === 'opencode') bin = findOpencode(this.mgr.store.settings.opencodePath) || cmd;
      // Bare command names on Windows may be .cmd/.ps1 shims: start them through the shell.
      const viaShell = IS_WIN && !/\.exe$/i.test(bin);
      return { file: bin, args: def.args, cwd, shell: viaShell };
    }

    // Remote: resolve the binary with the user's PATH, refuse Windows binaries in WSL, then exec it.
    const t = new Target(project, host);
    const d = posixDir(dir);
    const script = [
      t.preamble(),
      d ? `cd ${d} 2>/dev/null` : ':',
      `BIN=$(command -v ${shq(cmd)} 2>/dev/null)`,
      `case "$BIN" in '') echo "@@ACP_ERR notfound" >&2; exit 127 ;; /mnt/[a-z]/*) echo "@@ACP_ERR windows $BIN" >&2; exit 127 ;; esac`,
      `exec "$BIN" ${def.args.map(shq).join(' ')}`,
    ].join('\n');
    if (project.type === 'wsl') {
      return { file: 'wsl.exe', args: [...(project.wslDistro ? ['-d', project.wslDistro] : []), '--', 'sh', '-c', script], cwd: os.homedir() };
    }
    const target = resolveTarget(project, host);
    return {
      file: SSH_BIN,
      args: ['-T', ...batchOpts(project, host), '-o', 'ConnectTimeout=10', ...sshBaseArgs(project, target), sshDest(target), `sh -c ${shq(script)}`],
      cwd: os.homedir(),
      env: authEnv(project, host),
    };
  }

  async start() {
    this.setStatus('starting');
    this._setActivity('connecting', `Starting ${this.agentDef.name} via ACP…`);
    this.error = null;
    this._closed = false;
    try {
      const project = this.project;
      if (project.type !== 'local' && !this.remoteHome) {
        // ACP needs an absolute working directory; resolve ~ on the target first.
        const host = project.hostId ? this.mgr.store.getHost(project.hostId) : null;
        const r = await new Target(project, host).run('printf "@@HOME %s\\n" "$HOME"', { timeout: 30000 });
        const m = /@@HOME (\S+)/.exec(r.out);
        if (!m) throw new Error(`Could not connect: ${(r.err || r.out).trim().slice(0, 300)}`);
        this.remoteHome = m[1];
      }
      const spec = this._spawnSpec();
      const proc = spawn(spec.file, spec.args, { cwd: spec.cwd, shell: spec.shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: specEnv(spec) });
      this.proc = proc;
      proc.on('error', (e) => this._fail(`Could not start ${this.agentDef.name}: ${e.message}`));
      const conn = new AcpConnection(proc);
      this.conn = conn;
      conn.on('notification', (method, params) => this._onNotification(method, params));
      conn.onRequest('session/request_permission', (p) => this._askPermission(p));
      conn.on('exit', (code) => { if (!this._closed) this._fail(this._exitMessage(code)); });

      const init = await conn.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'termclaw', version: require('../../package.json').version },
      }, { timeout: 60000 });
      this.agentCaps = init.agentCapabilities || {};
      this.authMethods = init.authMethods || [];
      this._log(`connected to ${this.agentDef.name} via ACP (protocol ${init.protocolVersion})`);
      await this._openSession();
      this._setActivity('idle');
      this.setStatus('waiting', 'ready');
      this.mgr.emit('updated', this);
    } catch (e) {
      this._setActivity('idle');
      this._fail(e.exitCode !== undefined ? this._exitMessage(e.exitCode) : this._explain(e));
    }
  }

  // Why the agent process ended: "not found" markers from the start script, else its last stderr lines.
  _exitMessage(code) {
    const stderr = (this.conn && this.conn.stderr) || '';
    const err = /@@ACP_ERR (\S+)\s*(.*)/.exec(stderr);
    if (err) return this._startError(err[1], err[2].trim());
    if (code === 127 || /not (be )?found|ENOENT/i.test(stderr)) return this._startError('notfound', '');
    const tail = stderr.trim().split('\n').slice(-3).join(' | ');
    return `${this.agentDef.name} exited (${code})${tail ? ': ' + tail : ''}`;
  }

  _startError(kind, extra) {
    const where = this.project.type === 'wsl' ? 'in WSL' : 'on the remote host';
    if (kind === 'windows') return `Only the Windows ${this.agentDef.name} was found (${extra}). Install the Linux version inside WSL (Agents ▾ → Install).`;
    if (this.agentDef.custom) return `"${this.agentDef.bin}" was not found ${where}. Install it there or fix the ACP command in the project settings.`;
    return `"${this.agentDef.bin}" was not found ${where}. Install it with Agents ▾ → Install ${this.agentDef.name === 'GitHub Copilot' ? 'GitHub Copilot CLI' : this.agentDef.name}.`;
  }

  // Authentication errors get a hint to the login button.
  _explain(e) {
    const msg = e.message || String(e);
    if (e.code === -32000 || /auth|login|unauthor/i.test(msg)) {
      const how = (this.authMethods || []).map((m) => m.description || m.name).filter(Boolean).join('; ');
      return `${this.agentDef.name}: ${msg}. Use “Login” to sign in${how ? ' (' + how + ')' : ''}.`;
    }
    return `${this.agentDef.name}: ${msg}`;
  }

  async _openSession() {
    const cwd = this._cwdForAgent();
    if (this.acpSessionId && this.agentCaps.loadSession) {
      try {
        this.messages = [];
        const r = await this.conn.request('session/load', { sessionId: this.acpSessionId, cwd, mcpServers: [] }, { timeout: 60000 });
        this._applySessionInfo(r || {});
        this._log('conversation restored');
        await this._applyChosenModel();
        this._emitMessages(true);
        return;
      } catch (e) {
        this._log('could not restore conversation: ' + e.message);
      }
    }
    const r = await this.conn.request('session/new', { cwd, mcpServers: [] }, { timeout: 60000 });
    this.acpSessionId = r.sessionId;
    this.messages = [];
    this._applySessionInfo(r);
    this._flushEarly();
    this.mgr.persistOpen(this.projectId);
    await this._applyChosenModel();
    this._emitMessages(true);
  }

  // The agent needs the working directory in its own path format.
  _cwdForAgent() {
    const project = this.project;
    const host = project.hostId ? this.mgr.store.getHost(project.hostId) : null;
    const dir = projectDir(project, host);
    if (project.type === 'local') return dir ? dir.replace(/^~(?=$|[\\/])/, os.homedir()) : os.homedir();
    if (this.remoteHome && dir && dir.startsWith('~')) return this.remoteHome + dir.slice(1);
    return dir && !dir.startsWith('~') ? dir : (this.remoteHome || '/tmp') + (dir ? dir.slice(1) : '');
  }

  _applySessionInfo(r) {
    if (r.configOptions) this.configOptions = r.configOptions;
    if (r.models) this.models = r.models;
    if (r.modes) this.modes = r.modes; // {availableModes: [{id, name}], currentModeId}
  }

  // Agent settings other than the model (e.g. Copilot "Mode": agent / plan / autopilot), from
  // config options and session modes. Shown as dropdowns in the UI.
  agentOptions() {
    const out = (this.configOptions || [])
      .filter((o) => o.type === 'select' && o !== this._modelOption())
      .map((o) => ({ id: 'config:' + o.id, name: o.name || o.id, description: o.description || '', current: o.currentValue, options: (o.options || []).map((x) => ({ value: x.value, name: x.name || x.value })) }));
    if (this.modes && (this.modes.availableModes || []).length && !out.some((o) => /mode/i.test(o.name))) {
      out.push({ id: 'mode', name: 'Mode', description: '', current: this.modes.currentModeId, options: this.modes.availableModes.map((m) => ({ value: m.id, name: m.name || m.id })) });
    }
    return out;
  }

  async setAgentOption(id, value) {
    if (!this.conn || !this.acpSessionId) throw new Error(`Agent ${this.name} is not connected`);
    if (id === 'mode') {
      await this.conn.request('session/set_mode', { sessionId: this.acpSessionId, modeId: value }, { timeout: 30000 });
      if (this.modes) this.modes.currentModeId = value;
    } else {
      const configId = id.replace(/^config:/, '');
      const r = await this.conn.request('session/set_config_option', { sessionId: this.acpSessionId, configId, value }, { timeout: 30000 });
      if (r && r.configOptions) this.configOptions = r.configOptions;
      else { const o = this.configOptions.find((x) => x.id === configId); if (o) o.currentValue = value; }
    }
    this._log(`${id} set to ${value}`);
    this.mgr.emit('updated', this);
  }

  // Approval policy for permission requests: 'ask' (default), 'reads' (read-only tools are approved
  // automatically) or 'all' (everything is approved). Every automatic answer is shown in the chat.
  setApproval(policy) {
    this.approval = ['ask', 'reads', 'all'].includes(policy) ? policy : 'ask';
    this.mgr.persistOpen(this.projectId);
    this.mgr.emit('updated', this);
    if (this.permission && this._autoAnswer(this.permission.kind)) this.answerPermission(this._autoAnswer(this.permission.kind));
  }

  _autoAnswer(kind, options = this.permission && this.permission.options) {
    const readOnly = ['read', 'search', 'fetch', 'think'].includes(kind);
    if (!(this.approval === 'all' || (this.approval === 'reads' && readOnly))) return null;
    const pick = (options || []).find((o) => o.kind === 'allow_once') || (options || []).find((o) => /allow/.test(o.kind));
    return pick ? pick.id : null;
  }

  _fail(message) {
    if (this.disconnected) return;
    if (this.status === 'error' && this.error === message) return;
    this.error = message;
    this._log('error: ' + message);
    this.setStatus('error', message);
    this.mgr.emit('updated', this);
  }

  // ---------- updates ----------
  _flushEarly() {
    const early = this._early || [];
    this._early = null;
    for (const p of early) if (p.sessionId === this.acpSessionId) this._onNotification('session/update', p);
  }

  _onNotification(method, p) {
    if (method !== 'session/update') return;
    // Updates sent right after the session/new answer (e.g. the command list) can be read in the same chunk,
    // before the awaiting code has stored the new session id: keep them until it has.
    if (p.sessionId && !this.acpSessionId) { (this._early || (this._early = [])).push(p); return; }
    if (p.sessionId && p.sessionId !== this.acpSessionId) return;
    const u = p.update || {};
    this.lastOutputAt = Date.now();
    switch (u.sessionUpdate) {
      case 'agent_thought_chunk': this._appendThought(u.content); break;
      case 'agent_message_chunk': this._appendText('assistant', u.content); break;
      case 'user_message_chunk': this._appendText('user', u.content); break;
      case 'tool_call': this._toolCall(u); break;
      case 'tool_call_update': this._toolUpdate(u); break;
      case 'plan': this._plan(u); break;
      case 'session_info_update':
        if (u.title !== undefined) this.title = u.title || '';
        this._emitUsage(true);
        break;
      case 'available_commands_update': this.commands = u.availableCommands || []; break;
      case 'config_option_update': this.configOptions = u.configOptions || this.configOptions; this._updateModelLabel(); break;
      case 'current_model_update': if (this.models) this.models.currentModelId = u.modelId || u.currentModelId; this._updateModelLabel(); break;
      case 'current_mode_update': if (this.modes) this.modes.currentModeId = u.currentModeId || u.modeId; this.mgr.emit('updated', this); break;
      case 'usage_update': {
        // Context usage, sent while the agent works: shown live in the status bar.
        const extra = u.usage ? {
          inputTokens: u.usage.inputTokens ?? (this.usage && this.usage.inputTokens),
          outputTokens: u.usage.outputTokens ?? (this.usage && this.usage.outputTokens),
          thoughtTokens: u.usage.thoughtTokens ?? (this.usage && this.usage.thoughtTokens),
          cachedReadTokens: u.usage.cachedReadTokens ?? (this.usage && this.usage.cachedReadTokens),
          cachedWriteTokens: u.usage.cachedWriteTokens ?? (this.usage && this.usage.cachedWriteTokens),
          totalTokens: u.usage.totalTokens ?? (this.usage && this.usage.totalTokens),
        } : {};
        this.usage = { ...(this.usage || {}), ...extra, used: u.used, size: u.size, cost: u.cost || (this.usage && this.usage.cost) };
        this._emitUsage();
        break;
      }
      default: break;
    }
  }

  _current(role) {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === role && !last.done) return last;
    if (last && last.role !== role && !last.done) last.done = true;
    const m = { id: 'm' + Date.now() + Math.random().toString(36).slice(2, 6), role, text: '', thought: '', tools: [], time: Date.now(), done: false };
    this.messages.push(m);
    return m;
  }

  _contentToText(content) {
    if (!content) return '';
    if (content.type === 'text') return content.text || '';
    if (content.type === 'resource_link') return `[${content.name || content.uri || 'resource'}]`;
    if (content.type === 'resource' && content.resource) return content.resource.text || `[${content.resource.uri || 'resource'}]`;
    if (content.type === 'image') return `[image: ${content.mimeType || 'image'}]`;
    return '';
  }

  _appendThought(content) {
    const txt = this._contentToText(content);
    if (!txt) return;
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'assistant' && !last.done && (last.text || (last.tools && last.tools.length))) last.done = true;
    const m = this._current('assistant');
    m.thought = (m.thought || '') + txt;
    this._setActivity('reasoning', 'Reasoning…');
    this._emitMessages();
  }

  _appendText(role, content) {
    const txt = this._contentToText(content);
    if (!txt) return;
    if (role === 'assistant') {
      const last = this.messages[this.messages.length - 1];
      if (last && last.role === 'assistant' && !last.done && last.tools && last.tools.length) last.done = true;
    }
    this._current(role).text += txt;
    if (role === 'assistant') this._setActivity('responding', 'Writing response…');
    this._emitMessages();
  }

  _normalizeLocations(locs) {
    if (!Array.isArray(locs)) return [];
    return locs.filter((l) => l && l.path).map((l) => ({ path: l.path, line: l.line || null }));
  }

  _extractContent(items, rawOutput) {
    const texts = [];
    const diffs = [];
    for (const c of items || []) {
      if (!c) continue;
      if (c.type === 'diff') {
        diffs.push({ path: c.path || '', oldText: c.oldText ?? '', newText: c.newText ?? '' });
      } else if (c.content && c.content.text) {
        texts.push(c.content.text);
      } else if (c.type === 'text' && c.text) {
        texts.push(c.text);
      } else if (c.type === 'terminal' && c.terminalId) {
        texts.push(`[terminal ${c.terminalId}]`);
      } else {
        const s = this._contentToText(c.content || c);
        if (s) texts.push(s);
      }
    }
    if (!texts.length && rawOutput !== undefined && rawOutput !== null) {
      texts.push(typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput, null, 2));
    }
    return { text: texts.join('\n').slice(0, 4000), diffs };
  }

  _toolSubjectText(input, locations) {
    if (locations && locations.length) return locations[0].path + (locations[0].line ? ':' + locations[0].line : '');
    if (input && typeof input === 'object') {
      for (const k of ['path', 'filePath', 'file_path', 'command', 'cmd', 'pattern', 'query', 'url', 'description']) {
        if (typeof input[k] === 'string' && input[k]) return input[k].slice(0, 60);
      }
    }
    return '';
  }

  _toolCall(u) {
    if (u.kind) (this._toolKinds || (this._toolKinds = new Map())).set(u.toolCallId, u.kind);
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'assistant' && !last.done && last.text) last.done = true;
    const m = this._current('assistant');
    const locations = this._normalizeLocations(u.locations);
    const { text, diffs } = this._extractContent(u.content, u.rawOutput);
    const tool = {
      id: u.toolCallId,
      name: u.title || u.kind || 'tool',
      kind: u.kind || '',
      status: u.status || 'pending',
      input: u.rawInput,
      locations,
      diffs,
      result: text,
      startedAt: Date.now(),
    };
    m.tools.push(tool);
    const subj = this._toolSubjectText(tool.input, locations);
    this._setActivity('tool', `Running ${tool.name}${subj && !tool.name.includes(subj) ? ': ' + subj : ''}`);
    this._emitMessages();
  }

  _toolUpdate(u) {
    let found = null;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const t = (this.messages[i].tools || []).find((x) => x.id === u.toolCallId);
      if (!t) continue;
      found = t;
      if (u.status) t.status = u.status;
      if (u.title) t.name = u.title;
      if (u.kind) {
        t.kind = u.kind;
        (this._toolKinds || (this._toolKinds = new Map())).set(u.toolCallId, u.kind);
      }
      if (u.rawInput !== undefined) t.input = u.rawInput;
      if (u.locations) t.locations = this._normalizeLocations(u.locations);
      const { text, diffs } = this._extractContent(u.content, u.rawOutput);
      if (text) t.result = text;
      if (diffs.length) {
        t.diffs = [...(t.diffs || [])];
        for (const d of diffs) {
          const idx = d.path ? t.diffs.findIndex((x) => x.path === d.path) : -1;
          if (idx >= 0) t.diffs[idx] = d; else t.diffs.push(d);
        }
      }
      if (['completed', 'failed', 'error'].includes(t.status) && !t.completedAt) t.completedAt = Date.now();
      break;
    }
    if (found) {
      if (['completed', 'failed', 'error'].includes(found.status)) {
        const active = this.messages[this.messages.length - 1]?.tools?.find((x) => ['pending', 'running', 'in_progress'].includes(x.status));
        if (active) {
          const subj = this._toolSubjectText(active.input, active.locations);
          this._setActivity('tool', `Running ${active.name}${subj && !active.name.includes(subj) ? ': ' + subj : ''}`);
        } else {
          this._setActivity('thinking', 'Processing tool result…');
        }
      } else {
        const subj = this._toolSubjectText(found.input, found.locations);
        this._setActivity('tool', `Running ${found.name}${subj && !found.name.includes(subj) ? ': ' + subj : ''}`);
      }
    }
    this._emitMessages();
  }

  _plan(u) {
    this.plan = (u.entries || []).map((e) => ({
      content: e.content || '',
      status: e.status || 'pending',
      priority: e.priority || '',
    }));
    this._emitUsage(true);
  }

  // Usage & activity change often while the agent works; tell the UI at most every 200 ms.
  _emitUsage(now) {
    if (now) { clearTimeout(this._usageTimer); this._usageTimer = null; this.mgr.emit('updated', this); return; }
    if (this._usageTimer) return;
    this._usageTimer = setTimeout(() => { this._usageTimer = null; this.mgr.emit('updated', this); }, 200);
  }

  _emitMessages(now) {
    clearTimeout(this._emitTimer);
    const fire = () => this.mgr.emit('agent-messages', this, this.messages.map((m) => ({
      ...m,
      tools: (m.tools || []).map((t) => ({ ...t, locations: (t.locations || []).slice(), diffs: (t.diffs || []).slice() })),
    })));
    if (now) fire(); else this._emitTimer = setTimeout(fire, 100);
  }

  // ---------- permissions ----------
  _askPermission(p) {
    const tc = p.toolCall || {};
    const options = (p.options || []).map((o) => ({ id: o.optionId, name: o.name, kind: o.kind }));
    // The tool kind (read, edit, execute, ...) comes with the request or with the earlier tool_call update.
    const kind = tc.kind || (this._toolKinds && this._toolKinds.get(tc.toolCallId)) || 'other';
    const title = tc.title || tc.kind || 'Tool call';
    const auto = this._autoAnswer(kind, options);
    if (auto) {
      const opt = options.find((o) => o.id === auto);
      this.messages.push({ id: 'a' + Date.now(), role: 'system', text: `Auto-approved (${this.approval === 'all' ? 'all' : 'read-only'}): ${title} → ${opt ? opt.name : auto}`, time: Date.now(), done: true });
      this._emitMessages(true);
      this._log(`auto-approved ${kind}: ${title}`);
      return Promise.resolve({ outcome: { outcome: 'selected', optionId: auto } });
    }
    return new Promise((resolve) => {
      const req = {
        id: 'perm' + Date.now(),
        title,
        kind,
        input: tc.rawInput,
        options,
        resolve,
      };
      this.permission = req;
      this.setStatus('waiting', 'permission');
      this._setActivity('permission', `Waiting for permission: ${title}`);
      this.mgr.emit('updated', this);
      this.mgr.emit('agent-permission', this, this.permissionInfo());
    });
  }

  permissionInfo() {
    if (!this.permission) return null;
    const { resolve, ...rest } = this.permission;
    return rest;
  }

  answerPermission(optionId) {
    const req = this.permission;
    if (!req) throw new Error('No pending permission request');
    this.permission = null;
    req.resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
    this.setStatus('working', 'permission answered');
    this._setActivity('thinking', 'Continuing…');
    this.mgr.emit('updated', this);
    this.mgr.emit('agent-permission', this, null);
  }

  // ---------- interface shared with the OpenCode HTTP agent session ----------
  async send(text) {
    if (!this.conn || !this.acpSessionId) throw new Error(`Agent ${this.name} is not connected`);
    if (/^[/]\S/.test(text.trim())) {
      const r = await this.runSlash(text);
      if (r && r.handled === 'ui') throw new Error(`/${r.name} needs the app window and cannot be sent`);
      return;
    }
    return this._prompt(text);
  }

  _prompt(text) {
    this.hadInput = true;
    const last = this.messages[this.messages.length - 1];
    if (last && !last.done) last.done = true;
    this.messages.push({ id: 'u' + Date.now(), role: 'user', text, time: Date.now(), done: true });
    this._emitMessages(true);
    this.inFlight++;
    this.setStatus('working', 'input');
    if (this.inFlight === 1) this._setActivity('thinking', 'Waiting for model…');
    else this._emitUsage(true);
    // ACP runs one turn at a time; further prompts wait for the current one.
    const run = this.queue.then(() => {
      this._setActivity('thinking', 'Waiting for model…');
      return this.conn.request('session/prompt', { sessionId: this.acpSessionId, prompt: [{ type: 'text', text }] });
    })
      .then((r) => {
        const cur = this.messages[this.messages.length - 1];
        if (cur && !cur.done) cur.done = true;
        if (r && r.usage) {
          // Token counts of the finished turn, summed up for the session.
          const t = this.usage || {};
          const u = r.usage;
          this.usage = {
            ...t,
            inputTokens: (t.inputTokens || 0) + (u.inputTokens || 0),
            outputTokens: (t.outputTokens || 0) + (u.outputTokens || 0),
            thoughtTokens: (t.thoughtTokens || 0) + (u.thoughtTokens || 0),
            cachedReadTokens: (t.cachedReadTokens || 0) + (u.cachedReadTokens || 0),
            cachedWriteTokens: (t.cachedWriteTokens || 0) + (u.cachedWriteTokens || 0),
            totalTokens: (t.totalTokens || 0) + (u.totalTokens || ((u.inputTokens || 0) + (u.outputTokens || 0) + (u.thoughtTokens || 0))),
            turns: (t.turns || 0) + 1,
          };
          this._emitUsage(true);
        }
        if (r && r.stopReason && r.stopReason !== 'end_turn') this.messages.push({ id: 's' + Date.now(), role: 'system', text: `Stopped: ${r.stopReason}`, time: Date.now(), done: true });
        this._emitMessages(true);
        this.inFlight = Math.max(0, this.inFlight - 1);
        if (this.inFlight === 0) {
          this._setActivity('idle');
          this.setStatus('waiting', r && r.stopReason);
        } else {
          this._emitUsage(true);
        }
      })
      .catch((e) => {
        this.messages.push({ id: 'e' + Date.now(), role: 'system', text: this._explain(e), time: Date.now(), done: true });
        this._emitMessages(true);
        this.inFlight = Math.max(0, this.inFlight - 1);
        if (this.inFlight === 0) {
          this._setActivity('idle');
          this.setStatus('waiting', 'error');
        } else {
          this._emitUsage(true);
        }
      });
    this.queue = run;
    return Promise.resolve();
  }

  async interrupt() {
    if (this.permission) this.answerPermission(null);
    if (this.conn && this.acpSessionId) this.conn.notify('session/cancel', { sessionId: this.acpSessionId });
  }

  async refresh() { return this.messages; }

  readOutput({ lines = 20 } = {}) {
    const text = this.messages.slice(-lines).map((m) => {
      let s = `[${m.role}] ${m.text || ''}`;
      for (const t of m.tools || []) s += `\n  (tool ${t.name}: ${t.status})`;
      return s;
    }).join('\n\n');
    return { text, marker: this.messages.length };
  }

  lastAssistantText() {
    const a = [...this.messages].reverse().find((m) => m.role === 'assistant' && m.text);
    return a ? a.text : '';
  }

  async slashCommands() {
    return {
      builtin: BUILTINS,
      commands: this.commands.map((c) => ({ name: c.name, description: c.description || '', args: c.input && c.input.hint ? `<${c.input.hint}>` : undefined })),
      skills: [],
    };
  }

  async runSlash(input) {
    // "!cmd" is not an ACP feature: hand it to the agent as text (some agents run it as shell).
    if (input.trim().startsWith('!')) { await this._prompt(input.trim()); return { ok: true }; }
    const m = /^\/(\S+)\s*([\s\S]*)$/.exec(input.trim());
    if (!m) throw new Error('Not a slash command');
    const name = m[1];
    if (['model', 'login', 'help'].includes(name)) return { handled: 'ui', name };
    if (name === 'stop') { await this.interrupt(); return { ok: true }; }
    if (name === 'new') {
      this.acpSessionId = null;
      const r = await this.conn.request('session/new', { cwd: this._cwdForAgent(), mcpServers: [] }, { timeout: 60000 });
      this.acpSessionId = r.sessionId;
      this.messages = [];
      this.usage = null;
      this.plan = [];
      this.title = '';
      this._setActivity('idle');
      this._applySessionInfo(r);
      this._flushEarly();
      await this._applyChosenModel();
      this.mgr.persistOpen(this.projectId);
      this._emitMessages(true);
      this.mgr.emit('updated', this);
      return { ok: true };
    }
    // Agent commands are invoked by sending the command as prompt text.
    await this._prompt(input.trim());
    return { ok: true };
  }

  // Models: OpenCode reports a "model" config option, Copilot a model list.
  _modelOption() { return (this.configOptions || []).find((o) => o.category === 'model' || o.id === 'model'); }

  async listModels() {
    const opt = this._modelOption();
    let models = [];
    let current = null;
    if (opt) {
      models = (opt.options || []).map((o) => {
        const [providerID, ...rest] = String(o.value).split('/');
        return rest.length ? { providerID, id: rest.join('/'), name: (o.name || o.value).replace(/^[^/]+\//, ''), value: o.value, variants: [] }
          : { providerID: this.acpAgent, id: o.value, name: o.name || o.value, value: o.value, variants: [] };
      });
      current = models.find((x) => x.value === opt.currentValue) || null;
    } else if (this.models) {
      models = (this.models.availableModels || []).map((x) => ({ providerID: this.acpAgent, id: x.modelId, name: x.name || x.modelId, value: x.modelId, variants: [] }));
      current = models.find((x) => x.value === this.models.currentModelId) || null;
    }
    return { current: current && { providerID: current.providerID, id: current.id, variant: '' }, models };
  }

  async changeModel(providerID, id) {
    const { models } = await this.listModels();
    const m = models.find((x) => x.providerID === providerID && x.id === id);
    if (!m) throw new Error('Unknown model');
    await this._setModelValue(m.value);
    this.chosenModel = { value: m.value };
    this.mgr.persistOpen(this.projectId);
    this._log(`model set to ${m.value}`);
  }

  async _setModelValue(value) {
    const opt = this._modelOption();
    if (opt) {
      const r = await this.conn.request('session/set_config_option', { sessionId: this.acpSessionId, configId: opt.id, value }, { timeout: 30000 });
      if (r && r.configOptions) this.configOptions = r.configOptions; else opt.currentValue = value;
    } else {
      await this.conn.request('session/set_model', { sessionId: this.acpSessionId, modelId: value }, { timeout: 30000 });
      if (this.models) this.models.currentModelId = value;
    }
    this._updateModelLabel();
  }

  async _applyChosenModel() {
    if (this.chosenModel && this.chosenModel.value) {
      await this._setModelValue(this.chosenModel.value).catch((e) => this._log(`could not apply model ${this.chosenModel.value}: ${e.message}`));
    }
    this._updateModelLabel();
  }

  _updateModelLabel() {
    const opt = this._modelOption();
    if (opt) {
      const o = (opt.options || []).find((x) => x.value === opt.currentValue);
      this.model = opt.currentValue ? `${opt.currentValue}${o && o.name ? '' : ''}` : '';
    } else if (this.models) {
      const x = (this.models.availableModels || []).find((y) => y.modelId === this.models.currentModelId);
      this.model = x ? `${x.name}` : (this.models.currentModelId || '');
    }
    this.mgr.emit('updated', this);
  }

  async refreshModel() { this._updateModelLabel(); }

  loginCommand() {
    const def = this.agentDef;
    if (!def.login) throw new Error(`No login command is known for ${def.name}; log in from a terminal.`);
    const p = this.project;
    let bin = p.acpCommands && p.acpCommands[this.acpAgent] ? p.acpCommands[this.acpAgent] : def.bin;
    if (p.type === 'local' && this.acpAgent === 'opencode' && bin === 'opencode') bin = findOpencode(this.mgr.store.settings.opencodePath) || bin;
    if (p.type === 'local' && IS_WIN) return `& '${bin.replace(/'/g, "''")}' ${def.login.join(' ')}`;
    return `${/[\s'"]/.test(bin) ? shq(bin) : bin} ${def.login.join(' ')}`;
  }

  reconnect() {
    this.close();
    this.disconnected = false;
    this.start();
  }

  // Stops the agent process; reconnect() starts it again and resumes the conversation.
  disconnect() {
    if (this.disconnected) return;
    this.close();
    this._setDisconnected();
  }

  info() {
    return {
      ...super.info(), acpAgent: this.acpAgent, agentName: this.agentDef.name, agentSessionId: this.acpSessionId,
      model: this.model || '', title: this.title || '', permission: this.permissionInfo(), usage: this.usage || null,
      activity: this.activity || null, plan: this.plan || [], queuedCount: Math.max(0, (this.inFlight || 0) - 1),
      approval: this.approval || 'ask', agentOptions: this.agentOptions(),
    };
  }

  persistExtra() {
    return { acpAgent: this.acpAgent, acpSessionId: this.acpSessionId, model: this.chosenModel || null, approval: this.approval || 'ask' };
  }

  close() {
    this._closed = true;
    clearTimeout(this._usageTimer);
    clearTimeout(this._emitTimer);
    if (this.permission) { try { this.answerPermission(null); } catch {} }
    const p = this.proc;
    this.proc = null;
    this.conn = null;
    if (!p) return;
    try {
      if (IS_WIN) spawn('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      else p.kill();
    } catch {}
  }
}

module.exports = { AcpSession, AcpConnection, ACP_AGENTS, splitCommand };
