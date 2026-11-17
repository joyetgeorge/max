// A workspace's files, for the Files tab: folder listings, the ⌘P file list, reading and saving.
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { run: git, gitInput } = require('./git');
const { insideCwd } = require('./util');
const fsp = fs.promises;

const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_QUICK_OPEN_FILES = 200000;
const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif',
};
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// One folder: [{ name, path, dir, ignored? }], folders first.
async function list(ws, rel = '') {
  const dir = insideCwd(ws, rel || '.');
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  const items = await Promise.all(
    ents
      .filter((e) => e.name !== '.git' && e.name !== '.DS_Store')
      .map(async (e) => {
        let isDir = e.isDirectory();
        if (e.isSymbolicLink()) isDir = await fsp.stat(path.join(dir, e.name)).then((st) => st.isDirectory(), () => false);
        return { name: e.name, path: rel ? `${rel}/${e.name}` : e.name, dir: isDir };
      }),
  );
  // Dim gitignored entries, like VS Code.
  if (items.length) {
    const out = await gitInput(ws.cwd, ['check-ignore', '-z', '--stdin'], items.map((i) => i.path).join('\0') + '\0');
    const ignored = new Set(out.split('\0').filter(Boolean));
    for (const i of items) if (ignored.has(i.path)) i.ignored = true;
  }
  return items.sort((a, b) => b.dir - a.dir || byName.compare(a.name, b.name));
}

// Every file in the worktree that git doesn't ignore (tracked + untracked), like VS Code's Quick Open.
async function listAll(ws) {
  let out = '';
  try {
    out = await git(ws.cwd, ['ls-files', '-co', '--exclude-standard', '-z']);
  } catch {
    // Not a git repository any more: ask ripgrep.
    out = await new Promise((resolve) =>
      execFile('rg', ['--files', '--hidden', '-g', '!.git', '-0', '.'], { cwd: ws.cwd, maxBuffer: 256 * 1024 * 1024 }, (_err, stdout) => resolve(stdout || '')),
    );
    out = out.replace(/(^|\0)\.\//g, '$1');
  }
  return [...new Set(out.split('\0').filter(Boolean))].slice(0, MAX_QUICK_OPEN_FILES);
}

// { text, size, mtime } | { image (a data URL), size, mtime } | { binary, size } | { tooLarge, size }
async function read(ws, rel) {
  const abs = insideCwd(ws, rel);
  const st = await fsp.stat(abs);
  const mime = IMAGE_MIME[path.extname(rel).slice(1).toLowerCase()];
  if (st.size > (mime ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES)) return { tooLarge: true, size: st.size };
  const buf = await fsp.readFile(abs);
  if (mime) return { image: `data:${mime};base64,${buf.toString('base64')}`, size: st.size, mtime: st.mtimeMs };
  if (buf.subarray(0, 8000).includes(0)) return { binary: true, size: st.size };
  return { text: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs };
}

// Save from the editor. `expectMtime` guards against overwriting a file that changed on disk
// (e.g. an agent edited it) since it was opened: that returns { conflict: true } instead.
async function write(ws, rel, text, expectMtime) {
  const abs = insideCwd(ws, rel);
  if (expectMtime != null) {
    const cur = await fsp.stat(abs).then((s) => s.mtimeMs, () => null);
    if (cur != null && Math.abs(cur - expectMtime) > 1) return { conflict: true };
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, text, 'utf8');
  const st = await fsp.stat(abs);
  return { mtime: st.mtimeMs, size: st.size };
}

module.exports = { list, listAll, read, write };
