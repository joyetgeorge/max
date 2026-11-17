// Turns the app theme (main/app-theme.js, sent by the main process) into CSS variables and xterm options.
'use strict';

(function () {
  const rgb = (h) => {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const toHex = (c) => `#${c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
  const mix = (a, b, t) => toHex(rgb(a).map((x, i) => x + (rgb(b)[i] - x) * t));
  const alpha = (h, a) => `rgba(${rgb(h).join(', ')}, ${a})`;

  let current = null;

  function fontStack(k) {
    const fams = [k.fontFamily, k.symbolFont, 'Symbols Nerd Font Mono', 'SF Mono', 'ui-monospace', 'Menlo'].filter(Boolean);
    return `${[...new Set(fams)].map((f) => (/^[\w-]+$/.test(f) && f !== 'Menlo' ? f : `"${f}"`)).join(', ')}, monospace`;
  }

  function cssVars(k) {
    const bg = k.background;
    const fg = k.foreground;
    const a = k.ansi;
    const op = k.opacity;
    const [pt, pr, pb, pl] = k.padding;
    return {
      // Surfaces: each region paints one translucent layer so the blur shows through.
      '--bg': alpha(bg, op),
      '--bg-2': alpha(mix(bg, '#000000', 0.22), op),
      '--bg-solid': bg,
      '--bg-solid-2': mix(bg, fg, 0.05),
      // Overlays stack on top of a surface without adding opacity drift.
      '--bg-3': alpha(fg, 0.09),
      '--bg-hover': alpha(fg, 0.06),
      '--overlay-dark': 'rgba(0, 0, 0, 0.18)',
      '--border': k.inactiveBorder,
      '--border-soft': alpha(fg, 0.14),
      '--text': fg,
      '--text-strong': a[15],
      '--dim': mix(fg, bg, 0.36),
      '--faint': mix(fg, bg, 0.56),
      '--accent': k.activeBorder,
      '--accent-strong': k.activeBorder,
      '--accent-text': k.cursorText,
      '--selection': k.selectionBackground,
      '--running': a[4],
      '--waiting': a[3],
      '--done': a[2],
      '--exited': mix(fg, bg, 0.56),
      // Subagent bots in the sidebar
      '--bot-0': a[5],
      '--bot-1': a[6],
      '--bot-2': a[11],
      '--bot-3': a[13],
      '--bot-4': a[12],
      '--bot-5': a[14],
      '--add': a[2],
      '--del': a[1],
      '--link': k.urlColor,
      // Type
      '--mono': fontStack(k),
      '--mono-size': `${k.fontSize}px`,
      '--mono-lh': String(+(1.22 * k.cellHeight).toFixed(3)),
      '--term-pad': `${pt}px ${pr}px ${pb}px ${pl}px`,
      '--inactive-alpha': String(k.inactiveTextAlpha),
      // Diff + review
      '--rv-ln': mix(fg, bg, 0.62),
      '--rv-ln-active': fg,
      '--rv-add-line': alpha(a[2], 0.14),
      '--rv-del-line': alpha(a[1], 0.16),
      '--rv-add-word': alpha(a[2], 0.38),
      '--rv-del-word': alpha(a[1], 0.4),
      '--rv-add-gutter': alpha(a[2], 0.24),
      '--rv-del-gutter': alpha(a[1], 0.26),
      '--rv-fold': alpha(a[4], 0.1),
      '--rv-fold-hover': alpha(a[4], 0.18),
      '--s-mod': a[3],
      '--s-add': a[2],
      '--s-del': a[1],
      '--s-ren': a[4],
      // Syntax, from the ANSI palette
      '--syn-keyword': a[5],
      '--syn-func': a[4],
      '--syn-type': a[11],
      '--syn-string': a[2],
      '--syn-number': a[3],
      '--syn-prop': a[1],
      '--syn-param': a[13],
      '--syn-op': a[6],
      '--syn-meta': a[12],
      '--syn-comment': mix(fg, bg, 0.5),
      '--syn-punct': mix(fg, bg, 0.15),
      '--syn-builtin': a[14],
    };
  }

  function termOptions(k) {
    const a = k.ansi;
    return {
      fontFamily: fontStack(k),
      fontSize: k.fontSize,
      lineHeight: k.cellHeight,
      cursorStyle: k.cursorShape,
      cursorBlink: k.cursorBlink,
      scrollback: k.scrollback,
      macOptionIsMeta: k.optionAsAlt,
      theme: {
        // Transparent so the translucent pane (and the blur behind it) shows through.
        background: k.opacity < 1 ? 'rgba(0, 0, 0, 0)' : k.background,
        foreground: k.foreground,
        cursor: k.cursor,
        cursorAccent: k.cursorText,
        selectionBackground: k.selectionBackground,
        ...(k.selectionForeground ? { selectionForeground: k.selectionForeground } : {}),
        black: a[0],
        red: a[1],
        green: a[2],
        yellow: a[3],
        blue: a[4],
        magenta: a[5],
        cyan: a[6],
        white: a[7],
        brightBlack: a[8],
        brightRed: a[9],
        brightGreen: a[10],
        brightYellow: a[11],
        brightBlue: a[12],
        brightMagenta: a[13],
        brightCyan: a[14],
        brightWhite: a[15],
      },
    };
  }

  function apply(k) {
    current = k;
    const root = document.documentElement;
    for (const [name, value] of Object.entries(cssVars(k))) root.style.setProperty(name, value);
    root.classList.toggle('translucent', k.opacity < 1);
  }

  window.AppTheme = {
    apply,
    termOptions: () => (current ? termOptions(current) : {}),
    get current() {
      return current;
    },
  };
})();
