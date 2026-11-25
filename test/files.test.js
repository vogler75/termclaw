'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseList, filesFor, LIST_SCRIPT, CWD_SCRIPT, READ_SCRIPT } = require('../src/main/files');
const { buildSpawn } = require('../src/main/connect');

test('directory listing output is parsed: folders first, names with spaces and tabs', () => {
  const out = '/home/bob/proj\n\0f\t12\t1700000000.5\tz file.txt\0d\t4096\t1700000001\tsrc\0f\t3\t1700000002\ta\tb\0d\t0\t0\t.\0';
  const r = parseList(out);
  assert.strictEqual(r.path, '/home/bob/proj');
  assert.deepStrictEqual(r.entries.map((e) => [e.type, e.name]), [['dir', 'src'], ['file', 'a\tb'], ['file', 'z file.txt']]);
  assert.strictEqual(r.entries[2].mtime, 1700000000500);
  assert.strictEqual(r.entries[2].size, 12);
});

test('scripts quote paths and session ids for the remote shell', () => {
  assert.match(LIST_SCRIPT("'/tmp/a b'"), /^cd '\/tmp\/a b' \|\| exit 3; pwd -P/);
  assert.match(CWD_SCRIPT('abc-1'), /'\^TERMCLAW_SID=abc-1\$'/);
});

test('ssh shells without tmux carry the session marker for the directory lookup', () => {
  const s = buildSpawn({ name: 'p', type: 'ssh', host: 'dev1', user: 'bob', directory: '/srv', tmux: false }, null, { id: 's-42', name: 'x' });
  assert.match(s.args[s.args.length - 1], /^export TERMCLAW_SID='s-42'; cd '\/srv' && \{ s=\$\{SHELL:-\}; /);
});

test('local projects: list, exists, mkdir, upload and download copy files and folders', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termclaw-files-'));
  const proj = path.join(root, 'proj');
  const src = path.join(root, 'src');
  fs.mkdirSync(proj);
  fs.mkdirSync(path.join(src, 'folder'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a.txt'), 'A');
  fs.writeFileSync(path.join(src, 'folder', 'b.txt'), 'B');
  const f = filesFor({ type: 'local', directory: proj }, null);
  await f.upload([path.join(src, 'a.txt'), path.join(src, 'folder')], proj);
  await f.mkdir(proj, 'new');
  const l = await f.list('');
  assert.strictEqual(l.path, path.resolve(proj));
  assert.deepStrictEqual(l.entries.map((e) => `${e.type}:${e.name}`), ['dir:folder', 'dir:new', 'file:a.txt']);
  assert.deepStrictEqual(await f.exists(proj, ['a.txt', 'x', '../a.txt']), ['a.txt']);
  await assert.rejects(f.mkdir(proj, '../escape'), /Invalid/);
  const dl = path.join(root, 'dl');
  fs.mkdirSync(dl);
  await f.download([{ path: path.join(proj, 'folder'), type: 'dir' }, { path: path.join(proj, 'a.txt'), type: 'file' }], dl);
  assert.strictEqual(fs.readFileSync(path.join(dl, 'folder', 'b.txt'), 'utf8'), 'B');
  assert.strictEqual(fs.readFileSync(path.join(dl, 'a.txt'), 'utf8'), 'A');
  fs.rmSync(root, { recursive: true, force: true });
});

test('local files read: text, truncation, binary detection, image dataUrl, and remote read script quoting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termclaw-read-'));
  try {
    fs.writeFileSync(path.join(root, 'note.md'), '# Hello\nworld\n');
    fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(200));
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
    fs.writeFileSync(path.join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const f = filesFor({ type: 'local', directory: root }, null);

    const md = await f.read(path.join(root, 'note.md'));
    assert.strictEqual(md.binary, false);
    assert.strictEqual(md.truncated, false);
    assert.strictEqual(md.content, '# Hello\nworld\n');

    const big = await f.read(path.join(root, 'big.txt'), { maxBytes: 50 });
    assert.strictEqual(big.binary, false);
    assert.strictEqual(big.truncated, true);
    assert.strictEqual(big.size, 200);
    assert.strictEqual(big.content.length, 50);

    const bin = await f.read(path.join(root, 'bin.dat'));
    assert.strictEqual(bin.binary, true);
    assert.strictEqual(bin.dataUrl, '');
    assert.strictEqual(bin.content, '');

    const img = await f.read(path.join(root, 'pic.png'));
    assert.strictEqual(img.binary, true);
    assert.strictEqual(img.mime, 'image/png');
    assert.ok(img.dataUrl.startsWith('data:image/png;base64,'));

    await assert.rejects(f.read(root), /Not a regular file/);

    const script = READ_SCRIPT("/tmp/a b/c'd.yml", 1024);
    assert.match(script, /^f='\/tmp\/a b\/c'\\''d\.yml';/);
    assert.match(script, /head -c 1024 "\$f" \| base64$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('file viewer helpers: format detection, JSON validation, and syntax tokenization', () => {
  const { detectFormat, validateJson, tokenizeLine } = require('../src/renderer/file-viewer.js');

  assert.deepStrictEqual(detectFormat('README.md'), { id: 'markdown', label: 'Markdown', previewable: true });
  assert.deepStrictEqual(detectFormat('docker-compose.yml'), { id: 'yaml', label: 'YAML', previewable: false });
  assert.deepStrictEqual(detectFormat('package.json'), { id: 'json', label: 'JSON', previewable: false });
  assert.deepStrictEqual(detectFormat('Dockerfile'), { id: 'shell', label: 'Dockerfile', previewable: false });
  assert.deepStrictEqual(detectFormat('logo.svg'), { id: 'xml', label: 'SVG', previewable: true });
  assert.deepStrictEqual(detectFormat('main.rs'), { id: 'code', label: 'Rust', previewable: false });

  const okJson = validateJson('{"a":1,"b":true}');
  assert.strictEqual(okJson.valid, true);
  assert.match(okJson.pretty, /\n  "a": 1,/);
  assert.strictEqual(validateJson('{bad}').valid, false);

  const jsonToks = tokenizeLine('  "name": "termclaw",', 'json');
  assert.ok(jsonToks.some((t) => t.cls === 'tok-key' && t.text.includes('"name"')));
  assert.ok(jsonToks.some((t) => t.cls === 'tok-str' && t.text === '"termclaw"'));

  const ymlToks = tokenizeLine('  port: 8080 # web', 'yaml');
  assert.ok(ymlToks.some((t) => t.cls === 'tok-key' && t.text === 'port'));
  assert.ok(ymlToks.some((t) => t.cls === 'tok-num' && t.text === '8080'));
  assert.ok(ymlToks.some((t) => t.cls === 'tok-cmt' && t.text.includes('# web')));

  const mdToks = tokenizeLine('## Heading', 'markdown');
  assert.deepStrictEqual(mdToks, [{ cls: 'tok-h', text: '## Heading' }]);
});
