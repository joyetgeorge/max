/* global deck, Terminal, FitAddon, WebLinksAddon, Unicode11Addon, WebglAddon */
'use strict';

// Terminals: xterm.js instances wired to the PTYs in the main process.
function createTerm(wsId, kind, host) {
  const key = `${wsId}:${kind}`;
  // Font, size, cursor, palette and scrollback all come from the app theme (main/app-theme.js, via lib/theme.js).
  const term = new Terminal({
    allowProposedApi: true,
    allowTransparency: true,
    // Draw box-drawing/block glyphs (e.g. the Claude logo) as pixel-perfect cell
    // fills, instead of font glyphs that leave seams between cells.
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    // 1:1 with pixel deltas, like the rest of the UI; Alt+wheel scrolls faster.
    scrollSensitivity: 1,
    fastScrollSensitivity: 5,
    smoothScrollDuration: 0,
    ...window.AppTheme.termOptions(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(
    new WebLinksAddon.WebLinksAddon((_e, uri) => deck.openExternal(uri)),
  );
  term.attachCustomKeyEventHandler((e) => {
    if (e.key === 'Enter' && e.shiftKey && !e.metaKey) {
      // Newline in Claude Code's prompt (Esc+Return, i.e. Meta+Enter). Swallow keydown,
      // keypress AND keyup: if keypress reaches xterm it sends a plain \r, which submits.
      if (e.type === 'keydown') deck.write(key, '\x1b\r');
      return false;
    }
    // macOS text navigation, as readline keys both zsh and Claude Code understand.
    const nav = e.type === 'keydown' && !e.shiftKey && !e.ctrlKey && macNavKey(e);
    if (nav) {
      deck.write(key, nav);
      return false;
    }
    return !(e.metaKey && isAppShortcut(e));
  });
  term.open(host);
  installWheelScaling(term);
  installFileDrop(term, host, key);
  term.onData((d) => deck.write(key, d));
  if (kind === 'claude') term.onTitleChange((t) => onClaudeTitle(wsId, t));
  // Dragging a divider resizes on every frame; each PTY resize makes the TUI redraw
  // everything, so only tell the PTY once the size settles.
  let resizeTimer = null;
  term.onResize(({ cols, rows }) => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => deck.resize(key, cols, rows), 60);
  });

  const entry = { term, fit, host, wsId, kind, started: false, webgl: null, fitQueued: false };
  terms.set(key, entry);
  attachWebgl(entry);
  new ResizeObserver(() => queueFit(entry)).observe(host);
  return entry;
}

// Chromium allows ~16 live WebGL contexts per page; past that it silently kills the
// oldest. Keep WebGL on the most recently shown terminals and let the rest use the
// DOM renderer while hidden; they get WebGL back when shown again.
const MAX_WEBGL = 8;
const webglLru = []; // entries, most recently shown last
function attachWebgl(entry) {
  const at = webglLru.indexOf(entry);
  if (at >= 0) webglLru.splice(at, 1);
  webglLru.push(entry);
  if (!entry.webgl) {
    // customGlyphs only takes effect with the WebGL renderer; fall back to DOM if unavailable.
    try {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (entry.webgl === webgl) entry.webgl = null;
      });
      entry.term.loadAddon(webgl);
      patchWebglDefaultBg(webgl);
      entry.webgl = webgl;
    } catch {
      /* WebGL unavailable — DOM renderer */
    }
  }
  while (webglLru.length > MAX_WEBGL) {
    const old = webglLru.shift();
    old.webgl?.dispose();
    old.webgl = null;
  }
}
function releaseWebgl(entry) {
  const at = webglLru.indexOf(entry);
  if (at >= 0) webglLru.splice(at, 1);
  entry.webgl?.dispose();
  entry.webgl = null;
}

// Coalesce ResizeObserver bursts into one fit per frame.
function queueFit(entry) {
  if (entry.fitQueued) return;
  entry.fitQueued = true;
  requestAnimationFrame(() => {
    entry.fitQueued = false;
    fitTerm(entry);
  });
}

// ⌘←/→ line start/end, ⌘⌫ delete to line start, ⌥←/→ word back/forward.
// (xterm sends nothing for ⌘+arrow, and ⌥+arrow as CSI 1;3D, which shells ignore.)
function macNavKey(e) {
  if (e.metaKey && !e.altKey) return { ArrowLeft: '\x01', ArrowRight: '\x05', Backspace: '\x15' }[e.key];
  if (e.altKey && !e.metaKey) return { ArrowLeft: '\x1bb', ArrowRight: '\x1bf' }[e.key];
  return undefined;
}

// xterm WebGL bug: dim/italic cells carry flags in their bg value, so the
// rectangle pass treats them as "has background" and paints the theme background
// with alpha forced to 1. With our transparent theme bg that's a black box behind
// dim text (e.g. the status line). Keep default-bg rectangles at the theme's alpha.
let webglBgPatched = false;
function patchWebglDefaultBg(webgl) {
  if (webglBgPatched) return;
  const proto = webgl._renderer?._rectangleRenderer?.value?.constructor?.prototype;
  if (!proto || typeof proto._updateRectangle !== 'function') return;
  const orig = proto._updateRectangle;
  const CM_MASK = 0x3000000;
  const INVERSE = 0x4000000;
  proto._updateRectangle = function (vertices, offset, fg, bg, ...rest) {
    orig.call(this, vertices, offset, fg, bg, ...rest);
    if (!(fg & INVERSE) && (bg & CM_MASK) === 0) {
      vertices.attributes[offset + 7] = (this._themeService.colors.background.rgba & 0xff) / 255;
    }
  };
  webglBgPatched = true;
}

// When an app owns the mouse (Claude Code's fullscreen UI) or the alt screen is
// active, xterm.js emits at most ONE wheel report per wheel event and damps small
// trackpad deltas to 30%, so scrolling crawls. Convert pixel deltas to lines at
// native-UI speed (one line per cell height) and replay one synthetic event per
// line so xterm still does the protocol encoding.
const WHEEL_LINES_PER_CELL = 2; // raise for faster TUI scrolling
function installWheelScaling(term) {
  const synthetic = new WeakSet();
  let acc = 0;
  term.attachCustomWheelEventHandler((e) => {
    if (synthetic.has(e) || e.shiftKey || !e.deltaY) return true;
    const appScroll = term.modes.mouseTrackingMode !== 'none' || term.buffer.active.type === 'alternate';
    if (!appScroll) return true; // normal scrollback: xterm's native pixel scrolling

    const screen = term.element?.querySelector('.xterm-screen');
    const cellH = screen && term.rows ? screen.clientHeight / term.rows : 16;
    let lines =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY
      : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? e.deltaY * term.rows
      : (e.deltaY / cellH) * WHEEL_LINES_PER_CELL;
    if (e.altKey) lines *= term.options.fastScrollSensitivity || 5;
    if (Math.sign(lines) !== Math.sign(acc)) acc = 0; // direction change
    acc += lines;
    const n = Math.min(Math.trunc(Math.abs(acc)), term.rows);
    acc -= Math.sign(acc) * n;

    const opts = {
      deltaY: Math.sign(e.deltaY) * 1000, // large enough that xterm emits exactly one report
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      clientX: e.clientX,
      clientY: e.clientY,
      bubbles: true,
      cancelable: true,
    };
    for (let i = 0; i < n; i++) {
      const ev = new WheelEvent('wheel', opts);
      synthetic.add(ev);
      term.element.dispatchEvent(ev);
    }
    e.preventDefault();
    e.stopPropagation();
    return false;
  });
}

// Drag files/folders from Finder onto a terminal → their shell-escaped paths are typed at the
// cursor (like Terminal and iTerm). Claude Code picks up dropped image paths as attachments.
const SAFE_PATH = /^[A-Za-z0-9_./~@%+=:,-]+$/;
const shellEscape = (p) => (SAFE_PATH.test(p) ? p : p.replace(/[^A-Za-z0-9_./~@%+=:,-]/g, '\\$&'));
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
function installFileDrop(term, host, key) {
  const over = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    host.classList.add('drop-target');
  };
  host.addEventListener('dragenter', over);
  host.addEventListener('dragover', over);
  host.addEventListener('dragleave', (e) => {
    if (!host.contains(e.relatedTarget)) host.classList.remove('drop-target');
  });
  host.addEventListener('drop', (e) => {
    host.classList.remove('drop-target');
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const paths = [...e.dataTransfer.files].map((f) => deck.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    deck.write(key, `${paths.map(shellEscape).join(' ')} `);
    term.focus();
  });
}
// Files dropped anywhere else must not make the window navigate to them.
for (const ev of ['dragover', 'drop']) window.addEventListener(ev, (e) => hasFiles(e) && e.preventDefault());

function fitTerm(entry) {
  if (!entry || entry.host.offsetParent === null) return;
  try {
    entry.fit.fit();
  } catch {
    /* host not laid out yet */
  }
}

async function ensureStarted(entry) {
  if (entry.started) return;
  entry.started = true;
  fitTerm(entry);
  const res = await deck.startTerm(entry.wsId, entry.kind, entry.term.cols, entry.term.rows);
  if (res.alive) {
    // Re-attached after a renderer reload: nudge the TUI to redraw.
    deck.resize(res.key, entry.term.cols - 1, entry.term.rows);
    setTimeout(() => deck.resize(res.key, entry.term.cols, entry.term.rows), 50);
  }
}

deck.onTermData((key, data) => terms.get(key)?.term.write(data));
deck.onTermExit((key, code) => {
  const t = terms.get(key);
  if (t) t.term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`);
});
