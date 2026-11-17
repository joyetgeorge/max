// Device Mirror — main-process side: booted iOS Simulators (xcrun simctl) and Android devices or
// emulators (adb). The renderer polls `capture` for frames; the last full-resolution frame of each
// device is kept here so Copy / Save / Send to Claude use exactly the picture on screen.
// Android also takes input (tap, swipe, keys, text) through `adb shell input`; the iOS Simulator
// has no command-line input, so it is view-only (plus deep links).

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nativeImage, clipboard } = require('electron');

const SHOT_DIR = path.join(os.tmpdir(), 'max-device-shots');
const MAX_FRAME_H = 1400; // frames sent to the renderer are scaled down to this height

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 15000, ...opts }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || '').trim() || err.message)) : resolve(stdout),
    ),
  );
}

// adb is often not on PATH for GUI apps even after the login-shell PATH fix; try the SDK too.
function adbPath() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library/Android/sdk');
  const p = path.join(sdk, 'platform-tools', 'adb');
  return fs.existsSync(p) ? p : 'adb';
}

async function listIos() {
  try {
    const out = JSON.parse(await run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']));
    const devs = [];
    for (const [runtime, list] of Object.entries(out.devices || {})) {
      const os_ = runtime.split('.').pop().replace(/^(iOS|watchOS|tvOS|xrOS|visionOS)-/, '$1 ').replace(/-/g, '.');
      for (const d of list) if (d.state === 'Booted') devs.push({ id: `ios:${d.udid}`, platform: 'ios', udid: d.udid, name: d.name, os: os_ });
    }
    return devs;
  } catch {
    return []; // no Xcode, or no booted simulator
  }
}

async function listAndroid() {
  try {
    const out = await run(adbPath(), ['devices', '-l'], { timeout: 5000 });
    return out
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => /\sdevice(\s|$)/.test(l))
      .map((l) => {
        const serial = l.split(/\s+/)[0];
        const model = /model:(\S+)/.exec(l)?.[1]?.replace(/_/g, ' ');
        return { id: `android:${serial}`, platform: 'android', serial, name: model || serial, os: serial.startsWith('emulator-') ? 'Emulator' : 'Android' };
      });
  } catch {
    return []; // no adb, or the server isn't running
  }
}

module.exports = function createDevices() {
  const last = new Map(); // device id -> { png: Buffer, w, h, ts }
  let known = new Map(); // device id -> device

  async function list() {
    const devs = [...(await listIos()), ...(await listAndroid())];
    known = new Map(devs.map((d) => [d.id, d]));
    return devs;
  }
  const dev = (id) => {
    const d = known.get(id);
    if (!d) throw new Error('That device is no longer available');
    return d;
  };
  const adb = (d, args, opts) => run(adbPath(), ['-s', d.serial, ...args], opts);

  async function screenshotPng(d) {
    if (d.platform === 'android') return adb(d, ['exec-out', 'screencap', '-p'], { encoding: 'buffer' });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const file = path.join(SHOT_DIR, `frame-${d.udid}.png`);
    await run('xcrun', ['simctl', 'io', d.udid, 'screenshot', '--type=png', file]);
    return fs.promises.readFile(file);
  }

  async function capture(id) {
    const d = dev(id);
    const png = await screenshotPng(d);
    const img = nativeImage.createFromBuffer(png);
    if (img.isEmpty()) throw new Error('The device returned an empty screenshot');
    const { width: w, height: h } = img.getSize();
    last.set(id, { png, w, h, ts: Date.now() });
    const small = h > MAX_FRAME_H ? img.resize({ height: MAX_FRAME_H, quality: 'good' }) : img;
    return { w, h, src: `data:image/jpeg;base64,${small.toJPEG(82).toString('base64')}` };
  }

  function lastFrame(id) {
    const f = last.get(id);
    if (!f) throw new Error('No screenshot yet');
    return f;
  }
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = (id) => `${(known.get(id)?.name || 'device').replace(/[^\w.-]+/g, '-')}-${stamp()}.png`;

  return {
    list,
    capture,
    // Writes the last frame to a temp file and returns its path (for pasting into Claude).
    async saveTemp(id) {
      const f = lastFrame(id);
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const file = path.join(SHOT_DIR, fileName(id));
      await fs.promises.writeFile(file, f.png);
      return file;
    },
    async saveTo(id, file) {
      await fs.promises.writeFile(file, lastFrame(id).png);
      return file;
    },
    defaultName: fileName,
    copy(id) {
      clipboard.writeImage(nativeImage.createFromBuffer(lastFrame(id).png));
    },
    async openUrl(id, url) {
      const d = dev(id);
      if (d.platform === 'ios') await run('xcrun', ['simctl', 'openurl', d.udid, url]);
      else await adb(d, ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${url.replace(/'/g, `'\\''`)}'`]);
    },
    // Android input, in device pixels.
    async input(id, ev) {
      const d = dev(id);
      if (d.platform !== 'android') throw new Error('Input is only supported on Android');
      const n = (v) => String(Math.max(0, Math.round(Number(v) || 0)));
      if (ev.type === 'tap') await adb(d, ['shell', 'input', 'tap', n(ev.x), n(ev.y)]);
      else if (ev.type === 'swipe') await adb(d, ['shell', 'input', 'swipe', n(ev.x1), n(ev.y1), n(ev.x2), n(ev.y2), n(ev.ms || 250)]);
      else if (ev.type === 'key') {
        const KEYS = { back: '4', home: '3', recents: '187', enter: '66', del: '67', menu: '82', power: '26', volup: '24', voldown: '25' };
        if (!KEYS[ev.key]) throw new Error(`Unknown key ${ev.key}`);
        await adb(d, ['shell', 'input', 'keyevent', KEYS[ev.key]]);
      } else if (ev.type === 'text') {
        // `input text` splits on spaces (%s is a space) and the device shell interprets the rest.
        const t = String(ev.text || '').replace(/[^\x20-\x7e]/g, '');
        if (!t) return;
        const esc = t.replace(/ /g, '%s').replace(/([\\'"`$&|;<>()*?#~!\[\]{}])/g, '\\$1');
        await adb(d, ['shell', 'input', 'text', esc]);
      }
    },
    async openSimulator() {
      await run('open', ['-a', 'Simulator']);
    },
  };
};
