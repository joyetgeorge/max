'use strict';

// JSON Editor app.
// Two side-by-side panels built on vanilla-jsoneditor (the open-source editor behind
// jsoneditoronline.org): text / tree / table modes, format, compact, sort, repair,
// transform (JSONQuery, JMESPath, JSONPath), search & replace, undo/redo, expand/collapse.
// Each panel keeps its content and mode across restarts; the arrows copy one panel into the other.
(() => {
  const { node: el, icon: ph, store } = window.Kit;
  const { button, copy } = window.DeckApps.ui;

  const JSE_URL = new URL('../node_modules/vanilla-jsoneditor/standalone.js', location.href).href;
  let jseP = null;
  const loadJse = () => (jseP ??= import(JSE_URL));

  function jsonEditorApp() {
    const root = el('div', 'app app-json');
    const panes = el('div', 'jx-panes');
    const status = el('div', 'app-status', 'Loading editor…');
    root.append(panes, status);
    const sides = {};

    function panel(side, label) {
      const KEY = `deck.app.json.${side}`;
      const saved = store.json(KEY, {});
      // The first version of this app stored a single document; it becomes the left panel.
      if (side === 'left' && saved.text == null && store.get('deck.app.json')) saved.text = store.get('deck.app.json');
      const host = el('div', 'jx-editor jse-theme-dark');
      const fileInput = el('input');
      fileInput.type = 'file';
      fileInput.accept = '.json,application/json,text/plain';
      fileInput.hidden = true;
      const head = el(
        'div',
        'jx-head',
        el('span', 'jx-label', label),
        el('span', 'app-spacer'),
        button('', 'folder-open', 'Open a JSON file', () => fileInput.click()),
        button('', 'download-simple', 'Save as a .json file', () => download()),
        button('', 'copy', 'Copy', () => copy(text())),
        button('', 'trash', 'Clear', () => set('')),
      );
      const wrap = el('div', 'jx-panel', head, host, fileInput);
      const p = { side, host, wrap, editor: null, saved };

      const text = () => {
        const c = p.editor?.get();
        if (!c) return '';
        return c.text !== undefined ? c.text : JSON.stringify(c.json, null, 2);
      };
      const set = (t) => p.editor?.set({ text: t });
      p.text = text;
      p.set = set;
      function download() {
        const a = el('a');
        a.href = URL.createObjectURL(new Blob([text()], { type: 'application/json' }));
        a.download = `${side}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }
      fileInput.addEventListener('change', async () => {
        const f = fileInput.files?.[0];
        if (f) set(await f.text());
        fileInput.value = '';
      });
      let t = null;
      p.persist = (mode) => {
        if (mode) saved.mode = mode;
        clearTimeout(t);
        t = setTimeout(() => {
          saved.text = text();
          store.setJson(KEY, saved);
        }, 300);
      };
      sides[side] = p;
      return wrap;
    }

    const arrow = (iconName, title, from, to) =>
      button('', iconName, title, () => {
        const src = sides[from];
        const dst = sides[to];
        if (src.editor && dst.editor) dst.set(src.text());
      });
    const gutter = el(
      'div',
      'jx-gutter',
      arrow('arrow-right', 'Copy left panel to the right', 'left', 'right'),
      arrow('arrow-left', 'Copy right panel to the left', 'right', 'left'),
    );
    panes.append(panel('left', 'Left'), gutter, panel('right', 'Right'));

    loadJse()
      .then((m) => {
        for (const p of Object.values(sides)) {
          p.editor = m.createJSONEditor({
            target: p.host,
            props: {
              content: { text: p.saved.text ?? '' },
              mode: p.saved.mode || (p.side === 'left' ? 'text' : 'tree'),
              indentation: 2,
              // JavaScript and Lodash queries compile code at runtime, which the page's CSP forbids.
              queryLanguages: [m.jsonQueryLanguage, m.jmespathQueryLanguage, m.jsonpathQueryLanguage],
              onChange: () => p.persist(),
              onChangeMode: (mode) => p.persist(mode),
            },
          });
        }
        status.replaceChildren('Text, tree and table modes · format, sort, repair and transform from each panel’s menu · ⌘F to search');
      })
      .catch((e) => {
        status.className = 'app-status err';
        status.replaceChildren(ph('warning-circle'), ` Could not load the JSON editor: ${e.message}`);
      });

    return { el: root, focus: () => sides.left.editor?.focus() };
  }

  window.DeckApps.register({ id: 'json', name: 'JSON Editor', desc: 'Text, tree & table · repair, transform', icon: 'brackets-curly', mat: 'json', color: 'var(--bot-0)', build: jsonEditorApp });
})();
