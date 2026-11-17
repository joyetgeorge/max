/* global deck */
'use strict';

// ---------- command menu (⌘K) ----------
// Spotlight-style launcher: everything that isn't needed on screen all the time lives here.
const Palette = (() => {
  let root = null;
  let input;
  let listEl;
  let items = [];
  let sel = 0;

  const active = () => S.activeId && wsById(S.activeId);
  const withWs = (fn) => () => S.activeId && fn(S.activeId);

  function commands() {
    const ws = active();
    const g = (ws && S.git[ws.id]) || {};
    const cmds = [];
    const add = (section, label, ic, run, opts = {}) => cmds.push({ section, label, icon: ic, run, ...opts });
    if (ws) {
      add('Worktree', 'Review changes', 'git-diff', withWs(toggleReview), { key: '⌘⇧D', hint: g.files ? `${g.files} files` : '' });
      add('Worktree', 'Explore files', 'files', withWs(toggleExplorer), { key: '⌘⇧E', hint: 'file tree, source & Markdown preview' });
      add('Worktree', 'Go to file…', 'file-magnifying-glass', withWs(quickOpen), { key: '⌘P', hint: 'by name · name:line' });
      add('Worktree', 'Search in files', 'magnifying-glass', withWs(searchInFiles), { key: '⌘⇧F', hint: 'ripgrep · regex, case, whole word' });
      add('Worktree', 'Create pull request', 'git-pull-request', withWs(preparePr), { hint: 'pre-fills gh pr create in the shell' });
      add('Worktree', 'Restart Claude', 'arrow-clockwise', withWs((id) => restartClaude(id, false)), { key: '⌘⇧R', hint: 'resume conversation' });
      add('Worktree', 'Restart Claude with a new conversation', 'chat-circle-dots', withWs((id) => restartClaude(id, true)));
      add('Worktree', 'Rename worktree', 'pencil-simple-line', withWs(renameActive));
      if (ws.nameLocked) add('Worktree', 'Name from Claude’s topic', 'sparkle', withWs((id) => setAutoName(id, true)), { hint: ws.topic ? `→ ${ws.topic}` : 'follows the conversation' });
      else add('Worktree', 'Keep the current name', 'lock-simple', withWs((id) => setAutoName(id, false)), { hint: 'stop following Claude’s topic' });
      add('Worktree', 'Close worktree', 'x', withWs(closeWorkspace), { danger: true });
      add('Open', 'Open in VS Code', 'code', withWs((id) => deck.openPath(id, 'vscode')));
      add('Open', 'Reveal in Finder', 'folder-open', withWs((id) => deck.openPath(id, 'finder')));
      add('Tabs', 'New tab', 'plus', withWs((id) => openTab(id, 'newtab')), { key: '⌘T' });
      add('Tabs', 'Claude', 'sparkle', withWs((id) => openTab(id, 'claude')));
      add('Tabs', 'Shell', 'terminal-window', withWs(openShell), { key: '⌘`' });
      add('Tabs', 'New shell', 'terminal-window', withWs((id) => openTab(id, 'shell')));
      add('Tabs', 'Close tab', 'x', withWs((id) => closeTab(views.get(id), views.get(id).active)), { key: '⌘W' });
      add('Tabs', 'Reopen closed tab', 'arrow-counter-clockwise', withWs(reopenClosedTab), { key: '⌘⇧T' });
      add('Tabs', 'Next tab', 'arrow-right', withWs((id) => cycleTab(id, 1)), { key: '⌃Tab' });
      add('Tabs', 'Previous tab', 'arrow-left', withWs((id) => cycleTab(id, -1)), { key: '⌃⇧Tab' });
      for (const app of window.DeckApps.list) add('Apps', app.name, app.icon, withWs((id) => openTab(id, `app:${app.id}`)), { hint: app.desc });
    }
    add('General', 'New worktree…', 'plus', () => openModal(), { key: '⌘N' });
    add('General', 'Add repository…', 'folder-plus', async () => {
      const dir = await deck.pickRepo();
      if (dir) openModal(dir);
    });
    add('General', 'Toggle sidebar', 'sidebar', toggleSidebar, { key: '⌘B' });
    add('General', 'Next worktree needing attention', 'bell-simple', jumpToAttention, { key: '⌘J' });
    S.workspaces.forEach((w, i) => {
      if (w.id === S.activeId) return;
      add('Go to', `${repoName(w.repo)} / ${wsLabel(w)}`, 'arrow-right', () => select(w.id), {
        key: i < 9 ? `⌘${i + 1}` : '',
        hint: STATUS_TEXT[statusOf(w.id)],
        status: statusOf(w.id),
      });
    });
    return cmds;
  }

  // Subsequence fuzzy match; rewards word starts and contiguous runs.
  function score(q, text) {
    const t = text.toLowerCase();
    if (!q) return 1;
    if (t.includes(q)) return 100 - t.indexOf(q) + (t.startsWith(q) ? 50 : 0);
    let s = 0;
    let ti = 0;
    let run = 0;
    for (const ch of q) {
      const at = t.indexOf(ch, ti);
      if (at < 0) return 0;
      run = at === ti ? run + 1 : 0;
      s += 1 + run * 2 + (at === 0 || ' /-_'.includes(t[at - 1]) ? 3 : 0);
      ti = at + 1;
    }
    return s;
  }

  function render() {
    const q = input.value.trim().toLowerCase();
    const all = commands();
    items = q
      ? all
          .map((c) => ({ c, s: score(q, `${c.label} ${c.section}`) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .map((x) => x.c)
      : all;
    sel = Math.min(sel, Math.max(0, items.length - 1));
    const rows = [];
    let lastSection = null;
    items.forEach((c, i) => {
      if (!q && c.section !== lastSection) {
        rows.push(h('div', { class: 'cmdk-section' }, c.section));
        lastSection = c.section;
      }
      rows.push(
        h(
          'div',
          {
            class: `cmdk-item${i === sel ? ' sel' : ''}${c.danger ? ' danger' : ''}${c.status ? ` st-${c.status}` : ''}`,
            'data-i': i,
            onmousemove: () => {
              if (sel !== i) {
                sel = i;
                paintSel();
              }
            },
            onclick: () => run(i),
          },
          h('span', { class: 'cmdk-icon' }, icon(c.icon)),
          h('span', { class: 'cmdk-label' }, c.label),
          c.hint ? h('span', { class: 'cmdk-hint' }, c.hint) : null,
          c.key ? h('kbd', {}, c.key) : null,
        ),
      );
    });
    if (!items.length) rows.push(h('div', { class: 'cmdk-empty' }, 'No matching commands'));
    listEl.replaceChildren(...rows);
  }
  function paintSel() {
    listEl.querySelectorAll('.cmdk-item').forEach((el) => el.classList.toggle('sel', Number(el.dataset.i) === sel));
    listEl.querySelector('.cmdk-item.sel')?.scrollIntoView({ block: 'nearest' });
  }
  function run(i) {
    const c = items[i];
    if (!c) return;
    close(false);
    c.run();
  }

  function build() {
    input = h('input', { class: 'cmdk-input', placeholder: 'Type a command or search worktrees…', spellcheck: 'false' });
    listEl = h('div', { class: 'cmdk-list' });
    input.addEventListener('input', () => {
      sel = 0;
      render();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
        e.preventDefault();
        sel = (sel + 1) % Math.max(1, items.length);
        paintSel();
      } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
        e.preventDefault();
        sel = (sel - 1 + items.length) % Math.max(1, items.length);
        paintSel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        run(sel);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });
    root = h(
      'div',
      { class: 'cmdk-overlay hidden', onmousedown: (e) => e.target === root && close() },
      h(
        'div',
        { class: 'cmdk', role: 'dialog', 'aria-label': 'Command menu' },
        h('div', { class: 'cmdk-search' }, icon('magnifying-glass'), input, h('kbd', {}, 'esc')),
        listEl,
        h(
          'div',
          { class: 'cmdk-foot' },
          h('span', {}, h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' navigate'),
          h('span', {}, h('kbd', {}, '↵'), ' run'),
          h('span', {}, h('kbd', {}, '⌘K'), ' close'),
        ),
      ),
    );
    document.body.append(root);
  }

  function open() {
    if (!root) build();
    input.value = '';
    sel = 0;
    render();
    root.classList.remove('hidden');
    input.focus();
  }
  function close(refocus = true) {
    if (!root || root.classList.contains('hidden')) return;
    root.classList.add('hidden');
    if (refocus) focusActive();
  }
  const isOpen = () => !!root && !root.classList.contains('hidden');
  return { open, close, isOpen, toggle: () => (isOpen() ? close() : open()) };
})();
