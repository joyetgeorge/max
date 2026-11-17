// React Native network inspector and console — main-process side (the Network and RN Console apps).
//
// React Native 0.81 has no CDP Network domain, so instead of asking the app to report its
// traffic we install a tiny recorder in it through Metro's debugger proxy (no changes to the
// app's code): Runtime.addBinding gives the app a `__maxNet` function whose calls arrive here
// as Runtime.bindingCalled, and Runtime.evaluate patches XMLHttpRequest — which fetch() and
// Apollo use under the hood in React Native — to call it for every request and response.
//
// Metro allows ONE debugger per app: connecting closes React Native DevTools, and opening
// DevTools closes us (reason NEW_DEBUGGER_OPENED). When DevTools takes over we stay out of its
// way until the user presses Reconnect.

const PORTS = [8081, 8082, 8083, 19000];
// Fast while nothing is connected, so a freshly (re)launched app is caught before its first requests.
const SCAN_MS = 1000;
const SCAN_IDLE_MS = 4000; // once connected, just watch for apps coming and going
const TEXTUAL = /json|text|xml|graphql|javascript|html|x-www-form-urlencoded/i;

// Runs inside the app (Hermes). Plain ES5, and every hook is wrapped so a bug here can
// never break the app's own requests.
const RECORDER = `(function () {
  var g = globalThis;
  if (g.__maxNetInstalled) return 'already-installed';
  var XHR = g.XMLHttpRequest;
  if (!XHR) return 'no-xhr';
  g.__maxNetInstalled = true;
  var P = XHR.prototype, open = P.open, send = P.send, setHeader = P.setRequestHeader;
  var seq = 0, LIMIT = 1000000;
  function emit(o) { try { if (typeof g.__maxNet === 'function') g.__maxNet(JSON.stringify(o)); } catch (e) {} }
  function bodyOf(b) {
    try {
      if (b == null) return null;
      if (typeof b === 'string') return b.length > LIMIT ? b.slice(0, LIMIT) : b;
      if (b._parts || (g.FormData && b instanceof g.FormData)) return '[FormData]';
      if (g.Blob && b instanceof g.Blob) return '[Blob, ' + b.size + ' bytes]';
      if (typeof ArrayBuffer !== 'undefined' && b instanceof ArrayBuffer) return '[ArrayBuffer, ' + b.byteLength + ' bytes]';
      return String(b);
    } catch (e) { return null; }
  }
  P.open = function (method, url) {
    try { this.__maxNet = { id: 'r' + (++seq) + '.' + Date.now(), method: String(method).toUpperCase(), url: String(url), headers: {} }; } catch (e) {}
    return open.apply(this, arguments);
  };
  P.setRequestHeader = function (k, v) {
    try { if (this.__maxNet) this.__maxNet.headers[k] = String(v); } catch (e) {}
    return setHeader.apply(this, arguments);
  };
  P.send = function (body) {
    var x = this, m = x.__maxNet;
    if (m) {
      try {
        var done = false;
        emit({ t: 'req', id: m.id, method: m.method, url: m.url, headers: m.headers, body: bodyOf(body), ts: Date.now() });
        var fail = function (msg) { return function () { if (done) return; done = true; emit({ t: 'err', id: m.id, error: msg, ts: Date.now() }); }; };
        x.addEventListener('readystatechange', function () { if (x.readyState === 2 && !m.ttfb) m.ttfb = Date.now(); });
        x.addEventListener('error', fail('Network error'));
        x.addEventListener('timeout', fail('Timed out'));
        x.addEventListener('abort', fail('Aborted'));
        x.addEventListener('load', function () {
          if (done) return;
          done = true;
          var r = { t: 'res', id: m.id, status: x.status, headers: x.getAllResponseHeaders ? x.getAllResponseHeaders() : '', ts: Date.now(), ttfb: m.ttfb || null };
          try {
            var rt = x.responseType;
            if (!rt || rt === 'text') {
              var s = x.responseText || '';
              r.size = s.length; r.truncated = s.length > LIMIT; r.body = r.truncated ? s.slice(0, LIMIT) : s;
              emit(r);
            } else if (rt === 'json') {
              var j = JSON.stringify(x.response) || '';
              r.size = j.length; r.body = j;
              emit(r);
            } else if (rt === 'blob' && x.response && g.FileReader) {
              // fetch() asks for a Blob; read our own copy of it (the app's read is unaffected).
              var blob = x.response;
              r.size = blob.size;
              if (blob.size > LIMIT) { r.truncated = true; emit(r); return; }
              var fr = new g.FileReader();
              fr.onload = function () { r.dataUrl = fr.result; emit(r); };
              fr.onerror = function () { emit(r); };
              fr.readAsDataURL(blob);
            } else emit(r);
          } catch (e) { emit(r); }
        });
      } catch (e) {}
    }
    return send.apply(this, arguments);
  };
  return 'installed';
})()`;

// Also runs inside the app: forwards console.* calls and uncaught errors (the RN Console app)
// through the `__maxLog` binding. Arguments are serialised here, cycle- and depth-safe, so
// objects arrive whole and can be expanded in Max. Installed with the network recorder, once
// XMLHttpRequest exists — by then React Native has set up its console polyfill.
const LOGGER = `(function () {
  var g = globalThis;
  if (g.__maxLogInstalled) return 'already-installed';
  if (!g.console) return 'no-console';
  g.__maxLogInstalled = true;
  var seq = 0, MAX_STR = 20000, MAX_KEYS = 200, MAX_DEPTH = 6;
  function ser(v, depth, seen) {
    try {
      var t = typeof v;
      if (v === null || t === 'boolean' || t === 'number') return (t === 'number' && !isFinite(v)) ? { __t: 'num', v: String(v) } : v;
      if (t === 'string') return v.length > MAX_STR ? v.slice(0, MAX_STR) + '…' : v;
      if (t === 'undefined') return { __t: 'undefined' };
      if (t === 'function') return { __t: 'fn', name: v.name || '' };
      if (t === 'symbol' || t === 'bigint') return { __t: 'num', v: String(v) };
      if (v instanceof Error || (v && typeof v.message === 'string' && typeof v.stack === 'string')) return { __t: 'error', name: v.name || 'Error', message: String(v.message), stack: String(v.stack || '') };
      if (seen.indexOf(v) >= 0) return { __t: 'circular' };
      if (depth >= MAX_DEPTH) return { __t: 'more', kind: Array.isArray(v) ? 'Array(' + v.length + ')' : 'Object' };
      seen.push(v);
      var out;
      if (Array.isArray(v)) {
        out = [];
        for (var i = 0; i < v.length && i < MAX_KEYS; i++) out.push(ser(v[i], depth + 1, seen));
        if (v.length > MAX_KEYS) out.push({ __t: 'trunc', n: v.length - MAX_KEYS });
      } else if (v instanceof Date) {
        out = { __t: 'date', v: isNaN(v) ? 'Invalid Date' : v.toISOString() };
      } else {
        out = {};
        var keys = Object.keys(v), n = 0;
        for (var k = 0; k < keys.length && n < MAX_KEYS; k++, n++) out[keys[k]] = ser(v[keys[k]], depth + 1, seen);
        if (keys.length > MAX_KEYS) out['…'] = { __t: 'trunc', n: keys.length - MAX_KEYS };
      }
      seen.pop();
      return out;
    } catch (e) { return { __t: 'num', v: '[unserialisable]' }; }
  }
  function emit(level, args, extra) {
    try {
      if (typeof g.__maxLog !== 'function') return;
      var a = [];
      for (var i = 0; i < args.length; i++) a.push(ser(args[i], 0, []));
      var o = { id: 'l' + (++seq) + '.' + Date.now(), level: level, args: a, ts: Date.now() };
      if (extra) for (var k in extra) o[k] = extra[k];
      g.__maxLog(JSON.stringify(o));
    } catch (e) {}
  }
  ['log', 'info', 'warn', 'error', 'debug', 'trace'].forEach(function (lvl) {
    var orig = g.console[lvl];
    if (typeof orig !== 'function') return;
    g.console[lvl] = function () {
      var extra = null;
      if (lvl === 'trace' || lvl === 'error') { try { extra = { stack: String(new Error().stack || '').split('\\n').slice(2).join('\\n') }; } catch (e) {} }
      emit(lvl === 'trace' ? 'debug' : lvl, arguments, extra);
      return orig.apply(this, arguments);
    };
  });
  try {
    var EU = g.ErrorUtils;
    if (EU && EU.getGlobalHandler && EU.setGlobalHandler) {
      var prev = EU.getGlobalHandler();
      EU.setGlobalHandler(function (err, isFatal) {
        emit('error', [err], { uncaught: true, fatal: !!isFatal });
        if (prev) return prev(err, isFatal);
      });
    }
  } catch (e) {}
  return 'installed';
})()`;
// One evaluate installs both; it reports 'ready' only when both are in place.
const INSTALL = `(function () { var n = ${RECORDER}; if (n !== 'installed' && n !== 'already-installed') return n; var l = ${LOGGER}; return (l === 'installed' || l === 'already-installed') ? 'ready' : l; })()`;

function parseHeaders(raw) {
  const out = {};
  for (const line of String(raw || '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

// fetch() responses arrive as base64 data URLs: decode text types, describe the rest.
function decodeBody(ev) {
  if (!ev.dataUrl) return;
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(ev.dataUrl);
  delete ev.dataUrl;
  if (!m) return;
  const type = ev.headers['content-type'] || m[1] || '';
  const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
  if (!type || TEXTUAL.test(type)) ev.body = buf.toString('utf8');
  else ev.binary = true;
  ev.size = buf.length;
}

module.exports = function createRnNet(send) {
  const conns = new Map(); // target id -> { ws, target, state }
  const blocked = new Set(); // target ids React Native DevTools took over
  let timer = null;
  let running = false;

  const status = () => ({
    running,
    ports: PORTS,
    targets: [...conns.values()].map((c) => ({ id: c.target.id, app: c.target.appId || c.target.title, device: c.target.deviceName || '', state: c.state })),
  });
  const pushStatus = () => send('rnnet:status', status());

  async function listTargets() {
    const all = await Promise.all(
      PORTS.map(async (port) => {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(800) });
          const list = await res.json();
          return Array.isArray(list) ? list.map((t) => ({ ...t, port })) : [];
        } catch {
          return []; // nothing listening on this port
        }
      }),
    );
    // The app's JS runtime only — not Reanimated's UI runtime or other helpers.
    return all.flat().filter((t) => t.webSocketDebuggerUrl && /React Native/i.test(t.description || '') && !/Reanimated/i.test(t.description || ''));
  }

  function connect(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const conn = { ws, target, state: 'connecting', nextId: 1, ignored: new Set(), contexts: 0 };
    const targetInfo = { id: target.id, app: target.appId || target.title, device: target.deviceName || '' };
    // React Native's own dev traffic to Metro (symbolication, logs) isn't the app's: hide it.
    const metro = new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|10\\.0\\.2\\.2|[\\d.]+):${target.port}/`);
    conns.set(target.id, conn);
    const call = (method, params = {}) => ws.readyState === 1 && ws.send(JSON.stringify({ id: conn.nextId++, method, params }));
    conn.call = call;
    const install = () => {
      call('Runtime.addBinding', { name: '__maxNet' });
      call('Runtime.addBinding', { name: '__maxLog' });
      conn.tries = 0;
      evaluateRecorder();
    };
    // In a brand-new runtime (after a reload) we run before the app's bundle has loaded and
    // React Native hasn't defined XMLHttpRequest yet: retry until it has. RN sets it up in its
    // core init, before any app code can make a request.
    const evaluateRecorder = () => {
      clearTimeout(conn.retry);
      conn.installId = conn.nextId;
      call('Runtime.evaluate', { expression: INSTALL, returnByValue: true });
    };
    ws.onopen = () => {
      conn.state = 'connected';
      call('Runtime.enable');
      install();
      pushStatus();
    };
    ws.onmessage = (m) => {
      let msg;
      try {
        msg = JSON.parse(m.data);
      } catch {
        return;
      }
      // A JS reload gives a fresh runtime: install the recorder again.
      if (msg.method === 'Runtime.executionContextCreated') {
        install();
        // Runtime.enable reports the existing context too; only later ones are reloads.
        if (conn.contexts++) send('rnnet:console', { t: 'reload', ts: Date.now(), target: targetInfo });
      }
      if (msg.id && msg.id === conn.installId) {
        const v = msg.result?.result?.value;
        if (v !== 'ready' && conn.tries++ < 400) conn.retry = setTimeout(evaluateRecorder, 25);
        return;
      }
      if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__maxLog') {
        try {
          send('rnnet:console', { t: 'log', ...JSON.parse(msg.params.payload), target: targetInfo });
        } catch {
          /* ignore malformed */
        }
        return;
      }
      if (msg.method !== 'Runtime.bindingCalled' || msg.params?.name !== '__maxNet') return;
      let ev;
      try {
        ev = JSON.parse(msg.params.payload);
      } catch {
        return;
      }
      if (ev.t === 'req' && metro.test(ev.url)) conn.ignored.add(ev.id);
      if (conn.ignored.has(ev.id)) {
        if (ev.t !== 'req') conn.ignored.delete(ev.id);
        return;
      }
      if (ev.t === 'res') {
        ev.headers = parseHeaders(ev.headers);
        decodeBody(ev);
      }
      ev.target = targetInfo;
      send('rnnet:event', ev);
    };
    ws.onclose = (e) => {
      clearTimeout(conn.retry);
      if (conns.get(target.id) !== conn) return;
      if (String(e.reason || '').includes('NEW_DEBUGGER_OPENED')) {
        // React Native DevTools (or another debugger) took over: don't steal it back.
        blocked.add(target.id);
        conn.state = 'devtools';
      } else conns.delete(target.id);
      pushStatus();
    };
    ws.onerror = () => {};
  }

  async function scan() {
    if (!running) return;
    const targets = await listTargets();
    const live = new Set(targets.map((t) => t.id));
    // Apps that went away (closed, or Metro stopped).
    for (const [id, c] of conns) {
      if (!live.has(id)) {
        try {
          c.ws.close();
        } catch {
          /* ignore */
        }
        conns.delete(id);
        blocked.delete(id);
      }
    }
    for (const t of targets) if (!conns.has(t.id) && !blocked.has(t.id)) connect(t);
    pushStatus();
  }

  return {
    start() {
      if (running) return pushStatus();
      running = true;
      const tick = async () => {
        await scan();
        if (!running) return;
        const connected = [...conns.values()].some((c) => c.state === 'connected');
        timer = setTimeout(tick, connected ? SCAN_IDLE_MS : SCAN_MS);
      };
      tick();
    },
    stop() {
      running = false;
      clearTimeout(timer);
      for (const c of conns.values()) {
        try {
          c.ws.close();
        } catch {
          /* ignore */
        }
      }
      conns.clear();
      pushStatus();
    },
    // Reload the app's JS. We stay attached across a reload and reinstall the recorder as soon
    // as the new runtime exists, so this captures the startup requests a cold launch misses.
    reload() {
      for (const c of conns.values()) if (c.state === 'connected') c.call('Page.reload');
    },
    // Take the connection back from React Native DevTools.
    reconnect() {
      blocked.clear();
      for (const [id, c] of conns) if (c.state === 'devtools') conns.delete(id);
      scan();
    },
    status,
  };
};
