// Find in files (⌘⇧F): ripgrep, or `git grep` if rg isn't installed. Respects .gitignore and
// skips binaries.
const { spawn } = require('child_process');
const { escapeRe, eachLine, kill } = require('./util');

const MAX_MATCHES = 5000;
const splitGlobs = (s) =>
  String(s || '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
// ripgrep reports byte offsets into the UTF-8 line; the editor counts UTF-16 characters.
const charIndex = (line, byte) => Buffer.from(line, 'utf8').subarray(0, byte).toString('utf8').length;

// Resolves { files: [{ path, matches: [{ line, text, ranges: [[start, end]] }] }], total,
// truncated, cancelled, engine?, error? }. `register` is handed { kill } to cancel the search.
module.exports = function searchFiles(cwd, opts, register) {
  const { query, regex, caseSensitive, wholeWord, include, exclude } = opts;
  return new Promise((resolve) => {
    const files = new Map(); // path -> { path, matches }
    let total = 0;
    let truncated = false;
    let cancelled = false;
    let done = false;
    let child = null;
    let engine = 'rg';
    let stderr = '';
    const finish = (extra = {}) => {
      if (done) return;
      done = true;
      resolve({ files: [...files.values()], total, truncated, cancelled, ...extra });
    };
    // Enough matches: end the search and return what was found.
    const stop = () => {
      kill(child);
      finish({ engine });
    };
    const add = (path, line, text, ranges) => {
      if (done) return;
      if (total >= MAX_MATCHES) {
        truncated = true;
        stop();
        return;
      }
      if (!files.has(path)) files.set(path, { path, matches: [] });
      files.get(path).matches.push({ line, text, ranges });
      total += ranges.length || 1;
    };
    register({
      kill() {
        cancelled = true;
        kill(child);
        finish();
      },
    });

    const onRgLine = (line) => {
      if (!line) return;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.type !== 'match') return;
      const text = m.data.lines?.text;
      const path = m.data.path?.text?.replace(/^\.\//, '');
      if (text == null || path == null) return; // non-UTF-8 path or line
      const clean = text.replace(/\r?\n$/, '');
      add(path, m.data.line_number, clean, (m.data.submatches || []).map((sm) => [charIndex(clean, sm.start), charIndex(clean, sm.end)]));
    };

    // git grep fallback: one line per hit; match ranges are found again in JS.
    const gitGrep = () => {
      engine = 'git';
      const pathspec = (g) => (g.includes('/') ? g : `**/${g}`);
      const pathspecs = [...splitGlobs(include).map((g) => `:(glob)${pathspec(g)}`), ...splitGlobs(exclude).map((g) => `:(exclude,glob)${pathspec(g)}`)];
      const args = ['grep', '-n', '-I', '--untracked', '--exclude-standard', '--no-color', caseSensitive ? '' : '-i', regex ? '-E' : '-F', wholeWord ? '-w' : '', '-e', query, '--', ...pathspecs].filter(Boolean);
      let re = null;
      try {
        const src = regex ? query : escapeRe(query);
        re = new RegExp(wholeWord ? `\\b(?:${src})\\b` : src, caseSensitive ? 'g' : 'gi');
      } catch {
        /* invalid regex: git reports it */
      }
      child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      eachLine(child.stdout, (l) => {
        const m = /^(.*?):(\d+):(.*)$/.exec(l);
        if (!m) return;
        add(m[1], Number(m[2]), m[3], re ? [...m[3].matchAll(re)].filter((x) => x[0]).map((x) => [x.index, x.index + x[0].length]) : []);
      });
      child.stderr.on('data', (c) => (stderr += c));
      child.on('close', (code) => finish(code > 1 ? { error: stderr.trim() || 'Search failed', engine } : { engine }));
    };

    const rgArgs = [
      '--json', '--hidden', '-g', '!.git', '--max-columns', '1000', '--max-columns-preview', '--max-filesize', '4M',
      caseSensitive ? '-s' : '-i',
      ...(regex ? [] : ['-F']),
      ...(wholeWord ? ['-w'] : []),
      ...splitGlobs(include).flatMap((g) => ['-g', g]),
      ...splitGlobs(exclude).flatMap((g) => ['-g', `!${g}`]),
      '-e', query,
      // An explicit path: without one, rg searches stdin when it isn't a terminal (it never is here).
      '.',
    ];
    const rg = spawn('rg', rgArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child = rg;
    rg.on('error', (e) => (e.code === 'ENOENT' ? gitGrep() : finish({ error: e.message })));
    const flush = eachLine(rg.stdout, onRgLine);
    rg.stderr.on('data', (c) => (stderr += c));
    rg.on('close', (code) => {
      if (engine !== 'rg') return;
      flush();
      // rg exits 1 for "no matches", 2 for errors (e.g. a bad regex) — but also 2 when some files were unreadable.
      finish(code === 2 && !files.size ? { error: stderr.trim().split('\n').pop() || 'Search failed', engine } : { engine });
    });
  });
};
