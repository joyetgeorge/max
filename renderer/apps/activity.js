/* global deck, S, STATUS_TEXT, wsLabel, select, openTab */
'use strict';

// Agent Activity: a live timeline of every workspace's Claude — prompts, tool calls (with
// duration and result), questions, finished turns and subagents — from the hook events the main
// process already receives (see main/activity.js). The strip on top shows what each agent
// is doing right now. Click a row for its details; "Open" jumps to that workspace's Claude.
(() => {
  const { node: el, icon: ph, store } = window.Kit;
  const { button, copy } = window.DeckApps.ui;

  const TOOL_ICONS = [
    [/^Bash$|^BashOutput$|^KillShell$/, 'terminal'],
    [/^Read$|^NotebookRead$/, 'file-text'],
    [/^(Edit|MultiEdit|Write|NotebookEdit)$/, 'pencil-simple'],
    [/^(Grep|Glob|LS)$/, 'magnifying-glass'],
    [/^(WebFetch|WebSearch)$/, 'globe'],
    [/^(Task|Agent)$/, 'robot'],
    [/^TodoWrite$/, 'list-checks'],
    [/^Skill$/, 'sparkle'],
    [/^mcp__/, 'plugs'],
  ];
  const toolIcon = (name) => TOOL_ICONS.find(([re]) => re.test(name))?.[1] || 'wrench';
  const EVENTS = {
    UserPromptSubmit: { icon: 'chat-text', label: 'Prompt', cls: 'prompt' },
    PreToolUse: { icon: 'wrench', label: 'Tool', cls: 'tool' },
    Notification: { icon: 'bell-ringing', label: 'Needs input', cls: 'wait' },
    Stop: { icon: 'check-circle', label: 'Finished', cls: 'done' },
    SubagentStart: { icon: 'robot', label: 'Subagent started', cls: 'agent' },
    SubagentStop: { icon: 'robot', label: 'Subagent finished', cls: 'agent' },
    SessionStart: { icon: 'play-circle', label: 'Session started', cls: 'session' },
    SessionEnd: { icon: 'stop-circle', label: 'Session ended', cls: 'session' },
    PreCompact: { icon: 'archive', label: 'Compacting context', cls: 'session' },
  };
  const FILTERS = [
    ['all', 'All', () => true],
    ['prompts', 'Prompts', (e) => e.event === 'UserPromptSubmit'],
    ['tools', 'Tools', (e) => e.event === 'PreToolUse'],
    ['attention', 'Attention', (e) => e.event === 'Notification' || e.event === 'Stop' || e.failed],
    ['errors', 'Failed', (e) => e.failed],
  ];

  const fmtClock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const fmtDur = (ms) => (ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
  // Workspace globals from app.js (loaded after this file; only used at runtime).
  const wsOf = (id) => S.workspaces.find((w) => w.id === id);
  const wsName = (id) => {
    const ws = wsOf(id);
    return ws ? wsLabel(ws) : 'Closed workspace';
  };
  const wsColor = (id) => {
    const i = S.workspaces.findIndex((w) => w.id === id);
    return `var(--bot-${(i < 0 ? 0 : i) % 6})`;
  };
  function openWorkspace(id) {
    if (!wsOf(id)) return;
    select(id);
    openTab(id, 'claude');
  }

  function activityApp() {
    const entries = new Map(); // id -> entry
    let order = [];
    const turns = new Map(); // wsId -> { start, tools } for the turn in progress
    let filter = store.get('deck.app.activity.filter', 'all');
    let wsFilter = '';
    let query = '';
    let paused = false;
    let expanded = null;

    // ----- toolbar -----
    const count = el('span', 'app-title');
    const wsSelect = el('select', 'ac-select');
    wsSelect.title = 'Workspace';
    wsSelect.addEventListener('change', () => {
      wsFilter = wsSelect.value;
      renderList();
    });
    const search = el('input', 'nw-search');
    search.placeholder = 'Filter by tool, file, command or prompt';
    search.spellcheck = false;
    search.addEventListener('input', () => {
      query = search.value.trim().toLowerCase();
      renderList();
    });
    search.addEventListener('keydown', (e) => e.stopPropagation());
    const seg = el('div', 'nw-seg');
    const segBtns = {};
    for (const [k, label] of FILTERS) {
      const b = el('button', `nw-seg-btn${k === filter ? ' on' : ''}`, label);
      b.addEventListener('click', () => {
        filter = k;
        store.set('deck.app.activity.filter', k);
        for (const [kk, bb] of Object.entries(segBtns)) bb.classList.toggle('on', kk === k);
        renderList();
      });
      segBtns[k] = b;
      seg.append(b);
    }
    const pauseBtn = button('', 'pause', 'Pause the timeline', () => {
      paused = !paused;
      pauseBtn.replaceChildren(ph(paused ? 'play' : 'pause'));
      pauseBtn.title = paused ? 'Resume (catches up on what happened)' : 'Pause the timeline';
      pauseBtn.classList.toggle('armed', paused);
      if (!paused) renderList();
    });
    const clearBtn = button('', 'prohibit', 'Clear the timeline', async () => {
      await deck.activityClear();
      entries.clear();
      order = [];
      expanded = null;
      renderList();
    });
    const bar = el('div', 'app-bar nw-bar', count, el('span', 'app-spacer'), wsSelect, search, seg, pauseBtn, clearBtn);

    // ----- "now": one card per workspace with a live agent -----
    const now = el('div', 'ac-now');
    function renderNow() {
      const cards = S.workspaces
        .map((ws) => ({ ws, r: S.runtime[ws.id] }))
        .filter(({ r }) => r && r.status && !['dormant', 'exited'].includes(r.status));
      now.replaceChildren(
        ...cards.map(({ ws, r }) => {
          const card = el(
            'button',
            `ac-card st-${r.status}`,
            el('span', 'ac-card-top', el('span', 'ac-ws-dot'), el('span', 'ac-card-name', wsLabel(ws)), el('span', 'ac-card-status', STATUS_TEXT[r.status] || r.status)),
            el('span', 'ac-card-act', r.status === 'waiting' ? r.message || 'Needs your input' : r.activity || (r.status === 'done' ? 'Ready for review' : 'Idle')),
            r.agents?.length ? el('span', 'ac-card-agents', ph('robot'), ` ${r.agents.length} subagent${r.agents.length === 1 ? '' : 's'}`) : null,
          );
          card.style.setProperty('--ws', wsColor(ws.id));
          card.title = 'Open this workspace’s Claude';
          card.addEventListener('click', () => openWorkspace(ws.id));
          return card;
        }),
      );
      now.classList.toggle('hidden', !cards.length);
    }
    function renderWsOptions() {
      const ids = [...new Set([...S.workspaces.map((w) => w.id), ...order.map((id) => entries.get(id).wsId)])];
      const opts = [el('option', '', 'All workspaces'), ...ids.map((id) => el('option', '', wsName(id)))];
      opts[0].value = '';
      ids.forEach((id, i) => (opts[i + 1].value = id));
      wsSelect.replaceChildren(...opts);
      wsSelect.value = ids.includes(wsFilter) ? wsFilter : '';
      wsFilter = wsSelect.value;
    }

    // ----- timeline -----
    const list = el('div', 'ac-list');
    const empty = el('div', 'nw-empty');
    const timeline = el('div', 'ac-timeline', list, empty);

    const textOf = (e) => `${e.tool || ''} ${e.detail || ''} ${e.agent || ''} ${EVENTS[e.event]?.label || e.event}`.toLowerCase();
    const visible = (e) =>
      (!wsFilter || e.wsId === wsFilter) && FILTERS.find(([k]) => k === filter)[2](e) && (!query || textOf(e).includes(query));

    function rowEl(e) {
      const meta = EVENTS[e.event] || { icon: 'circle', label: e.event, cls: '' };
      const isTool = e.event === 'PreToolUse';
      let main;
      if (isTool) main = el('span', 'ac-main', el('b', '', e.tool), e.detail ? el('span', 'ac-detail', e.detail) : null);
      else if (e.event === 'Stop') main = el('span', 'ac-main', el('b', '', meta.label), e.turn ? el('span', 'ac-detail', `${fmtDur(e.turn.ms)} · ${e.turn.tools} tool call${e.turn.tools === 1 ? '' : 's'}`) : null);
      else main = el('span', 'ac-main', el('b', '', meta.label), e.detail ? el('span', 'ac-detail', e.detail.split('\n')[0]) : null);
      const right = isTool
        ? e.end
          ? el('span', `ac-dur${e.failed ? ' err' : ''}`, e.failed ? ph('x-circle') : null, fmtDur(e.end - e.ts))
          : el('span', 'ac-dur running', ph('circle-notch'), 'running')
        : el('span', 'ac-dur');
      const row = el(
        'div',
        `ac-row ev-${meta.cls}${e.failed ? ' failed' : ''}${expanded === e.id ? ' open' : ''}`,
        el('span', 'ac-time', fmtClock(e.ts)),
        el('span', 'ac-ws', el('span', 'ac-ws-dot'), el('span', 'ac-ws-name', wsName(e.wsId))),
        el('span', 'ac-icon', ph(isTool ? toolIcon(e.tool) : meta.icon)),
        main,
        e.agent && meta.cls !== 'agent' ? el('span', 'ac-agent', ph('arrow-elbow-down-right'), e.agent) : el('span'),
        right,
      );
      row.style.setProperty('--ws', wsColor(e.wsId));
      row.dataset.id = e.id;
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('button')) return;
        expanded = expanded === e.id ? null : e.id;
        renderList(true);
      });
      if (expanded !== e.id) return row;
      return el('div', 'ac-item', row, detailEl(e));
    }
    function detailEl(e) {
      const block = (title, text) => (text ? el('div', 'ac-sec', el('div', 'nw-sec-title', title), el('pre', 'nw-code', text)) : null);
      const actions = el(
        'div',
        'ac-actions',
        wsOf(e.wsId) ? button('Open Claude', 'arrow-square-out', 'Show this workspace’s Claude', () => openWorkspace(e.wsId)) : null,
        e.input ? button('Copy input', 'copy', 'Copy the tool input', () => copy(e.input)) : null,
        e.result ? button('Copy result', 'clipboard-text', 'Copy the tool result', () => copy(e.result)) : null,
        e.detail && !e.input ? button('Copy', 'copy', 'Copy', () => copy(e.detail)) : null,
      );
      return el(
        'div',
        'ac-detail-box',
        el('div', 'ac-meta', `${new Date(e.ts).toLocaleString()}${e.session ? ` · session ${e.session.slice(0, 8)}` : ''}${e.agent ? ` · subagent ${e.agent}` : ''}`),
        e.event === 'PreToolUse' ? [block('Input', e.input), block(e.failed ? 'Result (failed)' : 'Result', e.result || (e.end ? '' : 'Still running…'))] : block(EVENTS[e.event]?.label || e.event, e.detail),
        actions,
      );
    }

    function renderList(keepScroll = false) {
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
      const top = list.scrollTop;
      const shown = order.map((id) => entries.get(id)).filter(visible);
      list.replaceChildren(...shown.map(rowEl));
      empty.classList.toggle('hidden', shown.length > 0);
      empty.textContent = order.length ? 'Nothing matches the filter' : 'No activity yet — prompts, tool calls and finished turns from every workspace show up here';
      if (keepScroll) list.scrollTop = top;
      else if (atBottom) list.scrollTop = list.scrollHeight;
      renderCount();
    }
    function renderCount() {
      const tools = order.filter((id) => entries.get(id).event === 'PreToolUse');
      const hour = Date.now() - 3600000;
      const recent = tools.filter((id) => entries.get(id).ts > hour).length;
      const failed = tools.filter((id) => entries.get(id).failed).length;
      count.textContent = order.length ? `${order.length} events · ${recent} tool calls in the last hour${failed ? ` · ${failed} failed` : ''}` : 'Agent activity across all workspaces';
    }

    // Turn bookkeeping: a Stop row says how long the turn took and how many tools it used.
    function ingest(e) {
      if (e.event === 'UserPromptSubmit') turns.set(e.wsId, { start: e.ts, tools: 0 });
      else if (e.event === 'PreToolUse' && turns.has(e.wsId)) turns.get(e.wsId).tools++;
      else if (e.event === 'Stop' && turns.has(e.wsId) && !e.turn) {
        const t = turns.get(e.wsId);
        e.turn = { ms: e.ts - t.start, tools: t.tools };
        turns.delete(e.wsId);
      }
    }
    function add(e) {
      const old = entries.get(e.id);
      if (old) {
        // A tool call completing: patch its row in place.
        Object.assign(old, e);
        if (paused) return;
        const node = list.querySelector(`[data-id="${e.id}"]`);
        if (node) {
          const fresh = rowEl(old);
          (node.parentElement.classList.contains('ac-item') ? node.parentElement : node).replaceWith(fresh);
        }
        renderCount();
        return;
      }
      ingest(e);
      entries.set(e.id, e);
      order.push(e.id);
      if (order.length > 3000) entries.delete(order.shift());
      if (!wsSelectHas(e.wsId)) renderWsOptions();
      if (paused) return;
      if (!visible(e)) return renderCount();
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
      list.append(rowEl(e));
      empty.classList.add('hidden');
      if (atBottom) list.scrollTop = list.scrollHeight;
      renderCount();
    }
    const wsSelectHas = (id) => [...wsSelect.options].some((o) => o.value === id);

    deck.onActivity(add);
    deck.onStatus(() => renderNow());
    deck.onWorkspaceUpdated(() => renderNow());
    deck.activityList().then((all) => {
      for (const e of all) if (!entries.has(e.id)) {
        ingest(e);
        entries.set(e.id, e);
        order.push(e.id);
      }
      order.sort((a, b) => a - b);
      renderWsOptions();
      renderList();
      list.scrollTop = list.scrollHeight;
    });
    renderNow();
    renderWsOptions();
    renderList();
    // Keep "x tool calls in the last hour" honest while nothing new arrives.
    setInterval(renderCount, 60000);

    return {
      el: el('div', 'app app-activity', bar, now, timeline),
      focus: () => {
        renderNow();
        renderWsOptions();
      },
    };
  }

  window.DeckApps.register({
    id: 'activity',
    name: 'Agent Activity',
    desc: 'Live timeline of every agent’s prompts & tools',
    icon: 'pulse',
    mat: 'changelog',
    color: 'var(--bot-3)',
    build: activityApp,
  });
})();
