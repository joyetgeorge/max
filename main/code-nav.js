// Go to definition (⌘-click in the Files tab) — main-process side.
//
// JS/TS: the project's own TypeScript language server (node_modules/typescript/lib/tsserver.js),
// the way VS Code does it — it knows the whole project: imports, tsconfig paths, node_modules
// types. One server per worktree, started on first use, run with Electron's built-in Node.
// Anything else (or no TypeScript installed, or no answer): a ripgrep search for a declaration
// of the word (function/class/const/def/func/… name).

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { escapeRe, eachLine, kill } = require('./util');

const TS_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const REQUEST_TIMEOUT = 30000; // the first request waits for the project to load

// The worktree's TypeScript, or a parent's (monorepos keep it at the root). A git worktree has
// no node_modules of its own, so fall back to the main checkout's.
function findTsserver(cwd, repo) {
  for (const start of [cwd, repo].filter(Boolean)) {
    let dir = start;
    for (let i = 0; i < 5; i++) {
      const p = path.join(dir, 'node_modules', 'typescript', 'lib', 'tsserver.js');
      if (fs.existsSync(p)) return p;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

class TsServer {
  constructor(cwd, script) {
    this.cwd = cwd;
    this.seq = 0;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    this.proc = spawn(process.execPath, [script, '--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'], {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.proc.stdout.on('data', (c) => this.onData(c));
    this.proc.on('exit', () => {
      this.dead = true;
      for (const p of this.pending.values()) p.reject(new Error('TypeScript server stopped'));
      this.pending.clear();
    });
    this.proc.on('error', () => {});
  }

  // Messages are "Content-Length: N\r\n\r\n" + N bytes of JSON.
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const head = this.buf.indexOf('\r\n\r\n');
      if (head < 0) return;
      const m = /Content-Length: (\d+)/i.exec(this.buf.subarray(0, head).toString());
      if (!m) {
        this.buf = this.buf.subarray(head + 4);
        continue;
      }
      const len = Number(m[1]);
      if (this.buf.length < head + 4 + len) return;
      const body = this.buf.subarray(head + 4, head + 4 + len).toString();
      this.buf = this.buf.subarray(head + 4 + len);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      if (msg.type === 'response' && this.pending.has(msg.request_seq)) {
        const p = this.pending.get(msg.request_seq);
        this.pending.delete(msg.request_seq);
        clearTimeout(p.timer);
        if (msg.success) p.resolve(msg.body);
        else p.reject(new Error(msg.message || 'TypeScript request failed'));
      }
    }
  }

  request(command, args) {
    if (this.dead) return Promise.reject(new Error('TypeScript server stopped'));
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error('TypeScript server timed out'));
      }, REQUEST_TIMEOUT);
      this.pending.set(seq, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ seq, type: 'request', command, arguments: args })}\n`);
    });
  }

  kill() {
    this.dead = true;
    kill(this.proc);
  }
}

// Declarations of `word` in common languages, for the search fallback (ripgrep's default regex engine).
function declarationPattern(word) {
  const w = escapeRe(word);
  return [
    // function foo / class Foo / const foo / def foo / func foo / fun foo / struct Foo …
    `\\b(function\\*?|class|interface|type|enum|namespace|module|const|let|var|def|func|fun|struct|protocol|extension|trait|impl|object|val|typealias)\\s+${w}\\b`,
    // foo = (…) => / foo: function / foo = async function
    `\\b${w}\\s*[:=]\\s*(async\\s+)?(function\\b|\\([^)]*\\)\\s*(:[^=]+)?=>|[A-Za-z_$][\\w$]*\\s*=>)`,
    // class methods: foo(…) {  /  async foo(…): T {
    `^\\s*((public|private|protected|static|async|override|readonly|get|set)\\s+)*${w}\\s*(<[^>]*>)?\\s*\\([^)]*\\)\\s*(:[^{=]+)?\\{\\s*$`,
  ].join('|');
}

function searchDeclarations(cwd, word, fromPath) {
  return new Promise((resolve) => {
    const out = [];
    const p = spawn('rg', ['--json', '-n', '--max-count', '20', '--max-filesize', '2M', '-e', declarationPattern(word), '.'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const at = new RegExp(`\\b${escapeRe(word)}\\b`);
    eachLine(p.stdout, (l) => {
      try {
        const m = JSON.parse(l);
        if (m.type !== 'match') return;
        const col = (m.data.lines.text || '').search(at);
        out.push({ path: m.data.path.text.replace(/^\.\//, ''), line: m.data.line_number, col: Math.max(0, col), len: word.length });
      } catch {
        /* skip */
      }
    });
    p.on('error', () => resolve([]));
    p.on('close', () => {
      // Same file first, then the nearest folders, then shorter paths.
      const dir = path.dirname(fromPath);
      out.sort((a, b) => (b.path === fromPath) - (a.path === fromPath) || b.path.startsWith(dir) - a.path.startsWith(dir) || a.path.length - b.path.length);
      resolve(out.slice(0, 20));
    });
  });
}

// ---------- context-aware fallback (no language server, or no answer from it) ----------
const IS_TEST = /(^|\/)(__tests__|__mocks__|tests?|spec)\/|\.(spec|test|e2e|stories)\.[^/]+$/i;
const MODULE_EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

// Bindings that only make sense within the current file: parameters (`name: Type`, `name?:`,
// `(name, …`, `…, name)`, `name = default`) and destructured names (`{ a, name } =`).
function bindingPattern(word) {
  const w = escapeRe(word);
  return [
    `[(,]\\s*(\\.\\.\\.)?${w}\\s*\\??\\s*[:,)=]`,
    `^\\s*(public\\s+|private\\s+|protected\\s+|readonly\\s+)*${w}\\s*\\??\\s*:\\s*[^,;]+,?\\s*$`,
    `\\{[^}]*\\b${w}\\b[^}]*\\}\\s*=[^=>]`,
    `\\b(for|catch)\\s*\\(\\s*(const|let|var)?\\s*\\[?\\{?[^)]*\\b${w}\\b`,
  ].join('|');
}

// Declarations of `word` in a file's text: [{ line (1-based), col (0-based) }].
// withBindings: also parameters and destructured names (for the current file).
function declarationsIn(text, word, withBindings = false) {
  const re = new RegExp(withBindings ? `${declarationPattern(word)}|${bindingPattern(word)}` : declarationPattern(word), 'm');
  const at = new RegExp(`\\b${escapeRe(word)}\\b`);
  const out = [];
  text.split('\n').forEach((l, i) => {
    if (re.test(l)) out.push({ line: i + 1, col: Math.max(0, l.search(at)) });
  });
  return out;
}

// Where `word` is imported from in this file: { spec, name } (name = the exported name), or null.
function importOf(text, word) {
  const w = escapeRe(word);
  for (const m of text.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = m[1];
    if (new RegExp(`^\\s*${w}\\s*(,|$)`).test(clause)) return { spec: m[2], name: 'default' };
    if (new RegExp(`\\*\\s+as\\s+${w}\\b`).test(clause)) return { spec: m[2], name: null };
    const named = /\{([\s\S]*)\}/.exec(clause)?.[1] || '';
    for (const part of named.split(',')) {
      const [orig, alias] = part.replace(/\btype\s+/, '').trim().split(/\s+as\s+/);
      if ((alias || orig) === word) return { spec: m[2], name: orig };
    }
  }
  for (const m of text.matchAll(/(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (m[1] === word) return { spec: m[2], name: 'default' };
    if (m[1].startsWith('{') && new RegExp(`[{,\\s]${w}\\s*[,}:]`).test(m[1])) return { spec: m[2], name: word };
  }
  for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+([^\n]+)$/gm)) {
    if (m[2].split(',').some((p) => p.trim().split(/\s+as\s+/).pop() === word)) return { spec: m[1], name: word, python: true };
  }
  return null;
}

// A module specifier → a worktree-relative file that exists, or null.
function resolveModule(cwd, fromFile, imp) {
  const tries = [];
  if (imp.python) {
    const p = imp.spec.replace(/^\.+/, (d) => '../'.repeat(d.length - 1) || './').replace(/\./g, '/');
    const bases = imp.spec.startsWith('.') ? [path.join(path.dirname(fromFile), p)] : [p, path.join(path.dirname(fromFile), p)];
    for (const b of bases) tries.push(`${b}.py`, path.join(b, '__init__.py'));
  } else {
    let bases;
    if (imp.spec.startsWith('.')) bases = [path.join(path.dirname(fromFile), imp.spec)];
    else {
      // Path aliases we can guess without reading tsconfig: '@/x', '~/x', 'src/x', or a root folder.
      const bare = imp.spec.replace(/^[@~]\//, '');
      bases = [bare, path.join('src', bare)];
    }
    for (const b of bases) {
      tries.push(b);
      for (const e of MODULE_EXTS) tries.push(b + e);
      for (const e of MODULE_EXTS) tries.push(path.join(b, `index${e}`));
    }
  }
  for (const t of tries) {
    const rel = path.normalize(t).split(path.sep).join('/');
    if (rel.startsWith('..')) continue;
    try {
      if (fs.statSync(path.join(cwd, rel)).isFile()) return rel;
    } catch {
      /* next */
    }
  }
  return null;
}

async function contextualDefinition(cwd, file, text, line, word) {
  // 1. Declared in this file: the nearest declaration at or above the cursor (its scope, usually).
  const here = declarationsIn(text, word, true);
  if (here.length) {
    const above = here.filter((d) => d.line <= line).pop();
    const d = above || here[0];
    return [{ path: file, line: d.line, col: d.col, len: word.length }];
  }
  // 2. Imported: follow the import to that file.
  const imp = importOf(text, word);
  if (imp) {
    const target = resolveModule(cwd, file, imp);
    if (target) {
      let src = '';
      try {
        src = fs.readFileSync(path.join(cwd, target), 'utf8');
      } catch {
        /* unreadable */
      }
      let d = null;
      if (imp.name === 'default') {
        const i = src.split('\n').findIndex((l) => /\bexport\s+default\b/.test(l));
        if (i >= 0) d = { line: i + 1, col: 0 };
      } else if (imp.name) d = declarationsIn(src, imp.name)[0] || null;
      return [{ path: target, line: d?.line || 1, col: d?.col || 0, len: d ? (imp.name === 'default' ? 0 : imp.name.length) : 0 }];
    }
  }
  // 3. Anywhere in the worktree, leaving out tests unless we're in one.
  const all = await searchDeclarations(cwd, word, file);
  const fromTest = IS_TEST.test(file);
  const pick = fromTest ? all : all.filter((d) => !IS_TEST.test(d.path));
  return (pick.length ? pick : all).slice(0, 5);
}

module.exports = function createCodeNav() {
  const servers = new Map(); // worktree cwd -> TsServer
  const texts = new Map(); // absolute file -> the editor text last sent (requests skip it when unchanged)

  function serverFor(cwd, repo) {
    let s = servers.get(cwd);
    if (s && !s.dead) return s;
    const script = findTsserver(cwd, repo);
    if (!script) return null;
    s = new TsServer(cwd, script);
    servers.set(cwd, s);
    return s;
  }

  // file: worktree-relative path; line/col: 1-based; text: the editor's content (may be unsaved),
  // or null when unchanged since the last request for this file.
  async function definition(cwd, repo, { file, text, line, col, word }) {
    const absFile = path.join(cwd, file);
    if (text != null) texts.set(absFile, text);
    const real = fs.realpathSync(cwd);
    const rel = (abs) => {
      const r = path.relative(real, fs.existsSync(abs) ? fs.realpathSync(abs) : abs);
      return r.startsWith('..') || path.isAbsolute(r) ? null : r.split(path.sep).join('/');
    };
    if (TS_FILE.test(file)) {
      const s = serverFor(cwd, repo);
      if (s) {
        try {
          await s.request('updateOpen', { openFiles: [{ file: absFile, ...(text != null ? { fileContent: text } : {}), projectRootPath: cwd }] });
          const body = await s.request('definitionAndBoundSpan', { file: absFile, line, offset: col });
          const defs = (body?.definitions || [])
            .map((d) => {
              const p = rel(d.file);
              if (!p) return null; // outside the worktree: can't be opened here
              return { path: p, line: d.start.line, col: d.start.offset - 1, endLine: d.end.line, endCol: d.end.offset - 1 };
            })
            .filter(Boolean);
          if (defs.length) return { defs, engine: 'typescript' };
        } catch {
          /* fall through to the search */
        }
      }
    }
    if (!word) return { defs: [], engine: 'search' };
    let current = texts.get(absFile);
    if (current == null) {
      try {
        current = fs.readFileSync(absFile, 'utf8');
      } catch {
        current = '';
      }
    }
    const found = await contextualDefinition(cwd, file, current, line, word);
    return { defs: found.map((d) => ({ path: d.path, line: d.line, col: d.col, endLine: d.line, endCol: d.col + d.len })), engine: 'search' };
  }

  // Start the language server and load the project in the background (opening a JS/TS file),
  // so the first ⌘-click doesn't wait for a big project to load. Resolves when it's ready.
  async function warm(cwd, repo, file) {
    if (!TS_FILE.test(file)) return false;
    const s = serverFor(cwd, repo);
    if (!s) return false;
    if (!s.warmed) s.warmed = s.request('updateOpen', { openFiles: [{ file: path.join(cwd, file), projectRootPath: cwd }] }).then(() => true, () => false);
    return s.warmed;
  }

  return {
    definition,
    warm,
    // A worktree closed, or the app quitting.
    stop(cwd) {
      for (const [k, s] of servers) {
        if (cwd && k !== cwd) continue;
        s.kill();
        servers.delete(k);
      }
    },
  };
};
