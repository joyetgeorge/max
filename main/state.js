// state.json (workspaces, repos, the active workspace) and its persistence.
//
// The file is written atomically (temp file → fsync → rename), so it is never half-written,
// and a rolling backup is kept in state-backups/. A file that can't be read is set aside and
// the newest good backup is loaded — never silently replaced by an empty list of workspaces
// (which is how workspaces used to vanish when two copies of the app wrote at once).
const path = require('path');
const fs = require('fs');
const { escapeRe } = require('./util');

const BACKUP_EVERY_MS = 10 * 60 * 1000;
const BACKUP_KEEP = 30;
const SAVE_DELAY_MS = 200;
const emptyState = () => ({ workspaces: [], repos: {}, activeId: null });

// Workspace names: auto-named ones follow Claude Code's conversation topic (ws.topic, from the
// terminal title); a name you typed (at creation or by renaming) is kept (ws.nameLocked).
// Older workspaces had no flag: generated names ("repo 3") and ones made from the first prompt
// count as automatic, anything else as yours.
function migrate(state) {
  for (const ws of state.workspaces) {
    if (ws.nameLocked !== undefined) continue;
    const generated = new RegExp(`^${escapeRe(path.basename(ws.repo || ''))} \\d+$`).test(ws.name || '');
    const fromPrompt = !!ws.title && ws.title.startsWith(ws.name || '\0');
    ws.nameLocked = !(generated || fromPrompt);
  }
}

// readOnly: a copy that only hands over to the running one on launch must never write.
module.exports = function createStore(dataDir, { readOnly = false } = {}) {
  const file = path.join(dataDir, 'state.json');
  const backupDir = path.join(dataDir, 'state-backups');
  const listBackups = () => {
    try {
      return fs
        .readdirSync(backupDir)
        .filter((f) => /^state-.+\.json$/.test(f))
        .sort()
        .reverse()
        .map((f) => path.join(backupDir, f));
    } catch {
      return [];
    }
  };

  function load() {
    const read = (f) => ({ ...emptyState(), ...JSON.parse(fs.readFileSync(f, 'utf8')) });
    if (fs.existsSync(file)) {
      try {
        return read(file);
      } catch (e) {
        const aside = path.join(dataDir, `state.damaged-${Date.now()}.json`);
        try {
          fs.renameSync(file, aside);
        } catch {
          /* keep going */
        }
        console.error(`state.json could not be read (${e.message}); kept it as ${path.basename(aside)}, loading the newest backup`);
      }
    }
    for (const b of listBackups()) {
      try {
        return read(b);
      } catch {
        /* try an older one */
      }
    }
    return emptyState();
  }

  const state = load();
  migrate(state);

  let lastBackup = 0;
  function write() {
    if (readOnly) return;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const json = JSON.stringify(state, null, 2);
      const tmp = `${file}.${process.pid}.tmp`;
      const fd = fs.openSync(tmp, 'w', 0o600);
      fs.writeSync(fd, json);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(tmp, file);
      if (state.workspaces.length && Date.now() - lastBackup > BACKUP_EVERY_MS) {
        lastBackup = Date.now();
        fs.mkdirSync(backupDir, { recursive: true });
        fs.writeFileSync(path.join(backupDir, `state-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), json, { mode: 0o600 });
        for (const old of listBackups().slice(BACKUP_KEEP)) fs.rmSync(old, { force: true });
      }
    } catch (e) {
      console.error('Could not save state:', e.message);
    }
  }

  let timer = null;
  return {
    state,
    // Save soon (bursts of changes become one write).
    save() {
      clearTimeout(timer);
      timer = setTimeout(write, SAVE_DELAY_MS);
    },
    // Save now (on quit).
    flush() {
      clearTimeout(timer);
      write();
    },
  };
};
