// Syntax highlighter & GitHub-flavored Markdown previewer for the File Explorer.
// Pure DOM construction (never innerHTML with untrusted text) so viewed files cannot inject markup.

const LANG_BY_EXT = {
  '.md': { id: 'markdown', label: 'Markdown', previewable: true },
  '.markdown': { id: 'markdown', label: 'Markdown', previewable: true },
  '.mdx': { id: 'markdown', label: 'MDX', previewable: true },
  '.mkd': { id: 'markdown', label: 'Markdown', previewable: true },
  '.json': { id: 'json', label: 'JSON', previewable: false },
  '.jsonc': { id: 'json', label: 'JSONC', previewable: false },
  '.jsonl': { id: 'json', label: 'JSONL', previewable: false },
  '.yml': { id: 'yaml', label: 'YAML', previewable: false },
  '.yaml': { id: 'yaml', label: 'YAML', previewable: false },
  '.toml': { id: 'toml', label: 'TOML', previewable: false },
  '.ini': { id: 'toml', label: 'INI', previewable: false },
  '.cfg': { id: 'toml', label: 'Config', previewable: false },
  '.conf': { id: 'toml', label: 'Config', previewable: false },
  '.env': { id: 'toml', label: 'Env', previewable: false },
  '.properties': { id: 'toml', label: 'Properties', previewable: false },
  '.html': { id: 'xml', label: 'HTML', previewable: false },
  '.htm': { id: 'xml', label: 'HTML', previewable: false },
  '.xml': { id: 'xml', label: 'XML', previewable: false },
  '.svg': { id: 'xml', label: 'SVG', previewable: true },
  '.css': { id: 'css', label: 'CSS', previewable: false },
  '.scss': { id: 'css', label: 'SCSS', previewable: false },
  '.less': { id: 'css', label: 'Less', previewable: false },
  '.sh': { id: 'shell', label: 'Shell', previewable: false },
  '.bash': { id: 'shell', label: 'Bash', previewable: false },
  '.zsh': { id: 'shell', label: 'Zsh', previewable: false },
  '.fish': { id: 'shell', label: 'Fish', previewable: false },
  '.ps1': { id: 'shell', label: 'PowerShell', previewable: false },
  '.bat': { id: 'shell', label: 'Batch', previewable: false },
  '.cmd': { id: 'shell', label: 'Batch', previewable: false },
  '.sql': { id: 'sql', label: 'SQL', previewable: false },
  '.js': { id: 'code', label: 'JavaScript', previewable: false },
  '.mjs': { id: 'code', label: 'JavaScript', previewable: false },
  '.cjs': { id: 'code', label: 'JavaScript', previewable: false },
  '.jsx': { id: 'code', label: 'JSX', previewable: false },
  '.ts': { id: 'code', label: 'TypeScript', previewable: false },
  '.tsx': { id: 'code', label: 'TSX', previewable: false },
  '.py': { id: 'code', label: 'Python', previewable: false },
  '.rs': { id: 'code', label: 'Rust', previewable: false },
  '.go': { id: 'code', label: 'Go', previewable: false },
  '.c': { id: 'code', label: 'C', previewable: false },
  '.h': { id: 'code', label: 'C/C++ Header', previewable: false },
  '.cc': { id: 'code', label: 'C++', previewable: false },
  '.cpp': { id: 'code', label: 'C++', previewable: false },
  '.hpp': { id: 'code', label: 'C++ Header', previewable: false },
  '.hxx': { id: 'code', label: 'C++ Header', previewable: false },
  '.java': { id: 'code', label: 'Java', previewable: false },
  '.kt': { id: 'code', label: 'Kotlin', previewable: false },
  '.swift': { id: 'code', label: 'Swift', previewable: false },
  '.cs': { id: 'code', label: 'C#', previewable: false },
  '.rb': { id: 'code', label: 'Ruby', previewable: false },
  '.php': { id: 'code', label: 'PHP', previewable: false },
  '.lua': { id: 'code', label: 'Lua', previewable: false },
  '.zig': { id: 'code', label: 'Zig', previewable: false },
  '.dart': { id: 'code', label: 'Dart', previewable: false },
  '.dockerfile': { id: 'shell', label: 'Dockerfile', previewable: false },
};

const LANG_BY_FENCE = {
  md: 'markdown', markdown: 'markdown',
  json: 'json', jsonc: 'json', jsonl: 'json',
  yml: 'yaml', yaml: 'yaml',
  toml: 'toml', ini: 'toml', env: 'toml', conf: 'toml',
  html: 'xml', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'css', less: 'css',
  sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', powershell: 'shell', ps1: 'shell', dockerfile: 'shell',
  sql: 'sql',
  js: 'code', javascript: 'code', ts: 'code', typescript: 'code', jsx: 'code', tsx: 'code',
  py: 'code', python: 'code', rs: 'code', rust: 'code', go: 'code', c: 'code', cpp: 'code', 'c++': 'code',
  java: 'code', kt: 'code', swift: 'code', cs: 'code', rb: 'code', php: 'code', lua: 'code',
};

export function detectFormat(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const low = base.toLowerCase();
  if (low === 'dockerfile' || low.startsWith('dockerfile.')) return { id: 'shell', label: 'Dockerfile', previewable: false };
  if (low === 'makefile' || low === 'gnumakefile') return { id: 'shell', label: 'Makefile', previewable: false };
  if (low === '.gitignore' || low === '.dockerignore' || low === '.editorconfig' || low.startsWith('.env')) return { id: 'toml', label: 'Config', previewable: false };
  const dot = low.lastIndexOf('.');
  if (dot > 0 && LANG_BY_EXT[low.slice(dot)]) return LANG_BY_EXT[low.slice(dot)];
  return { id: 'text', label: 'Text', previewable: false };
}

export function validateJson(text) {
  try {
    const parsed = JSON.parse(text);
    return { valid: true, pretty: JSON.stringify(parsed, null, 2), error: '' };
  } catch (e) {
    return { valid: false, pretty: '', error: e.message };
  }
}

const CODE_KW = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'defer', 'def', 'del',
  'do', 'elif', 'else', 'enum', 'export', 'extends', 'extern', 'false', 'finally', 'fn', 'for', 'from', 'func',
  'function', 'go', 'if', 'impl', 'import', 'in', 'interface', 'is', 'lambda', 'let', 'loop', 'match', 'mod',
  'mut', 'namespace', 'new', 'nil', 'none', 'None', 'not', 'null', 'or', 'and', 'package', 'pass', 'private',
  'protected', 'pub', 'public', 'raise', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'switch',
  'template', 'this', 'throw', 'trait', 'true', 'True', 'False', 'try', 'type', 'typeof', 'undefined', 'unsafe',
  'use', 'using', 'var', 'virtual', 'void', 'where', 'while', 'with', 'yield',
]);

const SHELL_KW = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac', 'function',
  'local', 'export', 'unset', 'return', 'exit', 'set', 'shift', 'exec', 'eval', 'source', 'true', 'false',
  'FROM', 'RUN', 'CMD', 'COPY', 'ADD', 'ENV', 'ARG', 'WORKDIR', 'EXPOSE', 'ENTRYPOINT', 'VOLUME', 'USER', 'LABEL',
]);

const SQL_KW = new Set([
  'select', 'from', 'where', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'by', 'order', 'having',
  'limit', 'offset', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table', 'index', 'view',
  'alter', 'drop', 'as', 'and', 'or', 'not', 'in', 'is', 'null', 'true', 'false', 'distinct', 'union', 'case',
  'when', 'then', 'else', 'end', 'primary', 'key', 'foreign', 'references', 'default', 'not', 'exists', 'with',
]);

function scanRegex(line, re, classify) {
  const out = [];
  let last = 0;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push({ cls: '', text: line.slice(last, m.index) });
    const cls = classify(m);
    out.push({ cls, text: m[0] });
    last = m.index + m[0].length;
    if (!m[0].length) { re.lastIndex++; }
  }
  if (last < line.length) out.push({ cls: '', text: line.slice(last) });
  return out;
}

export function tokenizeLine(line, formatId) {
  if (!line || formatId === 'text' || line.length > 4000) return [{ cls: '', text: line || '' }];

  if (formatId === 'json') {
    const re = /(\/\/.*$|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    return scanRegex(line, re, (m) => {
      if (m[1]) return 'tok-cmt';
      if (m[2]) return m[3] ? 'tok-key' : 'tok-str';
      if (m[4]) return 'tok-kw';
      if (m[5]) return 'tok-num';
      return '';
    });
  }

  if (formatId === 'yaml') {
    if (/^\s*#/.test(line)) return [{ cls: 'tok-cmt', text: line }];
    if (/^\s*(?:---|\.\.\.)\s*$/.test(line)) return [{ cls: 'tok-kw', text: line }];
    const keyM = /^(\s*(?:-\s+)?)([^#:\n][^:\n]*?)(:)(\s|$)(.*)$/.exec(line);
    if (keyM) {
      const out = [];
      if (keyM[1]) out.push({ cls: 'tok-punc', text: keyM[1] });
      out.push({ cls: 'tok-key', text: keyM[2] });
      out.push({ cls: 'tok-punc', text: keyM[3] + keyM[4] });
      if (keyM[5]) out.push(...tokenizeYamlValue(keyM[5]));
      return out;
    }
    return tokenizeYamlValue(line);
  }

  if (formatId === 'toml') {
    if (/^\s*[#;]/.test(line)) return [{ cls: 'tok-cmt', text: line }];
    if (/^\s*\[+[^\]]+\]+\s*(?:#.*)?$/.test(line)) {
      const idx = line.indexOf('#');
      return idx >= 0 ? [{ cls: 'tok-type', text: line.slice(0, idx) }, { cls: 'tok-cmt', text: line.slice(idx) }] : [{ cls: 'tok-type', text: line }];
    }
    const kv = /^(\s*[^=#;\s][^=]*?)(\s*=\s*)(.*)$/.exec(line);
    if (kv) {
      return [{ cls: 'tok-key', text: kv[1] }, { cls: 'tok-punc', text: kv[2] }, ...tokenizeYamlValue(kv[3])];
    }
    return [{ cls: '', text: line }];
  }

  if (formatId === 'xml') {
    const re = /(<!--[\s\S]*?-->)|(<\/?[A-Za-z_][\w:.-]*|\/>|>)|(\s[A-Za-z_][\w:.-]*)(=)|("(?:[^"]*)"|'(?:[^']*)')/g;
    return scanRegex(line, re, (m) => {
      if (m[1]) return 'tok-cmt';
      if (m[2]) return 'tok-kw';
      if (m[3]) return 'tok-key';
      if (m[5]) return 'tok-str';
      return '';
    });
  }

  if (formatId === 'markdown') {
    if (/^\s*#{1,6}\s/.test(line)) return [{ cls: 'tok-h', text: line }];
    if (/^\s*```/.test(line)) return [{ cls: 'tok-kw', text: line }];
    if (/^\s*>/.test(line)) return [{ cls: 'tok-cmt', text: line }];
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) return [{ cls: 'tok-punc', text: line }];
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))|(^\s*(?:[-*+]|\d+\.)\s+)/g;
    return scanRegex(line, re, (m) => {
      if (m[1]) return 'tok-str';
      if (m[2]) return 'tok-key';
      if (m[3]) return 'tok-type';
      if (m[4]) return 'tok-num';
      return '';
    });
  }

  if (formatId === 'css') {
    const re = /(\/\*[\s\S]*?\*\/|\/\/.*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(--[\w-]+|#[0-9a-fA-F]{3,8}\b)|(\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|%|s|ms|deg|fr)?\b)|(@[\w-]+)|([a-z-]+(?=\s*:))/g;
    return scanRegex(line, re, (m) => {
      if (m[1]) return 'tok-cmt';
      if (m[2]) return 'tok-str';
      if (m[3]) return 'tok-type';
      if (m[4]) return 'tok-num';
      if (m[5]) return 'tok-kw';
      if (m[6]) return 'tok-key';
      return '';
    });
  }

  if (formatId === 'shell') {
    const re = /((?:^|\s)#.*$)|("(?:\\.|[^"\\])*"|'[^']*')|(\$\{[^}]+\}|\$[A-Za-z_]\w*)|(\b[A-Za-z_]\w*\b)|(\b\d+\b)/g;
    return scanRegex(line, re, (m) => {
      if (m[1]) return 'tok-cmt';
      if (m[2]) return 'tok-str';
      if (m[3]) return 'tok-type';
      if (m[4]) return SHELL_KW.has(m[4]) ? 'tok-kw' : '';
      if (m[5]) return 'tok-num';
      return '';
    });
  }

  if (formatId === 'sql') {
    const re = /(--.*$|\/\*[\s\S]*?\*\/)|('(?:''|[^'])*')|(\b[A-Za-z_]\w*\b)|(\b\d+(?:\.\d+)?\b)/g;
    return scanRegex(line, re, (m) => {
      if (m[1]) return 'tok-cmt';
      if (m[2]) return 'tok-str';
      if (m[3]) return SQL_KW.has(m[3].toLowerCase()) ? 'tok-kw' : '';
      if (m[4]) return 'tok-num';
      return '';
    });
  }

  // General programming languages (JS, TS, Python, Rust, Go, C/C++, Java, etc.)
  const re = /(\/\/.*$|\/\*[\s\S]*?\*\/|(?:^|\s)#.*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(@[A-Za-z_]\w*)|(\b0x[0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.\d[\d_]*)?\b)|(\b[A-Za-z_]\w*\b)/g;
  return scanRegex(line, re, (m) => {
    if (m[1]) return 'tok-cmt';
    if (m[2]) return 'tok-str';
    if (m[3]) return 'tok-type';
    if (m[4]) return 'tok-num';
    if (m[5]) {
      if (CODE_KW.has(m[5])) return 'tok-kw';
      if (/^[A-Z][A-Za-z0-9_]*$/.test(m[5])) return 'tok-type';
    }
    return '';
  });
}

function tokenizeYamlValue(val) {
  const re = /((?:^|\s)#.*$)|("(?:\\.|[^"\\])*"|'[^']*')|([&*][A-Za-z0-9_-]+)|\b(true|false|null|yes|no|~)\b|(-?\b\d+(?:\.\d+)?\b)/gi;
  return scanRegex(val, re, (m) => {
    if (m[1]) return 'tok-cmt';
    if (m[2]) return 'tok-str';
    if (m[3]) return 'tok-type';
    if (m[4]) return 'tok-kw';
    if (m[5]) return 'tok-num';
    return '';
  });
}

// ---------- DOM renderers (browser) ----------

function appendHighlightedText(parent, text, queryLower, matches) {
  if (!queryLower) { parent.appendChild(document.createTextNode(text)); return; }
  const low = text.toLowerCase();
  let pos = 0;
  let idx;
  while ((idx = low.indexOf(queryLower, pos)) >= 0) {
    if (idx > pos) parent.appendChild(document.createTextNode(text.slice(pos, idx)));
    const mark = document.createElement('mark');
    mark.className = 'fv-match';
    mark.textContent = text.slice(idx, idx + queryLower.length);
    parent.appendChild(mark);
    matches.push(mark);
    pos = idx + queryLower.length;
  }
  if (pos < text.length) parent.appendChild(document.createTextNode(text.slice(pos)));
}

export function renderCodeView(text, formatId, { wrap = false, search = '' } = {}) {
  const root = document.createElement('div');
  root.className = 'fv-code' + (wrap ? ' wrap' : '');
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const q = search ? search.toLowerCase() : '';
  const matches = [];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < lines.length; i++) {
    const row = document.createElement('div');
    row.className = 'fv-line';
    const ln = document.createElement('span');
    ln.className = 'fv-ln';
    ln.textContent = String(i + 1);
    const code = document.createElement('span');
    code.className = 'fv-lc';
    const toks = tokenizeLine(lines[i], formatId);
    for (const t of toks) {
      if (!t.text) continue;
      if (t.cls) {
        const sp = document.createElement('span');
        sp.className = t.cls;
        appendHighlightedText(sp, t.text, q, matches);
        code.appendChild(sp);
      } else {
        appendHighlightedText(code, t.text, q, matches);
      }
    }
    if (!lines[i]) code.appendChild(document.createTextNode(' '));
    row.append(ln, code);
    frag.appendChild(row);
  }
  root.appendChild(frag);
  return { el: root, lineCount: lines.length, matches };
}

// Parse optional YAML frontmatter ("---\nkey: val\n---\n") at the very top of a Markdown file.
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: null, body: text };
  const rows = [];
  for (const l of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(l.trim());
    if (kv) rows.push([kv[1], kv[2].replace(/^["']|["']$/g, '')]);
  }
  return rows.length ? { meta: rows, body: m[2] } : { meta: null, body: text };
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isTableSep(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function tableAligns(line) {
  return splitTableRow(line).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'));
}

function el(tag, cls, ...children) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function renderMdInline(text, opts) {
  const out = [];
  const re = /(`[^`]+`|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*[^*]+\*\*|~~[^~]+~~|\*[^*\n]+\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      out.push(el('code', 'md-inline', tok.slice(1, -1)));
    } else if (tok.startsWith('![')) {
      out.push(el('span', 'md-img-ref', `🖼 ${m[2] || m[3]}`));
    } else if (m[4] !== undefined && m[5] !== undefined) {
      const href = m[5];
      const a = el('a', 'md-link', ...renderMdInline(m[4], opts));
      a.href = '#';
      a.title = href;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (/^https?:\/\//i.test(href)) opts.onOpenLink && opts.onOpenLink(href);
        else if (!href.startsWith('#')) opts.onOpenFile && opts.onOpenFile(href.split('#')[0]);
      });
      out.push(a);
    } else if (tok.startsWith('**')) {
      out.push(el('strong', '', ...renderMdInline(tok.slice(2, -2), opts)));
    } else if (tok.startsWith('~~')) {
      out.push(el('del', '', ...renderMdInline(tok.slice(2, -2), opts)));
    } else if (tok.startsWith('*')) {
      out.push(el('em', '', ...renderMdInline(tok.slice(1, -1), opts)));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdownPreview(text, opts = {}) {
  const root = el('div', 'md-preview');
  const { meta, body } = parseFrontmatter(String(text ?? '').replace(/\r\n/g, '\n'));
  if (meta) {
    const tbl = el('table', 'md-frontmatter',
      meta.map(([k, v]) => el('tr', '', el('th', 'mono', k), el('td', '', v))));
    root.appendChild(tbl);
  }

  const lines = body.split('\n');
  let i = 0;
  let listEl = null;
  const closeList = () => { listEl = null; };

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trimEnd();

    // Fenced code block
    const fence = /^(`{3,}|~{3,})(\S*)\s*$/.exec(trimmed.trimStart());
    if (fence) {
      closeList();
      const marker = fence[1][0];
      const lang = fence[2] || '';
      const codeLines = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker}{${fence[1].length},}\\s*$`).test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const codeText = codeLines.join('\n');
      const copyBtn = el('button', 'md-copy', 'Copy');
      copyBtn.title = 'Copy code';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard?.writeText(codeText).then(() => {
          copyBtn.textContent = 'Copied';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
        }).catch(() => {});
      });
      const fmtId = LANG_BY_FENCE[lang.toLowerCase()] || 'text';
      const pre = el('pre', 'md-code');
      codeLines.forEach((cl, idx) => {
        for (const t of tokenizeLine(cl, fmtId)) {
          pre.appendChild(t.cls ? el('span', t.cls, t.text) : document.createTextNode(t.text));
        }
        if (idx < codeLines.length - 1) pre.appendChild(document.createTextNode('\n'));
      });
      root.appendChild(el('div', 'md-code-wrap',
        el('div', 'md-code-bar', el('span', 'mono', lang || 'code'), copyBtn),
        pre));
      continue;
    }

    // Table (header + separator row)
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeList();
      const headers = splitTableRow(trimmed);
      const aligns = tableAligns(lines[i + 1]);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        bodyRows.push(splitTableRow(lines[i]));
        i++;
      }
      const thead = el('thead', '', el('tr', '', headers.map((hText, ci) => {
        const th = el('th', '', ...renderMdInline(hText, opts));
        if (aligns[ci]) th.style.textAlign = aligns[ci];
        return th;
      })));
      const tbody = el('tbody', '', bodyRows.map((r) => el('tr', '', headers.map((_, ci) => {
        const td = el('td', '', ...renderMdInline(r[ci] || '', opts));
        if (aligns[ci]) td.style.textAlign = aligns[ci];
        return td;
      }))));
      root.appendChild(el('div', 'md-table-wrap', el('table', 'md-table', thead, tbody)));
      continue;
    }

    // Blockquote & GitHub Alerts (> [!NOTE], > [!WARNING], etc.)
    if (/^\s*>\s?/.test(trimmed)) {
      closeList();
      const qLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        qLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const alertM = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec((qLines[0] || '').trim());
      if (alertM) {
        const kind = alertM[1].toLowerCase();
        const bodyLines = qLines.slice(1);
        root.appendChild(el('div', `md-alert md-alert-${kind}`,
          el('div', 'md-alert-title', alertM[1].toUpperCase()),
          bodyLines.map((l) => (l.trim() ? el('p', '', ...renderMdInline(l, opts)) : null))));
      } else {
        root.appendChild(el('blockquote', 'md-quote',
          qLines.map((l) => (l.trim() ? el('p', '', ...renderMdInline(l, opts)) : null))));
      }
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(trimmed)) {
      closeList();
      root.appendChild(el('hr', 'md-hr'));
      i++;
      continue;
    }

    // Heading
    const head = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (head) {
      closeList();
      root.appendChild(el('div', `md-h md-h${Math.min(head[1].length, 4)}`, ...renderMdInline(head[2].replace(/\s+#+\s*$/, ''), opts)));
      i++;
      continue;
    }

    // Task list or standard list
    const taskItem = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(trimmed);
    const olItem = !taskItem ? /^\s*(\d+)\.\s+(.*)$/.exec(trimmed) : null;
    const ulItem = !taskItem && !olItem ? /^\s*[-*+]\s+(.*)$/.exec(trimmed) : null;
    if (taskItem || olItem || ulItem) {
      const wantTag = olItem ? 'OL' : 'UL';
      if (!listEl || listEl.tagName !== wantTag) {
        listEl = el(wantTag.toLowerCase(), taskItem ? 'md-tasks' : '');
        if (olItem && Number(olItem[1]) !== 1) listEl.setAttribute('start', String(Number(olItem[1])));
        root.appendChild(listEl);
      }
      if (taskItem) {
        const checked = taskItem[1].toLowerCase() === 'x';
        listEl.appendChild(el('li', 'md-task' + (checked ? ' done' : ''),
          el('span', 'md-task-box ' + (checked ? 'ok' : 'muted'), checked ? '☑' : '☐'),
          el('span', '', ...renderMdInline(taskItem[2], opts))));
      } else {
        listEl.appendChild(el('li', '', ...renderMdInline((olItem || ulItem)[olItem ? 2 : 1], opts)));
      }
      i++;
      continue;
    }

    // Blank line
    if (!trimmed.trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const next = j < lines.length ? lines[j] : '';
      const continues = listEl && ((listEl.tagName === 'OL' && /^\s*\d+\.\s+/.test(next)) || (listEl.tagName === 'UL' && /^\s*[-*+]\s+/.test(next)));
      if (!continues) closeList();
      i++;
      continue;
    }

    // Paragraph (join consecutive plain lines until blank line or block starter)
    closeList();
    const pLines = [trimmed];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(?:#{1,6}\s|```|~~~|>\s?|[-*+]\s|\d+\.\s|---+|___+|\*\*\*+)/.test(lines[i].trimStart()) && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
      pLines.push(lines[i].trimEnd());
      i++;
    }
    root.appendChild(el('p', '', ...renderMdInline(pLines.join(' '), opts)));
  }

  return root;
}
