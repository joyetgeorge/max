// Git for a workspace: the sidebar's branch + diff stat, the Review tab (changed files, one
// file's diff, discarding changes) and the status letters in the Files tab.
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { insideCwd } = require('./util');
const fsp = fs.promises;

const MAX_DIFF_BYTES = 2 * 1024 * 1024;

function git(cwd, args) {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout),
    ),
  );
}
// git with stdin; resolves stdout even on a non-zero exit (check-ignore exits 1 for "none").
function gitInput(cwd, args, input) {
  return new Promise((resolve) => {
    const p = spawn('git', args, { cwd });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.on('error', () => resolve(''));
    p.on('close', () => resolve(out));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

const repoRoot = async (dir) => (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
const currentBranch = async (cwd) => (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();

async function mergeBase(ws) {
  if (!ws.baseBranch) return 'HEAD';
  try {
    return (await git(ws.cwd, ['merge-base', ws.baseBranch, 'HEAD'])).trim();
  } catch {
    return 'HEAD';
  }
}
// What a scope is diffed against: the last commit, or where the branch left its base.
const diffSource = async (ws, scope) => (scope === 'uncommitted' ? 'HEAD' : mergeBase(ws));
const baseLabel = (ws, scope) => (scope === 'uncommitted' ? 'HEAD' : ws.baseBranch || 'HEAD');

// { branch, add, del, files } for the sidebar and toolbar.
async function info(ws) {
  try {
    // Independent git calls run concurrently (4 sequential spawns → 2 rounds).
    const [branch, base] = await Promise.all([currentBranch(ws.cwd), mergeBase(ws)]);
    const [stat, untrackedOut] = await Promise.all([
      git(ws.cwd, ['diff', '--numstat', base]),
      git(ws.cwd, ['ls-files', '--others', '--exclude-standard']),
    ]);
    let add = 0;
    let del = 0;
    let files = 0;
    for (const line of stat.split('\n')) {
      if (!line) continue;
      const [a, d] = line.split('\t');
      add += parseInt(a, 10) || 0;
      del += parseInt(d, 10) || 0;
      files++;
    }
    for (const line of untrackedOut.split('\n')) if (line) files++;
    return { branch, add, del, files };
  } catch (e) {
    return { error: e.message };
  }
}
// One in-flight info() per workspace: overlapping polls share the same result.
const infoInFlight = new Map();
function infoOnce(ws) {
  if (!infoInFlight.has(ws.id)) infoInFlight.set(ws.id, info(ws).finally(() => infoInFlight.delete(ws.id)));
  return infoInFlight.get(ws.id);
}

// Lines in an untracked file (0 for big, binary or unreadable ones). Async I/O and no string
// conversion, so a big untracked tree doesn't freeze IPC.
async function countLines(abs) {
  try {
    if ((await fsp.stat(abs)).size > MAX_DIFF_BYTES) return 0;
    const buf = await fsp.readFile(abs);
    if (buf.includes(0)) return 0;
    let n = 0;
    for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++;
    return buf.length && buf[buf.length - 1] !== 10 ? n + 1 : n;
  } catch {
    return 0; // unreadable — show with zero counts
  }
}

// Files that differ from `src` (a commit), plus untracked ones:
// [{ path, oldPath?, status, add, del, binary?, untracked? }], sorted by path.
async function listChanges(ws, src) {
  const [nsOut, numsOut, untrackedOut] = await Promise.all([
    git(ws.cwd, ['diff', '--name-status', '-M', '-z', src]),
    git(ws.cwd, ['diff', '--numstat', '-M', '-z', src]),
    git(ws.cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  // name-status -z: "M\0path\0" or "R087\0old\0new\0"
  const ns = nsOut.split('\0');
  const files = new Map();
  for (let i = 0; i < ns.length - 1; ) {
    const code = ns[i++];
    if (!code) continue;
    const status = code[0];
    const oldPath = status === 'R' || status === 'C' ? ns[i++] : undefined;
    const p = ns[i++];
    files.set(p, { path: p, ...(oldPath !== undefined ? { oldPath } : {}), status, add: 0, del: 0 });
  }
  // numstat -z: "a\td\tpath\0" or, for renames, "a\td\t\0old\0new\0"
  const nums = numsOut.split('\0');
  for (let i = 0; i < nums.length - 1; ) {
    const [a, d, p] = nums[i++].split('\t');
    let key = p;
    if (p === '') {
      i++; // old path
      key = nums[i++];
    }
    const f = files.get(key);
    if (f) {
      f.add = a === '-' ? 0 : parseInt(a, 10) || 0;
      f.del = d === '-' ? 0 : parseInt(d, 10) || 0;
      f.binary = a === '-';
    }
  }
  const untracked = untrackedOut.split('\0').filter(Boolean);
  const counts = await Promise.all(untracked.map((p) => countLines(insideCwd(ws, p))));
  untracked.forEach((p, i) => files.set(p, { path: p, status: 'U', untracked: true, add: counts[i], del: 0 }));
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function changes(ws, scope) {
  return { files: await listChanges(ws, await diffSource(ws, scope)), base: baseLabel(ws, scope) };
}

// One changed file, as a whole-file diff: { diff } | { untracked, text } | { binary } | { tooLarge }.
async function fileDiff(ws, scope, file) {
  if (file.untracked) {
    const abs = insideCwd(ws, file.path);
    if ((await fsp.stat(abs)).size > MAX_DIFF_BYTES) return { tooLarge: true };
    const buf = await fsp.readFile(abs);
    if (buf.includes(0)) return { binary: true };
    return { untracked: true, text: buf.toString('utf8') };
  }
  const src = await diffSource(ws, scope);
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
  const diff = await git(ws.cwd, ['diff', '--no-color', '--no-ext-diff', '-M', '--unified=1000000', src, '--', ...paths]);
  if (diff.length > MAX_DIFF_BYTES * 2) return { tooLarge: true };
  if (/^Binary files /m.test(diff)) return { binary: true };
  return { diff };
}

// Put a changed file back to how it is in `src`: new files are deleted, renames undone.
async function discard(ws, src, file) {
  const remove = async () => {
    await git(ws.cwd, ['rm', '-f', '-q', '--ignore-unmatch', '--', file.path]);
    fs.rmSync(insideCwd(ws, file.path), { force: true });
  };
  if (file.untracked) fs.rmSync(insideCwd(ws, file.path), { force: true });
  else if (file.status === 'A') await remove();
  else {
    if (file.oldPath) await remove();
    await git(ws.cwd, ['restore', `--source=${src}`, '--staged', '--worktree', '--', file.oldPath || file.path]);
  }
}

// path -> status letter (M/A/D/R/U); untracked folders end in "/".
async function status(ws) {
  let out = '';
  try {
    out = await git(ws.cwd, ['status', '--porcelain=v1', '-z']);
  } catch {
    return {};
  }
  const map = {};
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    const p = e.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // next entry is the original path
    map[p] = xy === '??' ? 'U' : xy.includes('D') ? 'D' : xy.includes('A') ? 'A' : xy[0] === 'R' ? 'R' : 'M';
  }
  return map;
}

module.exports = { run: git, gitInput, repoRoot, currentBranch, diffSource, baseLabel, infoOnce, changes, fileDiff, discard, status };
