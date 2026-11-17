/* global deck */
'use strict';

// RN Console: console.log / info / warn / error and uncaught errors of a React Native debug
// build, over the same Metro debugger connection as the Network app (see LOGGER in main/rn-net.js).
// Objects arrive serialised and expand in place; identical consecutive messages collapse into
// one row with a count; an error (with its stack) can be sent to the active workspace's Claude.
(() => {
  const { node: el, icon: ph, store } = window.Kit;
  const { button, copy, sendToClaude } = window.DeckApps.ui;
  const MAX_ROWS = 5000;
  const LEVELS = [
    ['all', 'All'],
    ['error', 'Errors'],
    ['warn', 'Warnings'],
    ['info', 'Info'],
    ['log', 'Logs'],
    ['debug', 'Debug'],
  ];
  const LEVEL_ICON = { error: 'x-circle', warn: 'warning', info: 'info', log: null, debug: 'bug' };

  // ----- values (see `ser` in main/rn-net.js for the markers) -----
  const isMarker = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.__t === 'string';
  function plain(v) {
    // Text form, for search, copy and sending to Claude.
    if (typeof v === 'string') return v;
    if (isMarker(v)) {
      if (v.__t === 'undefined') return 'undefined';
      if (v.__t === 'fn') return `ƒ ${v.name || 'anonymous'}()`;
      if (v.__t === 'error') return v.stack && v.stack.includes(v.message) ? v.stack : `${v.name}: ${v.message}\n${v.stack || ''}`.trim();
      if (v.__t === 'date') return v.v;
      if (v.__t === 'num') return v.v;
      if (v.__t === 'circular') return '[Circular]';
      if (v.__t === 'more') return `[${v.kind}]`;
      if (v.__t === 'trunc') return `… ${v.n} more`;
    }
    try {
      return JSON.stringify(v, (k, x) => (isMarker(x) && x.__t !== 'error' ? plain(x) : x), 2);
    } catch {
      return String(v);
    }
  }
  // printf-style %s %d %i %f %o %O %j %c in a leading string argument.
  function applyFormat(args) {
    if (typeof args[0] !== 'string' || !/%[sdifoOjc%]/.test(args[0])) return args;
    const rest = args.slice(1);
    let i = 0;
    const s = args[0].replace(/%([sdifoOjc%])/g, (m, f) => {
      if (f === '%') return '%';
      if (i >= rest.length) return m;
      const v = rest[i++];
      if (f === 'c') return '';
      if (f === 'd' || f === 'i') return String(parseInt(plain(v), 10));
      if (f === 'f') return String(parseFloat(plain(v)));
      return typeof v === 'string' ? v : plain(v).replace(/\s*\n\s*/g, ' ');
    });
    return [s, ...rest.slice(i)];
  }
  const preview = (v, depth = 0) => {
    if (typeof v === 'string') return depth ? JSON.stringify(v) : v;
    if (v === null || typeof v !== 'object') return String(v);
    if (isMarker(v)) return v.__t === 'error' ? `${v.name}: ${v.message}` : plain(v);
    if (depth > 1) return Array.isArray(v) ? `Array(${v.length})` : '{…}';
    if (Array.isArray(v)) return `[${v.slice(0, 6).map((x) => preview(x, depth + 1)).join(', ')}${v.length > 6 ? ', …' : ''}]`;
    const keys = Object.keys(v);
    return `{${keys.slice(0, 5).map((k) => `${k}: ${preview(v[k], depth + 1)}`).join(', ')}${keys.length > 5 ? ', …' : ''}}`;
  };

  function valueEl(v, top = true) {
    if (typeof v === 'string') return el('span', top ? 'rc-str-top' : 'rc-str', top ? v : JSON.stringify(v));
    if (typeof v === 'number') return el('span', 'rc-num', String(v));
    if (typeof v === 'boolean' || v === null) return el('span', 'rc-kw', String(v));
    if (isMarker(v)) {
      if (v.__t === 'error') return errorEl(v);
      const cls = v.__t === 'undefined' ? 'rc-kw' : v.__t === 'num' ? 'rc-num' : v.__t === 'fn' ? 'rc-fn' : 'rc-faint';
      return el('span', cls, plain(v));
    }
    // Objects and arrays: a one-line preview that expands into a tree.
    const isArr = Array.isArray(v);
    const keys = Object.keys(v);
    const node = el('span', 'rc-obj');
    const toggle = el('span', 'rc-toggle', ph('caret-right'), el('span', 'rc-preview', preview(v)));
    let body = null;
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (body) {
        body.remove();
        body = null;
        node.classList.remove('open');
        return;
      }
      node.classList.add('open');
      body = el(
        'div',
        'rc-children',
        keys.map((k) => el('div', 'rc-prop', el('span', isArr ? 'rc-key idx' : 'rc-key', k), el('span', 'rc-colon', ': '), valueEl(v[k], false))),
      );
      node.append(body);
    });
    node.append(toggle);
    return node;
  }
  function errorEl(v) {
    const stack = String(v.stack || '');
    const lines = stack.split('\n').filter((l) => !l.includes(v.message) || !l.startsWith(v.name));
    return el('span', 'rc-error', el('span', 'rc-error-msg', `${v.name}: ${v.message}`), lines.length ? el('pre', 'rc-stack', lines.map((l) => l.trim()).filter(Boolean).join('\n')) : null);
  }

  function rnConsoleApp() {
    const rows = []; // { id, level, args, ts, count, stack, uncaught, fatal, key, text }
    let level = store.get('deck.app.rnconsole.level', 'all');
    let query = '';
    let paused = false;
    let preserve = store.get('deck.app.rnconsole.preserve', '1') === '1';

    // ----- toolbar -----
    const dot = el('span', 'nw-dot');
    const statusText = el('span', 'nw-status-text', 'Starting…');
    const reconnectBtn = button('Reconnect', 'plug', 'Take the connection back from React Native DevTools', () => deck.rnNetReconnect());
    reconnectBtn.classList.add('hidden');
    const search = el('input', 'nw-search');
    search.placeholder = 'Filter messages';
    search.spellcheck = false;
    search.addEventListener('input', () => {
      query = search.value.trim().toLowerCase();
      render();
    });
    search.addEventListener('keydown', (e) => e.stopPropagation());
    const seg = el('div', 'nw-seg');
    const segBtns = {};
    for (const [k, label] of LEVELS) {
      const b = el('button', `nw-seg-btn${k === level ? ' on' : ''}`, label, el('span', 'rc-badge'));
      b.addEventListener('click', () => {
        level = k;
        store.set('deck.app.rnconsole.level', k);
        for (const [kk, bb] of Object.entries(segBtns)) bb.classList.toggle('on', kk === k);
        render();
      });
      segBtns[k] = b;
      seg.append(b);
    }
    const preserveBtn = button('', 'clock-counter-clockwise', '', () => {
      preserve = !preserve;
      store.set('deck.app.rnconsole.preserve', preserve ? '1' : '0');
      syncPreserve();
    });
    const syncPreserve = () => {
      preserveBtn.classList.toggle('on', preserve);
      preserveBtn.title = preserve ? 'Keeping the log across app reloads (click to clear on reload)' : 'Clearing the log on app reload (click to keep it)';
    };
    syncPreserve();
    const reloadBtn = button('', 'arrow-clockwise', 'Reload the app', () => deck.rnNetReload());
    const pauseBtn = button('', 'pause', 'Pause', () => {
      paused = !paused;
      pauseBtn.replaceChildren(ph(paused ? 'record' : 'pause'));
      pauseBtn.title = paused ? 'Resume' : 'Pause';
      pauseBtn.classList.toggle('armed', paused);
    });
    const clearBtn = button('', 'prohibit', 'Clear (⌘K in the log)', () => clear());
    const bar = el('div', 'app-bar nw-bar', dot, statusText, reconnectBtn, el('span', 'app-spacer'), search, seg, preserveBtn, reloadBtn, pauseBtn, clearBtn);

    const list = el('div', 'rc-list');
    const empty = el('div', 'nw-empty');
    const box = el('div', 'rc-box', list, empty);
    const summary = el('div', 'app-status nw-summary');
    box.tabIndex = -1;
    box.addEventListener('keydown', (e) => {
      if (e.metaKey && e.key === 'k') {
        e.preventDefault();
        e.stopPropagation();
        clear();
      }
    });

    function clear() {
      rows.length = 0;
      render();
    }
    const visible = (r) => (r.level === 'reload' ? level === 'all' && !query : (level === 'all' || r.level === level) && (!query || r.text.toLowerCase().includes(query)));

    function rowEl(r) {
      if (r.level === 'reload') return el('div', 'rc-reload', el('span', '', `App reloaded · ${new Date(r.ts).toLocaleTimeString()}`));
      const args = applyFormat(r.args);
      const msg = el('div', 'rc-msg');
      args.forEach((a, i) => {
        if (i) msg.append(' ');
        msg.append(valueEl(a));
      });
      if (r.stack && r.level === 'error' && !args.some((a) => isMarker(a) && a.__t === 'error')) msg.append(el('pre', 'rc-stack', r.stack));
      const actions = el(
        'span',
        'rc-actions',
        button('', 'copy', 'Copy message', () => copy(r.text)),
        r.level === 'error' || r.level === 'warn' ? button('', 'paper-plane-tilt', 'Send to this workspace’s Claude', () => send(r)) : null,
      );
      const node = el(
        'div',
        `rc-row lv-${r.level}${r.uncaught ? ' uncaught' : ''}`,
        el('span', 'rc-icon', LEVEL_ICON[r.level] ? ph(LEVEL_ICON[r.level]) : null),
        r.count > 1 ? el('span', 'rc-count', String(r.count)) : null,
        msg,
        el('span', 'rc-time', new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
        actions,
      );
      node.dataset.id = r.id;
      return node;
    }
    function send(r) {
      const where = r.target ? ` in ${r.target.app}${r.target.device ? ` (${r.target.device})` : ''}` : '';
      const kind = r.uncaught ? (r.fatal ? 'A fatal uncaught error' : 'An uncaught error') : r.level === 'warn' ? 'This warning' : 'This error';
      const err = sendToClaude(`${kind} was logged${where}:\n\n\`\`\`\n${r.text}\n\`\`\`\n`);
      if (err) {
        summary.textContent = err;
        summary.classList.add('err');
        setTimeout(() => summary.classList.remove('err'), 3000);
      }
    }
    function render() {
      const shown = rows.filter(visible);
      list.replaceChildren(...shown.slice(-1500).map(rowEl));
      empty.classList.toggle('hidden', shown.length > 0);
      empty.textContent = rows.length ? 'No messages match the filter' : 'Waiting for console output… log something in the app';
      list.scrollTop = list.scrollHeight;
      renderCounts();
    }
    function renderCounts() {
      const n = { error: 0, warn: 0 };
      for (const r of rows) if (r.level in n) n[r.level] += r.count;
      segBtns.error.querySelector('.rc-badge').textContent = n.error ? String(n.error) : '';
      segBtns.warn.querySelector('.rc-badge').textContent = n.warn ? String(n.warn) : '';
      const total = rows.reduce((s, r) => s + (r.count || 0), 0);
      summary.classList.remove('err');
      summary.textContent = total ? `${total} message${total === 1 ? '' : 's'}` : '';
    }

    deck.onRnConsole((ev) => {
      if (ev.t === 'reload') {
        if (!preserve) rows.length = 0;
        else rows.push({ id: `reload${ev.ts}`, level: 'reload', ts: ev.ts });
        return render();
      }
      if (paused) return;
      const text = applyFormat(ev.args || []).map(plain).join(' ') + (ev.stack && ev.level === 'error' ? `\n${ev.stack}` : '');
      const key = `${ev.level}\u0000${text}`;
      const lastRow = rows[rows.length - 1];
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
      if (lastRow && lastRow.key === key) {
        // Same message again: bump the count on its row.
        lastRow.count++;
        lastRow.ts = ev.ts;
        const node = list.querySelector(`[data-id="${CSS.escape(lastRow.id)}"]`);
        if (node && visible(lastRow)) node.replaceWith(rowEl(lastRow));
        renderCounts();
        return;
      }
      const r = { id: ev.id, level: ev.level, args: ev.args || [], ts: ev.ts, count: 1, stack: ev.stack, uncaught: ev.uncaught, fatal: ev.fatal, target: ev.target, key, text };
      rows.push(r);
      if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);
      if (visible(r)) {
        list.append(rowEl(r));
        while (list.childElementCount > 1500) list.firstElementChild.remove();
        empty.classList.add('hidden');
        if (atBottom) list.scrollTop = list.scrollHeight;
      }
      renderCounts();
    });
    deck.onRnNetStatus((st) => {
      const live = st.targets.filter((t) => t.state === 'connected');
      const taken = st.targets.filter((t) => t.state === 'devtools');
      dot.className = `nw-dot ${live.length ? 'on' : taken.length ? 'warn' : ''}`;
      reconnectBtn.classList.toggle('hidden', !taken.length);
      if (live.length) statusText.textContent = live.map((t) => `${t.app}${t.device ? ` · ${t.device}` : ''}`).join('   ');
      else if (taken.length) statusText.textContent = `React Native DevTools is attached to ${taken[0].app} (one debugger at a time)`;
      else statusText.textContent = `Waiting for a React Native debug build (Metro on :${st.ports.join(', :')})`;
    });
    deck.rnNetStart();
    render();

    return { el: el('div', 'app app-rnconsole', bar, box, summary), focus: () => search.focus() };
  }

  window.DeckApps.register({
    id: 'rnconsole',
    name: 'RN Console',
    desc: 'React Native logs & errors, via Metro',
    icon: 'terminal-window',
    mat: 'log',
    color: 'var(--waiting)',
    build: rnConsoleApp,
  });
})();
