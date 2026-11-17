'use strict';

// ---------- tooltips with shortcuts ----------
// Replaces native title tooltips app-wide. A trailing "(⌘⇧D)"-style hint in a title, or a
// data-shortcut attribute, is rendered as key caps — so every option shows its shortcut.
const Tooltip = (() => {
  const SHORTCUT_RE = /\s*\(((?:[⌘⇧⌥⌃]|esc\b)[^)]*)\)\s*$/i;
  let tip = null;
  let timer = null;
  let current = null;

  // "⌘⇧D" → ⌘ ⇧ D, "⌘1–9" → ⌘ 1–9, "Esc" → esc
  function keys(sc) {
    const out = [];
    let rest = '';
    for (const ch of sc.trim()) {
      if ('⌘⇧⌥⌃'.includes(ch)) {
        if (rest.trim()) out.push(rest.trim());
        rest = '';
        out.push(ch);
      } else rest += ch;
    }
    if (rest.trim()) out.push(/^esc$/i.test(rest.trim()) ? 'esc' : rest.trim());
    return out;
  }

  // Pull the title off the element so the native tooltip never shows.
  function adopt(el) {
    if (el.hasAttribute('title')) {
      el.dataset.tip = el.getAttribute('title');
      el.removeAttribute('title');
    }
  }

  function show(el) {
    const raw = el.dataset.tip || '';
    let text = raw;
    let sc = el.dataset.shortcut || '';
    const m = SHORTCUT_RE.exec(raw);
    if (m) {
      text = raw.slice(0, m.index);
      sc = sc || m[1];
    }
    if (!text && !sc) return;
    if (!tip) {
      tip = h('div', { class: 'tooltip', role: 'tooltip' });
      document.body.append(tip);
    }
    tip.replaceChildren(
      text ? h('span', { class: 'tooltip-text' }, text) : '',
      sc ? h('span', { class: 'tooltip-keys' }, keys(sc).map((k) => h('kbd', {}, k))) : '',
    );
    tip.classList.add('visible');
    // Below the element, or above if there's no room; clamped to the window.
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    let top = r.bottom + 6;
    if (top + t.height > innerHeight - 6) top = r.top - t.height - 6;
    const left = Math.min(Math.max(6, r.left + r.width / 2 - t.width / 2), innerWidth - t.width - 6);
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }
  function hide() {
    clearTimeout(timer);
    current = null;
    tip?.classList.remove('visible');
  }

  document.addEventListener(
    'mouseover',
    (e) => {
      const el = e.target.closest?.('[title], [data-tip], [data-shortcut]');
      if (el === current) return;
      hide();
      if (!el) return;
      adopt(el);
      current = el;
      timer = setTimeout(() => current === el && el.isConnected && show(el), 450);
    },
    true,
  );
  document.addEventListener('mouseout', (e) => current && !current.contains(e.relatedTarget) && hide(), true);
  for (const ev of ['mousedown', 'keydown', 'wheel', 'blur']) window.addEventListener(ev, hide, true);
  return { hide };
})();
