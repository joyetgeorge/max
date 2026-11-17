# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Max (repo name `max`) is a macOS Electron app for running several Claude Code agents side by side. Each **workspace** is one `claude` process in a real PTY, usually in its own git worktree, with browser-style **tabs** (Claude, shells, Review, Files, apps). See README.md for user-facing features and shortcuts.

## Commands

```bash
npm install        # also rebuilds node-pty for Electron (postinstall)
npm start          # run the app from source (electron .)
npm run dist       # production build → dist/Max-<version>-arm64.dmg + .zip
npm run dist:dir   # just dist/mac-arm64/Max.app (faster)
node --check <file>  # there is no linter/bundler/test runner; syntax-check edited JS
```

**Smoke test** (the only automated check): `main/index.js` has a headless-ish mode driven by env vars. Use a throwaway data folder so real workspaces are never touched:

```bash
DECK_USER_DATA=/tmp/max-test DECK_SMOKE_SHOT=/tmp/max-test/shot.png DECK_SMOKE_DELAY=8000 \
DECK_SMOKE_EVAL="console.log('[SMOKE]', S.workspaces.length)" ELECTRON_ENABLE_LOGGING=1 \
npx electron . 2>&1 | grep SMOKE
```

`DECK_SMOKE_EVAL` runs in the renderer after 3 s (renderer globals like `S`, `views`, `openTab`, `activateTab` are reachable); a screenshot is written and the app quits after `DECK_SMOKE_DELAY` ms. Seed `$DECK_USER_DATA/state.json` with a workspace (set `"claudeCommand": "true ||"` to avoid launching a real `claude`). Read the PNG to check UI changes.

## Architecture

**Main process** (`main/`, CommonJS; entry `main/index.js`) owns everything stateful: `state.json` (workspaces, repos), PTYs (`node-pty`, keyed `` `${wsId}:${kind}` `` — `claude`, `shell`, `shell-2`…), git/worktrees, notifications, and a token-protected localhost HTTP server that Claude Code hooks POST to. Each workspace's `claude` is launched with `--settings <hooks/<wsId>.json>` whose hooks `curl` that server; `index.js` turns hook events into the status shown in the sidebar (`setStatus` → `ws:status`). The workspace's Claude command can be overridden per repo (e.g. a launcher script); Max's own args are appended to it.

`index.js` keeps the app lifecycle, window, workspaces, PTYs and the IPC handlers (`registerIpc`; `handleWs` passes the workspace instead of its id). The rest is one module per concern:
- `state.js` — `createStore()`: loads `state.json`, saves it atomically with rolling backups
- `hooks.js` — the hook server and the per-workspace settings files (`EVENTS` lists the hook events Max subscribes to)
- `git.js` — git for a workspace: branch + diff stat, changed files, file diff, discard, status letters
- `files.js` — the Files tab: folder listing, ⌘P file list, read, save
- `search.js` — find in files (ripgrep, `git grep` fallback)
- `code-nav.js` — go-to-definition: the project's own `tsserver` per worktree, falling back to the main checkout's `node_modules`, then a ripgrep declaration search
- `rn-net.js` — React Native network inspector and console: attaches to the app's JS runtime through Metro's CDP proxy and installs an XHR recorder and a console/error logger via `Runtime.evaluate`/`Runtime.addBinding`
- `activity.js` — the in-memory hook-event log behind Agent Activity (a PreToolUse/PostToolUse pair becomes one entry)
- `devices.js` — Device Mirror: booted iOS Simulators (`xcrun simctl`) and Android devices (`adb`), screenshots and Android input
- `icons.js` — the Material Icon Theme manifest and icon names
- `app-theme.js` — the constant theme object (fonts, colours, opacity), sent to the renderer at startup
- `util.js` — `escapeRe`, `sh`, `slugify`, `insideCwd`, `eachLine`, `kill`

Everything in `main/` and `renderer/` is packaged (`build.files` in `package.json`); a new top-level folder would have to be added there.

**Preload** (`main/preload.js`) exposes one object, `window.deck`, mapping to `ipcMain.handle`/`send` channels named `area:action` (`ws:create`, `term:start`, `fs:search`, `code:definition`, …). Adding a feature that crosses processes means touching all three: the handler in `main/index.js`, the bridge in `main/preload.js`, the caller in `renderer/`.

**Renderer** (`renderer/`) is plain browser JS — no bundler, no modules. `index.html` loads the scripts in order; paths like `../node_modules/…` in scripts are relative to `index.html`, in stylesheets to the stylesheet.
- `lib/kit.js` → `Kit`: the helpers every script uses — DOM (`h` takes attributes, `node` a class string; `icon()` returns an element, `ph()` the same icon as an **HTML string** for `btn()`), `store` (localStorage that never throws, with JSON helpers), `loadPrefs`, file/folder icons, `ipcError`, `escapeRe`…
- `lib/theme.js` → `AppTheme` (CSS variables + xterm options derived from `main/app-theme.js`; all colours come from these variables)
- `views/review.js` → `Review` (diff view)
- `views/search.js` → `QuickOpen` (⌘P) and `SearchPanel` (⌘⇧F, mounted in the Files tab sidebar)
- `views/explorer.js` → `Explorer` (Files tab: tree + Monaco editor, loaded lazily via its AMD loader from `node_modules/monaco-editor/min`; also language detection, extra JS/TS highlighting rules, and the definition provider/editor opener)
- `apps/` → `DeckApps`: `index.js` is the registry (one shared instance per app whose element is moved into whichever workspace tab shows it); `json.js`, `network.js`, `notes.js`, `tasks.js`, `activity.js`, `rn-console.js`, `device-mirror.js`, `converters.js` each `DeckApps.register()` one app. A new app is a new file there plus a `<script>` tag. Apps share `DeckApps.ui` (`button`, `copy`, `sendToClaude`, which bracket-pastes text into the active workspace's Claude prompt).
- `shell/` — the shell. Unlike the files above (IIFEs that publish one global), these share the global scope, so their order matters: `state.js` (`S`, `views`, `terms`), `terminals.js`, `tabs.js` (the tab system: `openTab`/`activateTab`/`closeTab`, `TAB_KINDS`/`kindInfo`), `sidebar.js`, `new-worktree.js` (the ⌘N form), `tooltip.js`, `palette.js` (⌘K), `app.js` (git polling, events from the main process, global shortcuts — one capture-phase `keydown` handler; terminals let `isAppShortcut` keys through — and boot).
- `styles/` — `shell.css`, `apps.css`, `review.css`, `explorer.css` (the Files tab reuses the review layout's `.rv-*` classes).

Per-workspace view = `views.get(wsId)` with `v.tabs`; tab layouts persist in `localStorage` (`deck.tabs.<wsId>`), app data under `deck.app.*`.

## Things that bite

- **⌘R reloads only the renderer.** Changes to anything in `main/` need a full restart of the app.
- **One copy per data folder.** The installed Max and `npm start` share `~/Library/Application Support/max` (via `app.setPath('userData')`). A second launch quits immediately and hands over through `requestSingleInstanceLock`; the running copy asks whether to switch. Two copies writing at once is what used to corrupt `state.json` — it is now written atomically with rolling backups in `state-backups/`, and an unreadable file falls back to the newest backup. Keep the store in `main/state.js` the only writer.
- **CSP** in `index.html` is strict (`script-src 'self'`, no `unsafe-eval`): runtime code generation (e.g. JavaScript query languages) is blocked; fonts/images need `data:` allowances.
- Worktrees live in `~/.max/worktrees/<repo>/<slug>` on `deck/<slug>` branches; the slug ends with the workspace id's first 4 characters (used to re-adopt orphaned worktrees on startup).
- Packaged builds are ad-hoc signed and not notarized, arm64 only.
