'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const u = require('../src/main/usage');

const now = Date.UTC(2026, 10, 16, 8, 0, 0);
const sec = (ms) => Math.floor(ms / 1000);

test('usage: Claude Code status line payload → windows; a window past its reset is shown as reset', () => {
  const payload = JSON.stringify({ model: { id: 'x' }, rate_limits: { five_hour: { used_percentage: 42.4, resets_at: sec(now) + 3600 }, seven_day: { used_percentage: 81, resets_at: sec(now) - 10 } } });
  const p = u.parseClaude(payload, now - 5000, now);
  assert.strictEqual(p.id, 'claude');
  assert.deepStrictEqual(p.windows[0], { label: '5 h', usedPercent: 42.4, resetsAt: now + 3600e3 });
  assert.deepStrictEqual(p.windows[1], { label: 'week', usedPercent: null, resetsAt: null, reset: true });
  assert.strictEqual(p.stale, false);
  assert.strictEqual(u.parseClaude('{"model":{}}', now, now), null);
  assert.strictEqual(u.parseClaude('not json', now, now), null);
  assert.strictEqual(u.parseClaude(payload, now - 7 * 3600e3, now).stale, true);
});

test('usage: Codex session line → windows, with reset as a time or as seconds from the event', () => {
  const line = JSON.stringify({ timestamp: new Date(now - 60000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_in_seconds: 600 }, secondary: { used_percent: 90.5, window_minutes: 10080, resets_at: sec(now) + 86400 } } } });
  const p = u.parseCodex(line, now);
  assert.deepStrictEqual(p.windows, [
    { label: '5 h', usedPercent: 12, resetsAt: now - 60000 + 600e3 },
    { label: 'week', usedPercent: 90.5, resetsAt: now + 86400e3 },
  ]);
  assert.strictEqual(p.capturedAt, now - 60000);
  assert.strictEqual(u.parseCodex('{"payload":{"type":"token_count"}}', now), null);
  assert.strictEqual(u.windowLabel(1440), '1 d');
});

test('usage: collected output → providers, hook flag and the fullest running window', () => {
  const claude = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 30, resets_at: sec(now) + 60 } } });
  const codex = JSON.stringify({ timestamp: new Date(now).toISOString(), payload: { rate_limits: { primary: { used_percent: 55, window_minutes: 300, resets_at: sec(now) + 60 } } } });
  const r = u.parseCollect(`@@CLAUDE_AGE 120\r\n@@CLAUDE ${claude}\n@@CLAUDE_HOOK 1\n@@CODEX ${codex}\n@@DONE\n`, now);
  assert.strictEqual(r.claudeHook, true);
  assert.deepStrictEqual(r.providers.map((p) => p.id), ['claude', 'codex']);
  assert.strictEqual(r.providers[0].capturedAt, now - 120000);
  assert.deepStrictEqual(u.tightest(r.providers), { provider: 'Codex', label: '5 h', usedPercent: 55, resetsAt: now + 60000 });
  assert.deepStrictEqual(u.parseCollect('@@DONE\n', now), { providers: [], claudeHook: false });
});

test('usage: status line in settings.json — set, keep the former command, put it back', () => {
  const fresh = u.applyStatusLine('');
  assert.strictEqual(fresh.former, null);
  assert.deepStrictEqual(JSON.parse(fresh.text), { statusLine: { type: 'command', command: u.STATUS_COMMAND } });
  const own = u.applyStatusLine(JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: '~/bin/line.sh', padding: 0 } }));
  assert.strictEqual(own.former, '~/bin/line.sh');
  assert.deepStrictEqual(JSON.parse(own.text), { model: 'opus', statusLine: { type: 'command', command: u.STATUS_COMMAND, padding: 0 } });
  const again = u.applyStatusLine(own.text);
  assert.strictEqual(again.already, true);
  assert.strictEqual(again.former, null);
  assert.deepStrictEqual(JSON.parse(u.removeStatusLine(own.text, '~/bin/line.sh\n')), { model: 'opus', statusLine: { type: 'command', command: '~/bin/line.sh', padding: 0 } });
  assert.deepStrictEqual(JSON.parse(u.removeStatusLine(fresh.text, '')), {});
  assert.strictEqual(u.removeStatusLine('{"statusLine":{"command":"mine"}}', ''), null); // not ours: left alone
  assert.throws(() => u.applyStatusLine('{broken'), /not valid JSON/);
});

test('usage: the status line script stores the payload and runs the former status line; the collect script reads it', { skip: process.platform === 'win32' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'termclaw-usage-'));
  const dir = path.join(home, '.termclaw', 'usage');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), u.applyStatusLine('').text);
  fs.writeFileSync(path.join(dir, 'claude-statusline.sh'), u.STATUSLINE_SCRIPT);
  fs.writeFileSync(path.join(dir, 'claude-statusline-user'), 'echo "mine: $(cat | wc -c | tr -d " ")"\n');
  const env = { ...process.env, HOME: home, CODEX_HOME: '' };
  const soon = sec(Date.now()) + 3600;
  const payload = JSON.stringify({ cwd: '/x', rate_limits: { five_hour: { used_percentage: 7, resets_at: soon } } });
  const out = execFileSync('sh', [path.join(dir, 'claude-statusline.sh')], { input: payload, env }).toString();
  assert.strictEqual(out.trim(), 'mine: ' + payload.length);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'claude.json'), 'utf8'), payload);
  // a payload without rate limits (API key login) keeps the last reading
  execFileSync('sh', [path.join(dir, 'claude-statusline.sh')], { input: '{"cwd":"/x"}', env });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'claude.json'), 'utf8'), payload);

  const sess = path.join(home, '.codex', 'sessions', '2026', '11', '16');
  fs.mkdirSync(sess, { recursive: true });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), payload: { type: 'token_count', rate_limits: { primary: { used_percent: 61, window_minutes: 300, resets_at: soon } } } });
  fs.writeFileSync(path.join(sess, 'rollout-a.jsonl'), '{"type":"session_meta"}\n' + line + '\n{"type":"other"}\n');
  const collected = execFileSync('sh', ['-c', u.COLLECT_SCRIPT], { env }).toString();
  const r = u.parseCollect(collected);
  assert.strictEqual(r.claudeHook, true);
  assert.deepStrictEqual(r.providers.map((p) => [p.id, p.windows[0].usedPercent]), [['claude', 7], ['codex', 61]]);
  assert.strictEqual(u.collectLocalCodex(home).windows[0].usedPercent, 61);
  fs.rmSync(home, { recursive: true, force: true });
});
