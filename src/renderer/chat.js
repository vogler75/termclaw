// Structured chat view for OpenCode Server API and ACP agent sessions (also reused by Orchestrators).
import { h, clear, toast, modal } from './ui.js';

const ACTIVE_TOOL = new Set(['running', 'pending', 'in_progress', 'streaming']);
const TOOL_ICON = { completed: '✓', error: '✗', failed: '✗', running: '◌', pending: '◌', in_progress: '◌', streaming: '◌' };

// Tick live elapsed timers once per second without rebuilding any DOM.
let elapsedTimer = null;
function ensureElapsedTicker() {
  if (elapsedTimer) return;
  elapsedTimer = setInterval(() => {
    const now = Date.now();
    document.querySelectorAll('[data-elapsed-since]').forEach((el) => {
      const since = Number(el.dataset.elapsedSince);
      if (since) el.textContent = fmtElapsed(now - since);
    });
    document.querySelectorAll('[data-countdown-to]').forEach((el) => {
      const to = Number(el.dataset.countdownTo);
      if (!to) return;
      const rem = Math.max(0, Math.ceil((to - now) / 1000));
      el.textContent = rem > 0 ? `in ${rem}s` : 'now';
    });
  }, 1000);
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function fmtDuration(start, end) {
  if (!start || !end || end < start) return '';
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  return ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

// Merge an OpenCode live streaming overlay ({text, thought, tools, compaction}) into the message list without duplicating.
function mergeLive(list, live) {
  if (!live) return { items: list, extraText: '', compaction: '' };
  if (typeof live === 'string') return { items: list, extraText: live, compaction: '' };
  const hasContent = live.text || live.thought || (live.tools && live.tools.length);
  if (!hasContent) return { items: list, extraText: '', compaction: live.compaction || '' };

  const items = list.slice();
  const last = items[items.length - 1];
  if (last && last.role === 'assistant' && !last.done) {
    const toolMap = new Map((last.tools || []).map((t) => [t.id, { ...t }]));
    for (const t of live.tools || []) {
      const prev = toolMap.get(t.id);
      toolMap.set(t.id, prev ? { ...prev, ...t, input: t.input !== undefined && t.input !== '' ? t.input : prev.input, result: t.result || prev.result, diffs: (t.diffs && t.diffs.length) ? t.diffs : prev.diffs } : t);
    }
    items[items.length - 1] = {
      ...last,
      text: (live.text && live.text.length >= (last.text || '').length) ? live.text : last.text,
      thought: (live.thought && live.thought.length >= (last.thought || '').length) ? live.thought : last.thought,
      tools: [...toolMap.values()],
      _live: true,
    };
  } else {
    items.push({
      id: '__live__',
      role: 'assistant',
      text: live.text || '',
      thought: live.thought || '',
      tools: live.tools || [],
      done: false,
      _live: true,
    });
  }
  return { items, extraText: '', compaction: live.compaction || '' };
}

export function renderMessages(container, messages, live, { compact = false } = {}) {
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
  // Expanded tool calls and thinking blocks stay expanded across live re-renders.
  const open = container._openTools || (container._openTools = new Set());
  const openThoughts = container._openThoughts || (container._openThoughts = new Set());
  clear(container);
  const rawList = (messages || []).filter((m) => m.role !== 'idle');
  const { items, extraText, compaction } = mergeLive(rawList, live);
  const shown = compact ? items.slice(-6) : items;
  let toolGroup = null; // consecutive tool-only assistant messages share one box

  for (const m of shown) {
    const tools = m.tools || [];
    const thought = m.thought || '';
    const isEvent = m.role === 'user' && (m.text || '').startsWith('[TermClaw event]');
    if (m.role === 'assistant' && !m.text && !thought && tools.length && !m.error) {
      if (!toolGroup) {
        toolGroup = h('div', { class: 'msg assistant tools-only' + (m._live ? ' live' : '') }, m.time && !compact ? h('div', { class: 'meta' }, new Date(m.time).toLocaleTimeString()) : null);
        container.appendChild(toolGroup);
      }
      tools.forEach((t, i) => toolGroup.appendChild(toolLine(t, `${m.id}:${t.id || i}`, open, compact)));
      continue;
    }
    toolGroup = null;
    const thinking = m.role === 'assistant' && !m.text && !thought && !tools.length && !m.done;
    const el = h('div', { class: 'msg ' + (isEvent ? 'event' : m.role) + (m._live ? ' live' : '') + (m.compaction ? ' compaction' : '') },
      m.time && !compact ? h('div', { class: 'meta' }, new Date(m.time).toLocaleTimeString() + (isEvent ? ' · event' : '') + (m.cost ? ` · $${m.cost.toFixed(m.cost < 1 ? 3 : 2)}` : '')) : null,
      thought ? thoughtBlock(thought, m.id, openThoughts, !m.done && !m.text && !tools.length, compact) : null,
      tools.length ? h('div', { class: 'tool-list' }, tools.map((t, i) => toolLine(t, `${m.id}:${t.id || i}`, open, compact))) : null,
      thinking ? h('span', { class: 'thinking' }, 'thinking…')
        : m.text ? (m.role === 'assistant' && !compact ? markdown(m.text) : m.text) : null,
      m.retry ? h('div', { class: 'warn', style: { fontSize: '12px', marginTop: '4px' } }, `↻ Retry #${m.retry.attempt || 1}: ${(m.retry.error && m.retry.error.message) || 'retrying…'}`) : null,
      m.error ? h('div', { class: 'bad', style: { marginTop: '4px' } }, m.error) : null);
    container.appendChild(el);
  }
  if (compaction) container.appendChild(h('div', { class: 'msg system live compaction' }, 'Compacting context…\n' + compaction));
  if (extraText) container.appendChild(h('div', { class: 'msg assistant live' }, compact ? extraText : markdown(extraText)));
  if (!shown.length && !extraText && !compaction) container.appendChild(h('div', { class: 'muted' }, 'No messages yet.'));
  if (atBottom || compact) container.scrollTop = container.scrollHeight;
}

function thoughtBlock(text, key, openSet, active, compact) {
  const lines = String(text).trim().split('\n').filter((l) => l.trim());
  const preview = (lines[lines.length - 1] || '').trim().slice(0, 110);
  if (compact) return h('div', { class: 'thought-compact' }, active ? '◌ Thinking: ' : 'Thought: ', preview);
  const det = h('details', { class: 'thought-box' + (active ? ' active' : ''), open: openSet.has(key) },
    h('summary', { class: 'thought-head' },
      h('span', { class: 'thought-icon' + (active ? ' spin' : '') }, active ? '◌' : '✦'),
      h('span', { class: 'thought-label' }, active ? 'Reasoning…' : 'Thought'),
      preview ? h('span', { class: 'thought-preview' }, preview) : null),
    h('div', { class: 'thought-body' }, text));
  det.addEventListener('toggle', () => { if (det.open) openSet.add(key); else openSet.delete(key); });
  return det;
}

// The most telling argument of a tool call (path, pattern, command, ...), shortened.
function toolSubject(t) {
  if (t.locations && t.locations.length) {
    const loc = t.locations[0];
    return loc.path + (loc.line ? ':' + loc.line : '');
  }
  const input = t.input;
  if (typeof input === 'string') return input.trim().slice(0, 80);
  if (!input || typeof input !== 'object') return '';
  for (const k of ['path', 'filePath', 'file_path', 'fileName', 'pattern', 'command', 'cmd', 'url', 'query', 'description', 'prompt']) {
    if (typeof input[k] === 'string' && input[k]) return input[k];
  }
  const first = Object.values(input).find((v) => typeof v === 'string' && v);
  return first || '';
}

// First meaningful line of a tool result, e.g. "Found 8 matches" or "Read file …, lines 1-426".
function toolSummary(result) {
  const line = String(result || '').split('\n').map((l) => l.trim()).find((l) => l && !/^[{[]/.test(l));
  return line ? line.replace(/^→\s*/, '').slice(0, 120) : '';
}

// Compute line-level diff entries ({type: 'ctx'|'add'|'del'|'hunk', text}) from unified diff or oldText/newText.
function computeDiffRows(d) {
  if (d.unified) {
    const rows = [];
    let added = 0, removed = 0;
    for (const line of String(d.unified).split('\n')) {
      if (/^(?:diff --git|index |--- |\+\+\+ )/.test(line)) continue;
      if (line.startsWith('@@')) rows.push({ type: 'hunk', text: line });
      else if (line.startsWith('+')) { added++; rows.push({ type: 'add', text: line }); }
      else if (line.startsWith('-')) { removed++; rows.push({ type: 'del', text: line }); }
      else rows.push({ type: 'ctx', text: line });
    }
    return { rows, added, removed };
  }
  const oldLines = d.oldText ? String(d.oldText).split('\n') : [];
  const newLines = d.newText ? String(d.newText).split('\n') : [];
  // Trim common prefix and suffix first so large files diff cleanly and fast.
  let pre = 0;
  while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) pre++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > pre && newEnd > pre && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  const a = oldLines.slice(pre, oldEnd);
  const b = newLines.slice(pre, newEnd);

  const raw = [];
  if (pre > 0) {
    const ctxStart = Math.max(0, pre - 2);
    if (ctxStart > 0) raw.push({ type: 'hunk', text: `@@ … ${ctxStart} unchanged lines @@` });
    for (let i = ctxStart; i < pre; i++) raw.push({ type: 'ctx', text: ' ' + oldLines[i] });
  }
  let added = 0, removed = 0;
  if (a.length * b.length <= 40000) {
    // Classic LCS DP on the changed middle slice.
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) { raw.push({ type: 'ctx', text: ' ' + a[i++] }); j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { removed++; raw.push({ type: 'del', text: '-' + a[i++] }); }
      else { added++; raw.push({ type: 'add', text: '+' + b[j++] }); }
    }
    while (i < m) { removed++; raw.push({ type: 'del', text: '-' + a[i++] }); }
    while (j < n) { added++; raw.push({ type: 'add', text: '+' + b[j++] }); }
  } else {
    for (const l of a) { removed++; raw.push({ type: 'del', text: '-' + l }); }
    for (const l of b) { added++; raw.push({ type: 'add', text: '+' + l }); }
  }
  const sufCount = oldLines.length - oldEnd;
  if (sufCount > 0) {
    for (let i = 0; i < Math.min(2, sufCount); i++) raw.push({ type: 'ctx', text: ' ' + oldLines[oldEnd + i] });
    if (sufCount > 2) raw.push({ type: 'hunk', text: `@@ … ${sufCount - 2} unchanged lines @@` });
  }
  return { rows: raw.slice(0, 400), added, removed };
}

function diffStats(diffs) {
  if (!diffs || !diffs.length) return null;
  let added = 0, removed = 0;
  for (const d of diffs) {
    const r = computeDiffRows(d);
    added += r.added;
    removed += r.removed;
  }
  return added || removed ? { added, removed } : null;
}

function renderDiffView(d) {
  const { rows } = computeDiffRows(d);
  return h('div', { class: 'diff-block' },
    d.path ? h('div', { class: 'diff-path mono' }, d.path) : null,
    h('div', { class: 'diff-lines mono' },
      rows.map((r) => h('div', { class: 'diff-line diff-' + r.type }, r.text || ' '))));
}

function toolLine(t, key, open, compact) {
  const active = ACTIVE_TOOL.has(t.status);
  const icon = TOOL_ICON[t.status] || '•';
  const cls = t.status === 'completed' ? 'ok' : (t.status === 'error' || t.status === 'failed') ? 'bad' : 'warn';
  const dur = fmtDuration(t.startedAt, t.completedAt);
  const ds = !compact ? diffStats(t.diffs) : null;
  const hasInput = t.input !== undefined && t.input !== null && t.input !== '' && !(typeof t.input === 'object' && !Object.keys(t.input).length);
  const head = h('summary', { class: 'tool-head' },
    h('span', { class: 'tool-icon ' + cls + (active ? ' spin' : '') }, icon),
    h('span', { class: 'tool-name' }, t.name || 'tool'),
    h('span', { class: 'tool-subject mono' }, toolSubject(t)),
    ds ? h('span', { class: 'diff-stat mono' },
      ds.added ? h('span', { class: 'ok' }, '+' + ds.added) : null,
      ds.added && ds.removed ? ' ' : null,
      ds.removed ? h('span', { class: 'bad' }, '-' + ds.removed) : null) : null,
    !compact ? h('span', { class: 'tool-summary' }, toolSummary(t.result)) : null,
    dur ? h('span', { class: 'tool-dur mono' }, dur) : null);
  if (compact) return h('div', { class: 'tool-call' }, head);
  const det = h('details', { class: 'tool-call', open: open.has(key) },
    head,
    h('div', { class: 'tool-body' },
      t.locations && t.locations.length ? h('div', { class: 'tool-locs' }, t.locations.map((l) => h('span', { class: 'tag mono' }, l.path + (l.line ? ':' + l.line : '')))) : null,
      t.diffs && t.diffs.length ? h('div', null, h('div', { class: 'tool-label' }, 'Changes'), ...t.diffs.map(renderDiffView)) : null,
      hasInput ? h('div', { class: 'tool-label' }, 'Input') : null,
      hasInput ? h('pre', { class: 'tool-pre' }, typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2)) : null,
      t.result ? h('div', { class: 'tool-label' }, 'Output') : null,
      t.result ? h('pre', { class: 'tool-pre' }, t.result) : null));
  det.addEventListener('toggle', () => { if (det.open) open.add(key); else open.delete(key); });
  return det;
}

// Small Markdown renderer for agent answers (code blocks with copy, inline code, bold, italic, links, quotes, headings, lists).
// Builds DOM nodes, never HTML strings, so agent output cannot inject markup.
function markdown(text) {
  const root = h('div', { class: 'md' });
  const lines = String(text).split('\n');
  let i = 0;
  let listEl = null;
  const closeList = () => { listEl = null; };
  while (i < lines.length) {
    const raw = lines[i];
    const fence = /^```(\S*)\s*$/.exec(raw.trimEnd());
    if (fence) {
      closeList();
      const lang = fence[1] || '';
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trimEnd())) { codeLines.push(lines[i]); i++; }
      if (i < lines.length) i++;
      const code = codeLines.join('\n');
      const copyBtn = h('button', {
        class: 'md-copy',
        title: 'Copy code',
        onclick: () => {
          navigator.clipboard?.writeText(code).then(() => {
            copyBtn.textContent = 'Copied';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
          }).catch(() => {});
        },
      }, 'Copy');
      root.appendChild(h('div', { class: 'md-code-wrap' },
        h('div', { class: 'md-code-bar' }, h('span', { class: 'mono' }, lang || 'code'), copyBtn),
        h('pre', { class: 'md-code' }, code)));
      continue;
    }
    const line = raw.replace(/\s+$/, '');
    const head = /^(#{1,4})\s+(.*)$/.exec(line);
    const olItem = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    const ulItem = !olItem ? /^\s*[-*]\s+(.*)$/.exec(line) : null;
    const quote = /^>\s?(.*)$/.exec(line);
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      closeList();
      root.appendChild(h('hr', { class: 'md-hr' }));
    } else if (olItem || ulItem) {
      const wantTag = olItem ? 'OL' : 'UL';
      if (!listEl || listEl.tagName !== wantTag) {
        const startNum = olItem ? Number(olItem[1]) : 1;
        listEl = h(wantTag.toLowerCase(), olItem && startNum !== 1 ? { start: startNum } : null);
        root.appendChild(listEl);
      }
      listEl.appendChild(h('li', null, inline((olItem || ulItem)[olItem ? 2 : 1])));
    } else if (quote) {
      closeList();
      root.appendChild(h('blockquote', { class: 'md-quote' }, inline(quote[1])));
    } else if (!line.trim()) {
      // Keep an open list alive across blank lines if the next non-blank line continues it.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const next = j < lines.length ? lines[j] : '';
      const continues = listEl && ((listEl.tagName === 'OL' && /^\s*\d+\.\s+/.test(next)) || (listEl.tagName === 'UL' && /^\s*[-*]\s+/.test(next)));
      if (!continues) closeList();
    } else {
      closeList();
      if (head) root.appendChild(h('div', { class: 'md-h md-h' + head[1].length }, inline(head[2])));
      else root.appendChild(h('p', null, inline(line)));
    }
    i++;
  }
  return root;
}

function inline(text) {
  const out = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) out.push(h('code', { class: 'md-inline' }, tok.slice(1, -1)));
    else if (tok.startsWith('**')) out.push(h('b', null, inline(tok.slice(2, -2))));
    else if (tok.startsWith('*')) out.push(h('em', null, inline(tok.slice(1, -1))));
    else if (m[2] && m[3]) out.push(h('a', { href: m[3], target: '_blank', rel: 'noreferrer', class: 'md-link' }, m[2]));
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderChat(ctx, box, s, { compact = false } = {}) {
  ensureElapsedTicker();
  const { S, call } = ctx;
  const log = h('div', { class: 'chat-log', 'data-sid': s.id, 'data-compact': compact ? '1' : '' });
  const status = h('div', { class: 'chat-status', 'data-chat-status': s.id });
  const plan = h('div', { class: 'plan-box', 'data-plan': s.id });
  const activity = h('div', { class: 'activity-box', 'data-activity': s.id });
  const perm = h('div', { class: 'perm-box', 'data-perm': s.id });
  const question = h('div', { class: 'question-box', 'data-question': s.id });
  const chat = h('div', { class: 'chat' }, compact ? null : status, log, compact ? null : plan, compact ? null : activity, compact ? null : perm, compact ? null : question);
  box.appendChild(chat);
  fillStatus(ctx, status, s);
  if (!compact) {
    const ta = h('textarea', { placeholder: s.kind === 'acp'
      ? 'Prompt for the agent… (Enter to send, Shift+Enter for a new line, / for commands)'
      : 'Prompt for the agent… (Enter to send, Shift+Enter for a new line, / for commands, !cmd for shell)' });
    // The chat view is redrawn on status changes: keep the draft and the focus across redraws.
    const drafts = S.chatDrafts || (S.chatDrafts = new Map());
    ta.value = drafts.get(s.id) || '';
    ta.addEventListener('input', () => drafts.set(s.id, ta.value));
    ta.addEventListener('focus', () => { S.chatFocus = s.id; });
    ta.addEventListener('blur', () => { setTimeout(() => { if (S.chatFocus === s.id && !document.activeElement?.closest?.('.chat-input')) S.chatFocus = null; }, 0); });
    // A microtask runs right after this redraw, before the next key event, so no keystroke is lost.
    if (S.chatFocus === s.id) queueMicrotask(() => { if (ta.isConnected) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; } });
    const slash = slashMenu(ctx, s.id, ta);
    // After a redraw, reopen the command menu for a restored "/..." draft.
    if (S.chatFocus === s.id && /^\/\S*$/.test(ta.value)) queueMicrotask(() => { if (ta.isConnected) ta.dispatchEvent(new Event('input')); });
    const sendIt = async () => {
      const text = ta.value.trim();
      if (!text) return;
      ta.value = '';
      drafts.delete(s.id);
      slash.close();
      try {
        if (/^[/!]/.test(text)) await runSlash(ctx, s.id, text);
        else await call('agentSend', s.id, text);
      } catch (e) { toast(e.message, { error: true }); ta.value = text; }
    };
    ta.addEventListener('keydown', (e) => {
      if (slash.onKey(e)) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendIt(); }
    });
    const busy = s.status === 'working' || s.status === 'starting';
    chat.appendChild(h('div', { class: 'chat-input', style: { position: 'relative' } }, slash.el, ta,
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('button', { class: 'primary', onclick: sendIt }, 'Send'),
        h('button', {
          class: busy ? 'danger' : '',
          disabled: !busy,
          'data-stop-btn': s.id,
          onclick: () => call('agentInterrupt', s.id),
          title: 'Interrupt the current run',
        }, 'Stop'))));
  }
  renderMessages(log, S.agentMessages.get(s.id), S.agentLive.get(s.id), { compact });
  if (!compact) {
    renderPlan(ctx, s.id);
    renderActivity(ctx, s.id);
    renderPermission(ctx, s.id);
    renderQuestion(ctx, s.id);
  }
}

export function fillStatus(ctx, el, s) {
  if (!s) return;
  // Live usage updates redraw this bar; do not close a dropdown the user has open.
  if (document.activeElement && document.activeElement.tagName === 'SELECT' && el.contains(document.activeElement)) return;
  clear(el);
  const info = ctx.S.sessions.get(s.id) || s;
  const titleTip = [
    info.agentSessionId ? `${info.kind === 'acp' ? 'ACP' : 'OpenCode'} session ${info.agentSessionId}${info.url ? ' at ' + info.url : ''}` : '',
    info.title ? `Title: ${info.title}` : '',
  ].filter(Boolean).join('\n');
  el.append(...[
    ctx.dot(info.status),
    h('span', { class: info.status === 'working' ? 'warn' : '' }, ctx.STATUS_LABEL[info.status] || info.status),
    h('span', { title: titleTip }, info.kind === 'acp' ? `${info.agentName || 'Agent'} · ACP` : 'OpenCode · API'),
    info.model ? h('button', { class: 'model-btn', title: 'Change the model of this session', onclick: () => pickModel(ctx, s.id) }, info.model + ' ▾')
      : info.status !== 'starting' && info.status !== 'error' ? h('span', { class: 'warn' }, '· no model — log in to a provider') : null,
    // Agent settings published over ACP (Mode, etc.) or OpenCode (Agent build/plan).
    ...(info.agentOptions || []).map((o) => h('label', { class: 'status-select', title: o.description || o.name }, o.name,
      h('select', { onchange: (e) => ctx.call('agentSetOption', s.id, o.id, e.target.value).catch((err) => toast(err.message, { error: true })) },
        o.options.map((x) => h('option', { value: x.value, selected: x.value === o.current }, x.name))))),
    h('label', { class: 'status-select', title: 'How permission requests of the agent are answered' }, 'Approvals',
      h('select', { onchange: (e) => ctx.call('agentSetApproval', s.id, e.target.value).catch((err) => toast(err.message, { error: true })) },
        [['ask', 'Ask'], ['reads', 'Auto-approve reads'], ['all', 'Auto-approve all']].map(([v, l]) => h('option', { value: v, selected: (info.approval || 'ask') === v }, l)))),
    usageBlock(info.usage),
    h('span', { class: 'spacer' }),
    h('button', { title: 'View protocol & connection log', onclick: () => showAgentLog(ctx, s.id) }, 'Log'),
    h('button', { title: info.kind === 'acp' ? `Open a terminal to log in to ${info.agentName || 'the agent'}` : 'Open a terminal with “opencode auth login” to connect a provider (API key or OAuth)', onclick: () => providerLogin(ctx, s.id) }, info.kind === 'acp' ? 'Login' : 'Provider login'),
    h('button', { class: 'icon', title: 'Refresh model & session info', onclick: () => ctx.call('agentRefreshModel', s.id) }, '↻'),
    info.status === 'error' || info.status === 'disconnected' ? h('button', { onclick: () => ctx.call('reconnect', s.id) }, 'Reconnect') : null,
    // Full-width block: start errors can span several lines (server log excerpt).
    info.error ? h('div', { class: 'bad mono', style: { flexBasis: '100%', whiteSpace: 'pre-wrap', fontSize: '12px', maxHeight: '220px', overflow: 'auto' } }, info.error) : null,
  ].filter(Boolean));
}

// Token usage: visual context window meter + cumulative session tokens and cost.
const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
const fmtNum = (n) => Number(n || 0).toLocaleString();
function usageBlock(u) {
  if (!u || (!u.used && !u.totalTokens && !(u.cost && u.cost.amount))) return null;
  const pct = u.used && u.size ? Math.min(100, Math.round((u.used / u.size) * 100)) : null;
  const barCls = pct === null ? '' : pct >= 85 ? 'bad' : pct >= 65 ? 'warn' : 'ok';
  const parts = [];
  if (u.used) parts.push(`${fmtTokens(u.used)}${u.size ? '/' + fmtTokens(u.size) + ` (${pct}%)` : ' ctx'}`);
  if (u.totalTokens) parts.push(`${fmtTokens(u.totalTokens)} tok`);
  if (u.cost && typeof u.cost.amount === 'number' && u.cost.amount > 0) {
    parts.push(`${u.cost.currency === 'USD' ? '$' : (u.cost.currency || '') + ' '}${u.cost.amount.toFixed(u.cost.amount < 1 ? 3 : 2)}`);
  }
  const tipLines = [];
  if (u.used || u.size) tipLines.push(`Context window: ${fmtNum(u.used)} / ${u.size ? fmtNum(u.size) : '?'} tokens${pct !== null ? ` (${pct}%)` : ''}`);
  if (u.totalTokens) {
    tipLines.push(`Session total: ${fmtNum(u.totalTokens)} tokens in ${u.turns || 0} turn(s)`);
    tipLines.push(`  Input: ${fmtNum(u.inputTokens)} · Output: ${fmtNum(u.outputTokens)}`);
    const thought = u.reasoningTokens || u.thoughtTokens || 0;
    if (thought) tipLines.push(`  Reasoning / thought: ${fmtNum(thought)}`);
    const cRead = u.cacheReadTokens || u.cachedReadTokens || 0;
    const cWrite = u.cacheWriteTokens || u.cachedWriteTokens || 0;
    if (cRead || cWrite) tipLines.push(`  Cache: ${fmtNum(cRead)} read · ${fmtNum(cWrite)} write`);
  }
  if (u.cost && typeof u.cost.amount === 'number') {
    tipLines.push(`Cost: ${u.cost.currency === 'USD' ? '$' : (u.cost.currency || '') + ' '}${u.cost.amount.toFixed(4)}`);
  }
  return h('span', { class: 'usage-wrap', title: tipLines.join('\n') },
    pct !== null ? h('span', { class: 'ctx-meter' }, h('span', { class: 'ctx-fill ' + barCls, style: { width: pct + '%' } })) : null,
    h('span', { class: 'usage' }, parts.join(' · ')));
}

// Live activity indicator pinned above the input while the agent is working, connecting, retrying, or awaiting input.
export function renderActivity(ctx, id) {
  ensureElapsedTicker();
  const s = ctx.S.sessions.get(id);
  const busy = s && (s.status === 'working' || s.status === 'starting');
  document.querySelectorAll(`[data-stop-btn="${id}"]`).forEach((btn) => {
    btn.disabled = !busy;
    btn.classList.toggle('danger', !!busy);
  });
  document.querySelectorAll(`.activity-box[data-activity="${id}"]`).forEach((el) => {
    clear(el);
    if (!s) return;
    const act = s.activity;
    const waitingPrompt = s.permission || s.question;
    if (!busy && !waitingPrompt && (!act || act.phase === 'idle')) return;
    const phase = (act && act.phase) || (s.status === 'starting' ? 'connecting' : waitingPrompt ? (s.permission ? 'permission' : 'question') : 'thinking');
    const detail = (act && act.detail) || (phase === 'connecting' ? 'Connecting…' : phase === 'reasoning' ? 'Reasoning…' : phase === 'responding' ? 'Writing response…' : phase === 'compacting' ? 'Compacting context…' : 'Working…');
    const isPaused = phase === 'permission' || phase === 'question';
    const isRetry = phase === 'retry';
    el.append(...[
      isPaused ? h('span', { class: 'warn' }, '⚠') : h('span', { class: 'spinner' + (isRetry ? ' warn' : '') }),
      h('span', { class: 'activity-text' + (isRetry || isPaused ? ' warn' : '') }, detail),
      isRetry && act && act.nextAt ? h('span', { class: 'activity-meta mono', 'data-countdown-to': act.nextAt }, `in ${Math.max(0, Math.ceil((act.nextAt - Date.now()) / 1000))}s`) : null,
      act && act.startedAt && !isPaused ? h('span', { class: 'activity-meta mono', 'data-elapsed-since': act.startedAt }, fmtElapsed(Date.now() - act.startedAt)) : null,
      s.queuedCount > 0 ? h('span', { class: 'tag' }, `+${s.queuedCount} queued`) : null,
    ].filter(Boolean));
  });
}

// Pinned collapsible Plan / Todo tracker (from ACP `plan` or OpenCode `todo.updated`).
export function renderPlan(ctx, id) {
  const s = ctx.S.sessions.get(id);
  const openSet = ctx.S.planOpen || (ctx.S.planOpen = new Set());
  document.querySelectorAll(`.plan-box[data-plan="${id}"]`).forEach((el) => {
    clear(el);
    const plan = s && s.plan;
    if (!plan || !plan.length) return;
    const done = plan.filter((x) => x.status === 'completed').length;
    const current = plan.find((x) => x.status === 'in_progress');
    const det = h('details', { class: 'plan-details', open: openSet.has(id) },
      h('summary', { class: 'plan-head' },
        h('span', { class: 'plan-title' }, `Plan · ${done}/${plan.length}`),
        h('span', { class: 'ctx-meter' }, h('span', { class: 'ctx-fill ok', style: { width: Math.round((done / plan.length) * 100) + '%' } })),
        current ? h('span', { class: 'plan-cur' }, '▸ ' + current.content) : null),
      h('div', { class: 'plan-items' }, plan.map((item) => {
        const ico = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '▸' : item.status === 'cancelled' ? '✗' : '○';
        const cls = item.status === 'completed' ? 'ok' : item.status === 'in_progress' ? 'warn' : 'muted';
        return h('div', { class: 'plan-item ' + (item.status === 'completed' ? 'done' : '') },
          h('span', { class: 'plan-ico ' + cls }, ico),
          h('span', null, item.content),
          item.priority ? h('span', { class: 'tag' }, item.priority) : null);
      })));
    det.addEventListener('toggle', () => { if (det.open) openSet.add(id); else openSet.delete(id); });
    el.appendChild(det);
  });
}

async function showAgentLog(ctx, sessionId) {
  const lines = await ctx.call('agentLog', sessionId).catch(() => []);
  modal({
    title: 'Agent connection & protocol log',
    okText: null,
    cancelText: 'Close',
    body: lines.length
      ? h('pre', { class: 'tool-pre', style: { maxHeight: '420px' } }, lines.join('\n'))
      : h('div', { class: 'muted' }, 'No log entries yet.'),
  });
}

async function providerLogin(ctx, sessionId) {
  try { const t = await ctx.call('agentLogin', sessionId); ctx.selectSession(t.id); } catch (e) { toast(e.message, { error: true }); }
}

// Runs a slash command; commands that need UI (model picker, login, help) are handled here.
async function runSlash(ctx, sessionId, text) {
  const r = await ctx.call('agentRunSlash', sessionId, text);
  if (!r || r.handled !== 'ui') return;
  if (r.name === 'model') return pickModel(ctx, sessionId);
  if (r.name === 'login') return providerLogin(ctx, sessionId);
  if (r.name === 'help') {
    const c = await ctx.call('agentSlashCommands', sessionId);
    const row = (name, desc, tag) => h('tr', null, h('td', { class: 'mono' }, '/' + name), h('td', null, desc || ''), h('td', { class: 'muted' }, tag));
    modal({
      title: 'Commands', okText: null, cancelText: 'Close',
      body: h('table', { class: 'list' },
        c.builtin.map((x) => row(x.name + (x.args ? ' ' + x.args : ''), x.description, 'app')),
        c.commands.map((x) => row(x.name, x.description, 'command')),
        c.skills.map((x) => row(x.id, x.description.slice(0, 140), 'skill')),
        h('tr', null, h('td', { class: 'mono' }, '!<command>'), h('td', null, 'Run a shell command in the project'), h('td', { class: 'muted' }, 'app'))),
    });
  }
}

// Autocomplete list shown above the input while typing "/name".
function slashMenu(ctx, sessionId, ta) {
  const el = h('div', { class: 'slash-menu', style: { display: 'none' } });
  let items = [];
  let shown = [];
  let index = 0;
  let loaded = null;
  const load = () => loaded || (loaded = ctx.call('agentSlashCommands', sessionId).then((c) => {
    items = [
      ...c.builtin.map((x) => ({ name: x.name, desc: x.description, tag: 'app', args: x.args })),
      ...c.commands.map((x) => ({ name: x.name, desc: x.description, tag: 'command', args: x.args })),
      ...c.skills.map((x) => ({ name: x.id, desc: x.description, tag: 'skill' })),
    ];
  }).catch(() => { loaded = null; }));
  const close = () => { el.style.display = 'none'; shown = []; };
  const render = () => {
    clear(el);
    shown.forEach((it, i) => el.appendChild(h('div', {
      class: 'slash-item' + (i === index ? ' active' : ''),
      onmousedown: (e) => { e.preventDefault(); index = i; complete(); },
    }, h('span', { class: 'mono' }, '/' + it.name + (it.args ? ' ' + it.args : '')), h('span', { class: 'muted' }, it.desc.slice(0, 90)), h('span', { class: 'tag' }, it.tag))));
    el.style.display = shown.length ? '' : 'none';
  };
  const update = async () => {
    const m = /^\/(\S*)$/.exec(ta.value);
    if (!m) return close();
    await load();
    const q = m[1].toLowerCase();
    shown = items.filter((it) => it.name.toLowerCase().startsWith(q)).concat(items.filter((it) => !it.name.toLowerCase().startsWith(q) && it.name.toLowerCase().includes(q))).slice(0, 12);
    index = Math.min(index, Math.max(0, shown.length - 1));
    render();
  };
  const complete = () => {
    const it = shown[index];
    if (!it) return;
    ta.value = '/' + it.name + ' ';
    close();
    ta.focus();
  };
  ta.addEventListener('input', () => { index = 0; update(); });
  ta.addEventListener('blur', () => setTimeout(close, 150));
  return {
    el,
    close,
    // Returns true when the key was used by the menu.
    onKey(e) {
      if (!shown.length) return false;
      if (e.key === 'ArrowDown') { index = (index + 1) % shown.length; render(); e.preventDefault(); return true; }
      if (e.key === 'ArrowUp') { index = (index - 1 + shown.length) % shown.length; render(); e.preventDefault(); return true; }
      if (e.key === 'Escape') { close(); e.preventDefault(); return true; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        const it = shown[index];
        // Enter on an exact match without arguments runs it directly.
        if (e.key === 'Enter' && it && ta.value.trim() === '/' + it.name && !it.args) { close(); return false; }
        complete(); e.preventDefault(); return true;
      }
      return false;
    },
  };
}

// Model picker: models of all logged-in providers, grouped by provider, with search and effort (variant).
async function pickModel(ctx, sessionId) {
  let data;
  try { data = await ctx.call('agentModels', sessionId); } catch (e) { toast(e.message, { error: true }); return; }
  const { current, models } = data;
  let selected = current ? models.find((m) => m.providerID === current.providerID && m.id === current.id) : null;
  const search = h('input', { placeholder: `Search ${models.length} models…` });
  const list = h('div', { class: 'model-list' });
  const variant = h('select', { style: { width: 'auto' } });
  const fillVariants = () => {
    clear(variant);
    const vs = (selected && selected.variants) || [];
    variant.appendChild(h('option', { value: '' }, 'default'));
    for (const v of vs) variant.appendChild(h('option', { value: v, selected: current && current.variant === v && selected.id === current.id }, v));
    variant.disabled = !vs.length;
  };
  // Sorted by provider, then name, so each provider gets one header.
  const sorted = [...models].sort((a, b) => a.providerID.localeCompare(b.providerID) || a.name.localeCompare(b.name));
  const isCurrent = (m) => current && m.providerID === current.providerID && m.id === current.id;
  const renderList = () => {
    clear(list);
    const q = search.value.trim().toLowerCase();
    const shown = sorted.filter((m) => !q || `${m.providerID}/${m.id} ${m.name}`.toLowerCase().includes(q));
    let provider = null;
    for (const m of shown) {
      if (m.providerID !== provider) {
        provider = m.providerID;
        list.appendChild(h('div', { class: 'model-group' }, provider));
      }
      list.appendChild(h('label', { class: 'model-row' + (selected === m ? ' selected' : '') },
        h('input', { type: 'radio', name: 'model', checked: selected === m, onchange: () => { selected = m; fillVariants(); renderList(); } }),
        h('span', { class: 'model-name' }, m.name,
          isCurrent(m) ? h('span', { class: 'tag', style: { marginLeft: '6px' } }, 'current') : null,
          m.contextLimit ? h('span', { class: 'tag', style: { marginLeft: '4px' } }, fmtTokens(m.contextLimit) + ' ctx') : null),
        h('span', { class: 'model-id mono' }, m.id)));
    }
    if (!shown.length) list.appendChild(h('div', { class: 'muted', style: { padding: '8px' } }, 'No model matches.'));
  };
  search.addEventListener('input', renderList);
  renderList();
  fillVariants();
  modal({
    title: 'Model for this agent session',
    body: h('div', null,
      search, h('div', { style: { height: '8px' } }), list,
      h('div', { class: 'row', style: { marginTop: '10px' } }, h('span', { class: 'muted' }, 'Effort / variant:'), variant),
      h('p', { class: 'muted' }, 'Only models of logged-in providers are listed. Use “Provider login” to add more (e.g. Anthropic, OpenAI, GitHub Copilot).')),
    okText: 'Use model',
    onOk: async () => {
      if (!selected) throw new Error('Choose a model');
      await ctx.call('agentSetModel', sessionId, selected.providerID, selected.id, variant.value);
      toast(`Model: ${selected.providerID}/${selected.id}${variant.value ? ' (' + variant.value + ')' : ''}`);
    },
  });
}

// Permission request (ACP or OpenCode Server API): one button per option.
export function renderPermission(ctx, id) {
  const s = ctx.S.sessions.get(id);
  document.querySelectorAll(`.perm-box[data-perm="${id}"]`).forEach((el) => {
    clear(el);
    const p = s && s.permission;
    if (!p) return;
    const answer = async (optionId) => {
      try { await ctx.call('agentPermission', id, optionId); } catch (e) { toast(e.message, { error: true }); }
    };
    el.append(...[
      h('div', { class: 'perm-title' }, '⚠ The agent asks for permission: ', h('b', null, p.title)),
      p.input ? h('div', { class: 'tool' }, JSON.stringify(p.input).slice(0, 600)) : null,
      h('div', { class: 'row', style: { marginTop: '6px', flexWrap: 'wrap' } },
        ...(p.options || []).map((o) => h('button', { class: /allow/.test(o.kind) ? 'primary' : '', onclick: () => answer(o.id) }, o.name)),
        h('button', { onclick: () => answer(null) }, 'Cancel')),
    ].filter(Boolean));
  });
}

// Interactive question prompt (OpenCode v2 `question` tool).
export function renderQuestion(ctx, id) {
  const s = ctx.S.sessions.get(id);
  document.querySelectorAll(`.question-box[data-question="${id}"]`).forEach((el) => {
    clear(el);
    const qReq = s && s.question;
    if (!qReq || !qReq.questions || !qReq.questions.length) return;
    const answers = qReq.questions.map(() => new Set());
    const customInputs = qReq.questions.map(() => '');
    const blocks = qReq.questions.map((q, qi) => {
      const multi = !!q.multiple;
      const optEls = (q.options || []).map((opt) => {
        const input = h('input', {
          type: multi ? 'checkbox' : 'radio',
          name: `q-${qReq.id}-${qi}`,
          onchange: () => {
            if (!multi) answers[qi].clear();
            if (input.checked) answers[qi].add(opt.label); else answers[qi].delete(opt.label);
          },
        });
        return h('label', { class: 'q-opt' }, input, h('span', null, h('b', null, opt.label), opt.description ? h('span', { class: 'muted' }, ' — ' + opt.description) : null));
      });
      const customEl = q.custom !== false ? h('input', {
        placeholder: 'Or type a custom answer…',
        oninput: (e) => { customInputs[qi] = e.target.value; },
      }) : null;
      return h('div', { class: 'q-item' },
        h('div', { class: 'q-header' }, q.header ? h('span', { class: 'tag' }, q.header) : null, h('b', null, q.question)),
        optEls.length ? h('div', { class: 'q-opts' }, optEls) : null,
        customEl);
    });
    const submit = async () => {
      const payload = qReq.questions.map((_, qi) => {
        const list = [...answers[qi]];
        const custom = customInputs[qi].trim();
        if (custom) list.push(custom);
        return list;
      });
      try { await ctx.call('agentQuestionReply', id, payload); } catch (e) { toast(e.message, { error: true }); }
    };
    const reject = async () => {
      try { await ctx.call('agentQuestionReject', id); } catch (e) { toast(e.message, { error: true }); }
    };
    el.append(
      h('div', { class: 'perm-title' }, '? The agent has a question:'),
      ...blocks,
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'primary', onclick: submit }, 'Submit answer'),
        h('button', { onclick: reject }, 'Dismiss')));
  });
}

export function renderChatLog(ctx, id) {
  document.querySelectorAll(`.chat-log[data-sid="${id}"]`).forEach((el) => {
    renderMessages(el, ctx.S.agentMessages.get(id), ctx.S.agentLive.get(id), { compact: el.dataset.compact === '1' });
  });
}
