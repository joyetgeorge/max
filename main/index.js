// Max — main process: the app's lifecycle and window, workspaces and their PTYs (claude + shells),
// status from Claude Code's hooks, and the IPC the renderer calls (see preload.js).
// The rest of the main process lives in the modules required below.
const { app, BrowserWindow, ipcMain, dialog, Notification, shell, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const pty = require('node-pty');
const theme = require('./app-theme');
const createStore = require('./state');
const createHookServer = require('./hooks');
const createRnNet = require('./rn-net');
const createActivityLog = require('./activity');
const createDevices = require('./devices');
const createCodeNav = require('./code-nav');
const searchFiles = require('./search');
const Git = require('./git');
const Files = require('./files');
const icons = require('./icons');
const { escapeRe, sh, slugify, insideCwd, kill } = require('./util');

app.setName('Max');
// State (workspaces, localStorage) predates the rename: keep it in the original
// "max" folder so existing workspaces carry over.
// DECK_USER_DATA isolates state (used by the smoke test).
app.setPath('userData', process.env.DECK_USER_DATA || path.join(app.getPath('appData'), 'max'));
const DATA_DIR = app.getPath('userData');

// One Max per data folder. Two copies on the same folder (e.g. the installed app and `npm start`)
// silently lose data: the second can't lock Chromium's storage, so everything it saves (notes,
// tabs, app contents) lives only in memory, and both overwrite each other's state.json.
// Locked per userData dir, so DECK_USER_DATA (the smoke test) runs alongside.
//
// A second launch always quits at once and hands over to the running copy. If it's the *other*
// kind (installed Max vs the dev copy), the running copy asks whether to keep itself or switch:
// switching quits it cleanly (state saved, Chromium storage flushed) and starts the other.
const KIND = app.isPackaged ? 'max' : 'dev';
const KIND_NAME = { max: 'the installed Max', dev: 'the dev copy (npm start)' };
const gotInstanceLock = app.requestSingleInstanceLock({ kind: KIND });
if (!gotInstanceLock) app.quit();
let relaunchOther = null; // { exe, args, cwd } to start once we've quit
app.on('second-instance', async (_e, argv, cwd, data) => {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
  }
  const other = data?.kind;
  if (!other || other === KIND) return;
  const opts = {
    type: 'question',
    buttons: [`Keep ${KIND === 'max' ? 'Max' : 'the dev copy'}`, `Switch to ${other === 'max' ? 'Max' : 'the dev copy'}`],
    defaultId: 0,
    cancelId: 0,
    message: `You opened ${KIND_NAME[other]}, but ${KIND_NAME[KIND]} is running`,
    detail: 'They share the same workspaces, notes and tabs, so only one can run at a time. Switching quits this one (everything is saved) and opens the other.',
  };
  const { response } = await (win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
  if (response !== 1) return;
  relaunchOther = { exe: argv[0], args: argv.slice(1), cwd };
  app.quit();
});
// Start the other copy after we're gone: a short delay lets this process release the lock first.
app.on('will-quit', () => {
  if (!relaunchOther) return;
  const { exe, args, cwd } = relaunchOther;
  relaunchOther = null;
  spawn('/bin/sh', ['-c', 'sleep 1.5; exec "$0" "$@"', exe, ...args], { cwd, detached: true, stdio: 'ignore' }).unref();
});

const ROOT = path.join(__dirname, '..');
const APP_ICON = path.join(ROOT, 'renderer', 'assets', 'icon.png');
const WORKTREE_ROOT = path.join(os.homedir(), '.max', 'worktrees');
const USER_SHELL = process.env.SHELL || '/bin/zsh';

let win = null;

// ---------- state ----------
// Persisted (state.json, see state.js). The copy that hands over on launch never writes.
const store = createStore(DATA_DIR, { readOnly: !gotInstanceLock });
const { state, save } = store;
const findWs = (id) => state.workspaces.find((w) => w.id === id);
const patchRepo = (root, patch) => (state.repos[root] = { ...state.repos[root], ...patch });
// The name shown for a workspace: Claude's topic while it is auto-named, else the name you gave it.
const nameOf = (ws) => (!ws.nameLocked && ws.topic) || ws.name;
// Runtime-only status, never persisted.
const runtime = new Map(); // wsId -> { status, activity, message, unread, agents }
const ptys = new Map(); // `${wsId}:${kind}` -> IPty
const codeNav = createCodeNav();
const hookServer = createHookServer({ dir: path.join(DATA_DIR, 'hooks'), isWorkspace: (id) => !!findWs(id), onEvent: handleHook });

// Claude Code keeps each folder's conversations in ~/.claude/projects/<path with non-alphanumerics as '-'>.
const claudeSessionsDir = (cwd) => path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
const hasSessions = (dir) => {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.jsonl'));
  } catch {
    return false;
  }
};

// Self-repair: a worktree under WORKTREE_ROOT with no workspace, whose hook file is still there
// (they're deleted when you close a workspace, even with "keep worktree"), lost its workspace
// some other way — add it back. Its id is recovered from the hook file name (the worktree folder
// ends with the id's first 4 characters), so its tabs and other saved bits come back too.
async function adoptOrphanWorktrees() {
  const hooks = hookServer.settingsIds();
  if (!hooks) return 0;
  const known = new Set(state.workspaces.map((w) => path.resolve(w.cwd)));
  let added = 0;
  let repoDirs = [];
  try {
    repoDirs = fs.readdirSync(WORKTREE_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return 0;
  }
  for (const r of repoDirs) {
    for (const d of fs.readdirSync(path.join(WORKTREE_ROOT, r.name), { withFileTypes: true })) {
      const cwd = path.join(WORKTREE_ROOT, r.name, d.name);
      if (!d.isDirectory() || known.has(cwd) || !fs.existsSync(path.join(cwd, '.git'))) continue;
      const short = d.name.split('-').pop();
      const id = hooks.find((h) => h.length === 12 && h.startsWith(short));
      if (!id || findWs(id)) continue;
      let repo;
      try {
        repo = path.dirname((await Git.run(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
      } catch {
        continue; // not a working git worktree any more
      }
      // "agent-harness-app-10-62ec" was made from the name "agent-harness-app 10".
      const stem = d.name.slice(0, -(short.length + 1));
      const m = new RegExp(`^${escapeRe(path.basename(repo))}-(\\d+)$`).exec(stem);
      state.workspaces.push({
        id,
        name: m ? `${path.basename(repo)} ${m[1]}` : stem.replace(/-/g, ' '),
        repo,
        cwd,
        worktree: true,
        branch: `deck/${d.name}`,
        baseBranch: null,
        createdAt: fs.statSync(cwd).birthtimeMs || Date.now(),
        nameLocked: false,
        recovered: true,
      });
      patchRepo(repo, { lastUsed: state.repos[repo]?.lastUsed || Date.now() });
      known.add(cwd);
      added++;
    }
  }
  if (added) {
    console.log(`Recovered ${added} worktree workspace${added === 1 ? '' : 's'}`);
    save();
  }
  return added;
}

// ---------- runtime status ----------
const send = (ch, ...args) => win && !win.isDestroyed() && win.webContents.send(ch, ...args);
const activity = createActivityLog(send);

function rt(id) {
  if (!runtime.has(id)) runtime.set(id, { status: 'idle', activity: '', message: '', unread: false, agents: [] });
  return runtime.get(id);
}
function setStatus(id, patch) {
  const r = rt(id);
  // Hooks fire on every tool call; skip the IPC + sidebar re-render when nothing changed.
  if (Object.keys(patch).every((k) => r[k] === patch[k])) return;
  Object.assign(r, patch);
  send('ws:status', id, r);
  updateBadge();
}
let lastBadge = null;
function updateBadge() {
  let n = 0;
  for (const r of runtime.values()) if (r.unread) n++;
  const badge = n ? String(n) : '';
  if (badge === lastBadge) return;
  lastBadge = badge;
  if (app.dock) app.dock.setBadge(badge);
}

// ---------- hook events → status ----------
function describeTool(p) {
  const i = p.tool_input || {};
  const target = i.file_path || i.path || i.command || i.pattern || i.url || i.description || '';
  const short = String(target).replace(os.homedir(), '~').split('\n')[0].slice(0, 80);
  return short ? `${p.tool_name} · ${short}` : p.tool_name || '';
}

function handleHook(wsId, event, p) {
  const ws = findWs(wsId);
  const isActive = state.activeId === wsId && win && win.isFocused();
  activity.log(wsId, event, p);
  switch (event) {
    case 'SessionStart':
      if (p.session_id && ws.sessionId !== p.session_id) {
        ws.sessionId = p.session_id;
        save();
      }
      setStatus(wsId, { status: 'idle', activity: '', agents: [] });
      break;
    case 'UserPromptSubmit':
      if (!ws.title && p.prompt) {
        ws.title = String(p.prompt).split('\n')[0].slice(0, 80);
        save();
        send('ws:updated', ws);
      }
      setStatus(wsId, { status: 'running', activity: 'Thinking…', message: '' });
      break;
    case 'PreToolUse':
      setStatus(wsId, { status: 'running', activity: describeTool(p), message: '' });
      break;
    case 'PostToolUse':
      if (rt(wsId).status === 'waiting') setStatus(wsId, { status: 'running', message: '' });
      break;
    case 'Notification':
      // The idle reminder after a finished turn shouldn't downgrade "done".
      if (rt(wsId).status === 'done' && /waiting for your input/i.test(p.message || '')) break;
      setStatus(wsId, { status: 'waiting', message: p.message || 'Needs your input', unread: !isActive });
      notify(ws, p.message || 'Needs your input');
      break;
    case 'SubagentStart': {
      // Running subagents, keyed by agent_id; the main agent is implicit.
      const agents = rt(wsId).agents.filter((a) => a.id !== p.agent_id);
      agents.push({ id: p.agent_id || crypto.randomUUID(), type: p.agent_type || 'agent' });
      setStatus(wsId, { agents });
      break;
    }
    case 'SubagentStop': {
      const agents = rt(wsId).agents;
      const i = p.agent_id ? agents.findIndex((a) => a.id === p.agent_id) : agents.length - 1;
      if (i >= 0) setStatus(wsId, { agents: agents.filter((_, j) => j !== i) });
      break;
    }
    case 'Stop':
      setStatus(wsId, { status: 'done', activity: '', unread: !isActive });
      notify(ws, 'Finished — ready for review');
      break;
    default:
      break;
  }
}

// ---------- notifications ----------
const liveNotifications = new Set(); // keep a reference, or the click handler can be garbage-collected
// Clicking a notification brings Max forward, then runs onClick.
function showNotification(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false, icon: APP_ICON });
  liveNotifications.add(n);
  n.on('click', () => {
    liveNotifications.delete(n);
    win.show();
    win.focus();
    onClick();
  });
  n.on('close', () => liveNotifications.delete(n));
  n.show();
}
function notify(ws, body) {
  if (state.activeId === ws.id && win && win.isFocused()) return;
  showNotification(nameOf(ws), body, () => send('ws:focus', ws.id));
}

// ---------- PTYs ----------
function spawnTerm(wsId, kind, cols, rows) {
  const key = `${wsId}:${kind}`;
  if (ptys.has(key)) return { key, alive: true };
  const ws = findWs(wsId);
  if (!ws) throw new Error('Unknown workspace');

  let command;
  if (kind === 'claude') {
    const settings = hookServer.writeSettings(wsId);
    // A repo can need its own launcher (e.g. a script that adds --add-dir flags and then execs claude).
    // It's used verbatim as a shell command; our flags are appended, so it must pass "$@" through to claude.
    const launcher = ws.claudeCommand || state.repos[ws.repo]?.claudeCommand || 'claude';
    const parts = [launcher, '--settings', sh(settings)];
    // Resume the saved conversation; if that's unknown (or its transcript is gone), continue the
    // folder's most recent one, so a workspace never silently starts from scratch.
    const sessions = claudeSessionsDir(ws.cwd);
    if (ws.sessionId && fs.existsSync(path.join(sessions, `${ws.sessionId}.jsonl`))) parts.push('--resume', sh(ws.sessionId));
    else if (!ws.pendingPrompt && hasSessions(sessions)) parts.push('--continue');
    else if (ws.pendingPrompt) parts.push(sh(ws.pendingPrompt));
    if (ws.pendingPrompt) {
      delete ws.pendingPrompt;
      save();
    }
    // Keep a shell around if claude exits so the user can see why.
    command = `${parts.join(' ')}; echo; echo "[claude exited — restart it with ⌘⇧R]"; exec ${USER_SHELL} -l`;
  } else if (ws.pendingSetup) {
    command = `echo "▶ setup: ${ws.pendingSetup.replace(/"/g, '\\"')}"; ${ws.pendingSetup}; exec ${USER_SHELL} -l`;
    delete ws.pendingSetup;
    save();
  }

  const args = command ? ['-l', '-i', '-c', command] : ['-l'];
  const p = pty.spawn(USER_SHELL, args, {
    name: 'xterm-256color',
    cols: cols || 100,
    rows: rows || 30,
    cwd: fs.existsSync(ws.cwd) ? ws.cwd : os.homedir(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'max',
      DECK_WORKSPACE: ws.name,
      DECK_ROOT_PATH: ws.repo,
      DECK_BASE_BRANCH: ws.baseBranch || '',
    },
  });
  ptys.set(key, p);
  if (kind === 'claude') setStatus(wsId, { status: 'starting', activity: '', message: '', agents: [] });

  // Coalesce output into ~8ms frames to keep IPC cheap during heavy redraws.
  let buf = '';
  let timer = null;
  p.onData((d) => {
    if (kind === 'claude' && d.includes('\x07') && state.activeId !== wsId) setStatus(wsId, { unread: true });
    buf += d;
    if (!timer)
      timer = setTimeout(() => {
        send('term:data', key, buf);
        buf = '';
        timer = null;
      }, 8);
  });
  p.onExit(({ exitCode }) => {
    if (ptys.get(key) === p) ptys.delete(key); // a restart may already have replaced it
    send('term:exit', key, exitCode);
    if (kind === 'claude') setStatus(wsId, { status: 'exited', activity: '', agents: [] });
  });
  return { key, alive: false };
}

// End a PTY (if it's running) and forget it.
function killTerm(key) {
  const p = ptys.get(key);
  if (!p) return;
  ptys.delete(key);
  kill(p);
}
function killWsTerms(wsId) {
  for (const key of [...ptys.keys()]) if (key.startsWith(`${wsId}:`)) killTerm(key);
}

// ---------- IPC ----------
// Explorer editors with unsaved changes, per workspace (count). Checked before quitting.
const dirtyEditors = new Map();

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (_e, ...args) => fn(...args));
  // For handlers that act on a workspace: called with the workspace instead of its id.
  // An id that no longer exists (the workspace was just closed) answers `missing`.
  const handleWs = (channel, fn, missing = null) =>
    handle(channel, (id, ...args) => {
      const ws = findWs(id);
      return ws ? fn(ws, ...args) : missing;
    });

  handle('state:get', () => ({
    workspaces: state.workspaces,
    repos: state.repos,
    activeId: state.activeId,
    runtime: Object.fromEntries(runtime),
    home: os.homedir(),
    theme,
  }));

  // ----- repositories -----
  handle('repo:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Choose a git repository' });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('repo:inspect', async (dir) => {
    const root = await Git.repoRoot(dir);
    const current = await Git.currentBranch(root);
    const branches = (await Git.run(root, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads']))
      .split('\n')
      .filter(Boolean)
      .slice(0, 200);
    return { root, current, branches, setup: state.repos[root]?.setup || '', claudeCommand: state.repos[root]?.claudeCommand || '' };
  });
  // Repo logo shown in the sidebar header: a material-icon-theme icon name (null = default folder).
  handle('repo:setLogo', (root, logo) => {
    patchRepo(root, { logo: logo || undefined });
    save();
  });

  // ----- workspaces -----
  handle('ws:create', async (opts) => {
    const { repo, name, useWorktree, baseBranch, prompt, setup } = opts;
    const claudeCommand = (opts.claudeCommand || '').trim();
    const root = await Git.repoRoot(repo);
    const id = crypto.randomBytes(6).toString('hex');
    const displayName = name || (prompt ? prompt.split('\n')[0].slice(0, 40) : `${path.basename(root)} ${state.workspaces.length + 1}`);
    let cwd = root;
    let branch = null;

    if (useWorktree) {
      const slug = `${slugify(displayName)}-${id.slice(0, 4)}`;
      branch = `deck/${slug}`;
      cwd = path.join(WORKTREE_ROOT, path.basename(root), slug);
      fs.mkdirSync(path.dirname(cwd), { recursive: true });
      await Git.run(root, ['worktree', 'add', '-b', branch, cwd, baseBranch || 'HEAD']);
    } else if (baseBranch) {
      // No worktree: the session runs in the repo root, so put the root on the chosen branch.
      // git refuses (and we surface the error) if uncommitted changes would be overwritten.
      if ((await Git.currentBranch(root)) !== baseBranch) await Git.run(root, ['switch', baseBranch]);
    }

    patchRepo(root, { setup: setup || '', claudeCommand: claudeCommand || undefined, lastUsed: Date.now() });
    const ws = {
      id,
      name: displayName,
      nameLocked: !!name, // typed in the form: keep it; otherwise follow Claude's topic
      repo: root,
      cwd,
      worktree: !!useWorktree,
      branch,
      baseBranch: baseBranch || null,
      ...(claudeCommand ? { claudeCommand } : {}),
      createdAt: Date.now(),
      ...(prompt ? { pendingPrompt: prompt } : {}),
      ...(useWorktree && setup ? { pendingSetup: setup } : {}),
    };
    state.workspaces.push(ws);
    state.activeId = id;
    save();
    return ws;
  });

  handle('ws:setActive', (id) => {
    state.activeId = id;
    save();
    if (runtime.has(id)) setStatus(id, { unread: false });
  });

  handleWs('ws:rename', (ws, name) => {
    if (name.trim()) {
      ws.name = name.trim();
      ws.nameLocked = true; // your name wins over Claude's topic
      save();
    }
    return ws;
  });
  // Claude Code's conversation topic (from its terminal title), cleaned up by the renderer.
  handleWs('ws:setTopic', (ws, topic) => {
    if (!topic || ws.topic === topic) return ws;
    ws.topic = topic;
    save();
    send('ws:updated', ws);
    return ws;
  });
  // Auto-name on: the name follows the topic. Off: keep `name` (what's shown now) for good.
  handleWs('ws:setAutoName', (ws, auto, name) => {
    ws.nameLocked = !auto;
    if (!auto && name?.trim()) ws.name = name.trim();
    save();
    send('ws:updated', ws);
    return ws;
  });

  handle('ws:reorder', (ids) => {
    state.workspaces.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    save();
  });

  handleWs(
    'ws:remove',
    async (ws) => {
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ws.worktree ? ['Cancel', 'Close, keep worktree', 'Close & delete worktree'] : ['Cancel', 'Close'],
        defaultId: 1,
        cancelId: 0,
        message: `Close “${ws.name}”?`,
        detail: ws.worktree
          ? `Worktree: ${ws.cwd}\nBranch ${ws.branch} is kept either way.`
          : 'The agent process will be stopped. The repository is untouched.',
      });
      if (response === 0) return false;
      killWsTerms(ws.id);
      codeNav.stop(ws.cwd);
      if (ws.worktree && response === 2) {
        try {
          await Git.run(ws.repo, ['worktree', 'remove', '--force', ws.cwd]);
        } catch (e) {
          dialog.showErrorBox('Could not remove worktree', e.message);
        }
      }
      hookServer.removeSettings(ws.id);
      state.workspaces = state.workspaces.filter((w) => w.id !== ws.id);
      runtime.delete(ws.id);
      if (state.activeId === ws.id) state.activeId = state.workspaces[0]?.id || null;
      save();
      updateBadge();
      return true;
    },
    false,
  );

  // ----- terminals -----
  handle('term:start', spawnTerm);
  ipcMain.on('term:write', (_e, key, data) => ptys.get(key)?.write(data));
  // Closing a shell tab ends its process.
  ipcMain.on('term:kill', (_e, key) => {
    if (!key.endsWith(':claude')) killTerm(key);
  });
  ipcMain.on('term:resize', (_e, key, cols, rows) => {
    try {
      ptys.get(key)?.resize(Math.max(cols, 2), Math.max(rows, 2));
    } catch {
      /* pty may have exited */
    }
  });
  handle('term:restart', (wsId, kind, cols, rows, fresh) => {
    killTerm(`${wsId}:${kind}`);
    if (fresh) {
      delete findWs(wsId).sessionId;
      save();
    }
    return spawnTerm(wsId, kind, cols, rows);
  });

  // ----- git: sidebar stat + Review tab -----
  handleWs('git:info', Git.infoOnce);
  handleWs('git:changes', Git.changes);
  handleWs('git:fileDiff', Git.fileDiff);
  handleWs(
    'git:revert',
    async (ws, scope, file) => {
      const src = await Git.diffSource(ws, scope);
      const isNew = file.untracked || file.status === 'A';
      const target = scope === 'uncommitted' ? 'the last commit' : `the ${Git.baseLabel(ws, scope)} version`;
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Cancel', isNew ? 'Delete file' : 'Revert file'],
        defaultId: 0,
        cancelId: 0,
        message: isNew ? `Delete ${file.path}?` : `Revert ${file.path} to ${target}?`,
        detail: 'This discards the changes in the working tree and cannot be undone.',
      });
      if (response !== 1) return false;
      await Git.discard(ws, src, file);
      return true;
    },
    false,
  );

  // ----- Files tab -----
  handleWs('fs:list', Files.list);
  handleWs('fs:files', Files.listAll, []); // ⌘P
  handleWs('fs:read', Files.read);
  handleWs('fs:status', Git.status, {});
  handle('fs:write', (id, rel, text, expectMtime) => {
    const ws = findWs(id);
    if (!ws) throw new Error('Workspace not found');
    return Files.write(ws, rel, text, expectMtime);
  });
  ipcMain.on('editor:dirty', (_e, id, n) => {
    if (n) dirtyEditors.set(id, n);
    else dirtyEditors.delete(id);
  });

  // ⌘⇧F. A new search in the same workspace cancels the previous one.
  const searches = new Map(); // wsId -> { kill }
  handle('fs:search', (id, opts) => {
    const ws = findWs(id);
    if (!ws || !opts?.query) return { files: [], total: 0 };
    searches.get(id)?.kill();
    return searchFiles(ws.cwd, opts, (job) => searches.set(id, job));
  });
  handle('fs:searchCancel', (id) => searches.get(id)?.kill());

  // ⌘-click: go to definition (TypeScript language server for JS/TS, a declaration search otherwise).
  handleWs('code:warm', (ws, file) => codeNav.warm(ws.cwd, ws.repo, file), false);
  handle('code:definition', (id, req) => {
    const ws = findWs(id);
    if (!ws || !req?.file) return { defs: [] };
    insideCwd(ws, req.file);
    return codeNav.definition(ws.cwd, ws.repo, req);
  });

  // ----- bundled icons -----
  handle('icons:manifest', icons.iconManifest);
  handle('icons:list', icons.iconNames);

  // ----- opening things outside Max -----
  handle('open:external', (url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  handleWs('open:path', (ws, how) => {
    if (how === 'finder') shell.openPath(ws.cwd);
    if (how === 'vscode') execFile('open', ['-a', 'Visual Studio Code', ws.cwd]);
  });
  handleWs('open:file', (ws, rel, line) => {
    const abs = insideCwd(ws, rel);
    // `code -g` jumps to the line; fall back to plain open if the CLI isn't installed.
    execFile('code', ['-g', `${abs}:${line || 1}`], (err) => {
      if (err) execFile('open', ['-a', 'Visual Studio Code', abs]);
    });
  });

  // ----- apps -----
  // React Native network inspector (the Network app); scans for apps only while it's open.
  const rnNet = createRnNet(send);
  handle('rnnet:start', () => rnNet.start());
  handle('rnnet:reconnect', () => rnNet.reconnect());
  handle('rnnet:reload', () => rnNet.reload());
  // Agent Activity: the hook-event log (see activity.js).
  handle('activity:list', () => activity.list());
  handle('activity:clear', () => activity.clear());
  // Device Mirror: simulator / device screenshots and Android input (see devices.js).
  const devices = createDevices();
  handle('dev:list', () => devices.list());
  handle('dev:capture', (id) => devices.capture(id));
  handle('dev:saveTemp', (id) => devices.saveTemp(id));
  handle('dev:copy', (id) => devices.copy(id));
  handle('dev:save', async (id) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('desktop'), devices.defaultName(id)), filters: [{ name: 'PNG image', extensions: ['png'] }] });
    return r.canceled ? null : devices.saveTo(id, r.filePath);
  });
  handle('dev:openUrl', (id, url) => devices.openUrl(id, String(url)));
  handle('dev:input', (id, ev) => devices.input(id, ev));
  handle('dev:openSimulator', () => devices.openSimulator());
  // Reminders from the renderer (e.g. a task falling due): a click tells the page which item it was about.
  handle('notify', ({ title, body, tag }) => showNotification(title, body, () => send('notify:click', tag)));
}

// ---------- window ----------
function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
      },
      {
        label: 'Window',
        submenu: [{ label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('menu:close') }, { role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
      },
    ]),
  );
}

// Apps launched from Finder/Dock get launchd's minimal PATH (/usr/bin:/bin:…), so
// Homebrew git, `code`, etc. wouldn't be found. Adopt the login shell's PATH once.
function loadShellPath() {
  if (!app.isPackaged) return Promise.resolve();
  return new Promise((resolve) => {
    execFile(USER_SHELL, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { timeout: 4000 }, (err, stdout) => {
      const m = !err && /__PATH__(.*)__PATH__/.exec(stdout || '');
      if (m && m[1]) process.env.PATH = m[1];
      resolve();
    });
  });
}

function isDark(hexColor) {
  const n = parseInt(hexColor.slice(1), 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum < 128;
}

function createWindow() {
  win = new BrowserWindow({
    width: Number(process.env.DECK_SMOKE_W || 1500),
    height: 950,
    minWidth: 900,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    icon: APP_ICON, // Windows/Linux taskbar; macOS uses the Dock icon set at startup
    // Theme opacity below 1: a transparent window over a native blur; the page paints the
    // theme background at that opacity.
    transparent: theme.opacity < 1,
    backgroundColor: theme.opacity < 1 ? '#00000000' : theme.background,
    ...(theme.opacity < 1 && theme.blur > 0 ? { vibrancy: 'under-window', visualEffectState: 'active' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // Keep the blur material dark/light to match the theme background.
  nativeTheme.themeSource = isDark(theme.background) ? 'dark' : 'light';
  // No close/minimize/zoom buttons — use ⌘Q, ⌘M and ⌃⌘F instead.
  if (process.platform === 'darwin') win.setWindowButtonVisibility(false);
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  win.on('focus', () => {
    if (state.activeId && runtime.has(state.activeId)) setStatus(state.activeId, { unread: false });
  });
  // ⌘W / Close Window hides instead of closing: agents keep running, and the Dock icon
  // (or a notification) brings the window back. ⌘Q is the real quit.
  win.on('close', (e) => {
    if (quitting || process.platform !== 'darwin') return;
    e.preventDefault();
    if (win.isFullScreen()) {
      win.once('leave-full-screen', () => win.hide());
      win.setFullScreen(false);
    } else win.hide();
  });
  // Links clicked inside the app open externally.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

let closeConfirmed = false;
app.whenReady().then(async () => {
  if (!gotInstanceLock) return; // quitting: the running copy took over
  await adoptOrphanWorktrees().catch((e) => console.error('Worktree recovery failed:', e.message));
  if (app.dock) app.dock.setIcon(APP_ICON);
  await Promise.all([hookServer.start(), loadShellPath()]);
  registerIpc();
  buildMenu();
  createWindow();
  if (process.env.DECK_SMOKE_SHOT) {
    // Smoke test: optionally run JS in the page, screenshot after the agent boots, then quit.
    if (process.env.DECK_SMOKE_EVAL)
      setTimeout(() => win.webContents.executeJavaScript(process.env.DECK_SMOKE_EVAL), 3000);
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.DECK_SMOKE_SHOT, img.toPNG());
      fs.writeFileSync(`${process.env.DECK_SMOKE_SHOT}.json`, JSON.stringify(Object.fromEntries(runtime), null, 2));
      app.quit();
    }, Number(process.env.DECK_SMOKE_DELAY || 12000));
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else win?.show();
  });
});

let quitting = false;
app.on('before-quit', (e) => {
  const unsaved = [...dirtyEditors.values()].reduce((a, b) => a + b, 0);
  if (unsaved && !closeConfirmed && win && !win.isDestroyed()) {
    // Free-standing alert, not a sheet: sheets on the transparent window misbehave.
    const response = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Cancel', 'Quit Without Saving'],
      defaultId: 0,
      cancelId: 0,
      message: `You have ${unsaved} unsaved file${unsaved === 1 ? '' : 's'}.`,
      detail: 'Your changes will be lost if you quit without saving.',
    });
    if (response !== 1) {
      e.preventDefault();
      relaunchOther = null; // the switch is off too
      win.show();
      return;
    }
    closeConfirmed = true;
  }
  quitting = true;
  codeNav.stop();
  for (const p of ptys.values()) kill(p);
  store.flush();
});
app.on('window-all-closed', () => app.quit());
