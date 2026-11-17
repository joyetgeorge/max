/* global deck */
'use strict';

// Wires the shell together: git polling, events from the main process, shortcuts, boot.

// ---------- git polling ----------
const gitStamp = {}; // wsId -> last refresh time
async function refreshGit(id) {
  gitStamp[id] = Date.now();
  const info = await deck.gitInfo(id);
  if (!info || info.error || !wsById(id)) return;
  const prev = S.git[id];
  S.git[id] = info;
  // Most polls change nothing: skip the DOM work.
  if (prev && prev.branch === info.branch && prev.add === info.add && prev.del === info.del && prev.files === info.files) return;
  paintGit(views.get(id), info);
  scheduleSidebar();
}
function paintGit(v, info) {
  if (v && info) {
    v.branchText.textContent = info.branch;
    v.stat.classList.toggle('hidden', !info.files);
    v.stat.replaceChildren(
      icon('git-diff'),
      `${info.files} file${info.files === 1 ? '' : 's'} `,
      h('span', { class: 'add' }, `+${info.add}`),
      ' ',
      h('span', { class: 'del' }, `−${info.del}`),
    );
  }
}
// Each refresh spawns several git processes, so poll by need: the active worktree and
// agents that are working every 6s, idle background worktrees every 60s, nothing while
// the window is hidden (a full refresh runs when it comes back).
const GIT_POLL_MS = 6000;
const GIT_IDLE_MS = 60000;
function pollGit(all = false) {
  if (document.hidden) return;
  const now = Date.now();
  for (const w of S.workspaces) {
    const st = statusOf(w.id);
    const busy = w.id === S.activeId || st === 'running' || st === 'waiting' || st === 'starting';
    if (all || busy || now - (gitStamp[w.id] || 0) >= GIT_IDLE_MS) refreshGit(w.id);
  }
}
setInterval(() => pollGit(), GIT_POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pollGit(true);
});

// ---------- status events ----------
deck.onStatus((id, r) => {
  const prev = S.runtime[id]?.status;
  S.runtime[id] = r;
  if (id === S.activeId && document.hasFocus()) r.unread = false;
  scheduleSidebar();
  const v = views.get(id);
  if (v && r.status !== prev) renderStrip(v); // the Claude tab's icon follows the status
  if (r.status === 'done' && prev !== 'done') {
    refreshGit(id);
    if (v?.review?.visible) v.review.refresh();
    if (v?.explorer?.visible) v.explorer.refresh();
  }
});
deck.onWorkspaceUpdated((ws) => {
  const i = S.workspaces.findIndex((w) => w.id === ws.id);
  if (i >= 0) S.workspaces[i] = { ...S.workspaces[i], ...ws };
  const v = views.get(ws.id);
  if (v && i >= 0) v.titleText.textContent = wsLabel(S.workspaces[i]);
  scheduleSidebar();
});
deck.onFocusWorkspace((id) => select(id));
// A task reminder was clicked: open Tasks in the current worktree, on that task.
deck.onNotifyClick((tag) => {
  const m = /^task:(.+)$/.exec(tag || '');
  if (!m || !S.activeId) return;
  openTab(S.activeId, 'app:tasks');
  window.DeckApps.instance('tasks')?.openTask?.(m[1]);
});

// ---------- keyboard ----------
function isAppShortcut(e) {
  const k = e.key.toLowerCase();
  if (/^[1-9]$/.test(e.key)) return true;
  if (e.shiftKey && (k === '[' || k === ']' || k === '{' || k === '}' || k === 'd' || k === 'e' || k === 'a' || k === 'r' || k === 't' || k === 'f')) return true;
  return ['n', 't', 'k', 'j', 'b', 'p', '`'].includes(k);
}

function cycle(dir) {
  const i = S.workspaces.findIndex((w) => w.id === S.activeId);
  const n = S.workspaces.length;
  if (n) select(S.workspaces[(i + dir + n) % n].id);
}

function jumpToAttention() {
  const rank = (w) => {
    const r = S.runtime[w.id] || {};
    if (r.status === 'waiting') return 0;
    if (r.unread) return 1;
    return 9;
  };
  const start = S.workspaces.findIndex((w) => w.id === S.activeId);
  const ordered = [...S.workspaces.slice(start + 1), ...S.workspaces.slice(0, start + 1)];
  const target = ordered.filter((w) => rank(w) < 9).sort((a, b) => rank(a) - rank(b))[0];
  if (target) select(target.id);
}

window.addEventListener(
  'keydown',
  (e) => {
    if (!modal.classList.contains('hidden')) return;
    if (Palette.isOpen()) {
      if (e.metaKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopPropagation();
        Palette.close();
      }
      return; // the palette handles its own keys
    }
    // ⌃Tab / ⌃⇧Tab: next / previous window tab, as in a browser.
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      if (S.activeId) cycleTab(S.activeId, e.shiftKey ? -1 : 1);
      return;
    }
    // ⌃1–8: go to that tab; ⌃9: the last tab (as ⌘1–9 does in a browser).
    if (e.ctrlKey && !e.metaKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) {
      e.preventDefault();
      e.stopPropagation();
      const v = views.get(S.activeId);
      const n = Number(e.code.slice(5));
      const tab = v && (n === 9 ? v.tabs[v.tabs.length - 1] : v.tabs[n - 1]);
      if (tab) activateTab(v, tab.id);
      return;
    }
    if (!e.metaKey || !isAppShortcut(e)) return;
    const k = e.key.toLowerCase();
    // Rich-text editors (sticky notes) keep ⌘B / ⌘I / ⌘U for bold, italic, underline.
    if (e.target.isContentEditable && !e.shiftKey && 'biu'.includes(k)) return;
    e.preventDefault();
    e.stopPropagation();
    if (/^[1-9]$/.test(e.key)) S.workspaces[Number(e.key) - 1] && select(S.workspaces[Number(e.key) - 1].id);
    else if (e.shiftKey && (k === '[' || k === '{')) cycle(-1);
    else if (e.shiftKey && (k === ']' || k === '}')) cycle(1);
    else if (e.shiftKey && k === 'd') S.activeId && toggleReview(S.activeId);
    else if (e.shiftKey && k === 'e') S.activeId && toggleExplorer(S.activeId);
    else if (e.shiftKey && k === 'a') S.activeId && openTab(S.activeId, 'newtab');
    else if (e.shiftKey && k === 'r') S.activeId && restartClaude(S.activeId, false);
    else if (e.shiftKey && k === 't') S.activeId && reopenClosedTab(S.activeId);
    else if (e.shiftKey && k === 'f') S.activeId && searchInFiles(S.activeId);
    else if (k === 'p' && !e.shiftKey) S.activeId && quickOpen(S.activeId);
    else if (k === 'b') toggleSidebar();
    else if (k === 't') S.activeId && openTab(S.activeId, 'newtab');
    else if (k === 'k') Palette.toggle();
    else if (k === 'n') openModal();
    else if (k === 'j') jumpToAttention();
    else if (k === '`') S.activeId && openShell(S.activeId);
  },
  true,
);

// ⌘W (app menu): close the active window tab — in Files, its open editor tabs go first.
// Never hides the window: that made the whole app vanish when there was nothing to close.
deck.onMenuClose(() => {
  if (!modal.classList.contains('hidden') || Palette.isOpen()) return;
  const v = views.get(S.activeId);
  const tab = activeTab(v);
  if (!tab) return;
  if (tab.kind === 'explorer' && v.explorer.closeActive()) return;
  closeTab(v, tab.id);
});

window.addEventListener('focus', () => {
  if (S.runtime[S.activeId]) {
    S.runtime[S.activeId].unread = false;
    scheduleSidebar();
  }
});

// ---------- boot ----------
(async function boot() {
  const st = await deck.getState();
  window.AppTheme.apply(st.theme);
  delete st.theme;
  Object.assign(S, st);
  renderSidebar();
  const first = wsById(S.activeId) || S.workspaces[0];
  if (first) select(first.id);
  else showView(null);
  S.workspaces.forEach((w) => refreshGit(w.id));
})();
