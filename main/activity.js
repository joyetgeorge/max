// The activity log behind the Agent Activity app: every hook event of every workspace, newest
// last, kept in memory for this run. A tool call is one entry: PreToolUse creates it and
// PostToolUse completes it (end time, a short result, whether it failed). Each new or completed
// entry is pushed to the renderer as `activity:event`.
const os = require('os');

const MAX = 3000;

const clip = (v, n) => {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s;
};
function toolTarget(p) {
  const i = p.tool_input || {};
  const t = i.file_path || i.notebook_path || i.path || i.command || i.pattern || i.url || i.query || i.description || i.prompt || i.skill || '';
  return String(t).replace(os.homedir(), '~').split('\n')[0].slice(0, 200);
}

module.exports = function createActivityLog(send) {
  const entries = [];
  const openTools = new Map(); // tool_use_id -> entry
  let seq = 0;

  function log(wsId, event, p) {
    if (event === 'PostToolUse') {
      const e = openTools.get(p.tool_use_id);
      if (!e) return;
      openTools.delete(p.tool_use_id);
      const r = p.tool_response;
      e.end = Date.now();
      e.result = clip(r, 4000);
      e.failed = !!(r && typeof r === 'object' && (r.is_error || r.isError || r.success === false || (r.error && !r.stdout)));
      send('activity:event', e);
      return;
    }
    const e = { id: ++seq, ts: Date.now(), wsId, event, session: p.session_id || '', agent: p.agent_id ? p.agent_type || 'agent' : '' };
    if (event === 'PreToolUse') {
      Object.assign(e, { tool: p.tool_name || '', detail: toolTarget(p), input: clip(p.tool_input, 4000) });
      if (p.tool_use_id) openTools.set(p.tool_use_id, e);
    } else if (event === 'UserPromptSubmit') e.detail = clip(p.prompt, 4000);
    else if (event === 'Notification') e.detail = p.message || '';
    else if (event === 'SubagentStart' || event === 'SubagentStop') e.detail = p.agent_type || 'agent';
    else if (event === 'SessionStart') e.detail = p.source || '';
    else if (event === 'SessionEnd') e.detail = p.reason || '';
    else if (event === 'PreCompact') e.detail = p.trigger || '';
    entries.push(e);
    if (entries.length > MAX) {
      const old = entries.shift();
      for (const [k, v] of openTools) if (v === old) openTools.delete(k);
    }
    send('activity:event', e);
  }

  return {
    // Never throws: the log must not break status tracking.
    log(wsId, event, p) {
      try {
        log(wsId, event, p);
      } catch {
        /* ignore */
      }
    },
    list: () => entries,
    clear() {
      entries.length = 0;
      openTools.clear();
    },
  };
};
