/* global hljs, deck, marked, DOMPurify */
// VS Code–style explorer: the worktree's file tree on the left, and on the right an editor
// with tabs (Monaco — VS Code's own editor), plus image and rendered-Markdown views.
'use strict';

(function () {
  const { esc, node, btn, ph, segmented, crumbs, sidePanelSash, loadPrefs, ipcError, baseName, isMarkdown, fileIcon, folderIcon, iconsReady } = window.Kit;
  const { GIT_STATUS, GIT_STATUS_RANK: STATUS_RANK } = window.Kit;
  const statusCls = (st) => GIT_STATUS[st]?.cls;
  const [prefs, savePrefs] = loadPrefs('deck.explorer.prefs', { sideW: 260, md: 'preview', minimap: true, wrap: false });
  const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

  marked.use({ gfm: true });

  // Repo-relative path for a link/image target in a Markdown file; null if it escapes the repo.
  function resolveRel(fromFile, href) {
    const clean = href.split('#')[0].split('?')[0];
    if (!clean) return fromFile;
    const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/') + 1) : '';
    const base = `file:///__root__/${clean.startsWith('/') ? '' : dir}`;
    let u;
    try {
      u = new URL(clean.replace(/^\/+/, ''), base);
    } catch {
      return null;
    }
    const p = decodeURIComponent(u.pathname);
    return p.startsWith('/__root__/') ? p.slice('/__root__/'.length) : null;
  }

  // GitHub-style heading anchors.
  function slugger() {
    const seen = new Map();
    return (text) => {
      const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      return n ? `${base}-${n}` : base;
    };
  }

  // ---------- In-app confirm dialog ----------
  // Drawn in the page rather than as a native sheet: sheets on this transparent, blurred
  // window could make the whole window vanish. Resolves to the index of the chosen button.
  let askOpen = null;
  function ask({ message, detail = '', buttons = ['OK'], defaultId = 0, cancelId = buttons.length - 1 }) {
    if (askOpen) return askOpen;
    askOpen = new Promise((resolve) => {
      const prevFocus = document.activeElement;
      const done = (i) => {
        window.removeEventListener('keydown', onKey, true);
        root.remove();
        askOpen = null;
        prevFocus?.focus?.();
        resolve(i);
      };
      // macOS order: the default button sits on the right, the rest to its left.
      const btns = buttons.map((label, i) => {
        const b = node('button', i === defaultId ? 'primary' : '', label);
        b.type = 'button';
        b.addEventListener('click', () => done(i));
        return b;
      });
      const order = [...btns.keys()].sort((a, b) => (a === defaultId) - (b === defaultId) || (a === cancelId) - (b === cancelId) || b - a);
      const box = node(
        'div',
        'ask-box',
        node('div', 'ask-msg', message),
        detail ? node('div', 'ask-detail', detail) : null,
        node('div', 'ask-actions', ...order.map((i) => btns[i])),
      );
      box.setAttribute('role', 'alertdialog');
      const root = node('div', 'ask-backdrop', box);
      root.addEventListener('mousedown', (e) => e.target === root && e.preventDefault());
      const onKey = (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          done(cancelId);
        } else if (e.key === 'Enter' && !e.target.closest?.('.ask-box button')) {
          e.preventDefault();
          done(defaultId);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          const all = order.map((i) => btns[i]);
          const at = all.indexOf(document.activeElement);
          all[(at + (e.shiftKey ? -1 : 1) + all.length) % all.length].focus();
        } else if (e.metaKey && e.key.toLowerCase() === 'd' && buttons.length > 2) {
          // ⌘D = Don't Save, as in macOS save prompts
          e.preventDefault();
          const i = buttons.findIndex((l) => /^don/i.test(l));
          if (i >= 0) done(i);
        }
      };
      window.addEventListener('keydown', onKey, true);
      document.body.append(root);
      btns[defaultId].focus();
    });
    return askOpen;
  }

  // ---------- Monaco (loaded on first use; it's large) ----------
  const MONACO_BASE = new URL('../node_modules/monaco-editor/min/vs', location.href).href;
  let monacoP = null;
  function loadMonaco() {
    monacoP ??= new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = `${MONACO_BASE}/editor/editor.main.css`;
      document.head.append(css);
      const s = document.createElement('script');
      s.src = `${MONACO_BASE}/loader.js`;
      s.onerror = () => reject(new Error('Could not load the editor'));
      s.onload = () => {
        const amd = window.require;
        amd.config({ paths: { vs: MONACO_BASE } });
        amd(['vs/index'], (m) => {
          configureMonaco(m);
          // Richer JS/TS highlighting must be in place before the first file is tokenized.
          patchJsTokenizers(m)
            .catch(() => {}) // stock highlighting still works
            .then(() => resolve(m));
        }, reject);
      };
      document.head.append(s);
    });
    return monacoP;
  }

  function configureMonaco(m) {
    // Without the whole project loaded, semantic checks only produce false "cannot find module" errors.
    const ts = m.typescript || m.languages.typescript;
    for (const d of [ts?.typescriptDefaults, ts?.javascriptDefaults]) {
      d?.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
      d?.setCompilerOptions({ ...d.getCompilerOptions(), jsx: 4 /* react-jsx */, allowJs: true, target: 99, allowNonTsExtensions: true });
    }
    const json = m.json || m.languages.json;
    json?.jsonDefaults?.setDiagnosticsOptions({ validate: true, allowComments: true, trailingCommas: 'ignore', enableSchemaRequest: false });
    applyMonacoTheme(m);
    setupDefinitions(m);
  }

  // ---------- go to definition (⌘-click, F12) ----------
  // Models are named file:///<wsId>/<worktree-relative path>. The main process finds definitions
  // (TypeScript's language server for JS/TS, a declaration search otherwise); a definition in
  // another file opens there as a new tab.
  const explorers = new Map(); // wsId -> Explorer
  const modelFile = (uri) => {
    const mt = /^\/([^/]+)\/(.+)$/.exec(uri.path);
    return mt ? { wsId: mt[1], path: mt[2] } : null;
  };
  function setupDefinitions(m) {
    const uriFor = (wsId, path) => m.Uri.from({ scheme: 'file', path: `/${wsId}/${path}` });
    // Monaco's own TS definitions only see the open file; ours know the whole project.
    const ts = m.typescript || m.languages.typescript;
    for (const d of [ts?.typescriptDefaults, ts?.javascriptDefaults]) d?.setModeConfiguration?.({ ...d.modeConfiguration, definitions: false });

    const sentVersion = new WeakMap(); // model -> version the language server has (skip resending the text)
    const provider = {
      async provideDefinition(model, position) {
        const f = modelFile(model.uri);
        const word = model.getWordAtPosition(position)?.word;
        if (!f || !word) return null;
        const version = model.getVersionId();
        let res;
        try {
          res = await deck.findDefinition(f.wsId, {
            file: f.path,
            text: sentVersion.get(model) === version ? null : model.getValue(),
            line: position.lineNumber,
            col: position.column,
            word,
          });
        } catch {
          return null;
        }
        sentVersion.set(model, version);
        const defs = (res?.defs || []).slice(0, 8);
        // Load the other files' text, so the ⌘-hover preview and the peek list can show them.
        await Promise.all(
          defs.map(async (d) => {
            const uri = uriFor(f.wsId, d.path);
            if (m.editor.getModel(uri)) return;
            const r = await deck.readFile(f.wsId, d.path).catch(() => null);
            if (r?.text != null && !m.editor.getModel(uri)) m.editor.createModel(r.text, languageFor(d.path, r.text, m), uri);
          }),
        );
        return defs.map((d) => ({
          uri: uriFor(f.wsId, d.path),
          range: { startLineNumber: d.line, startColumn: d.col + 1, endLineNumber: d.endLine, endColumn: d.endCol + 1 },
        }));
      },
    };
    m.languages.registerDefinitionProvider(
      m.languages.getLanguages().map((l) => l.id),
      provider,
    );
    // A definition in another file: open it in the Files tab (a new tab), at the definition.
    m.editor.registerEditorOpener({
      openCodeEditor(_source, resource, selOrPos) {
        const f = modelFile(resource);
        const ex = f && explorers.get(f.wsId);
        if (!ex) return false;
        let pos = null;
        if (selOrPos) {
          const r = selOrPos.startLineNumber
            ? selOrPos
            : { startLineNumber: selOrPos.lineNumber, startColumn: selOrPos.column, endLineNumber: selOrPos.lineNumber, endColumn: selOrPos.column };
          pos = { line: r.startLineNumber, col: r.startColumn - 1, len: r.endLineNumber === r.startLineNumber ? r.endColumn - r.startColumn : 0 };
        }
        ex.goTo(f.path, pos);
        return true;
      },
    });
  }

  // Monaco's JS/TS highlighter (Monarch) marks every name as plain `identifier`, so variables,
  // calls and properties all came out in the foreground colour. VS Code tells them apart (TextMate
  // grammar + the TS server); these rules get most of the way: a name followed by `(` is a function
  // (call or declaration — keywords like `if (` stay keywords), and `.name` is a property.
  const JS_EXTRA_RULES = [
    [/\.\.\./, 'delimiter'], // spread/rest, not a property access
    [/(\.)(#?[a-zA-Z_$][\w$]*)(?=\s*(?:<[^<>()]*>)?\s*\()/, ['delimiter', 'identifier.function']],
    [/(\.)(#?[a-zA-Z_$][\w$]*)/, ['delimiter', 'identifier.property']],
    [/#?[a-z_$][\w$]*(?=\s*(?:<[^<>()]*>)?\s*\()/, { cases: { '@keywords': 'keyword', '@default': 'identifier.function' } }],
  ];
  async function patchJsTokenizers(m) {
    for (const id of ['typescript', 'javascript']) {
      const lang = m.languages.getLanguages().find((l) => l.id === id);
      if (!lang?.loader) continue;
      const apply = async () => {
        const mod = await lang.loader();
        const base = mod?.language;
        if (!base?.tokenizer?.common) return;
        m.languages.setMonarchTokensProvider(id, { ...base, tokenizer: { ...base.tokenizer, common: [...JS_EXTRA_RULES, ...base.tokenizer.common] } });
      };
      await apply();
      // Monaco installs the stock tokenizer the first time a language is used: put ours back after it.
      m.languages.onLanguage(id, () => setTimeout(apply, 0));
    }
  }

  // CSS colour → #rrggbb or #rrggbbaa, which is all Monaco themes accept.
  let colorCtx = null;
  function toHex(c) {
    colorCtx ??= document.createElement('canvas').getContext('2d');
    colorCtx.fillStyle = '#808080';
    colorCtx.fillStyle = c || '#808080';
    const v = colorCtx.fillStyle;
    if (v.startsWith('#')) return v;
    const [r, g, b, a = 1] = (v.match(/[\d.]+/g) || [128, 128, 128]).map(Number);
    const hx = (x) => Math.round(x).toString(16).padStart(2, '0');
    return `#${hx(r)}${hx(g)}${hx(b)}${a < 1 ? hx(a * 255) : ''}`;
  }

  // Theme the editor from the app theme's CSS variables (renderer/lib/theme.js), like the rest of the app.
  function applyMonacoTheme(m) {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => toHex(cs.getPropertyValue(n).trim());
    const fg = (n) => v(n).slice(1, 7);
    const bg = v('--bg-solid').slice(0, 7);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
    const dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
    const sel = v('--selection');
    const rule = (token, n, fontStyle) => ({ token, foreground: fg(n), ...(fontStyle ? { fontStyle } : {}) });
    m.editor.defineTheme('max', {
      base: dark ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [
        rule('', '--text'),
        rule('comment', '--syn-comment', 'italic'),
        rule('keyword', '--syn-keyword'),
        rule('storage', '--syn-keyword'),
        rule('string', '--syn-string'),
        rule('string.escape', '--syn-op'),
        rule('regexp', '--syn-op'),
        rule('number', '--syn-number'),
        rule('constant', '--syn-builtin'),
        rule('predefined', '--syn-builtin'),
        rule('type', '--syn-type'),
        rule('type.identifier', '--syn-type'),
        rule('identifier', '--text'),
        rule('identifier.function', '--syn-func'),
        rule('identifier.property', '--syn-prop'),
        rule('variable', '--syn-param'),
        rule('variable.predefined', '--syn-builtin'),
        rule('delimiter', '--syn-punct'),
        rule('operator', '--syn-op'),
        rule('tag', '--syn-keyword'),
        rule('metatag', '--syn-meta'),
        rule('annotation', '--syn-meta'),
        rule('attribute.name', '--syn-prop'),
        rule('attribute.value', '--syn-string'),
        rule('key', '--syn-prop'),
        rule('string.key.json', '--syn-prop'),
        rule('string.value.json', '--syn-string'),
        rule('keyword.json', '--syn-builtin'),
        rule('emphasis', '--text', 'italic'),
        rule('strong', '--text-strong', 'bold'),
        rule('header', '--syn-keyword', 'bold'),
      ],
      colors: {
        // Transparent so the explorer's translucent surface (and the window blur) shows through.
        'editor.background': '#00000000',
        'editorGutter.background': '#00000000',
        'minimap.background': '#00000000',
        'editor.foreground': v('--text'),
        'editorLineNumber.foreground': v('--rv-ln'),
        'editorLineNumber.activeForeground': v('--rv-ln-active'),
        'editorCursor.foreground': v('--accent'),
        'editor.selectionBackground': sel.length === 7 ? `${sel}99` : sel,
        'editor.inactiveSelectionBackground': sel.length === 7 ? `${sel}55` : sel,
        'editor.lineHighlightBackground': v('--bg-hover'),
        'editor.lineHighlightBorder': '#00000000',
        'editorWidget.background': v('--bg-solid-2'),
        'editorWidget.border': v('--border-soft'),
        'editorSuggestWidget.background': v('--bg-solid-2'),
        'editorHoverWidget.background': v('--bg-solid-2'),
        'input.background': v('--bg-solid'),
        'focusBorder': `${v('--accent').slice(0, 7)}88`,
        'editorIndentGuide.background1': v('--border-soft'),
        'scrollbarSlider.background': `#${fg('--text')}22`,
        'scrollbarSlider.hoverBackground': `#${fg('--text')}33`,
        'scrollbarSlider.activeBackground': `#${fg('--text')}44`,
      },
    });
    m.editor.setTheme('max');
  }

  // ---------- language for a file ----------
  // Monaco picks a language from the extension only, so config files like .swcrc (JSON) or
  // .npmrc (INI) came up as plain text. Known names first (as VS Code maps them), then — for
  // anything Monaco doesn't recognise — a guess from the content.
  const LANG_BY_NAME = {
    '.swcrc': 'json', '.babelrc': 'json', '.eslintrc': 'json', '.jshintrc': 'json', '.jscsrc': 'json', '.nycrc': 'json',
    '.stylelintrc': 'json', '.lintstagedrc': 'json', '.releaserc': 'json', '.mocharc': 'json', '.watchmanconfig': 'json',
    '.firebaserc': 'json', '.prettierrc': 'json', '.huskyrc': 'json', '.bowerrc': 'json', '.jsbeautifyrc': 'json', 'composer.lock': 'json',
    '.npmrc': 'ini', '.yarnrc': 'ini', '.editorconfig': 'ini', '.gitconfig': 'ini', '.gitmodules': 'ini', '.pylintrc': 'ini', '.flake8': 'ini',
    '.zshrc': 'shell', '.zprofile': 'shell', '.zshenv': 'shell', '.bashrc': 'shell', '.bash_profile': 'shell', '.profile': 'shell',
    podfile: 'ruby', gemfile: 'ruby', fastfile: 'ruby', appfile: 'ruby', matchfile: 'ruby', pluginfile: 'ruby', brewfile: 'ruby', rakefile: 'ruby',
    'podfile.lock': 'yaml', jenkinsfile: 'groovy', procfile: 'yaml',
  };
  function languageFor(path, text, m) {
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    if (LANG_BY_NAME[name]) return LANG_BY_NAME[name];
    if (/^\.env(\..+)?$/.test(name) || name.endsWith('.env')) return 'ini';
    if (/^(docker|container)file(\..+)?$/.test(name) || name.endsWith('.dockerfile')) return 'dockerfile';
    // Does Monaco know this file from its extension or name? Then let it decide.
    const known = m.languages.getLanguages().some(
      (l) => l.id !== 'plaintext' && ((l.extensions || []).some((e) => name.endsWith(e.toLowerCase())) || (l.filenames || []).some((f) => f.toLowerCase() === name)),
    );
    if (known) return undefined;
    const head = text.slice(0, 2000).replace(/^﻿/, '');
    const shebang = /^#!.*\b(node|deno|bun|bash|zsh|sh|python3?|ruby)\b/.exec(head);
    if (shebang) return { node: 'javascript', deno: 'typescript', bun: 'javascript', python: 'python', python3: 'python', ruby: 'ruby' }[shebang[1]] || 'shell';
    const t = head.trimStart();
    if ((t.startsWith('{') || t.startsWith('[')) && /^[[{]\s*("|\]|\}|\[|\{|\d|true|false|null|\/\/)/.test(t)) return 'json';
    if (t.startsWith('<?xml')) return 'xml';
    // Mostly "key: value" / "- item" lines → YAML.
    const lines = head.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    if (lines.length && lines.filter((l) => /^\s*(-\s+\S|[\w.-]+:(\s|$))/.test(l)).length / lines.length > 0.6) return 'yaml';
    return undefined;
  }

  // ---------- Explorer ----------
  class Explorer {
    constructor(wsId, hooks) {
      this.wsId = wsId;
      this.hooks = hooks;
      explorers.set(wsId, this); // for definitions that open another file
      this.children = new Map(); // dir path ('' = root) -> items
      this.expanded = new Set();
      this.deco = new Map(); // path -> status letter (files and folders)
      this.untrackedDirs = [];
      this.cursor = null; // keyboard focus row path
      this.tabs = []; // { path, preview, kind, model, savedAlt, mtime, viewState, image, info, size, deleted, mdMode }
      this.active = null;
      this.editor = null;
      this.lastDirtyCount = 0;
      this.build();
    }

    get selected() {
      return this.active?.path ?? null;
    }

    build() {
      this.tree = node('div', 'rv-files ex-tree');
      this.tree.tabIndex = 0;
      // Delegated: rows are rebuilt on every render.
      this.tree.addEventListener('click', (e) => {
        const row = e.target.closest('.rv-row[data-path]');
        if (!row) return;
        this.moveCursor(row.dataset.path);
        if (row.dataset.dir) this.toggleDir(row.dataset.path);
        else this.openFile(row.dataset.path); // single click: preview tab, like VS Code
      });
      this.tree.addEventListener('dblclick', (e) => {
        const row = e.target.closest('.rv-row[data-path]');
        if (row && !row.dataset.dir) this.openFile(row.dataset.path, { pin: true, focus: true });
      });
      // The sidebar has two views, like VS Code's activity bar: the file tree and Search (⌘⇧F).
      this.search = new window.SearchPanel(this.wsId, { onOpen: (path, pos) => this.goTo(path, pos) });
      this.viewBtns = {
        files: btn('rv-icon ex-view on', 'Explorer (⌘⇧E)', ph('files'), () => this.showFiles()),
        search: btn('rv-icon ex-view', 'Search (⌘⇧F)', ph('magnifying-glass'), () => this.showSearch()),
      };
      this.sideTitle = node('span', 'rv-title', 'Explorer');
      this.filesTools = node(
        'span',
        'ex-tools',
        btn('rv-icon', 'Collapse folders', ph('arrows-in-line-vertical'), () => {
          this.expanded.clear();
          this.renderTree();
        }),
        btn('rv-icon', 'Refresh', ph('arrow-clockwise'), () => this.refresh()),
      );
      this.searchTools = node(
        'span',
        'ex-tools hidden',
        btn('rv-icon', 'Collapse all results', ph('arrows-in-line-vertical'), () => this.search.collapseAll()),
        btn('rv-icon', 'Search again', ph('arrow-clockwise'), () => this.search.run(true)),
        btn('rv-icon', 'Clear search', ph('x-circle'), () => this.search.clear()),
      );
      const side = node(
        'aside',
        'rv-side',
        node('div', 'rv-side-head', this.viewBtns.files, this.viewBtns.search, this.sideTitle, node('span', 'rv-spacer'), this.filesTools, this.searchTools),
        this.tree,
        this.search.el,
      );
      const sash = node('div', 'rv-sash');
      sidePanelSash(sash, side, prefs, savePrefs);

      this.tabStrip = node('div', 'ex-tabs');
      this.tabStrip.addEventListener('wheel', (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) this.tabStrip.scrollLeft += e.deltaY;
      });
      const md = segmented([['preview', 'Preview'], ['source', 'Edit']], (k) => {
        if (!this.active) return;
        prefs.md = k;
        savePrefs();
        this.active.mdMode = k;
        this.showActive();
        if (k === 'source') this.editor?.focus();
      });
      this.mdSeg = md.el;
      this.mdSeg.classList.add('hidden');
      this.mdBtns = md.btns;
      this.wrapBtn = btn('rv-icon', 'Toggle word wrap (⌥Z)', ph('text-align-left'), () => this.toggleWrap());
      this.minimapBtn = btn('rv-icon', 'Toggle minimap', ph('sidebar-simple'), () => {
        prefs.minimap = !prefs.minimap;
        savePrefs();
        this.editor?.updateOptions({ minimap: { enabled: prefs.minimap } });
        this.syncToggles();
      });
      this.saveBtn = btn('rv-icon', 'Save (⌘S)', ph('floppy-disk'), () => this.save());
      this.copyBtn = btn('rv-icon', 'Copy relative path', ph('copy'), () => this.selected && navigator.clipboard.writeText(this.selected));
      this.openBtn = btn('rv-icon', 'Open file in VS Code', ph('arrow-square-out'), () => {
        if (!this.selected) return;
        const line = this.editorVisible() ? this.editor.getPosition()?.lineNumber || 1 : 1;
        deck.openFile(this.wsId, this.selected, line);
      });
      this.crumbs = node('div', 'rv-crumbs');
      this.cursorPos = node('span', 'ex-pos');
      this.navStatus = node('span', 'ex-nav-status');
      this.body = node('div', 'ex-body hl');
      this.body.addEventListener('click', (e) => this.onBodyClick(e));
      this.editorHost = node('div', 'ex-editor hidden');

      const main = node(
        'section',
        'rv-main',
        node(
          'div',
          'rv-tabbar ex-tabbar',
          this.tabStrip,
          node('span', 'rv-spacer'),
          this.saveBtn,
          this.wrapBtn,
          this.minimapBtn,
          this.copyBtn,
          this.openBtn,
          node('span', 'rv-sep'),
          btn('rv-icon', 'Close explorer (Esc)', ph('x'), () => this.hooks.onClose()),
        ),
        node('div', 'rv-subbar', this.crumbs, this.navStatus, this.cursorPos, this.mdSeg),
        node('div', 'ex-stage', this.editorHost, this.body),
      );

      this.el = node('div', 'review explorer hidden', side, sash, main);
      this.el.tabIndex = -1;
      // Capture: ⌘S etc. must win over Monaco's own key handling.
      this.el.addEventListener('keydown', (e) => this.onKey(e), true);
      this.syncToggles();
      this.showActive();
    }

    syncToggles() {
      const mode = this.active?.mdMode || prefs.md;
      for (const [k, b] of Object.entries(this.mdBtns)) b.classList.toggle('on', mode === k);
      this.wrapBtn.classList.toggle('on', prefs.wrap);
      this.minimapBtn.classList.toggle('on', prefs.minimap);
    }

    show(path) {
      this.el.classList.remove('hidden');
      this.refresh().then(() => path && this.reveal(path));
      this.focus();
    }
    hide() {
      this.el.classList.add('hidden');
    }
    get visible() {
      return !this.el.classList.contains('hidden');
    }
    focus() {
      if (this.editorVisible()) this.editor.focus();
      else this.tree.focus();
    }
    editorVisible() {
      return !!this.editor && !this.editorHost.classList.contains('hidden');
    }

    // ----- data -----
    async loadDir(rel) {
      const items = await deck.listDir(this.wsId, rel);
      if (items) this.children.set(rel, items);
      return items;
    }

    async refresh() {
      await iconsReady;
      const dirs = ['', ...this.expanded];
      const [results, status] = await Promise.all([
        Promise.all(dirs.map((d) => this.loadDir(d).catch(() => null))),
        deck.fileStatus(this.wsId).catch(() => ({})),
      ]);
      results.forEach((r, i) => {
        if (!r && dirs[i]) {
          this.expanded.delete(dirs[i]); // folder is gone
          this.children.delete(dirs[i]);
        }
      });
      if (!results[0]) {
        this.tree.replaceChildren(node('div', 'rv-empty', 'Could not read the worktree folder.'));
        return;
      }
      this.setStatus(status || {});
      this.renderTree();
      // Pick up changes made on disk (e.g. by the agent) in tabs with no unsaved edits.
      await Promise.all(this.tabs.map((t) => this.syncFromDisk(t)));
    }

    async refreshStatus() {
      this.setStatus((await deck.fileStatus(this.wsId).catch(() => null)) || {});
      this.renderTree();
    }

    setStatus(status) {
      this.deco = new Map();
      this.untrackedDirs = [];
      const bump = (p, c) => {
        const cur = this.deco.get(p);
        if (!cur || STATUS_RANK[c] > STATUS_RANK[cur]) this.deco.set(p, c);
      };
      for (let [p, c] of Object.entries(status)) {
        if (p.endsWith('/')) {
          this.untrackedDirs.push(p);
          p = p.slice(0, -1);
        }
        this.deco.set(p, c);
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i++) bump(parts.slice(0, i).join('/'), c);
      }
    }
    decoOf(p) {
      return this.deco.get(p) || (this.untrackedDirs.some((d) => p.startsWith(d)) ? 'U' : null);
    }

    // ----- tree -----
    renderTree() {
      const rows = [];
      const walk = (dir, depth) => {
        for (const it of this.children.get(dir) || []) {
          const st = this.decoOf(it.path);
          const cls = `rv-row ${it.dir ? 'rv-dir' : 'rv-file'}${st ? ` ${statusCls(st)}` : ''}${it.ignored ? ' ex-ignored' : ''}`;
          const open = it.dir && this.expanded.has(it.path);
          const row = node('div', `${cls}${open ? ' open' : ''}${it.path === this.selected ? ' selected' : ''}${it.path === this.cursor ? ' cursor' : ''}`);
          row.style.paddingLeft = `${8 + depth * 14}px`;
          row.dataset.path = it.path;
          if (it.dir) row.dataset.dir = '1';
          row.title = it.path;
          const name = node('span', 'rv-name', node('span', 'rv-base-name', it.name));
          if (it.dir) {
            const chev = node('span', 'rv-chev');
            chev.innerHTML = ph('caret-right');
            row.append(chev, folderIcon(it.name, open), name);
            if (st) row.append(node('span', `rv-dot ${statusCls(st)}`));
          } else {
            row.append(node('span', 'ex-chev-pad'), fileIcon(it.name), name);
            if (st) row.append(node('span', `rv-letter ${statusCls(st)}`, st));
          }
          rows.push(row);
          if (open) {
            if (this.children.has(it.path)) walk(it.path, depth + 1);
            else rows.push(node('div', 'rv-row ex-loading', 'Loading…'));
          }
        }
      };
      walk('', 0);
      if (!rows.length) rows.push(node('div', 'rv-empty', 'Empty folder'));
      this.tree.replaceChildren(...rows);
    }

    async toggleDir(path, force) {
      const open = force ?? !this.expanded.has(path);
      if (open === this.expanded.has(path)) return;
      if (open) this.expanded.add(path);
      else this.expanded.delete(path);
      this.renderTree();
      if (open && !this.children.has(path)) {
        try {
          await this.loadDir(path);
        } catch (e) {
          this.children.set(path, []);
          this.hooks.onError?.(ipcError(e));
        }
        this.renderTree();
      }
    }

    // Load the TypeScript project in the background the first time a JS/TS file opens, so ⌘-click
    // is quick; the status bar says so while it loads (big projects take a while).
    warmDefinitions(path) {
      if (this.warmed || !/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(path)) return;
      this.warmed = true;
      this.navStatus.textContent = 'Loading TypeScript project…';
      this.navStatus.title = 'Go to definition (⌘-click) is ready when this disappears';
      deck
        .warmDefinitions(this.wsId, path)
        .catch(() => false)
        .then(() => {
          this.navStatus.textContent = '';
          this.navStatus.title = '';
        });
    }

    // ----- sidebar views -----
    showSearch(prefill) {
      this.tree.classList.add('hidden');
      this.filesTools.classList.add('hidden');
      this.searchTools.classList.remove('hidden');
      this.viewBtns.files.classList.remove('on');
      this.viewBtns.search.classList.add('on');
      this.sideTitle.textContent = 'Search';
      this.search.show(prefill);
    }
    showFiles() {
      this.search.hide();
      this.tree.classList.remove('hidden');
      this.filesTools.classList.remove('hidden');
      this.searchTools.classList.add('hidden');
      this.viewBtns.files.classList.add('on');
      this.viewBtns.search.classList.remove('on');
      this.sideTitle.textContent = 'Explorer';
      this.tree.focus();
    }
    get searchVisible() {
      return this.search.visible;
    }
    // The single-line selection in the editor, to prefill Search with (as VS Code does).
    selectedText() {
      const ed = this.editorVisible() ? this.editor : null;
      const sel = ed?.getSelection();
      if (!sel || sel.isEmpty() || sel.startLineNumber !== sel.endLineNumber) return '';
      return ed.getModel().getValueInRange(sel);
    }

    // Open a file (pinned) and, given a position, select that range in the editor — for ⌘P
    // and search results. Markdown switches to Source so the line is visible.
    async goTo(path, pos) {
      await this.reveal(path, { pin: true });
      const tab = this.tabs.find((t) => t.path === path);
      if (!tab || this.active !== tab) return;
      if (!pos?.line || tab.kind !== 'text') return this.focus();
      if (isMarkdown(path) && tab.mdMode === 'preview') {
        tab.mdMode = 'source';
        this.syncToggles();
      }
      await this.showActive();
      const ed = this.editor;
      if (!ed || this.active !== tab || ed.getModel() !== tab.model) return;
      const line = Math.min(pos.line, tab.model.getLineCount());
      const col = (pos.col || 0) + 1;
      const range = { startLineNumber: line, startColumn: col, endLineNumber: line, endColumn: col + (pos.len || 0) };
      ed.setSelection(range);
      ed.focus();
      // A just-shown editor hasn't measured itself yet and ignores the scroll: lay out first.
      requestAnimationFrame(() => {
        if (ed.getModel() !== tab.model) return;
        ed.layout();
        ed.revealRangeInCenter(range);
      });
    }

    // Expand every ancestor of a path, then open it.
    async reveal(path, opts) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        this.expanded.add(dir);
        if (!this.children.has(dir)) await this.loadDir(dir).catch(() => null);
      }
      this.cursor = path;
      this.renderTree();
      this.tree.querySelector(`.rv-row[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'center' });
      await this.openFile(path, opts);
    }

    visibleRows() {
      return [...this.tree.querySelectorAll('.rv-row[data-path]')];
    }
    moveCursor(path) {
      this.cursor = path;
      for (const r of this.visibleRows()) r.classList.toggle('cursor', r.dataset.path === path);
      this.tree.querySelector('.rv-row.cursor')?.scrollIntoView({ block: 'nearest' });
    }
    syncTreeSelection() {
      for (const r of this.visibleRows()) r.classList.toggle('selected', r.dataset.path === this.selected);
    }

    // ----- tabs -----
    isDirty(t) {
      return !!t?.model && !t.model.isDisposed() && t.model.getAlternativeVersionId() !== t.savedAlt;
    }
    dirtyTabs() {
      return this.tabs.filter((t) => this.isDirty(t));
    }

    // Open a file in a tab. Without `pin` it goes in the single preview tab (italic), which the
    // next preview replaces — VS Code's behaviour. Editing or double-clicking pins it.
    async openFile(path, { pin = false, focus = false } = {}) {
      let tab = this.tabs.find((t) => t.path === path);
      if (!tab) {
        tab = { path, preview: !pin, kind: 'loading', mdMode: prefs.md };
        const prev = pin ? null : this.tabs.find((t) => t.preview && !this.isDirty(t));
        if (prev) {
          this.tabs.splice(this.tabs.indexOf(prev), 1, tab);
          this.disposeTab(prev);
        } else {
          const at = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
          this.tabs.splice(at, 0, tab);
        }
        this.activate(tab);
        await this.loadTab(tab);
        if (this.active !== tab) return;
      } else if (pin) tab.preview = false;
      this.activate(tab);
      if (focus) this.focus();
    }

    async loadTab(tab) {
      let res;
      try {
        res = await deck.readFile(this.wsId, tab.path);
      } catch (e) {
        Object.assign(tab, { kind: 'info', info: ['Could not open file', ipcError(e)] });
        return;
      }
      if (!this.tabs.includes(tab) || !res) return;
      tab.size = res.size;
      tab.mtime = res.mtime;
      if (res.tooLarge) Object.assign(tab, { kind: 'info', info: ['File too large', 'Open it in VS Code to view.'] });
      else if (res.binary) Object.assign(tab, { kind: 'info', info: ['Binary file', 'This file can’t be shown as text.'] });
      else if (res.image) Object.assign(tab, { kind: 'image', image: res.image });
      else {
        let m;
        try {
          m = await loadMonaco();
        } catch (e) {
          Object.assign(tab, { kind: 'info', info: ['Editor failed to load', ipcError(e)] });
          return;
        }
        if (!this.tabs.includes(tab)) return;
        const uri = m.Uri.from({ scheme: 'file', path: `/${this.wsId}/${tab.path}` });
        m.editor.getModel(uri)?.dispose();
        tab.model = m.editor.createModel(res.text, languageFor(tab.path, res.text, m), uri);
        tab.savedAlt = tab.model.getAlternativeVersionId();
        tab.kind = 'text';
        tab.model.onDidChangeContent(() => this.onEdit(tab));
        this.warmDefinitions(tab.path);
      }
      if (this.active === tab) this.showActive();
    }

    // Re-read a clean tab when its file changed on disk; mark it if the file is gone.
    async syncFromDisk(tab) {
      if (tab.kind !== 'text' && tab.kind !== 'image') return;
      let res;
      try {
        res = await deck.readFile(this.wsId, tab.path);
      } catch {
        if (!tab.deleted) {
          tab.deleted = true;
          this.renderTabs();
        }
        return;
      }
      const wasDeleted = tab.deleted;
      tab.deleted = false;
      if (res?.mtime === tab.mtime && !wasDeleted) return;
      if (tab.kind === 'image' && res?.image) {
        Object.assign(tab, { image: res.image, mtime: res.mtime, size: res.size });
      } else if (tab.kind === 'text' && res?.text != null && !this.isDirty(tab)) {
        if (res.text !== tab.model.getValue()) {
          // An undoable edit, so the cursor and undo history survive the reload.
          tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text: res.text }], () => null);
          tab.savedAlt = tab.model.getAlternativeVersionId();
        }
        Object.assign(tab, { mtime: res.mtime, size: res.size });
      } else return;
      this.renderTabs();
      if (this.active === tab && !this.editorVisible()) this.showActive();
    }

    onEdit(tab) {
      if (tab.preview) tab.preview = false;
      const dirty = this.isDirty(tab);
      if (dirty !== !!tab.wasDirty) {
        tab.wasDirty = dirty;
        this.renderTabs();
        this.reportDirty();
      }
    }

    reportDirty() {
      const n = this.dirtyTabs().length;
      if (n !== this.lastDirtyCount) {
        this.lastDirtyCount = n;
        deck.setDirty(this.wsId, n);
      }
    }

    activate(tab) {
      if (this.active && this.active !== tab && this.editorVisible() && this.editor.getModel() === this.active.model) {
        this.active.viewState = this.editor.saveViewState();
      }
      this.active = tab;
      if (tab) this.cursor = tab.path;
      this.renderTabs();
      this.showActive();
      this.syncTreeSelection();
      if (tab && tab.kind !== 'loading') this.syncFromDisk(tab);
    }

    renderTabs() {
      // Same file name in two tabs → show the folder too, like VS Code.
      const counts = new Map();
      for (const t of this.tabs) counts.set(baseName(t.path), (counts.get(baseName(t.path)) || 0) + 1);
      this.tabStrip.replaceChildren(
        ...this.tabs.map((t) => {
          const name = baseName(t.path);
          const dirty = this.isDirty(t);
          const el = node(
            'div',
            `ex-tab${t === this.active ? ' active' : ''}${t.preview ? ' preview' : ''}${dirty ? ' dirty' : ''}${t.deleted ? ' deleted' : ''}`,
            fileIcon(name),
            node('span', 'ex-tab-name', name),
            counts.get(name) > 1 ? node('span', 'ex-tab-dir', t.path.split('/').slice(-2, -1)[0] || '') : null,
          );
          el.title = t.path + (t.deleted ? ' (deleted)' : '') + (t.preview ? ' · preview — double-click to keep open' : '');
          const close = btn('ex-tab-close', dirty ? 'Unsaved changes — close (⌘W)' : 'Close (⌘W)', ph('x'), (e) => {
            e.stopPropagation();
            this.closeTab(t);
          });
          el.append(close);
          el.addEventListener('mousedown', (e) => {
            if (e.button === 0 && !e.target.closest('.ex-tab-close')) this.activate(t);
          });
          el.addEventListener('auxclick', (e) => {
            if (e.button === 1) this.closeTab(t);
          });
          el.addEventListener('dblclick', () => {
            t.preview = false;
            this.renderTabs();
          });
          // Drag to reorder.
          el.draggable = true;
          el.addEventListener('dragstart', (e) => {
            this.dragTab = t;
            e.dataTransfer.effectAllowed = 'move';
          });
          el.addEventListener('dragover', (e) => {
            if (!this.dragTab) return;
            e.preventDefault();
            e.stopPropagation();
          });
          el.addEventListener('drop', (e) => {
            if (!this.dragTab || this.dragTab === t) return;
            e.preventDefault();
            e.stopPropagation();
            this.tabs.splice(this.tabs.indexOf(this.dragTab), 1);
            this.tabs.splice(this.tabs.indexOf(t) + (e.offsetX > el.offsetWidth / 2 ? 1 : 0), 0, this.dragTab);
            this.dragTab = null;
            this.renderTabs();
          });
          el.addEventListener('dragend', () => (this.dragTab = null));
          return el;
        }),
      );
      this.tabStrip.querySelector('.ex-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      this.saveBtn.disabled = !this.isDirty(this.active);
    }

    async closeTab(tab = this.active) {
      if (!tab) return false;
      if (this.isDirty(tab)) {
        this.activate(tab);
        const r = await ask({
          buttons: ['Save', 'Cancel', 'Don’t Save'],
          defaultId: 0,
          cancelId: 1,
          message: `Do you want to save the changes you made to ${baseName(tab.path)}?`,
          detail: 'Your changes will be lost if you don’t save them.',
        });
        if (r === 1) return true;
        if (r === 0 && !(await this.save(tab))) return true;
      }
      const i = this.tabs.indexOf(tab);
      if (i < 0) return true;
      this.tabs.splice(i, 1);
      this.disposeTab(tab);
      if (this.active === tab) this.activate(this.tabs[i] || this.tabs[i - 1] || null);
      else this.renderTabs();
      this.reportDirty();
      if (this.visible) this.focus();
      return true;
    }

    disposeTab(tab) {
      if (this.editor?.getModel() === tab.model) this.editor.setModel(null);
      tab.model?.dispose();
      tab.model = null;
    }

    // Called on ⌘W: closes the active tab; false when there's none (so the window can close).
    closeActive() {
      if (askOpen) return true; // a save prompt is already up
      if (!this.visible || !this.active) return false;
      this.closeTab(this.active);
      return true;
    }

    cycleTab(dir) {
      if (this.tabs.length < 2) return;
      const i = this.tabs.indexOf(this.active);
      this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length]);
      this.focus();
    }

    async save(tab = this.active) {
      if (!tab || tab.kind !== 'text' || !tab.model) return false;
      const text = tab.model.getValue();
      const alt = tab.model.getAlternativeVersionId();
      const wasDeleted = tab.deleted;
      try {
        let res = await deck.writeFile(this.wsId, tab.path, text, tab.mtime);
        if (res?.conflict) {
          const r = await ask({
            buttons: ['Overwrite', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            message: `${baseName(tab.path)} changed on disk since you opened it.`,
            detail: 'Overwrite it with your version? The other changes will be lost.',
          });
          if (r !== 0) return false;
          res = await deck.writeFile(this.wsId, tab.path, text, null);
        }
        Object.assign(tab, { mtime: res.mtime, size: res.size, savedAlt: alt, deleted: false, preview: false });
        tab.wasDirty = this.isDirty(tab);
      } catch (e) {
        await ask({ buttons: ['OK'], message: `Could not save ${baseName(tab.path)}`, detail: ipcError(e) });
        return false;
      }
      this.renderTabs();
      this.reportDirty();
      if (wasDeleted) this.refresh();
      else this.refreshStatus();
      return true;
    }

    async saveAll() {
      for (const t of this.dirtyTabs()) await this.save(t);
    }

    toggleWrap() {
      prefs.wrap = !prefs.wrap;
      savePrefs();
      this.editor?.updateOptions({ wordWrap: prefs.wrap ? 'on' : 'off' });
      this.syncToggles();
    }

    // ----- viewer -----
    async ensureEditor() {
      if (this.editor) return this.editor;
      const m = await loadMonaco();
      if (this.editor) return this.editor;
      const cs = getComputedStyle(document.documentElement);
      this.editor = m.editor.create(this.editorHost, {
        model: null,
        theme: 'max',
        automaticLayout: true,
        fontFamily: cs.getPropertyValue('--mono').trim(),
        fontSize: parseFloat(cs.getPropertyValue('--mono-size')) || 13,
        minimap: { enabled: prefs.minimap },
        wordWrap: prefs.wrap ? 'on' : 'off',
        scrollBeyondLastLine: true,
        smoothScrolling: true,
        renderWhitespace: 'selection',
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: 'active', indentation: true },
        stickyScroll: { enabled: true },
        fixedOverflowWidgets: true,
        padding: { top: 6 },
        mouseWheelZoom: false,
        dragAndDrop: true,
        linkedEditing: true,
      });
      this.editor.addAction({
        id: 'max.toggleWrap',
        label: 'View: Toggle Word Wrap',
        keybindings: [m.KeyMod.Alt | m.KeyCode.KeyZ],
        run: () => this.toggleWrap(),
      });
      this.editor.onDidChangeCursorPosition((e) => {
        this.cursorPos.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
      });
      return this.editor;
    }

    async showActive() {
      const tab = this.active;
      this.syncToggles();
      if (!tab) {
        this.crumbs.replaceChildren();
        this.mdSeg.classList.add('hidden');
        this.cursorPos.textContent = '';
        this.editorHost.classList.add('hidden');
        this.showEmpty('No file open', 'Pick a file in the tree.');
        return;
      }
      this.crumbs.replaceChildren(...crumbs(tab.path));
      const md = isMarkdown(tab.path) && tab.kind === 'text';
      this.mdSeg.classList.toggle('hidden', !md);
      const useEditor = tab.kind === 'text' && !(md && tab.mdMode === 'preview');
      this.cursorPos.classList.toggle('hidden', !useEditor);
      if (useEditor) {
        const ed = await this.ensureEditor();
        if (this.active !== tab || !tab.model) return;
        this.body.classList.add('hidden');
        this.editorHost.classList.remove('hidden');
        if (ed.getModel() !== tab.model) {
          ed.setModel(tab.model);
          if (tab.viewState) ed.restoreViewState(tab.viewState);
        }
        const p = ed.getPosition();
        if (p) this.cursorPos.textContent = `Ln ${p.lineNumber}, Col ${p.column}`;
        return;
      }
      if (this.editorVisible() && this.editor.getModel()) {
        const owner = this.tabs.find((t) => t.model === this.editor.getModel());
        if (owner) owner.viewState = this.editor.saveViewState();
      }
      this.editorHost.classList.add('hidden');
      this.body.classList.remove('hidden');
      if (tab.kind === 'loading') this.body.innerHTML = '<div class="rv-empty">Loading…</div>';
      else if (tab.kind === 'info') this.showEmpty(...tab.info);
      else if (tab.kind === 'image') {
        this.body.className = 'ex-body hl';
        this.body.replaceChildren(
          node('div', 'ex-image', Object.assign(document.createElement('img'), { src: tab.image, alt: baseName(tab.path) })),
          node('div', 'ex-image-meta', tab.size != null ? fmtSize(tab.size) : ''),
        );
      } else if (md) {
        this.renderMarkdown(tab.model.getValue(), tab.path);
        this.body.scrollTop = 0;
      }
    }

    showEmpty(title, detail) {
      this.body.className = 'ex-body hl';
      this.body.classList.remove('hidden');
      this.body.innerHTML = `<div class="rv-empty"><strong>${esc(title)}</strong><br>${esc(detail || '')}</div>`;
    }

    renderMarkdown(text, path) {
      const html = DOMPurify.sanitize(marked.parse(text), { USE_PROFILES: { html: true } });
      const doc = node('article', 'md-body');
      doc.innerHTML = html;
      const slug = slugger();
      doc.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((hEl) => (hEl.id = slug(hEl.textContent)));
      doc.querySelectorAll('pre code').forEach((code) => {
        const lang = /language-([\w+-]+)/.exec(code.className)?.[1];
        if (lang && hljs.getLanguage(lang)) {
          try {
            code.innerHTML = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value;
          } catch {
            /* leave plain */
          }
        }
      });
      // Repo-relative images are read through the main process (the page can't load file:// paths).
      doc.querySelectorAll('img[src]').forEach((img) => {
        const src = img.getAttribute('src');
        if (/^(https?:|data:)/i.test(src)) return;
        const rel = resolveRel(path, src);
        img.removeAttribute('src');
        if (!rel) return;
        deck
          .readFile(this.wsId, rel)
          .then((r) => r?.image && (img.src = r.image))
          .catch(() => {});
      });
      this.body.className = 'ex-body hl ex-md';
      this.body.replaceChildren(doc);
    }

    onBodyClick(e) {
      const a = e.target.closest('.md-body a[href]');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href');
      if (href.startsWith('#')) {
        this.scrollToAnchor(href.slice(1));
      } else if (/^https?:/i.test(href)) {
        deck.openExternal(href);
      } else if (!/^[a-z][\w+.-]*:/i.test(href) && this.selected) {
        const rel = resolveRel(this.selected, href);
        const hash = href.includes('#') ? href.slice(href.indexOf('#') + 1) : '';
        if (rel) this.reveal(rel, { pin: true }).then(() => hash && this.scrollToAnchor(hash));
      }
    }
    scrollToAnchor(id) {
      const target = this.body.querySelector(`[id="${CSS.escape(decodeURIComponent(id))}"]`);
      target?.scrollIntoView({ block: 'start' });
    }

    // ----- keys -----
    onKey(e) {
      const k = e.key.toLowerCase();
      if (e.metaKey && !e.ctrlKey && k === 's') {
        e.preventDefault();
        e.stopPropagation();
        if (e.altKey) this.saveAll();
        else this.save();
        return;
      }
      if (e.metaKey && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        e.stopPropagation();
        this.cycleTab(e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (e.target.closest('.monaco-editor, input, textarea')) return; // the editor owns its keys (Esc included)
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hooks.onClose();
        return;
      }
      if (e.target !== this.tree || e.metaKey) return;
      const rows = this.visibleRows();
      if (!rows.length) return;
      let i = rows.findIndex((r) => r.dataset.path === this.cursor);
      const row = rows[i];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        i = Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)));
        const next = rows[i];
        this.moveCursor(next.dataset.path);
        if (!next.dataset.dir) this.openFile(next.dataset.path); // preview as you move, like VS Code
      } else if (e.key === 'ArrowRight' && row?.dataset.dir) {
        e.preventDefault();
        this.toggleDir(row.dataset.path, true);
      } else if (e.key === 'ArrowLeft' && row) {
        e.preventDefault();
        if (row.dataset.dir && this.expanded.has(row.dataset.path)) this.toggleDir(row.dataset.path, false);
        else if (row.dataset.path.includes('/')) {
          const parent = row.dataset.path.slice(0, row.dataset.path.lastIndexOf('/'));
          this.moveCursor(parent);
        }
      } else if (e.key === 'Enter' && row) {
        e.preventDefault();
        if (row.dataset.dir) this.toggleDir(row.dataset.path);
        else this.openFile(row.dataset.path, { pin: true, focus: true });
      }
    }
  }

  window.Explorer = Explorer;
})();
