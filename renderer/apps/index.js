'use strict';

// Built-in dev tools, each opened as a window tab (see openTab in shell/tabs.js).
// Add an app with a file in this folder that calls DeckApps.register({ id, name, desc,
// icon (Phosphor, for the ⌘K menu), mat (Material Icon Theme name, for its tab and tile), color,
// build() -> { el, focus? } }), and load it from index.html; apps are listed in load order.
(() => {
  const { node: el, icon: ph } = window.Kit;

  // What the apps share: a toolbar button and copy-to-clipboard.
  function button(label, iconName, title, onclick) {
    const b = el('button', 'app-btn', iconName ? ph(iconName) : null, label);
    b.title = title || label;
    b.addEventListener('click', onclick);
    return b;
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = el('textarea');
      t.value = text;
      document.body.append(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
  }

  // Paste text into the active workspace's Claude prompt (bracketed paste, so newlines don't
  // submit it) and show its tab. Returns an error message, or '' on success.
  // S and openTab are shell globals (shell/ loads after the apps; this only runs later).
  function sendToClaude(text) {
    const id = S.activeId;
    if (!id) return 'No workspace is open';
    const st = S.runtime[id]?.status;
    if (!st || st === 'exited' || st === 'dormant') return 'Claude isn’t running in this workspace';
    deck.write(`${id}:claude`, `\x1b[200~${text}\x1b[201~`);
    openTab(id, 'claude');
    return '';
  }

  const list = [];
  // One instance per app, shared by every workspace: its element is moved into whichever
  // workspace's tab is showing it, so there's never a second copy with stale state.
  const built = new Map();
  function instance(id) {
    const app = list.find((a) => a.id === id);
    if (!app) return null;
    if (!built.has(id)) built.set(id, app.build());
    return built.get(id);
  }

  window.DeckApps = { list, register: (app) => list.push(app), instance, ui: { button, copy, sendToClaude } };
})();
