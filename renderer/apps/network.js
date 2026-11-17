/* global deck */
'use strict';

// Network app: a React Native network inspector.
// Every XHR/fetch/Apollo request of a React Native app in a simulator or on a device, via
// Metro's debugger (see main/rn-net.js). Chrome-style: a request table, and Headers / Payload /
// Response for the selected one. GraphQL requests are named after their operation.
(() => {
  const { node: el, icon: ph, store, trackDrag } = window.Kit;
  const { button, copy } = window.DeckApps.ui;

  function networkApp() {
    const MAX_ROWS = 2000;
    const reqs = new Map(); // id -> entry
    let order = []; // ids, oldest first
    let selected = null;
    let paused = false;
    let filter = '';
    let kind = 'all'; // all | graphql | rest | errors
    let detailTab = 'headers';

    const span = (cls, text) => el('span', cls, text);
    const fmtSize = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(1)} MB`);
    const fmtMs = (n) => (n == null ? '' : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(2)} s`);
    const parseJson = (s) => {
      try {
        return typeof s === 'string' && /^\s*[[{]/.test(s) ? JSON.parse(s) : undefined;
      } catch {
        return undefined;
      }
    };
    // GraphQL: name the row after the operation (Apollo sends operationName; else parse the query).
    function gqlOf(body) {
      const j = parseJson(body);
      const ops = Array.isArray(j) ? j : j ? [j] : [];
      if (!ops.length || !ops.every((o) => o && typeof o.query === 'string')) return null;
      return ops.map((o) => {
        const m = /\b(query|mutation|subscription)\s+(\w+)/.exec(o.query);
        return { name: o.operationName || m?.[2] || '(anonymous)', type: m?.[1] || 'query', query: o.query, variables: o.variables };
      });
    }
    function nameOf(r) {
      if (r.gql) return r.gql.map((o) => o.name).join(', ');
      try {
        const u = new URL(r.url);
        const last = u.pathname.split('/').filter(Boolean).pop() || u.host;
        return last + u.search;
      } catch {
        return r.url;
      }
    }
    const hostOf = (url) => {
      try {
        return new URL(url).host;
      } catch {
        return '';
      }
    };
    const typeOf = (r) => {
      const ct = r.resHeaders?.['content-type'] || '';
      if (r.gql) return 'graphql';
      if (/json/.test(ct)) return 'json';
      if (/html/.test(ct)) return 'html';
      if (/image\//.test(ct)) return ct.split('/')[1].split(';')[0];
      if (/text\//.test(ct)) return 'text';
      return ct ? ct.split(';')[0].split('/').pop() : '';
    };
    const isError = (r) => !!r.error || r.status >= 400 || r.gqlErrors;

    // ----- toolbar -----
    const dot = el('span', 'nw-dot');
    const statusText = el('span', 'nw-status-text', 'Starting…');
    const reconnectBtn = button('Reconnect', 'plug', 'Take the connection back from React Native DevTools', () => deck.rnNetReconnect());
    reconnectBtn.classList.add('hidden');
    const search = el('input', 'nw-search');
    search.placeholder = 'Filter by URL, operation or method';
    search.spellcheck = false;
    search.addEventListener('input', () => {
      filter = search.value.trim().toLowerCase();
      renderTable();
    });
    search.addEventListener('keydown', (e) => e.stopPropagation());
    const seg = el('div', 'nw-seg');
    const segBtns = {};
    for (const [k, label] of [['all', 'All'], ['graphql', 'GraphQL'], ['rest', 'REST'], ['errors', 'Errors']]) {
      const b = el('button', 'nw-seg-btn', label);
      b.addEventListener('click', () => {
        kind = k;
        for (const [kk, bb] of Object.entries(segBtns)) bb.classList.toggle('on', kk === k);
        renderTable();
      });
      segBtns[k] = b;
      seg.append(b);
    }
    segBtns.all.classList.add('on');
    const pauseBtn = button('', 'pause', 'Pause recording', () => {
      paused = !paused;
      pauseBtn.replaceChildren(ph(paused ? 'record' : 'pause'));
      pauseBtn.title = paused ? 'Resume recording' : 'Pause recording';
      pauseBtn.classList.toggle('armed', paused);
    });
    const reloadBtn = button('', 'arrow-clockwise', 'Reload the app (captures its startup requests)', () => deck.rnNetReload());
    const clearBtn = button('', 'prohibit', 'Clear', () => {
      reqs.clear();
      order = [];
      selected = null;
      renderTable();
      renderDetail();
    });
    const bar = el('div', 'app-bar nw-bar', dot, statusText, reconnectBtn, el('span', 'app-spacer'), search, seg, reloadBtn, pauseBtn, clearBtn);

    // ----- table -----
    const tbody = el('div', 'nw-rows');
    const head = el('div', 'nw-row nw-head', span('c-name', 'Name'), span('c-method', 'Method'), span('c-status', 'Status'), span('c-type', 'Type'), span('c-size', 'Size'), span('c-time', 'Time'));
    const empty = el('div', 'nw-empty');
    const table = el('div', 'nw-table', head, tbody, empty);
    const summary = el('div', 'app-status nw-summary');

    function visible(r) {
      if (kind === 'graphql' && !r.gql) return false;
      if (kind === 'rest' && r.gql) return false;
      if (kind === 'errors' && !isError(r)) return false;
      if (filter && !`${r.method} ${r.url} ${r.gql ? r.gql.map((o) => o.name).join(' ') : ''}`.toLowerCase().includes(filter)) return false;
      return true;
    }
    function rowEl(r) {
      const status = r.error ? r.error : r.status == null ? 'pending' : String(r.status);
      const row = el(
        'div',
        `nw-row${r.id === selected ? ' sel' : ''}${isError(r) ? ' err' : ''}${r.status == null && !r.error ? ' pending' : ''}`,
        span('c-name', el('span', 'nw-name', r.gql ? ph('graph') : null, ' ', nameOf(r)), el('span', 'nw-host', hostOf(r.url))),
        span('c-method', r.method),
        span('c-status', status),
        span('c-type', typeOf(r)),
        span('c-size', fmtSize(r.size)),
        span('c-time', r.end ? fmtMs(r.end - r.start) : ''),
      );
      row.dataset.id = r.id;
      row.title = r.url;
      row.addEventListener('click', () => select(r.id));
      return row;
    }
    function renderTable() {
      const atBottom = tbody.scrollHeight - tbody.scrollTop - tbody.clientHeight < 24;
      const shown = order.map((id) => reqs.get(id)).filter(visible);
      tbody.replaceChildren(...shown.map(rowEl));
      empty.classList.toggle('hidden', shown.length > 0);
      empty.textContent = order.length ? 'No requests match the filter' : 'Waiting for requests… use the app to see its network traffic here';
      if (atBottom) tbody.scrollTop = tbody.scrollHeight;
      const total = order.length;
      const bytes = order.reduce((n, id) => n + (reqs.get(id).size || 0), 0);
      summary.textContent = total ? `${shown.length} / ${total} requests · ${fmtSize(bytes)} transferred` : '';
    }
    // Repaint one row in place (responses arrive one by one; avoid rebuilding the table).
    function updateRow(r) {
      const old = tbody.querySelector(`[data-id="${CSS.escape(r.id)}"]`);
      if (old) {
        if (visible(r)) old.replaceWith(rowEl(r));
        else old.remove();
      } else renderTable();
      if (r.id === selected) renderDetail();
    }

    // ----- details, beside the table; the sash between them resizes (double-click resets) -----
    const detail = el('div', 'nw-detail hidden');
    const sash = el('div', 'nw-sash hidden');
    sash.title = 'Drag to resize · double-click to reset';
    const SPLIT_KEY = 'deck.app.network.split';
    let split = Number(store.get(SPLIT_KEY, '')) || 38; // table width, % of the area
    const main = el('div', 'nw-main', table, sash, detail);
    const applySplit = () => (table.style.flex = detail.classList.contains('hidden') ? '' : `0 0 ${split}%`);
    sash.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const rect = main.getBoundingClientRect();
      sash.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      trackDrag(
        (ev) => {
          split = Math.min(80, Math.max(20, ((ev.clientX - rect.left) / rect.width) * 100));
          applySplit();
        },
        () => {
          sash.classList.remove('dragging');
          document.body.style.cursor = '';
          store.set(SPLIT_KEY, String(Math.round(split * 10) / 10));
        },
      );
    });
    sash.addEventListener('dblclick', () => {
      split = 38;
      store.set(SPLIT_KEY, '38');
      applySplit();
    });
    // Too narrow for every column: keep just Name and Status.
    new ResizeObserver(([e]) => table.classList.toggle('narrow', e.contentRect.width < 560)).observe(table);
    function select(id) {
      selected = selected === id ? null : id;
      tbody.querySelectorAll('.nw-row').forEach((n) => n.classList.toggle('sel', n.dataset.id === selected));
      renderDetail();
    }
    const kv = (obj) =>
      el(
        'div',
        'nw-kv',
        Object.entries(obj || {}).map(([k, v]) => el('div', 'nw-kv-row', span('nw-k', k), span('nw-v', String(v)))),
      );
    const section = (title, ...children) => el('div', 'nw-sec', el('div', 'nw-sec-title', title), ...children);
    function codeBlock(text, lang) {
      const pre = el('pre', 'nw-code hl');
      const code = el('code');
      if (window.hljs && lang && text.length < 400000) {
        try {
          code.innerHTML = window.hljs.highlight(text, { language: lang }).value;
        } catch {
          code.textContent = text;
        }
      } else code.textContent = text;
      pre.append(code);
      return pre;
    }
    const pretty = (s) => {
      const j = parseJson(s);
      return j === undefined ? { text: s, lang: null } : { text: JSON.stringify(j, null, 2), lang: 'json' };
    };
    function curlOf(r) {
      const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
      const parts = [`curl ${q(r.url)}`];
      if (r.method !== 'GET') parts.push(`-X ${r.method}`);
      for (const [k, v] of Object.entries(r.reqHeaders || {})) parts.push(`-H ${q(`${k}: ${v}`)}`);
      if (r.reqBody && !/^\[/.test(r.reqBody)) parts.push(`--data-raw ${q(r.reqBody)}`);
      return parts.join(' \\\n  ');
    }
    function renderDetail() {
      const r = selected && reqs.get(selected);
      detail.classList.toggle('hidden', !r);
      sash.classList.toggle('hidden', !r);
      applySplit();
      if (!r) return detail.replaceChildren();
      const tabs = el('div', 'nw-tabs');
      for (const [k, label] of [['headers', 'Headers'], ['payload', 'Payload'], ['response', 'Response']]) {
        const b = el('button', `nw-tab${detailTab === k ? ' on' : ''}`, label);
        b.addEventListener('click', () => {
          detailTab = k;
          renderDetail();
        });
        tabs.append(b);
      }
      const closeBtn = button('', 'x', 'Close details', () => select(r.id));
      const actions = el(
        'div',
        'nw-actions',
        button('', 'terminal', 'Copy as cURL', () => copy(curlOf(r))),
        button('', 'clipboard-text', 'Copy the response body', () => copy(r.resBody ?? '')),
        closeBtn,
      );
      const body = el('div', 'nw-detail-body');
      if (detailTab === 'headers') {
        body.append(
          section(
            'General',
            kv({
              URL: r.url,
              Method: r.method,
              Status: r.error || (r.status ?? 'pending'),
              Duration: r.end ? fmtMs(r.end - r.start) : '',
              'Waiting (TTFB)': r.ttfb ? fmtMs(r.ttfb - r.start) : '',
              App: r.target ? `${r.target.app}${r.target.device ? ` · ${r.target.device}` : ''}` : '',
              Started: new Date(r.start).toLocaleTimeString(),
            }),
          ),
          section('Response headers', kv(r.resHeaders)),
          section('Request headers', kv(r.reqHeaders)),
        );
      } else if (detailTab === 'payload') {
        if (r.gql) {
          for (const op of r.gql) {
            body.append(section(`${op.type} ${op.name}`, codeBlock(op.query.trim(), 'graphql')));
            if (op.variables && Object.keys(op.variables).length) body.append(section('Variables', codeBlock(JSON.stringify(op.variables, null, 2), 'json')));
          }
        } else if (r.reqBody) {
          const p = pretty(r.reqBody);
          body.append(codeBlock(p.text, p.lang));
        } else {
          let params = null;
          try {
            params = Object.fromEntries(new URL(r.url).searchParams);
          } catch {
            /* ignore */
          }
          body.append(params && Object.keys(params).length ? section('Query string', kv(params)) : el('div', 'nw-none', 'No request body'));
        }
      } else if (r.binary) body.append(el('div', 'nw-none', `Binary response (${r.resHeaders?.['content-type'] || 'unknown type'}, ${fmtSize(r.size)})`));
      else if (r.resBody == null) body.append(el('div', 'nw-none', r.error ? r.error : r.status == null ? 'Waiting for the response…' : r.truncated ? `Response too large to capture (${fmtSize(r.size)})` : 'No response body'));
      else {
        const p = pretty(r.resBody);
        if (r.truncated) body.append(el('div', 'nw-none', 'Showing the first 1 MB'));
        body.append(codeBlock(p.text, p.lang));
      }
      detail.replaceChildren(el('div', 'nw-detail-head', tabs, el('span', 'app-spacer'), actions), body);
    }

    // ----- events from the main process -----
    deck.onRnNetEvent((ev) => {
      if (ev.t === 'req') {
        if (paused) return;
        const r = { id: ev.id, method: ev.method, url: ev.url, reqHeaders: ev.headers, reqBody: ev.body, start: ev.ts, target: ev.target, gql: gqlOf(ev.body) };
        reqs.set(r.id, r);
        order.push(r.id);
        if (order.length > MAX_ROWS) reqs.delete(order.shift());
        renderTable();
        return;
      }
      const r = reqs.get(ev.id);
      if (!r) return;
      r.end = ev.ts;
      if (ev.t === 'err') r.error = ev.error;
      else {
        Object.assign(r, { status: ev.status, resHeaders: ev.headers, resBody: ev.body ?? null, size: ev.size, truncated: ev.truncated, binary: ev.binary, ttfb: ev.ttfb });
        // GraphQL reports failures in a 200 response.
        const j = r.gql && parseJson(r.resBody);
        r.gqlErrors = !!(j && (Array.isArray(j) ? j.some((x) => x?.errors?.length) : j.errors?.length));
      }
      updateRow(r);
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
    renderTable();

    return {
      el: el('div', 'app app-network', bar, main, summary),
      focus: () => search.focus(),
    };
  }

  window.DeckApps.register({ id: 'network', name: 'Network', desc: 'React Native app requests, via Metro', icon: 'wifi-high', mat: 'http', color: 'var(--bot-4)', build: networkApp });
})();
