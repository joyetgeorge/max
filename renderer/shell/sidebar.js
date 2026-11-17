/* global deck */
'use strict';

// ---------- subagent indicators ----------
// Pac-Man-style chomper for a running subagent; currentColor so each takes its palette colour.
const CHOMP_OPEN = 'M8 8L13.73 3.99A7 7 0 1 0 13.73 12.01Z';
const CHOMP_SHUT = 'M8 8L14.97 7.39A7 7 0 1 0 14.97 8.61Z';
function chomper(i) {
  const el = h('span', { class: `chomper bot-c${i % 6}`, 'aria-hidden': 'true' });
  el.innerHTML =
    `<svg viewBox="0 0 16 16" width="1em" height="1em"><path fill="currentColor" d="${CHOMP_OPEN}">` +
    `<animate attributeName="d" dur="0.36s" begin="${(i * 0.09).toFixed(2)}s" repeatCount="indefinite" ` +
    `values="${CHOMP_OPEN};${CHOMP_SHUT};${CHOMP_OPEN}"/></path></svg>`;
  return el;
}

// One small, distinctly coloured bot per running subagent (main agent is the row's icon).
const MAX_BOTS = 5;
function agentBots(agents = []) {
  if (!agents.length) return null;
  const shown = agents.slice(0, MAX_BOTS);
  return h(
    'span',
    { class: 'ws-agents', title: `${agents.length} subagent${agents.length > 1 ? 's' : ''} running:\n${agents.map((a) => `• ${a.type}`).join('\n')}` },
    shown.map((_, i) => chomper(i)),
    agents.length > MAX_BOTS ? h('span', { class: 'ws-agents-more' }, `+${agents.length - MAX_BOTS}`) : null,
  );
}

// ---------- sidebar ----------
let dragId = null;
// 2500 → 2.5k so the diff stat never has to truncate.
const fmtCount = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));

// Show the ⌘1–9 hints only while ⌘ is held, instead of on every row all the time.
// The same goes for the window tabs' ⌃1–9 while ⌃ is held.
for (const [key, cls] of [['Meta', 'cmd-held'], ['Control', 'ctrl-held']]) {
  window.addEventListener('keydown', (e) => e.key === key && document.body.classList.add(cls), true);
  window.addEventListener('keyup', (e) => e.key === key && document.body.classList.remove(cls), true);
}
window.addEventListener('blur', () => document.body.classList.remove('cmd-held', 'ctrl-held'));

// ---------- sidebar visibility (⌘B), remembered per machine ----------
function setSidebarHidden(hidden) {
  document.body.classList.toggle('sidebar-hidden', hidden);
  store.set('deck.sidebarHidden', hidden ? '1' : '');
}
function toggleSidebar() {
  setSidebarHidden(!document.body.classList.contains('sidebar-hidden'));
}
if (store.get('deck.sidebarHidden')) document.body.classList.add('sidebar-hidden');

// ---------- sidebar width (drag the right edge; double-click resets) ----------
(() => {
  const DEFAULT = 270;
  const MIN = 180;
  const MAX = 480;
  const sash = $('#sidebar-sash');
  const setW = (w) => document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
  const clamp = (w) => Math.round(Math.min(MAX, Math.max(MIN, w)));
  const saved = Number(store.get('deck.sidebarW'));
  if (saved) setW(clamp(saved));
  const persist = (w) => store.set('deck.sidebarW', String(w));
  sash.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const sidebar = $('#sidebar');
    const startX = e.clientX;
    const startW = sidebar.getBoundingClientRect().width;
    let w = startW;
    document.body.classList.add('resizing-sidebar');
    trackDrag(
      (ev) => setW((w = clamp(startW + ev.clientX - startX))),
      () => {
        document.body.classList.remove('resizing-sidebar');
        persist(w);
      },
    );
  });
  sash.addEventListener('dblclick', () => {
    setW(DEFAULT);
    persist(DEFAULT);
  });
})();

// ---------- sidebar: repo (workspace) → worktrees ----------
const collapsedRepos = new Set(store.json('deck.collapsedRepos', []));
const saveCollapsed = () => store.setJson('deck.collapsedRepos', [...collapsedRepos]);

// The repo is the group header, so the row shows what distinguishes the worktree.
// Auto-generated names ("max 3") just repeat the repo; show the branch instead.
function itemLabel(ws, branch) {
  // Auto-named: Claude Code's current conversation topic, once it has one.
  if (!ws.nameLocked && ws.topic) return ws.topic;
  const auto = new RegExp(`^${escapeRe(repoName(ws.repo))} \\d+$`);
  if (!auto.test(ws.name)) return ws.name;
  if (!ws.worktree) return 'main checkout';
  // Still on the generated deck/<slug> branch → "worktree N"; switched to a real branch → show it.
  return !branch || branch === shortBranch(ws.branch) ? `worktree ${ws.name.split(' ').pop()}` : branch;
}

// The name shown for a workspace everywhere (sidebar, toolbar, command menu).
const wsLabel = (ws) => itemLabel(ws, shortBranch(S.git[ws.id]?.branch || ws.branch));

// ---------- auto-naming from Claude Code's terminal title ----------
// Claude Code keeps the terminal title set to a short summary of the conversation, prefixed with
// its status glyph (✳ idle, a spinner while working). Strip that, skip non-topics, and only save
// once the text has settled, so a workspace isn't renamed on every flicker.
function cleanTitle(raw) {
  let t = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  t = t.replace(/^[^\p{L}\p{N}]+/u, '').trim(); // status glyphs, spinners, emoji
  if (t.length < 3 || /^claude( code)?$/i.test(t)) return '';
  if (/^[~/]/.test(t) || /^[\w.-]+@[\w.-]+:/.test(t)) return ''; // a shell's "user@host: ~/dir" title
  return t.length > 60 ? `${t.slice(0, 59).trimEnd()}…` : t;
}
const topicTimers = new Map();
function onClaudeTitle(wsId, raw) {
  const topic = cleanTitle(raw);
  if (!topic) return;
  clearTimeout(topicTimers.get(wsId));
  topicTimers.set(
    wsId,
    setTimeout(() => {
      topicTimers.delete(wsId);
      const ws = wsById(wsId);
      if (ws && ws.topic !== topic) deck.setWorkspaceTopic(wsId, topic);
    }, 1500),
  );
}
function setAutoName(id, auto) {
  const ws = wsById(id);
  if (!ws) return;
  // Turning it off keeps what's shown now as the fixed name.
  deck.setAutoName(id, auto, auto ? null : wsLabel(ws));
}

// Group by repo (first-seen order), keep worktree order within a repo, and keep
// S.workspaces in that same order so ⌘1–9, ⌘⇧[ ] and ⌘J follow what's on screen.
function groupWorkspaces() {
  const groups = new Map();
  for (const ws of S.workspaces) {
    if (!groups.has(ws.repo)) groups.set(ws.repo, []);
    groups.get(ws.repo).push(ws);
  }
  const ordered = [...groups.values()].flat();
  if (ordered.some((w, i) => w !== S.workspaces[i])) {
    S.workspaces = ordered;
    deck.reorderWorkspaces(ordered.map((w) => w.id));
  }
  return groups;
}

const STATUS_RANK = { waiting: 0, running: 1, done: 2, exited: 3, starting: 4, idle: 5, dormant: 6 };

// ---------- repo icon picker (material-icon-theme) ----------
// Older logos may be image data URLs; everything else is an icon name.
const logoSrc = (logo) => (logo?.startsWith('data:') ? logo : matIconSrc(logo || 'folder'));

async function editRepoLogo(repo) {
  const names = await deck.listIcons();
  const current = S.repos[repo]?.logo || 'folder';
  const finish = async (logo) => {
    close();
    if (logo === undefined) return;
    const value = logo === 'folder' ? null : logo;
    await deck.setRepoLogo(repo, value);
    S.repos[repo] = { ...(S.repos[repo] || {}), logo: value || undefined };
    renderSidebar();
  };
  const grid = h('div', { class: 'ip-grid' });
  const search = h('input', { class: 'ip-search', placeholder: `Search ${names.length} icons…`, spellcheck: 'false' });
  const render = () => {
    const q = search.value.trim().toLowerCase().replace(/\s+/g, '-');
    // Folder icons first: they read best as a repo badge.
    const hits = names.filter((n) => n.includes(q)).sort((a, b) => (b.startsWith('folder') - a.startsWith('folder')) || a.localeCompare(b));
    grid.replaceChildren(
      ...hits.map((n) =>
        h(
          'button',
          { type: 'button', class: `ip-cell${n === current ? ' selected' : ''}`, title: n, onclick: () => finish(n) },
          h('img', { src: matIconSrc(n), alt: '', loading: 'lazy', draggable: 'false' }),
        ),
      ),
      hits.length ? null : h('div', { class: 'ip-empty' }, 'No icons match'),
    );
  };
  const overlay = h(
    'div',
    { class: 'modal', onmousedown: (e) => e.target === overlay && finish(undefined) },
    h(
      'div',
      { class: 'sheet ip-sheet', role: 'dialog', 'aria-label': 'Choose icon' },
      h('h2', {}, `Icon for ${repoName(repo)}`),
      search,
      grid,
      h(
        'div',
        { class: 'ip-actions' },
        h('button', { type: 'button', onclick: () => finish('folder') }, 'Reset to folder'),
        h('button', { type: 'button', onclick: () => finish(undefined) }, 'Cancel'),
      ),
    ),
  );
  function close() {
    overlay.remove();
  }
  search.addEventListener('input', render);
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') finish(undefined);
    if (e.key === 'Enter') grid.querySelector('.ip-cell')?.click(); // pick the first match
  });
  render();
  document.body.append(overlay);
  search.focus();
}

function repoHeader(repo, items) {
  const collapsed = collapsedRepos.has(repo);
  // Collapsed: surface the most urgent status so nothing hides behind the fold.
  const top = items.map((w) => statusOf(w.id)).sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b])[0];
  const unread = items.some((w) => S.runtime[w.id]?.unread);
  return h(
    'div',
    {
      class: `repo-head${collapsed ? ' collapsed' : ''} st-${top}`,
      title: shortPath(repo),
      oncontextmenu: (e) => {
        e.preventDefault();
        editRepoLogo(repo);
      },
      onclick: () => {
        collapsed ? collapsedRepos.delete(repo) : collapsedRepos.add(repo);
        saveCollapsed();
        renderSidebar();
      },
    },
    h('span', { class: 'repo-caret' }, icon('caret-right')),
    h(
      'button',
      {
        class: 'repo-logo',
        title: 'Change icon…',
        onclick: (e) => {
          e.stopPropagation();
          editRepoLogo(repo);
        },
      },
      h('img', { src: logoSrc(S.repos[repo]?.logo), alt: '', draggable: 'false' }),
    ),
    h('span', { class: 'repo-name' }, repoName(repo)),
    collapsed && (top === 'running' || top === 'waiting' || unread) ? h('span', { class: 'repo-pip' }) : null,
    h('span', { class: 'repo-count' }, String(items.length)),
    h(
      'button',
      {
        class: 'repo-add',
        title: `New worktree in ${repoName(repo)}`,
        onclick: (e) => {
          e.stopPropagation();
          openModal(repo);
        },
      },
      icon('plus'),
    ),
  );
}

// Status hooks and git polls can arrive in bursts; rebuild the sidebar at most once a frame.
let sidebarQueued = false;
function scheduleSidebar() {
  if (sidebarQueued) return;
  sidebarQueued = true;
  requestAnimationFrame(() => {
    if (sidebarQueued) renderSidebar();
  });
}

function renderSidebar() {
  sidebarQueued = false;
  const list = $('#ws-list');
  const groups = groupWorkspaces();
  let i = 0;
  list.replaceChildren(
    ...[...groups].map(([repo, items]) => {
      const start = i;
      i += items.length;
      const collapsed = collapsedRepos.has(repo);
      return h(
        'li',
        { class: 'repo' },
        repoHeader(repo, items),
        collapsed ? null : h('ul', { class: 'repo-items' }, items.map((ws, j) => wsItem(ws, start + j, list))),
      );
    }),
  );
}

function wsItem(ws, i, list) {
  const st = statusOf(ws.id);
  const r = S.runtime[ws.id] || {};
  const g = S.git[ws.id] || {};
  const fullBranch = g.branch || ws.branch || (ws.worktree ? '' : 'repo root');
  const branch = shortBranch(fullBranch);
  const label = itemLabel(ws, branch);
  const activity =
    st === 'waiting' ? r.message || STATUS_TEXT.waiting : st === 'running' ? r.activity || STATUS_TEXT.running : STATUS_TEXT[st];
  const li = h(
    'li',
    {
      class: `ws-item st-${st}${ws.id === S.activeId ? ' active' : ''}${r.unread ? ' unread' : ''}${st === 'waiting' ? ' waiting' : ''}`,
      draggable: 'true',
      title: [label, ws.title && ws.title !== label ? `First prompt: ${ws.title}` : '', !ws.nameLocked ? 'Named from Claude’s topic · double-click to rename' : '', shortPath(ws.cwd)].filter(Boolean).join('\n'),
      'data-shortcut': i < 9 ? `⌘${i + 1}` : null,
      onclick: () => select(ws.id),
      ondblclick: (e) => startRename(ws, e.currentTarget),
      ondragstart: (e) => {
        dragId = ws.id;
        e.currentTarget.classList.add('dragging');
      },
      ondragend: () => {
        dragId = null;
        renderSidebar();
      },
      ondragover: (e) => {
        e.preventDefault();
        list.querySelectorAll('.drop-above').forEach((x) => x.classList.remove('drop-above'));
        e.currentTarget.classList.add('drop-above');
      },
      ondrop: (e) => {
        e.preventDefault();
        if (!dragId || dragId === ws.id || wsById(dragId)?.repo !== ws.repo) return; // reorder within a repo only
        const ids = S.workspaces.map((w) => w.id).filter((x) => x !== dragId);
        ids.splice(ids.indexOf(ws.id), 0, dragId);
        S.workspaces.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
        deck.reorderWorkspaces(ids);
        renderSidebar();
      },
    },
    h(
      'span',
      { class: 'ws-bot', title: `Main agent · ${STATUS_TEXT[st]}` },
      // Pulses via CSS while working; the negative delay keeps the phase continuous across sidebar re-renders.
      h('span', { class: 'mi mi-claude', 'aria-hidden': 'true', style: `animation-delay: -${Date.now() % 1100}ms` }),
    ),
    h('span', { class: 'ws-name' }, label),
    h(
      'span',
      { class: 'ws-right' },
      r.unread ? h('span', { class: 'badge', title: 'Unread' }) : null,
      i < 9 ? h('span', { class: 'ws-idx' }, `⌘${i + 1}`) : null,
      g.add || g.del
        ? h(
            'button',
            {
              class: 'ws-diff',
              title: ws.id === S.activeId ? 'Review changes (⌘⇧D)' : 'Review changes',
              onclick: (e) => {
                e.stopPropagation();
                select(ws.id);
                toggleReview(ws.id, true);
              },
            },
            h('span', { class: 'add' }, `+${fmtCount(g.add)}`),
            h('span', { class: 'del' }, `−${fmtCount(g.del)}`),
          )
        : null,
      h(
        'button',
        {
          class: 'ws-close',
          title: 'Close worktree',
          onclick: (e) => {
            e.stopPropagation();
            closeWorkspace(ws.id);
          },
        },
        icon('x'),
      ),
    ),
    h(
      'span',
      { class: 'ws-sub' },
      agentBots(r.agents),
      h(
        'span',
        { class: 'ws-sub-text' },
        h('span', { class: 'ws-status' }, activity),
        branch && branch !== label ? [h('span', { class: 'ws-sep' }, ' · '), h('span', { class: 'ws-branch', title: fullBranch }, branch)] : null,
      ),
      wsAppIcons(ws),
    ),
  );
  return li;
}

// The workspace's open tabs (besides Claude, which the row itself is) as small icons; click one to
// go straight to that tab. Workspaces not opened since launch show the tabs they'll restore.
function wsTabKinds(wsId) {
  const v = views.get(wsId);
  if (v) return v.tabs.map((t) => ({ kind: t.kind, on: wsId === S.activeId && t.id === v.active }));
  return (store.json(tabsKey(wsId))?.tabs || []).map((t) => ({ kind: t.kind, on: false }));
}
function wsAppIcons(ws) {
  const kinds = new Map(); // kind -> { count, on }, in tab order
  for (const t of wsTabKinds(ws.id)) {
    if (t.kind === 'claude' || t.kind === 'newtab' || !kindInfo(t.kind)) continue;
    const k = kinds.get(t.kind) || { count: 0, on: false };
    k.count++;
    k.on ||= t.on;
    kinds.set(t.kind, k);
  }
  if (!kinds.size) return null;
  return h(
    'span',
    { class: 'ws-apps' },
    [...kinds].map(([kind, k]) => {
      const info = kindInfo(kind);
      return h(
        'button',
        {
          class: `ws-app${k.on ? ' on' : ''}`,
          title: k.count > 1 ? `${info.title} (${k.count})` : info.title,
          onclick: (e) => {
            e.stopPropagation();
            goToTab(ws.id, kind);
          },
        },
        kindIcon(kind), // the same Material icon as the tab
        k.count > 1 ? h('span', { class: 'ws-app-n' }, String(k.count)) : null,
      );
    }),
  );
}
function goToTab(wsId, kind) {
  select(wsId);
  const v = views.get(wsId);
  // Several of that kind (shells): cycle through them on repeated clicks.
  const all = v?.tabs.filter((t) => t.kind === kind) || [];
  if (!all.length) return;
  const cur = all.findIndex((t) => t.id === v.active);
  activateTab(v, all[(cur + 1) % all.length].id);
}

function startRename(ws, li) {
  const nameEl = $('.ws-name', li);
  const shown = wsLabel(ws);
  const input = h('input', { value: shown });
  nameEl.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    // Only a real change counts: clicking away from an untouched name mustn't freeze it.
    if (commit && input.value.trim() && input.value.trim() !== shown) {
      ws.name = input.value.trim();
      ws.nameLocked = true;
      await deck.renameWorkspace(ws.id, ws.name);
      const v = views.get(ws.id);
      if (v) v.titleText.textContent = wsLabel(ws);
    }
    renderSidebar();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

function select(id) {
  if (!wsById(id)) return;
  S.activeId = id;
  if (S.runtime[id]) S.runtime[id].unread = false;
  deck.setActive(id);
  renderSidebar();
  showView(id);
  refreshGit(id);
}

async function closeWorkspace(id) {
  const idx = S.workspaces.findIndex((w) => w.id === id);
  const removed = await deck.removeWorkspace(id);
  if (!removed) return;
  const v = views.get(id);
  if (v) {
    // The main process has already ended every terminal of this workspace.
    for (const entry of [v.claude, ...v.tabs.map((t) => t.term).filter(Boolean)]) {
      releaseWebgl(entry);
      entry.term.dispose();
    }
    v.el.remove();
    views.delete(id);
  }
  for (const key of [...terms.keys()]) if (key.startsWith(`${id}:`)) terms.delete(key);
  store.remove(tabsKey(id));
  S.workspaces.splice(idx, 1);
  delete S.runtime[id];
  const next = S.workspaces[Math.min(idx, S.workspaces.length - 1)];
  S.activeId = next?.id || null;
  if (next) select(next.id);
  else {
    renderSidebar();
    showView(null);
  }
}

// Rename from the command menu: make sure the row is on screen first.
function renameActive(id) {
  if (document.body.classList.contains('sidebar-hidden')) setSidebarHidden(false);
  const ws = wsById(id);
  const repo = collapsedRepos.has(ws.repo);
  if (repo) {
    collapsedRepos.delete(ws.repo);
    saveCollapsed();
    renderSidebar();
  }
  const li = $('#ws-list .ws-item.active');
  if (li) startRename(ws, li);
}
