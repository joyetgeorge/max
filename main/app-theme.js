// The app's theme: one constant object, used by the main process (window background,
// translucency, blur, light/dark) and sent to the renderer, where renderer/lib/theme.js turns it
// into CSS variables, terminal options and the editor theme. Edit the values here to restyle Max.
module.exports = Object.freeze({
  // Terminal and code font (falls back through renderer/lib/theme.js's font stack if not installed)
  fontFamily: 'FiraCode Nerd Font Mono',
  symbolFont: 'JetBrainsMono Nerd Font', // glyph fallback for icons in prompts
  fontSize: 14.05,
  cellHeight: 1.15, // line height, as a multiple of the font's

  background: '#121f1d',
  foreground: '#dde5e0',
  selectionBackground: '#4d4d4d',
  selectionForeground: '#ffffff',
  cursor: '#3ec195',
  cursorText: '#1b1f28',
  cursorShape: 'block', // block | underline | bar
  cursorBlink: false,
  // ANSI colours 0–15; also the source of the syntax, status and diff colours
  ansi: Object.freeze([
    '#333333', '#ab7d7d', '#83aa7c', '#c0b283', '#77beb4', '#c993b5', '#7ebdae', '#dde5e0',
    '#4a4a4a', '#9d6d6d', '#78b573', '#d0c191', '#6ba89f', '#8c9f87', '#88bdaa', '#ecf4ef',
  ]),

  opacity: 0.85, // below 1: translucent window over a native blur (changing 1 ↔ <1 needs a restart)
  blur: 80,
  scrollback: 20000,
  padding: Object.freeze([2, 9, 3, 9]), // terminal padding: top, right, bottom, left (px)
  inactiveTextAlpha: 0.5,
  activeBorder: '#3ec195', // the accent colour
  inactiveBorder: '#1c2926',
  urlColor: '#88bdaa',
  optionAsAlt: true, // ⌥ acts as Meta in terminals
});
