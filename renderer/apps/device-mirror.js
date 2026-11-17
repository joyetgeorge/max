/* global deck */
'use strict';

// Device Mirror: a live view of a booted iOS Simulator or an Android device/emulator (see
// main/devices.js), refreshed by repeated screenshots while the tab is visible. On Android you can
// tap, swipe, type and press Back / Home / Recents on the picture. Any device: open a deep link,
// copy or save the frame, or send it to the active workspace's Claude as an image path.
(() => {
  const { node: el, icon: ph, store, ipcError } = window.Kit;
  const { button, sendToClaude } = window.DeckApps.ui;
  const RATES = [
    ['0', 'As fast as possible'],
    ['1000', 'Every second'],
    ['3000', 'Every 3 seconds'],
    ['-1', 'Paused'],
  ];

  function deviceMirrorApp() {
    let devices = [];
    let deviceId = store.get('deck.app.mirror.device', '');
    let rate = Number(store.get('deck.app.mirror.rate', '0'));
    let frame = null; // { w, h } of the last frame, in device pixels
    let looping = false;
    let wake = null; // resolves the loop's current wait early (after input, or a setting change)
    let frames = [];

    const root = el('div', 'app app-mirror');
    const visible = () => root.isConnected && root.offsetParent !== null && !document.hidden;
    const sleep = (ms) =>
      new Promise((res) => {
        const t = setTimeout(done, ms);
        function done() {
          clearTimeout(t);
          wake = null;
          res();
        }
        wake = done;
      });
    const kick = () => wake?.();
    const current = () => devices.find((d) => d.id === deviceId);

    // ----- toolbar -----
    const devSelect = el('select', 'ac-select dm-device');
    devSelect.title = 'Device';
    devSelect.addEventListener('change', () => {
      deviceId = devSelect.value;
      store.set('deck.app.mirror.device', deviceId);
      frame = null;
      img.removeAttribute('src');
      sync();
      kick();
    });
    const rateSelect = el('select', 'ac-select');
    rateSelect.title = 'Refresh rate';
    for (const [v, label] of RATES) {
      const o = el('option', '', label);
      o.value = v;
      rateSelect.append(o);
    }
    rateSelect.value = String(rate);
    rateSelect.addEventListener('change', () => {
      rate = Number(rateSelect.value);
      store.set('deck.app.mirror.rate', String(rate));
      sync();
      kick();
    });
    const refreshBtn = button('', 'arrows-clockwise', 'Look for devices again', () => refreshDevices());
    const shotBtn = button('', 'camera', 'Take a screenshot now', () => captureOnce());
    const copyBtn = button('', 'copy', 'Copy the screenshot', () => act(() => deck.devCopy(deviceId), 'Copied to the clipboard'));
    const saveBtn = button('', 'download-simple', 'Save the screenshot as a PNG', () =>
      act(async () => {
        const file = await deck.devSave(deviceId);
        return file && `Saved ${file}`;
      }),
    );
    const claudeBtn = button('Send to Claude', 'paper-plane-tilt', 'Paste this screenshot into the active workspace’s Claude prompt', () =>
      act(async () => {
        const file = await deck.devSaveTemp(deviceId);
        const err = sendToClaude(`${file} `);
        if (err) throw new Error(err);
      }),
    );
    const simBtn = button('', 'device-mobile', 'Open the Simulator app', () => deck.devOpenSimulator());
    const urlInput = el('input', 'nw-search dm-url');
    urlInput.placeholder = 'Open a URL or deep link (myapp://…)';
    urlInput.spellcheck = false;
    urlInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && urlInput.value.trim()) {
        const url = urlInput.value.trim();
        store.set('deck.app.mirror.url', url);
        act(() => deck.devOpenUrl(deviceId, url), `Opened ${url}`).then(kick);
      }
    });
    urlInput.value = store.get('deck.app.mirror.url', '');
    const bar = el('div', 'app-bar nw-bar', devSelect, refreshBtn, rateSelect, shotBtn, el('span', 'app-spacer'), urlInput, copyBtn, saveBtn, claudeBtn, simBtn);

    // ----- the screen -----
    const img = el('img', 'dm-screen');
    img.draggable = false;
    img.alt = '';
    const placeholder = el('div', 'dm-empty');
    const stage = el('div', 'dm-stage', img, placeholder);

    // Android controls under the picture.
    const typeInput = el('input', 'nw-search dm-type');
    typeInput.placeholder = 'Type into the device (↵ sends, ⇧↵ also presses Enter)';
    typeInput.spellcheck = false;
    typeInput.addEventListener('keydown', async (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      const text = typeInput.value;
      typeInput.value = '';
      if (text) await act(() => deck.devInput(deviceId, { type: 'text', text }));
      if (e.shiftKey) await act(() => deck.devInput(deviceId, { type: 'key', key: 'enter' }));
      kick();
    });
    const key = (k, iconName, title) => button('', iconName, title, () => act(() => deck.devInput(deviceId, { type: 'key', key: k })).then(kick));
    const androidBar = el(
      'div',
      'dm-android',
      key('back', 'caret-left', 'Back'),
      key('home', 'circle', 'Home'),
      key('recents', 'square', 'Recent apps'),
      typeInput,
      key('del', 'backspace', 'Delete'),
      key('voldown', 'speaker-low', 'Volume down'),
      key('volup', 'speaker-high', 'Volume up'),
      key('power', 'power', 'Power'),
    );
    const status = el('div', 'app-status nw-summary');
    root.append(bar, stage, androidBar, status);

    function setStatus(text, cls = '') {
      status.className = `app-status nw-summary ${cls}`;
      status.textContent = text;
    }
    let flashT = null;
    async function act(fn, ok) {
      try {
        const msg = await fn();
        if (msg || ok) {
          setStatus(msg || ok, 'ok');
          clearTimeout(flashT);
          flashT = setTimeout(renderStatus, 2500);
        }
      } catch (e) {
        setStatus(ipcError(e), 'err');
        clearTimeout(flashT);
        flashT = setTimeout(renderStatus, 4000);
      }
    }
    function renderStatus() {
      const d = current();
      if (!d) return setStatus('');
      const fps = frames.length > 1 ? (frames.length - 1) / ((frames[frames.length - 1] - frames[0]) / 1000) : 0;
      setStatus(
        `${d.name} · ${d.os}${frame ? ` · ${frame.w}×${frame.h}` : ''}${rate >= 0 && fps ? ` · ${fps.toFixed(1)} fps` : ''}${d.platform === 'android' ? ' · click to tap, drag to swipe' : ' · view only (use the Simulator window to interact)'}`,
      );
    }

    function sync() {
      const d = current();
      const has = !!d;
      for (const b of [shotBtn, copyBtn, saveBtn, claudeBtn]) b.disabled = !has;
      urlInput.disabled = !has;
      simBtn.classList.toggle('hidden', !(d?.platform === 'ios'));
      androidBar.classList.toggle('hidden', d?.platform !== 'android');
      stage.classList.toggle('android', d?.platform === 'android');
      img.classList.toggle('hidden', !has || !frame);
      placeholder.classList.toggle('hidden', has && !!frame);
      if (!devices.length)
        placeholder.replaceChildren(
          ph('device-mobile-camera'),
          el('div', '', 'No devices found'),
          el('div', 'dm-empty-sub', 'Boot an iOS Simulator, start an Android emulator, or connect a device with USB debugging on'),
          button('Look again', 'arrows-clockwise', 'Look for devices again', () => refreshDevices()),
        );
      else if (!has) placeholder.replaceChildren(ph('device-mobile'), el('div', '', 'Choose a device'));
      else placeholder.replaceChildren(ph('circle-notch'), el('div', '', `Connecting to ${d.name}…`));
      renderStatus();
      if (has && rate >= 0) loop();
    }

    async function refreshDevices() {
      devices = await deck.devList().catch(() => []);
      const opts = devices.map((d) => {
        const o = el('option', '', `${d.name} — ${d.os}`);
        o.value = d.id;
        return o;
      });
      if (!devices.length) {
        const o = el('option', '', 'No devices');
        o.value = '';
        opts.push(o);
      }
      devSelect.replaceChildren(...opts);
      if (!devices.some((d) => d.id === deviceId)) deviceId = devices[0]?.id || '';
      devSelect.value = deviceId;
      sync();
    }

    function show(f) {
      frame = { w: f.w, h: f.h };
      img.src = f.src;
      const now = performance.now();
      frames.push(now);
      while (frames.length > 10 || (frames.length && now - frames[0] > 10000)) frames.shift();
      sync();
    }
    async function captureOnce() {
      if (!deviceId) return;
      try {
        show(await deck.devCapture(deviceId));
      } catch (e) {
        await act(() => Promise.reject(e));
        if (/no longer available/.test(e.message)) refreshDevices();
      }
    }
    async function loop() {
      if (looping) return;
      looping = true;
      try {
        while (deviceId && rate >= 0) {
          if (!visible()) {
            frames = [];
            await sleep(700);
            continue;
          }
          const t0 = performance.now();
          const id = deviceId;
          try {
            const f = await deck.devCapture(id);
            if (id === deviceId) show(f);
          } catch (e) {
            await act(() => Promise.reject(e));
            if (/no longer available/.test(e.message)) await refreshDevices();
            await sleep(2000);
            continue;
          }
          await sleep(Math.max(30, rate - (performance.now() - t0)));
        }
      } finally {
        looping = false;
      }
    }

    // ----- Android input: click to tap, drag to swipe (in device pixels) -----
    const toDevice = (ev) => {
      const r = img.getBoundingClientRect();
      return { x: ((ev.clientX - r.left) / r.width) * frame.w, y: ((ev.clientY - r.top) / r.height) * frame.h };
    };
    img.addEventListener('pointerdown', (e) => {
      if (current()?.platform !== 'android' || !frame || e.button !== 0) return;
      e.preventDefault();
      img.setPointerCapture(e.pointerId);
      const start = { ...toDevice(e), t: performance.now(), cx: e.clientX, cy: e.clientY };
      const ripple = el('span', 'dm-ripple');
      const sr = stage.getBoundingClientRect();
      ripple.style.left = `${e.clientX - sr.left}px`;
      ripple.style.top = `${e.clientY - sr.top}px`;
      stage.append(ripple);
      setTimeout(() => ripple.remove(), 500);
      const up = (ev) => {
        img.removeEventListener('pointerup', up);
        const end = toDevice(ev);
        const moved = Math.hypot(ev.clientX - start.cx, ev.clientY - start.cy) > 8;
        const ms = Math.round(performance.now() - start.t);
        const input = moved
          ? { type: 'swipe', x1: start.x, y1: start.y, x2: end.x, y2: end.y, ms: Math.min(2000, Math.max(80, ms)) }
          : ms > 500
            ? { type: 'swipe', x1: start.x, y1: start.y, x2: start.x, y2: start.y, ms } // long press
            : { type: 'tap', x: start.x, y: start.y };
        act(() => deck.devInput(deviceId, input)).then(() => setTimeout(kick, 120));
      };
      img.addEventListener('pointerup', up);
    });

    refreshDevices();
    return {
      el: root,
      focus: () => {
        refreshDevices();
        kick();
      },
    };
  }

  window.DeckApps.register({
    id: 'mirror',
    name: 'Device Mirror',
    desc: 'Live iOS Simulator & Android screen',
    icon: 'device-mobile',
    mat: 'image',
    color: 'var(--bot-5)',
    build: deviceMirrorApp,
  });
})();
