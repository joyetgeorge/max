// Claude Code hooks → the app. Each workspace's `claude` is started with a settings file whose
// hooks `curl` their JSON payload to a token-protected localhost server:
//   POST /hook/<token>/<wsId>/<event>
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact'];

// dir: where the per-workspace settings files live. isWorkspace(id): is this a known workspace?
// onEvent(wsId, event, payload): called for every hook that fires.
module.exports = function createHookServer({ dir, isWorkspace, onEvent }) {
  const token = crypto.randomBytes(16).toString('hex');
  let port = 0;
  const settingsFile = (wsId) => path.join(dir, `${wsId}.json`);

  function start() {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        const [, kind, reqToken, wsId, event] = (req.url || '').split('/');
        if (req.method !== 'POST' || kind !== 'hook' || reqToken !== token || !isWorkspace(wsId)) {
          res.writeHead(404).end();
          return;
        }
        let body = '';
        req.on('data', (c) => {
          body += c;
          if (body.length > 1e6) req.destroy();
        });
        req.on('end', () => {
          let payload = {};
          try {
            payload = JSON.parse(body || '{}');
          } catch {
            /* ignore malformed payloads */
          }
          onEvent(wsId, event, payload);
          res.writeHead(200).end();
        });
      });
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  }

  // Write the workspace's settings file (the port and token change on every launch); returns its path.
  function writeSettings(wsId) {
    fs.mkdirSync(dir, { recursive: true });
    const cmd = (event) => ({
      type: 'command',
      command: `curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${port}/hook/${token}/${wsId}/${event} >/dev/null 2>&1 || true`,
    });
    const hooks = Object.fromEntries(EVENTS.map((e) => [e, [{ ...(e.endsWith('ToolUse') ? { matcher: '*' } : {}), hooks: [cmd(e)] }]]));
    const file = settingsFile(wsId);
    fs.writeFileSync(file, JSON.stringify({ hooks }, null, 2), { mode: 0o600 });
    return file;
  }

  return {
    start,
    writeSettings,
    removeSettings: (wsId) => fs.rmSync(settingsFile(wsId), { force: true }),
    // Workspace ids that have a settings file; null if the folder can't be read.
    settingsIds() {
      try {
        return fs.readdirSync(dir).map((f) => f.replace(/\.json$/, ''));
      } catch {
        return null;
      }
    },
  };
};
