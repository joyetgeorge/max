/* global deck */
'use strict';

// ---------- views: one per workspace, each a strip of browser-style window tabs ----------
// Every tool is a full-window tab: Claude, shells, Review, Files, the apps and the "New tab"
// page. Tabs open after the current one, close with × / ⌘W / middle-click, reorder by drag,
// and ⌘⇧T reopens the last one closed.
// `mat` is the Material Icon Theme icon shown on the tab and the New tab page.
const TAB_KINDS = {
  claude: { title: 'Claude', mat: 'claude', single: true, desc: 'The agent for this worktree' },
  shell: { title: 'Shell', mat: 'console', desc: 'A terminal in the worktree' },
  review: { title: 'Review', mat: 'diff', single: true, desc: 'Changes against the base branch' },
  explorer: { title: 'Files', mat: 'folder-open', single: true, desc: 'File tree, source & Markdown preview' },
  newtab: { title: 'New tab', mat: 'folder-app' },
};
function kindInfo(kind) {
  if (kind.startsWith('app:')) {
    const app = window.DeckApps.list.find((a) => `app:${a.id}` === kind);
    return app && { title: app.name, mat: app.mat, color: app.color, single: true, desc: app.desc };
  }
  return TAB_KINDS[kind];
}
// Full-colour Material icons; the negative delay keeps the Claude pulse continuous across re-renders.
const kindIcon = (kind) =>
  h('img', {
    class: `mat-icon${kind === 'claude' ? ' claude-icon' : ''}`,
    src: matIconSrc(kindInfo(kind).mat),
    alt: '',
    draggable: 'false',
    style: kind === 'claude' ? `animation-delay: -${Date.now() % 1100}ms` : null,
  });

let tabSeq = 0;
const activeTab = (v) => v?.tabs.find((t) => t.id === v.active);
const tabOfKind = (v, kind) => v?.tabs.find((t) => t.kind === kind);

function buildView(ws) {
  const v = { id: ws.id, tabs: [], active: null, closed: [], shellSeq: 0 };

  v.titleText = h('span', {}, wsLabel(ws));
  v.title = h('span', { class: 'title' }, icon('folder-simple'), v.titleText);
  v.branchText = h('span', {}, ws.branch || '…');
  v.branch = h('span', { class: 'chip' }, icon('git-branch'), v.branchText);
  // The diff chip doubles as the Review toggle — it's only there when there's something to review.
  v.stat = h('span', { class: 'chip stat-chip hidden', title: 'Review changes (⌘⇧D)', onclick: () => toggleReview(ws.id) });
  v.strip = h('div', { class: 'wtabs', role: 'tablist' });
  v.stage = h('div', { class: 'stage' });
  v.el = h(
    'section',
    { class: 'view hidden', 'data-id': ws.id },
    h('div', { class: 'toolbar' }, v.title, v.strip, h('span', { class: 'spacer' }), v.branch, v.stat),
    v.stage,
  );
  $('#views').append(v.el);

  // Claude's terminal outlives its tab: closing the tab only hides it, the agent keeps running.
  v.claudeHost = h('div', { class: 'term-host' });
  v.claude = createTerm(ws.id, 'claude', v.claudeHost);
  v.review = null; // built on first open
  v.explorer = null;
  views.set(ws.id, v);
  restoreTabs(v);
  paintGit(v, S.git[ws.id]);
  return v;
}

// Open a tab (or, for single-instance kinds, switch to the existing one). Returns the tab.
function openTab(wsId, kind, { activate = true, after = null, path = null, termKind = null } = {}) {
  const v = views.get(wsId);
  const info = v && kindInfo(kind);
  if (!info) return null;
  let tab = info.single ? tabOfKind(v, kind) : null;
  if (!tab) {
    tab = { id: `t${++tabSeq}`, kind, pane: h('div', { class: 'tab-pane hidden' }), termKind };
    mountTab(v, tab);
    const ref = after || activeTab(v);
    const at = ref ? v.tabs.indexOf(ref) + 1 : v.tabs.length;
    v.tabs.splice(at || v.tabs.length, 0, tab);
    v.stage.append(tab.pane);
  }
  if (activate) activateTab(v, tab.id, path);
  else renderStrip(v);
  return tab;
}

// ---------- tab persistence: each workspace's tabs survive quitting (stored per machine) ----------
const tabsKey = (wsId) => `deck.tabs.${wsId}`;
function saveTabs(v) {
  if (v.restoring) return;
  const tabs = v.tabs.map((t) => (t.termKind ? { kind: t.kind, termKind: t.termKind } : { kind: t.kind }));
  store.setJson(tabsKey(v.id), { tabs, active: v.tabs.findIndex((t) => t.id === v.active) });
}
function restoreTabs(v) {
  const saved = store.json(tabsKey(v.id));
  v.restoring = true;
  // Shells come back as fresh shells after a quit; after a reload (⌘R) the same termKind
  // reattaches to the shell that's still running.
  for (const t of saved?.tabs || []) if (kindInfo(t.kind)) openTab(v.id, t.kind, { activate: false, termKind: t.termKind });
  if (!v.tabs.length) openTab(v.id, 'claude', { activate: false });
  v.restoring = false;
  v.active = (v.tabs[saved?.active] || v.tabs[0]).id;
  renderStrip(v);
}

function mountTab(v, tab) {
  const id = v.id;
  if (tab.kind === 'claude') tab.pane.append(v.claudeHost);
  else if (tab.kind === 'shell') {
    if (tab.termKind) {
      // Restored: keep its key, and number new shells after it.
      tab.num = Number(tab.termKind.split('-')[1] || 1);
      v.shellSeq = Math.max(v.shellSeq, tab.num);
    } else {
      v.shellSeq += 1;
      tab.num = v.shellSeq;
      // The first shell keeps the plain "shell" key: setup commands and older sessions use it.
      tab.termKind = v.shellSeq === 1 ? 'shell' : `shell-${v.shellSeq}`;
    }
    const host = h('div', { class: 'term-host' });
    tab.pane.append(host);
    tab.term = createTerm(id, tab.termKind, host);
    ensureStarted(tab.term);
  } else if (tab.kind === 'review') {
    v.review ??= new window.Review(id, {
      onClose: () => closeKind(id, 'review'),
      onChanged: () => refreshGit(id),
      onPreview: (path) => toggleExplorer(id, true, path),
    });
    tab.pane.append(v.review.el);
  } else if (tab.kind === 'explorer') {
    v.explorer ??= new window.Explorer(id, { onClose: () => closeKind(id, 'explorer') });
    tab.pane.append(v.explorer.el);
  } else if (tab.kind === 'newtab') tab.pane.append(newTabPage(v, tab));
  // app:<id> panes are filled on activation (the app instance is shared between workspaces).
}

function activateTab(v, tabId, path = null) {
  const tab = v.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const prev = activeTab(v);
  if (prev && prev !== tab) {
    if (prev.kind === 'review') v.review.hide();
    if (prev.kind === 'explorer') v.explorer.hide();
  }
  v.active = tab.id;
  for (const t of v.tabs) t.pane.classList.toggle('hidden', t !== tab);
  v.stat.classList.toggle('on', tab.kind === 'review');
  renderStrip(v);
  if (v.el.classList.contains('hidden')) return; // showView() finishes the job when it's shown

  if (tab.kind === 'review') v.review.show();
  else if (tab.kind === 'explorer') v.explorer.show(path);
  else if (tab.kind.startsWith('app:')) {
    const inst = window.DeckApps.instance(tab.kind.slice(4));
    if (inst.el.parentElement !== tab.pane) tab.pane.append(inst.el);
    requestAnimationFrame(() => inst.focus?.());
  } else if (tab.kind === 'newtab') requestAnimationFrame(() => $('.app-tile', tab.pane)?.focus());
  const entry = tab.kind === 'claude' ? v.claude : tab.term;
  if (entry) {
    attachWebgl(entry);
    requestAnimationFrame(() => {
      ensureStarted(entry);
      fitTerm(entry);
      entry.term.focus();
    });
  }
}

// Close a tab. Claude, Review and Files keep their state for when they're reopened;
// a shell's process ends with its tab.
function closeTab(v, tabId, { remember = true } = {}) {
  const i = v.tabs.findIndex((t) => t.id === tabId);
  if (i < 0) return;
  const tab = v.tabs[i];
  if (remember && tab.kind !== 'newtab') v.closed.push(tab.kind);
  if (tab.kind === 'review') v.review.hide();
  if (tab.kind === 'explorer') v.explorer.hide();
  if (tab.term) {
    const key = `${v.id}:${tab.termKind}`;
    releaseWebgl(tab.term);
    tab.term.term.dispose();
    terms.delete(key);
    deck.killTerm(key);
  }
  tab.pane.remove();
  v.tabs.splice(i, 1);
  if (v.active === tab.id) {
    // Like a browser: the tab to the right takes over, else the one to the left.
    const next = v.tabs[i] || v.tabs[i - 1];
    if (next) activateTab(v, next.id);
    else openTab(v.id, 'newtab'); // never an empty window
  } else renderStrip(v);
}
function closeKind(wsId, kind) {
  const v = views.get(wsId);
  const tab = tabOfKind(v, kind);
  if (tab) closeTab(v, tab.id);
}
function reopenClosedTab(wsId) {
  const v = views.get(wsId);
  const kind = v?.closed.pop();
  if (kind) openTab(wsId, kind);
}
function cycleTab(wsId, dir) {
  const v = views.get(wsId);
  if (!v || v.tabs.length < 2) return;
  const i = v.tabs.indexOf(activeTab(v));
  activateTab(v, v.tabs[(i + dir + v.tabs.length) % v.tabs.length].id);
}

let tabDragId = null;
function renderStrip(v) {
  const shells = v.tabs.filter((t) => t.kind === 'shell').length;
  const st = statusOf(v.id);
  v.strip.replaceChildren(
    ...v.tabs.map((t, i) => {
      const info = kindInfo(t.kind);
      const title = t.kind === 'shell' && shells > 1 ? `Shell ${t.num}` : info.title;
      const key = i < 8 ? `⌃${i + 1}` : i === v.tabs.length - 1 ? '⌃9' : '';
      return h(
        'div',
        {
          class: `wtab${t.id === v.active ? ' on' : ''}${t.kind === 'claude' ? ` claude st-${st}` : ''}`,
          role: 'tab',
          draggable: 'true',
          title: key ? `${title} (${key})` : title,
          onmousedown: (e) => e.button === 0 && !e.target.closest('.wtab-close') && activateTab(v, t.id),
          onauxclick: (e) => e.button === 1 && closeTab(v, t.id), // middle-click closes
          ondragstart: (e) => {
            tabDragId = t.id;
            e.dataTransfer.effectAllowed = 'move';
          },
          ondragend: () => {
            tabDragId = null;
            renderStrip(v);
          },
          ondragover: (e) => {
            if (!tabDragId || tabDragId === t.id || !v.tabs.some((x) => x.id === tabDragId)) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            const before = e.clientX < r.left + r.width / 2;
            v.strip.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
            e.currentTarget.classList.add(before ? 'drop-before' : 'drop-after');
          },
          ondrop: (e) => {
            e.preventDefault();
            const moving = v.tabs.find((x) => x.id === tabDragId);
            if (!moving || moving === t) return;
            const before = e.currentTarget.classList.contains('drop-before');
            v.tabs.splice(v.tabs.indexOf(moving), 1);
            v.tabs.splice(v.tabs.indexOf(t) + (before ? 0 : 1), 0, moving);
            renderStrip(v);
          },
        },
        h('span', { class: 'wtab-icon' }, kindIcon(t.kind)),
        h('span', { class: 'wtab-title' }, title),
        key ? h('span', { class: 'wtab-idx' }, key) : null,
        h(
          'button',
          {
            class: 'wtab-close',
            title: t.id === v.active ? 'Close tab (⌘W)' : 'Close tab',
            onclick: (e) => {
              e.stopPropagation();
              closeTab(v, t.id);
            },
          },
          icon('x'),
        ),
      );
    }),
    h('button', { class: 'wtab-new', title: 'New tab (⌘T)', onclick: () => openTab(v.id, 'newtab') }, icon('plus')),
  );
  $('.wtab.on', v.strip)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  saveTabs(v);
  scheduleSidebar(); // the sidebar shows each workspace's open tabs
}

// The "New tab" page: pick what this tab becomes (it's replaced in place, like a browser).
function newTabPage(v, tab) {
  const pick = (kind) => {
    openTab(v.id, kind, { after: tab });
    closeTab(v, tab.id, { remember: false });
  };
  const tile = (kind) => {
    const info = kindInfo(kind);
    const b = h(
      'button',
      { class: 'app-tile', onclick: () => pick(kind) },
      h('span', { class: 'app-tile-icon' }, kindIcon(kind)),
      h('span', { class: 'app-tile-name' }, info.title),
      h('span', { class: 'app-tile-desc' }, info.desc || ''),
    );
    b.style.setProperty('--tile', info.color || (kind === 'claude' ? '#d97757' : 'var(--accent)'));
    return b;
  };
  return h(
    'div',
    { class: 'apps-drawer' },
    h('div', { class: 'apps-drawer-head' }, h('h2', {}, 'New tab'), h('span', { class: 'apps-drawer-sub' }, 'Open a tool in this worktree')),
    h('div', { class: 'apps-section' }, 'Worktree'),
    h('div', { class: 'apps-grid' }, ['claude', 'shell', 'review', 'explorer'].map(tile)),
    h('div', { class: 'apps-section' }, 'Apps'),
    h('div', { class: 'apps-grid' }, window.DeckApps.list.map((a) => tile(`app:${a.id}`))),
  );
}

// Keyboard focus back into whatever the active tab shows.
function focusActive(id = S.activeId) {
  const v = views.get(id);
  const tab = activeTab(v);
  if (!tab) return;
  if (tab.kind === 'claude') v.claude.term.focus();
  else if (tab.term) tab.term.term.focus();
  else if (tab.kind === 'review') v.review.el.focus();
  else if (tab.kind === 'explorer') v.explorer.focus();
  else if (tab.kind.startsWith('app:')) window.DeckApps.instance(tab.kind.slice(4))?.focus?.();
  else $('.app-tile', tab.pane)?.focus();
}

function showView(id) {
  for (const [vid, v] of views) v.el.classList.toggle('hidden', vid !== id);
  const ws = wsById(id);
  $('#empty').classList.toggle('hidden', !!ws);
  if (!ws) return;
  const v = views.get(id) || buildView(ws);
  v.el.classList.remove('hidden');
  ensureStarted(v.claude); // the agent runs whether or not its tab is open
  activateTab(v, v.active);
}

// ⌘⇧D / ⌘⇧E: open (or switch to) the tab; pressed again on it, close it.
function toggleReview(id, force) {
  const v = views.get(id);
  if (!v) return;
  const open = force ?? activeTab(v)?.kind !== 'review';
  if (open) openTab(id, 'review');
  else closeKind(id, 'review');
}
function toggleExplorer(id, force, path) {
  const v = views.get(id);
  if (!v) return;
  // On the Files tab with Search showing, ⌘⇧E goes back to the file tree (as in VS Code).
  if (force == null && activeTab(v)?.kind === 'explorer' && v.explorer.searchVisible) return v.explorer.showFiles();
  const open = force ?? activeTab(v)?.kind !== 'explorer';
  if (open) openTab(id, 'explorer', { path });
  else closeKind(id, 'explorer');
}

// ⌘P: Quick Open — pick a file by name; it opens in the Files tab (at a line, for `name:42`).
function openInFiles(id, path, pos) {
  const v = views.get(id);
  if (!v) return;
  openTab(id, 'explorer');
  v.explorer.goTo(path, pos);
}
function quickOpen(id) {
  if (!views.get(id)) return;
  window.QuickOpen.open(id, (path, pos) => openInFiles(id, path, pos), () => focusActive(id));
}
// ⌘⇧F: Search in the Files tab's sidebar, prefilled with the editor's selection.
function searchInFiles(id) {
  const v = views.get(id);
  if (!v) return;
  const prefill = activeTab(v)?.kind === 'explorer' ? v.explorer.selectedText() : '';
  openTab(id, 'explorer');
  v.explorer.showSearch(prefill);
}

// ⌘`: switch to a shell; on a shell already, open another.
function openShell(id) {
  const v = views.get(id);
  if (!v) return null;
  const cur = activeTab(v);
  if (cur?.kind === 'shell') return openTab(id, 'shell');
  const existing = v.tabs.filter((t) => t.kind === 'shell').pop();
  if (existing) {
    activateTab(v, existing.id);
    return existing;
  }
  return openTab(id, 'shell');
}

async function restartClaude(id, fresh) {
  const v = views.get(id);
  if (!v) return;
  openTab(id, 'claude');
  v.claude.term.reset();
  v.claude.started = true;
  await deck.restartTerm(id, 'claude', v.claude.term.cols, v.claude.term.rows, fresh);
  v.claude.term.focus();
}

function preparePr(id) {
  const ws = wsById(id);
  const tab = openShell(id);
  if (!tab) return;
  const base = ws.baseBranch ? ` --base ${ws.baseBranch}` : '';
  // Typed but not executed — review, then press Enter.
  setTimeout(() => deck.write(`${id}:${tab.termKind}`, `git push -u origin HEAD && gh pr create --fill --web${base}`), 400);
}
