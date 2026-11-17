// Small helpers shared by the main-process modules.
const path = require('path');

// Escape a string for use inside a RegExp.
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Quote a string for a POSIX shell.
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';

// Absolute path of `rel` inside a workspace's folder; throws if it points outside it.
function insideCwd(ws, rel) {
  const abs = path.resolve(ws.cwd, rel);
  if (abs !== ws.cwd && !abs.startsWith(ws.cwd + path.sep)) throw new Error('Path escapes the workspace');
  return abs;
}

// Call onLine for every complete line a stream produces. Returns a function that hands over
// whatever is left (a last line without a newline) once the stream has ended.
function eachLine(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8'); // so a multi-byte character split across chunks stays whole
  stream.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) onLine(l);
  });
  return () => {
    const rest = buf;
    buf = '';
    if (rest) onLine(rest);
  };
}

// Kill a child process or PTY that may already be gone. One that never started has no pid:
// Node would then signal pid 0, which is this app's whole process group.
function kill(proc) {
  if (!proc?.pid) return;
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
}

module.exports = { escapeRe, sh, slugify, insideCwd, eachLine, kill };
