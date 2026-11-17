'use strict';

// Converters: small everyday developer tools in one tab — encode/decode (Base64, URL, HTML,
// JSON string, hex), JWT decoder, timestamps, hashes, UUIDs, regex tester, text diff, case
// converter, number bases and colours. Everything runs locally; inputs are remembered.
(() => {
  const { node: el, icon: ph, store } = window.Kit;
  const { button, copy } = window.DeckApps.ui;
  const K = (tool, field) => `deck.app.conv.${tool}.${field}`;

  // ----- small UI helpers -----
  function area(tool, field, placeholder, { rows, mono = true } = {}) {
    const t = el('textarea', `cv-area${mono ? ' mono' : ''}`);
    t.placeholder = placeholder || '';
    t.spellcheck = false;
    if (rows) t.rows = rows;
    if (tool) {
      t.value = store.get(K(tool, field), '');
      t.addEventListener('input', () => store.set(K(tool, field), t.value));
    }
    t.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Tab' && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        document.execCommand('insertText', false, '  ');
      }
    });
    return t;
  }
  function input(tool, field, placeholder, def = '') {
    const i = el('input', 'cv-input');
    i.placeholder = placeholder || '';
    i.spellcheck = false;
    if (tool) {
      i.value = store.get(K(tool, field), def);
      i.addEventListener('input', () => store.set(K(tool, field), i.value));
    }
    i.addEventListener('keydown', (e) => e.stopPropagation());
    return i;
  }
  function selectEl(tool, field, options, def) {
    const s = el('select', 'ac-select');
    for (const [v, label] of options) {
      const o = el('option', '', label);
      o.value = v;
      s.append(o);
    }
    s.value = store.get(K(tool, field), def ?? options[0][0]);
    s.addEventListener('change', () => store.set(K(tool, field), s.value));
    return s;
  }
  const label = (text, ...extra) => el('div', 'cv-label', el('span', '', text), el('span', 'app-spacer'), ...extra);
  const copyBtn = (get, title = 'Copy') => button('', 'copy', title, () => copy(typeof get === 'function' ? get() : get));
  const errBox = () => el('div', 'cv-err hidden');
  const showErr = (box, msg) => {
    box.textContent = msg || '';
    box.classList.toggle('hidden', !msg);
  };
  // Rows of "name  value  [copy]".
  function kvTable(rows) {
    return el(
      'div',
      'cv-kv',
      rows.map(([k, v, hint]) =>
        el('div', 'cv-kv-row', el('span', 'cv-k', k), el('span', 'cv-v', v, hint ? el('span', 'cv-hint', hint) : null), v ? copyBtn(String(v)) : el('span')),
      ),
    );
  }

  // ----- encoders -----
  const utf8 = new TextEncoder();
  const fromUtf8 = new TextDecoder('utf-8', { fatal: true });
  const b64encode = (s) => {
    let bin = '';
    for (const b of utf8.encode(s)) bin += String.fromCharCode(b);
    return btoa(bin);
  };
  const b64bytes = (s) => {
    const clean = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };
  const b64decode = (s) => fromUtf8.decode(b64bytes(s));
  const HTML_ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const htmlDecode = (s) => new DOMParser().parseFromString(`<!doctype html><body>${s.replace(/</g, '&lt;')}`, 'text/html').body.textContent;
  const CODECS = {
    base64: { name: 'Base64', enc: b64encode, dec: b64decode },
    base64url: { name: 'Base64 URL', enc: (s) => b64encode(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), dec: b64decode },
    urlc: { name: 'URL component', enc: encodeURIComponent, dec: (s) => decodeURIComponent(s.replace(/\+/g, ' ')) },
    url: { name: 'Full URL', enc: encodeURI, dec: decodeURI },
    html: { name: 'HTML entities', enc: (s) => s.replace(/[&<>"']/g, (c) => HTML_ENT[c]), dec: htmlDecode },
    json: { name: 'JSON string', enc: (s) => JSON.stringify(s), dec: (s) => { const v = JSON.parse(s.trim()); if (typeof v !== 'string') throw new Error('Not a JSON string'); return v; } },
    hex: { name: 'Hex (UTF-8 bytes)', enc: (s) => [...utf8.encode(s)].map((b) => b.toString(16).padStart(2, '0')).join(' '), dec: (s) => { const h = s.replace(/0x|[\s:,]/gi, ''); if (!/^([0-9a-f]{2})*$/i.test(h)) throw new Error('Not hex bytes'); return fromUtf8.decode(Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16))); } },
  };

  function encodeTool() {
    const fmt = selectEl('encode', 'fmt', Object.entries(CODECS).map(([k, c]) => [k, c.name]));
    const plain = area('encode', 'plain', 'Text');
    const coded = area('encode', 'coded', 'Encoded');
    const err = errBox();
    const run = (from) => {
      const c = CODECS[fmt.value];
      try {
        if (from === 'plain') coded.value = c.enc(plain.value);
        else plain.value = coded.value.trim() ? c.dec(coded.value) : '';
        showErr(err, '');
      } catch (e) {
        showErr(err, `Can’t decode as ${c.name}: ${e.message}`);
      }
      store.set(K('encode', 'plain'), plain.value);
      store.set(K('encode', 'coded'), coded.value);
    };
    plain.addEventListener('input', () => run('plain'));
    coded.addEventListener('input', () => run('coded'));
    fmt.addEventListener('change', () => run('plain'));
    const swap = button('', 'arrows-down-up', 'Swap: decode what’s in the text box', () => {
      coded.value = plain.value;
      run('coded');
    });
    return el(
      'div',
      'cv-tool cv-split',
      el('div', 'cv-row', el('span', 'cv-label-inline', 'Format'), fmt, el('span', 'app-spacer'), swap),
      label('Text', copyBtn(() => plain.value)),
      plain,
      label('Encoded', copyBtn(() => coded.value)),
      coded,
      err,
    );
  }

  // ----- JWT -----
  const fmtDate = (sec) => {
    const d = new Date(sec * 1000);
    return isNaN(d) ? String(sec) : `${d.toLocaleString()}`;
  };
  function rel(ms) {
    const s = Math.round(Math.abs(ms) / 1000);
    const txt = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : s < 172800 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 86400)} days`;
    return ms >= 0 ? `in ${txt}` : `${txt} ago`;
  }
  function jwtTool() {
    const tok = area('jwt', 'token', 'Paste a JWT (eyJ…)', { rows: 5 });
    const out = el('div', 'cv-out');
    const err = errBox();
    const run = () => {
      out.replaceChildren();
      const t = tok.value.trim().replace(/^Bearer\s+/i, '');
      if (!t) return showErr(err, '');
      const parts = t.split('.');
      try {
        if (parts.length < 2) throw new Error('A JWT has three dot-separated parts');
        const header = JSON.parse(b64decode(parts[0]));
        const payload = JSON.parse(b64decode(parts[1]));
        showErr(err, '');
        const now = Date.now();
        const claims = [];
        let state = null;
        for (const [k, name] of [['iat', 'Issued'], ['nbf', 'Not before'], ['exp', 'Expires']]) {
          if (typeof payload[k] === 'number') claims.push([`${name} (${k})`, fmtDate(payload[k]), rel(payload[k] * 1000 - now)]);
        }
        if (typeof payload.exp === 'number') state = payload.exp * 1000 < now ? ['expired', `Expired ${rel(payload.exp * 1000 - now)}`] : ['valid', `Valid · expires ${rel(payload.exp * 1000 - now)}`];
        if (typeof payload.nbf === 'number' && payload.nbf * 1000 > now) state = ['expired', `Not valid yet (${rel(payload.nbf * 1000 - now)})`];
        for (const k of ['iss', 'sub', 'aud', 'jti']) if (payload[k] != null) claims.push([k, Array.isArray(payload[k]) ? payload[k].join(', ') : String(payload[k])]);
        const json = (o) => JSON.stringify(o, null, 2);
        out.append(
          state ? el('div', `cv-badge ${state[0]}`, ph(state[0] === 'valid' ? 'check-circle' : 'clock-countdown'), state[1]) : null,
          claims.length ? kvTable(claims) : null,
          label('Header', copyBtn(json(header))),
          el('pre', 'nw-code', json(header)),
          label('Payload', copyBtn(json(payload))),
          el('pre', 'nw-code', json(payload)),
          label('Signature', copyBtn(parts[2] || '')),
          el('pre', 'nw-code cv-sig', parts[2] || '(none)'),
          el('div', 'cv-note', ph('info'), 'Decoded only — the signature is not verified.'),
        );
      } catch (e) {
        showErr(err, `Not a valid JWT: ${e.message}`);
      }
    };
    tok.addEventListener('input', run);
    run();
    return el('div', 'cv-tool', label('Token', copyBtn(() => tok.value)), tok, err, out);
  }

  // ----- timestamps -----
  function parseTime(s) {
    s = s.trim();
    if (!s) return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      // Guess the unit from the size: seconds, milliseconds, microseconds, nanoseconds.
      const abs = Math.abs(n);
      if (abs < 1e11) return { ms: n * 1000, unit: 'seconds' };
      if (abs < 1e14) return { ms: n, unit: 'milliseconds' };
      if (abs < 1e17) return { ms: n / 1000, unit: 'microseconds' };
      return { ms: n / 1e6, unit: 'nanoseconds' };
    }
    const ms = Date.parse(s);
    return isNaN(ms) ? { error: true } : { ms, unit: 'date' };
  }
  function timeTool() {
    const inp = input('time', 'value', 'Unix time (s / ms / µs / ns), ISO 8601 or any date');
    const nowLine = el('div', 'cv-now');
    const out = el('div', 'cv-out');
    const err = errBox();
    const run = () => {
      const p = parseTime(inp.value);
      out.replaceChildren();
      if (!p) return showErr(err, '');
      if (p.error) return showErr(err, 'Can’t read that as a date or a number');
      showErr(err, '');
      const d = new Date(p.ms);
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      out.append(
        el('div', 'cv-note', ph('info'), p.unit === 'date' ? 'Read as a date' : `Read as Unix ${p.unit}`),
        kvTable([
          ['Unix seconds', String(Math.floor(p.ms / 1000))],
          ['Unix milliseconds', String(Math.round(p.ms))],
          ['ISO 8601 (UTC)', d.toISOString()],
          [`Local (${tz})`, d.toLocaleString([], { dateStyle: 'full', timeStyle: 'long' })],
          ['UTC', d.toUTCString()],
          ['Relative', rel(p.ms - Date.now())],
          ['Day of year', String(Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000))],
        ]),
      );
    };
    const tick = () => {
      const n = Date.now();
      nowLine.replaceChildren(el('span', 'cv-k', 'Now'), el('span', 'cv-v', `${Math.floor(n / 1000)}`), el('span', 'cv-hint', new Date(n).toISOString()));
    };
    tick();
    setInterval(() => nowLine.isConnected && tick(), 1000);
    inp.addEventListener('input', run);
    const nowBtn = button('Now', 'clock', 'Use the current time', () => {
      inp.value = String(Math.floor(Date.now() / 1000));
      store.set(K('time', 'value'), inp.value);
      run();
    });
    run();
    return el('div', 'cv-tool', nowLine, el('div', 'cv-row', inp, nowBtn), err, out);
  }

  // ----- hashes -----
  function hashTool() {
    const text = area('hash', 'text', 'Text to hash');
    const out = el('div', 'cv-out');
    const upper = selectEl('hash', 'case', [['lower', 'lowercase hex'], ['upper', 'UPPERCASE hex'], ['b64', 'Base64']]);
    let seq = 0;
    const run = async () => {
      const my = ++seq;
      const data = utf8.encode(text.value);
      const rows = [];
      for (const alg of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']) {
        const buf = new Uint8Array(await crypto.subtle.digest(alg, data));
        let v = upper.value === 'b64' ? btoa(String.fromCharCode(...buf)) : [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
        if (upper.value === 'upper') v = v.toUpperCase();
        rows.push([alg, v]);
      }
      rows.push(['Length', `${text.value.length} characters · ${data.length} bytes`]);
      if (my === seq) out.replaceChildren(kvTable(rows));
    };
    text.addEventListener('input', run);
    upper.addEventListener('change', run);
    run();
    return el('div', 'cv-tool', el('div', 'cv-row', el('span', 'cv-label-inline', 'Output'), upper), text, out);
  }

  // ----- UUIDs -----
  function uuidTool() {
    const count = input('uuid', 'count', 'How many', '5');
    count.type = 'number';
    count.min = '1';
    count.max = '1000';
    count.classList.add('cv-num');
    const fmt = selectEl('uuid', 'fmt', [['lower', 'lowercase'], ['upper', 'UPPERCASE'], ['nodash', 'no dashes'], ['braces', '{braces}']]);
    const out = area(null, null, '', { rows: 12 });
    out.readOnly = true;
    const gen = () => {
      const n = Math.min(1000, Math.max(1, Number(count.value) || 1));
      out.value = Array.from({ length: n }, () => {
        const u = crypto.randomUUID();
        return fmt.value === 'upper' ? u.toUpperCase() : fmt.value === 'nodash' ? u.replace(/-/g, '') : fmt.value === 'braces' ? `{${u}}` : u;
      }).join('\n');
    };
    count.addEventListener('input', gen);
    fmt.addEventListener('change', gen);
    gen();
    return el(
      'div',
      'cv-tool',
      el('div', 'cv-row', el('span', 'cv-label-inline', 'UUID v4 ×'), count, fmt, el('span', 'app-spacer'), button('Generate', 'arrows-clockwise', 'Generate new ones', gen), copyBtn(() => out.value, 'Copy all')),
      out,
    );
  }

  // ----- regex -----
  function regexTool() {
    const pat = input('regex', 'pattern', 'Pattern, e.g. (\\w+)@(\\w+)\\.com');
    pat.classList.add('mono');
    const flags = input('regex', 'flags', 'flags', 'g');
    flags.classList.add('cv-flags', 'mono');
    const text = area('regex', 'text', 'Test text', { rows: 8 });
    const repl = input('regex', 'replace', 'Replace with (optional; $1, $<name>)');
    repl.classList.add('mono');
    const err = errBox();
    const preview = el('pre', 'nw-code cv-hl');
    const matches = el('div', 'cv-out');
    const replaced = el('pre', 'nw-code');
    const replWrap = el('div', '', label('Result', copyBtn(() => replaced.textContent)), replaced);
    const run = () => {
      preview.replaceChildren();
      matches.replaceChildren();
      replWrap.classList.add('hidden');
      if (!pat.value) {
        preview.textContent = text.value;
        return showErr(err, '');
      }
      let re;
      try {
        re = new RegExp(pat.value, flags.value.replace(/[^dgimsuyv]/g, ''));
        showErr(err, '');
      } catch (e) {
        preview.textContent = text.value;
        return showErr(err, e.message);
      }
      const s = text.value;
      const all = re.global || re.sticky ? [...s.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))] : [re.exec(s)].filter(Boolean);
      let at = 0;
      for (const m of all.slice(0, 5000)) {
        if (m.index > at) preview.append(s.slice(at, m.index));
        preview.append(el('mark', '', m[0] || '​'));
        at = m.index + m[0].length;
      }
      preview.append(s.slice(at));
      matches.append(
        el('div', 'cv-label', el('span', '', `${all.length} match${all.length === 1 ? '' : 'es'}`)),
        ...all.slice(0, 200).map((m, i) =>
          el(
            'div',
            'cv-match',
            el('span', 'cv-k', `#${i + 1} @${m.index}`),
            el('span', 'cv-v', JSON.stringify(m[0])),
            m.length > 1 ? el('span', 'cv-groups', [...m].slice(1).map((g, j) => el('span', 'cv-group', `$${j + 1} `, el('b', '', g === undefined ? 'undefined' : JSON.stringify(g))))) : null,
            m.groups ? el('span', 'cv-groups', Object.entries(m.groups).map(([k, g]) => el('span', 'cv-group', `${k} `, el('b', '', JSON.stringify(g))))) : null,
          ),
        ),
      );
      if (repl.value) {
        replWrap.classList.remove('hidden');
        replaced.textContent = s.replace(re, repl.value);
      }
    };
    for (const x of [pat, flags, text, repl]) x.addEventListener('input', run);
    run();
    return el('div', 'cv-tool', el('div', 'cv-row', el('span', 'cv-slash', '/'), pat, el('span', 'cv-slash', '/'), flags), err, text, label('Matches'), preview, repl, replWrap, matches);
  }

  // ----- text diff (line LCS, with the changed part of a replaced line highlighted) -----
  function diffLines(a, b) {
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const A = a.slice(pre, a.length - suf);
    const B = b.slice(pre, b.length - suf);
    const ops = [];
    for (let i = 0; i < pre; i++) ops.push(['=', a[i], i, i]);
    if (A.length * B.length > 9e6) {
      // Too big for the table: show it as removed + added.
      A.forEach((l, i) => ops.push(['-', l, pre + i, null]));
      B.forEach((l, j) => ops.push(['+', l, null, pre + j]));
    } else {
      const n = A.length;
      const m = B.length;
      const L = new Uint32Array((n + 1) * (m + 1));
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * (m + 1) + j] = A[i] === B[j] ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
      let i = 0;
      let j = 0;
      while (i < n || j < m) {
        if (i < n && j < m && A[i] === B[j]) ops.push(['=', A[i], pre + i++, pre + j++]);
        // On a tie take the removal first, so a changed line reads "- old" then "+ new".
        else if (i < n && (j === m || L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1])) ops.push(['-', A[i], pre + i++, null]);
        else ops.push(['+', B[j], null, pre + j++]);
      }
    }
    for (let k = suf; k > 0; k--) ops.push(['=', a[a.length - k], a.length - k, b.length - k]);
    return ops;
  }
  function inlineDiff(x, y) {
    let p = 0;
    while (p < x.length && p < y.length && x[p] === y[p]) p++;
    let s = 0;
    while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
    return [p, s];
  }
  function diffTool() {
    const left = area('diff', 'left', 'Original');
    const right = area('diff', 'right', 'Changed');
    const ws = selectEl('diff', 'ws', [['exact', 'Exact'], ['trim', 'Ignore leading/trailing spaces'], ['all', 'Ignore all whitespace']]);
    const out = el('div', 'cv-diff');
    const stat = el('span', 'cv-label-inline');
    const run = () => {
      const norm = ws.value === 'trim' ? (l) => l.trim() : ws.value === 'all' ? (l) => l.replace(/\s+/g, '') : (l) => l;
      const a = left.value.split('\n');
      const b = right.value.split('\n');
      const na = a.map(norm);
      const nb = b.map(norm);
      const ops = diffLines(na, nb).map(([op, , i, j]) => [op, op === '+' ? b[j] : a[i], i, j]);
      let add = 0;
      let del = 0;
      const rows = [];
      for (let k = 0; k < ops.length; k++) {
        const [op, text, i, j] = ops[k];
        if (op === '+') add++;
        if (op === '-') del++;
        const line = el('span', 'cv-dl-text');
        // A removed line followed by an added one: mark just the part that changed.
        const pair = op === '-' && ops[k + 1]?.[0] === '+' ? ops[k + 1][1] : op === '+' && ops[k - 1]?.[0] === '-' ? ops[k - 1][1] : null;
        if (pair != null) {
          const [p, s] = op === '-' ? inlineDiff(text, pair) : inlineDiff(pair, text);
          line.append(text.slice(0, p), el('mark', '', text.slice(p, text.length - s)), text.slice(text.length - s));
        } else line.textContent = text;
        rows.push(el('div', `cv-dl ${op === '+' ? 'add' : op === '-' ? 'del' : ''}`, el('span', 'cv-ln', i == null ? '' : String(i + 1)), el('span', 'cv-ln', j == null ? '' : String(j + 1)), el('span', 'cv-op', op === '=' ? ' ' : op), line));
      }
      out.replaceChildren(...rows);
      stat.textContent = add || del ? `+${add} −${del}` : left.value || right.value ? 'No differences' : '';
    };
    let t = null;
    const later = () => {
      clearTimeout(t);
      t = setTimeout(run, 150);
    };
    left.addEventListener('input', later);
    right.addEventListener('input', later);
    ws.addEventListener('change', run);
    run();
    return el(
      'div',
      'cv-tool cv-difftool',
      el('div', 'cv-row', ws, el('span', 'app-spacer'), stat, button('', 'arrows-left-right', 'Swap sides', () => {
        [left.value, right.value] = [right.value, left.value];
        store.set(K('diff', 'left'), left.value);
        store.set(K('diff', 'right'), right.value);
        run();
      })),
      el('div', 'cv-diff-inputs', left, right),
      out,
    );
  }

  // ----- case converter -----
  function words(s) {
    return s
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean);
  }
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  const CASES = [
    ['camelCase', (w) => w.map((x, i) => (i ? cap(x) : x.toLowerCase())).join('')],
    ['PascalCase', (w) => w.map(cap).join('')],
    ['snake_case', (w) => w.map((x) => x.toLowerCase()).join('_')],
    ['CONSTANT_CASE', (w) => w.map((x) => x.toUpperCase()).join('_')],
    ['kebab-case', (w) => w.map((x) => x.toLowerCase()).join('-')],
    ['dot.case', (w) => w.map((x) => x.toLowerCase()).join('.')],
    ['path/case', (w) => w.map((x) => x.toLowerCase()).join('/')],
    ['Title Case', (w) => w.map(cap).join(' ')],
    ['Sentence case', (w) => w.map((x, i) => (i ? x.toLowerCase() : cap(x))).join(' ')],
  ];
  function caseTool() {
    const text = area('case', 'text', 'Text, one item per line (e.g. user_id, fetchUserProfile, Max Width)', { rows: 4 });
    const out = el('div', 'cv-out');
    const run = () => {
      const lines = text.value.split('\n').filter((l) => l.trim());
      out.replaceChildren(
        kvTable([
          ...CASES.map(([name, fn]) => [name, lines.map((l) => fn(words(l))).join('\n')]),
          ['lowercase', lines.map((l) => l.toLowerCase()).join('\n')],
          ['UPPERCASE', lines.map((l) => l.toUpperCase()).join('\n')],
        ]),
      );
    };
    text.addEventListener('input', run);
    run();
    return el('div', 'cv-tool', text, out);
  }

  // ----- number bases -----
  function baseTool() {
    const BASES = [
      ['10', 'Decimal', 10, ''],
      ['16', 'Hex', 16, '0x'],
      ['8', 'Octal', 8, '0o'],
      ['2', 'Binary', 2, '0b'],
    ];
    const err = errBox();
    const fields = {};
    const info = el('div', 'cv-note');
    const set = (from) => {
      const [, , radix, prefix] = BASES.find((b) => b[0] === from);
      let s = fields[from].value.trim().replace(/[_\s,]/g, '');
      const neg = s.startsWith('-');
      if (neg) s = s.slice(1);
      if (prefix && s.toLowerCase().startsWith(prefix)) s = s.slice(2);
      if (!s) {
        for (const [k] of BASES) if (k !== from) fields[k].value = '';
        info.textContent = '';
        return showErr(err, '');
      }
      const digits = '0123456789abcdef'.slice(0, radix);
      if (![...s.toLowerCase()].every((c) => digits.includes(c))) return showErr(err, `Not a base-${radix} number`);
      let n = 0n;
      for (const c of s.toLowerCase()) n = n * BigInt(radix) + BigInt(digits.indexOf(c));
      if (neg) n = -n;
      showErr(err, '');
      for (const [k, , r] of BASES) if (k !== from) fields[k].value = n.toString(r);
      store.set(K('base', 'dec'), n.toString(10));
      const abs = n < 0n ? -n : n;
      const bits = abs.toString(2).length;
      info.replaceChildren(ph('info'), `${bits} bit${bits === 1 ? '' : 's'}${abs < 2n ** 53n && n >= 0n && n < 0x110000n ? ` · as a character: ${JSON.stringify(String.fromCodePoint(Number(n)))}` : ''}`);
    };
    const rows = BASES.map(([k, name]) => {
      const i = input(null, null, name);
      i.classList.add('mono');
      fields[k] = i;
      i.addEventListener('input', () => set(k));
      return el('div', 'cv-kv-row', el('span', 'cv-k', name), i, copyBtn(() => i.value));
    });
    fields['10'].value = store.get(K('base', 'dec'), '255');
    set('10');
    return el('div', 'cv-tool', el('div', 'cv-kv cv-kv-inputs', rows), err, info);
  }

  // ----- colours -----
  function parseColor(s) {
    const probe = new Option().style;
    probe.color = '';
    probe.color = s.trim();
    if (!probe.color) return null;
    // Let the browser resolve any CSS colour (names, hsl(), etc.) to rgb().
    const c = document.createElement('canvas').getContext('2d');
    c.fillStyle = '#000';
    c.fillStyle = probe.color;
    const v = c.fillStyle; // "#rrggbb" or "rgba(r, g, b, a)"
    if (v.startsWith('#')) return { r: parseInt(v.slice(1, 3), 16), g: parseInt(v.slice(3, 5), 16), b: parseInt(v.slice(5, 7), 16), a: 1 };
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(v);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] } : null;
  }
  function toHsl({ r, g, b }) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
  }
  function colorTool() {
    const inp = input('color', 'value', 'Any CSS colour: #3b82f6, rgb(59 130 246), hsl(217 91% 60%), tomato', '#3b82f6');
    const picker = el('input', 'cv-picker');
    picker.type = 'color';
    const swatch = el('div', 'cv-swatch');
    const out = el('div', 'cv-out');
    const err = errBox();
    const run = () => {
      const c = parseColor(inp.value);
      if (!c) {
        out.replaceChildren();
        return showErr(err, inp.value.trim() ? 'Not a CSS colour' : '');
      }
      showErr(err, '');
      const hex2 = (n) => Math.round(n).toString(16).padStart(2, '0');
      const hex = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${c.a < 1 ? hex2(c.a * 255) : ''}`;
      const { h, s, l } = toHsl(c);
      const a = c.a < 1 ? ` / ${+c.a.toFixed(3)}` : '';
      picker.value = hex.slice(0, 7);
      swatch.style.background = hex;
      // Relative luminance → contrast against white and black (WCAG).
      const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      const L = 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
      const cw = (1.05 / (L + 0.05)).toFixed(2);
      const cb = ((L + 0.05) / 0.05).toFixed(2);
      out.replaceChildren(
        kvTable([
          ['HEX', hex],
          ['RGB', `rgb(${c.r} ${c.g} ${c.b}${a})`],
          ['HSL', `hsl(${h} ${s}% ${l}%${a})`],
          ['Swift', `UIColor(red: ${(c.r / 255).toFixed(3)}, green: ${(c.g / 255).toFixed(3)}, blue: ${(c.b / 255).toFixed(3)}, alpha: ${+c.a.toFixed(3)})`],
          ['Android', `0x${hex2(c.a * 255).toUpperCase()}${hex.slice(1, 7).toUpperCase()}`],
          ['Contrast', `${cw}:1 on white · ${cb}:1 on black`],
        ]),
      );
    };
    picker.addEventListener('input', () => {
      inp.value = picker.value;
      store.set(K('color', 'value'), inp.value);
      run();
    });
    inp.addEventListener('input', run);
    run();
    return el('div', 'cv-tool', el('div', 'cv-row', swatch, picker, inp), err, out);
  }

  const TOOLS = [
    { id: 'encode', name: 'Encode / Decode', icon: 'lock-key-open', build: encodeTool },
    { id: 'jwt', name: 'JWT', icon: 'key', build: jwtTool },
    { id: 'time', name: 'Timestamp', icon: 'clock', build: timeTool },
    { id: 'regex', name: 'Regex', icon: 'asterisk', build: regexTool },
    { id: 'diff', name: 'Text diff', icon: 'git-diff', build: diffTool },
    { id: 'hash', name: 'Hash', icon: 'hash', build: hashTool },
    { id: 'uuid', name: 'UUID', icon: 'fingerprint', build: uuidTool },
    { id: 'case', name: 'Case', icon: 'text-aa', build: caseTool },
    { id: 'base', name: 'Number base', icon: 'binary', build: baseTool },
    { id: 'color', name: 'Colour', icon: 'palette', build: colorTool },
  ];

  function convertersApp() {
    const nav = el('div', 'cv-nav');
    const pane = el('div', 'cv-pane');
    const built = new Map();
    const navBtns = {};
    let current = null;
    function show(id) {
      const tool = TOOLS.find((t) => t.id === id) || TOOLS[0];
      current = tool.id;
      store.set('deck.app.conv.tool', tool.id);
      if (!built.has(tool.id)) built.set(tool.id, tool.build());
      pane.replaceChildren(el('div', 'cv-title', tool.name), built.get(tool.id));
      for (const [k, b] of Object.entries(navBtns)) b.classList.toggle('on', k === tool.id);
      requestAnimationFrame(() => pane.querySelector('textarea:not([readonly]), input')?.focus());
    }
    for (const t of TOOLS) {
      const b = el('button', 'cv-nav-btn', ph(t.icon), el('span', '', t.name));
      b.addEventListener('click', () => show(t.id));
      navBtns[t.id] = b;
      nav.append(b);
    }
    show(store.get('deck.app.conv.tool', 'encode'));
    return {
      el: el('div', 'app app-converters', el('div', 'cv-main', nav, pane)),
      focus: () => show(current),
    };
  }

  window.DeckApps.register({
    id: 'converters',
    name: 'Converters',
    desc: 'Base64, JWT, timestamps, regex, diff & more',
    icon: 'swap',
    mat: 'hex',
    color: 'var(--bot-0)',
    build: convertersApp,
  });
})();
