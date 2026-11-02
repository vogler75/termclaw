'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const connect = require('../src/main/connect');
const askpass = require('../src/main/askpass');
const { isPasswordPrompt } = require('../src/main/sessions');
const { Store } = require('../src/main/store');

const project = { id: 'p1', type: 'ssh', host: 'box', user: 'bob', port: 22, tmux: false };

test('stored password: BatchMode is replaced by the askpass helper only for that target', (t) => {
  t.after(() => connect.setAskpass({ file: '', lookup: () => '' }));
  connect.setAskpass({ file: '/x/ssh-askpass.sh', lookup: (p, host) => (host ? '' : p.id === 'p1' ? 's3cret' : '') });
  const ex = connect.buildRemoteExec(project, null, 'true');
  assert.ok(ex.args.includes('BatchMode=no') && ex.args.includes('NumberOfPasswordPrompts=1'));
  assert.ok(!ex.args.includes('BatchMode=yes'));
  assert.deepStrictEqual(ex.env, { SSH_ASKPASS: '/x/ssh-askpass.sh', SSH_ASKPASS_REQUIRE: 'force', TERMCLAW_SSH_PASSWORD: 's3cret' });
  assert.ok(!ex.args.join(' ').includes('s3cret'), 'the password never appears on the command line');
  assert.strictEqual(connect.buildSpawn(project, null, { id: 's', name: 'shell' }).passwordFill, true);

  const other = connect.buildRemoteExec({ ...project, id: 'p2' }, null, 'true');
  assert.ok(other.args.includes('BatchMode=yes'));
  assert.strictEqual(other.env, null);
  assert.strictEqual(connect.buildSpawn({ ...project, id: 'p2' }, null, { id: 's', name: 'shell' }).passwordFill, false);
  assert.strictEqual(connect.specEnv(other), process.env);
});

test('password prompts are recognised in terminal output', () => {
  assert.ok(isPasswordPrompt("Welcome\r\nbob@box's password: "));
  assert.ok(isPasswordPrompt('\x1b[1m(bob@box) Password:\x1b[0m '));
  assert.ok(!isPasswordPrompt("bob@box's password: \r\nPermission denied, please try again.\r\n"));
  assert.ok(!isPasswordPrompt('Are you sure you want to continue connecting (yes/no/[fingerprint])? '));
  assert.ok(!isPasswordPrompt('bob@box:~$ '));
});

test('stored passwords are not exported and survive an import', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pw-'));
  const s = new Store(dir);
  const h = s.saveHost({ name: 'box', hostname: 'box', password: 'plain' });
  s.setCredential('host:' + h.id, 'enc:abc');
  s.saveNow();
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.strictEqual(file.hosts[0].password, undefined);
  assert.strictEqual(file.credentials['host:' + h.id], 'enc:abc');
  const exported = s.exportJson();
  assert.ok(!exported.includes('enc:abc') && !exported.includes('credentials'));
  s.importJson(JSON.stringify({ hosts: [], credentials: { 'host:x': 'plain:evil' } }));
  assert.deepStrictEqual(s.data.credentials, { ['host:' + h.id]: 'enc:abc' });
  s.deleteHost(h.id);
  assert.deepStrictEqual(s.data.credentials, {});
  s.saveNow();
});

// The helper prints the password for password prompts only; special characters come through unchanged.
function runHelper(file, prompt, pw) {
  const env = { ...process.env, TERMCLAW_SSH_PASSWORD: pw };
  const r = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/c', file, prompt], { env, encoding: 'utf8' })
    : spawnSync(file, [prompt], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.replace(/\r?\n$/, '') };
}

test('askpass helper answers password prompts only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ap-'));
  const file = askpass.install(dir);
  assert.ok(file && fs.existsSync(file));
  const pw = 'p&a!s%s"x <y> |z^';
  assert.deepStrictEqual(runHelper(file, "bob@box's password: ", pw), { code: 0, out: pw });
  assert.deepStrictEqual(runHelper(file, '(bob@box) Password: ', pw), { code: 0, out: pw });
  assert.strictEqual(runHelper(file, 'Are you sure you want to continue connecting (yes/no/[fingerprint])? ', pw).code, 1);
  assert.strictEqual(runHelper(file, "bob@box's password: ", '').code, 1);
});

test('a project on a dev host can log in as another user', () => {
  const host = { id: 'h1', hostname: 'devbox', user: 'bob', port: 22 };
  const onHost = { id: 'p3', type: 'ssh', hostId: 'h1', user: 'stale-inline-user', tmux: false };
  assert.strictEqual(connect.resolveTarget(onHost, host).user, 'bob', 'the old inline user field is not an override');
  const ex = connect.buildRemoteExec({ ...onHost, hostUser: 'alice' }, host, 'true');
  assert.ok(ex.args.includes('alice@devbox'));
  assert.strictEqual(connect.resolveTarget({ type: 'ssh', host: 'box', user: 'carol', hostUser: 'x' }, null).user, 'carol');
});
