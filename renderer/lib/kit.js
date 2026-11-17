/* global deck */
// Helpers shared by every renderer script: DOM building, icons, localStorage, small utilities.
'use strict';

(function () {
  // ---------- DOM ----------
  const $ = (sel, el = document) => el.querySelector(sel);

  // h('div', { class: 'x', onclick: fn, title: 't' }, ...children) — attributes and listeners.
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) el.append(c);
    return el;
  }
  // node('div', 'cls', ...children) — the short form, for elements that only need a class.
  function node(tag, cls, ...children) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    for (const c of children.flat()) if (c != null) el.append(c);
    return el;
  }
  // A button whose content is an HTML string (usually ph(...), or a plain label).
  function btn(cls, title, html, onclick) {
    const b = node('button', cls);
    b.title = title;
    b.innerHTML = html;
    b.addEventListener('click', onclick);
    return b;
  }
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // Phosphor icons (regular weight): https://phosphoricons.com
  // icon() is an element; ph() is the same thing as an HTML string, for btn() and innerHTML.
  const icon = (name) => h('i', { class: `ph ph-${name}`, 'aria-hidden': 'true' });
  const ph = (name) => `<i class="ph ph-${name}" aria-hidden="true"></i>`;

  // A segmented control. options: [[key, label], …]; onPick(key) runs on a click.
  // Returns { el, btns: { key: button } }; the caller marks the chosen one with the `on` class.
  function segmented(options, onPick, cls = 'rv-seg') {
    const el = node('div', cls);
    const btns = {};
    for (const [key, label] of options) {
      btns[key] = btn('', '', label, () => onPick(key));
      el.append(btns[key]);
    }
    return { el, btns };
  }

  // "a/b/c.js" → a › b › c.js, for the path bar above a file.
  function crumbs(path) {
    const parts = path.split('/');
    return parts.flatMap((p, i) => (i === parts.length - 1 ? [node('span', 'rv-crumb-last', p)] : [node('span', '', p), node('span', 'rv-crumb-sep', '›')]));
  }

  // Follow the mouse from a mousedown until the button is released.
  function trackDrag(onMove, onEnd) {
    const up = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', up);
      onEnd?.();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', up);
  }

  // ---------- localStorage (it can be unavailable; nothing here ever throws) ----------
  const store = {
    get(k, fallback = '') {
      try {
        return localStorage.getItem(k) ?? fallback;
      } catch {
        return fallback;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* not saved */
      }
    },
    remove(k) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* nothing to remove */
      }
    },
    json(k, fallback = null) {
      try {
        return JSON.parse(localStorage.getItem(k) ?? 'null') ?? fallback;
      } catch {
        return fallback;
      }
    },
    setJson(k, v) {
      store.set(k, JSON.stringify(v));
    },
  };
  // Saved preferences over defaults: [prefs, save].
  function loadPrefs(key, defaults) {
    const prefs = { ...defaults, ...store.json(key, {}) };
    return [prefs, () => store.setJson(key, prefs)];
  }

  // A side panel (file list, tree) resized by dragging the sash next to it; the width is prefs.sideW.
  function sidePanelSash(sash, side, prefs, savePrefs) {
    side.style.width = `${prefs.sideW}px`;
    sash.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = side.offsetWidth;
      sash.classList.add('dragging');
      trackDrag(
        (ev) => {
          prefs.sideW = Math.min(600, Math.max(180, startW + ev.clientX - startX));
          side.style.width = `${prefs.sideW}px`;
        },
        () => {
          sash.classList.remove('dragging');
          savePrefs();
        },
      );
    });
  }

  // ---------- small utilities ----------
  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The message of an error thrown by a deck.* call, without Electron's "Error invoking remote method" prefix.
  const ipcError = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
  const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const isMarkdown = (p) => /\.(md|markdown|mdown|mkd|mdx)$/i.test(p);
  const uid = () => Math.random().toString(36).slice(2, 10);

  // Git status letters, as shown in Review and the Files tree.
  const GIT_STATUS = {
    M: { label: 'Modified', cls: 's-mod' },
    A: { label: 'Added', cls: 's-add' },
    U: { label: 'Untracked', cls: 's-add' },
    D: { label: 'Deleted', cls: 's-del' },
    R: { label: 'Renamed', cls: 's-ren' },
    C: { label: 'Copied', cls: 's-ren' },
    T: { label: 'Type changed', cls: 's-mod' },
  };
  // Which status a folder shows when its files differ: the highest rank.
  const GIT_STATUS_RANK = { D: 3, M: 2, T: 2, R: 2, C: 2, A: 1, U: 1 };

  // ---------- Material Icon Theme ----------
  // File and folder icons resolved the way VS Code does:
  // exact file name → longest matching extension → language id → default file icon.
  const MAT_ICON_DIR = '../node_modules/material-icon-theme/icons/';
  const matIconSrc = (name) => `${MAT_ICON_DIR}${name}.svg`;
  const LANG_ID_BY_EXT = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact', ts: 'typescript', mts: 'typescript', cts: 'typescript',
    tsx: 'typescriptreact', json: 'json', jsonc: 'jsonc', md: 'markdown', css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html',
    yml: 'yaml', yaml: 'yaml', sh: 'shellscript', zsh: 'shellscript', bash: 'shellscript', swift: 'swift', kt: 'kotlin', kts: 'kotlin',
    java: 'java', py: 'python', rb: 'ruby', xml: 'xml', plist: 'xml', m: 'objective-c', mm: 'objective-cpp', h: 'c', c: 'c', cpp: 'cpp',
    gradle: 'groovy', groovy: 'groovy', sql: 'sql', graphql: 'graphql', gql: 'graphql', go: 'go', rs: 'rust', php: 'php', dart: 'dart',
  };
  let ICONS = null; // the theme's manifest, from the main process
  const iconsReady = deck
    .getIcons()
    .then((m) => (ICONS = m))
    .catch(() => null);

  function iconImg(id, cls) {
    const img = document.createElement('img');
    img.className = cls;
    img.alt = '';
    img.draggable = false;
    img.src = MAT_ICON_DIR + (ICONS?.defs[id] || 'file.svg');
    return img;
  }
  function fileIconId(name) {
    if (!ICONS) return 'file';
    const lower = name.toLowerCase();
    if (ICONS.fileNames[lower]) return ICONS.fileNames[lower];
    const parts = lower.split('.');
    for (let i = 1; i < parts.length; i++) {
      const ext = parts.slice(i).join('.');
      if (ICONS.fileExtensions[ext]) return ICONS.fileExtensions[ext];
    }
    const lang = LANG_ID_BY_EXT[parts[parts.length - 1]];
    if (lang && ICONS.languageIds[lang]) return ICONS.languageIds[lang];
    return ICONS.file;
  }
  const fileIcon = (name) => iconImg(fileIconId(name), 'fi');
  function folderIcon(name, open) {
    const lower = name.toLowerCase();
    const id = ICONS && (open ? ICONS.folderNamesExpanded[lower] || ICONS.folderExpanded : ICONS.folderNames[lower] || ICONS.folder);
    return iconImg(id || 'folder', 'rv-folder');
  }

  window.Kit = {
    $, h, node, btn, esc, icon, ph, segmented, crumbs, trackDrag, sidePanelSash,
    store, loadPrefs,
    escapeRe, ipcError, baseName, dirName, isMarkdown, uid,
    GIT_STATUS, GIT_STATUS_RANK,
    matIconSrc, fileIcon, folderIcon, iconsReady,
  };
})();
