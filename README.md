# Max

A desktop app for running several Claude Code agents in parallel, switching between them like browser tabs.
It takes ideas from [cmux](https://cmux.com) (vertical tabs, attention rings) and [Conductor](https://conductor.build) (worktree per agent, diff review).

## Run

```bash
npm install   # also rebuilds node-pty for Electron
npm start
```

Build an installable app (arm64, ad-hoc signed) with `npm run dist`. It writes `dist/Max-<version>-arm64.dmg`; `npm run dist:dir` builds just `dist/mac-arm64/Max.app`.

You need `claude` and `git` on your login-shell PATH. `gh` is needed for the Create PR button.

## How it works

- **Workspace = one agent.** Each workspace runs `claude` in a real PTY (xterm.js + node-pty), plus an optional shell.
  By default each one gets its own git worktree at `~/.max/worktrees/<repo>/<slug>` on a new `deck/<slug>` branch, so agents don't step on each other.
- **Live status from Claude Code hooks.** Each agent gets a `--settings` file with hooks (SessionStart, UserPromptSubmit, Pre/PostToolUse, Notification, Stop).
  The hooks POST to a token-protected `127.0.0.1` server in the app. That gives the sidebar these states:
  - blue pulse: working, with the current tool and file
  - amber ring: needs permission or input
  - green: done, ready for review
- When an agent needs you, you get a macOS notification and the dock badge shows how many agents are waiting.
- **Resume.** The app stores the session ID, so restarting the app or pressing ↻ runs `claude --resume <id>`.
- **Window tabs.** Everything in a workspace is a full-window tab that works like a browser tab: Claude, any number of shells,
  **Review** (diff against the merge-base with your base branch, including untracked files), **Files**, and the apps
  (JSON Editor, Network, RN Console, Device Mirror, Agent Activity, Converters, Notes, Tasks). **+** or ⌘T opens a New tab page to pick from. Tabs open next to the current one,
  close with × / ⌘W / middle-click, can be dragged to reorder, and ⌘⇧T reopens the last one you closed.
  Closing the Claude tab only hides it, and the agent keeps running. Closing a shell tab ends that shell.
  Each workspace's tabs are restored after quitting. Restored shells start fresh, because shell processes don't survive a quit.
- **Setup command.** Runs once in a new worktree's shell and is remembered per repo, e.g. `cp "$DECK_ROOT_PATH/.env" . && npm ci`.
  Available env vars: `DECK_ROOT_PATH`, `DECK_BASE_BRANCH`, `DECK_WORKSPACE`.
- **Create PR** types `git push -u origin HEAD && gh pr create --fill --web --base <base>` into the shell, without running it.

- **Network** shows every request of a React Native debug build running in a simulator or on a device:
  XHR, `fetch` and Apollo, with GraphQL requests named after their operation, plus Headers, Payload and Response views and Copy as cURL.
  It needs no changes to the app. Max finds the app through Metro (ports 8081, 8082, 8083, 19000), connects as its debugger,
  and installs a small XHR recorder with `Runtime.evaluate`. Metro allows one debugger per app, so opening React Native DevTools
  disconnects Max until you press Reconnect. Requests made before Max connects aren't captured.

- **RN Console** shows the same app's `console.*` output and uncaught errors over that connection. Objects expand in place,
  repeated messages collapse into one row with a count, and you can filter by level or text. The log can be kept or cleared
  when the app reloads. Any error or warning can be pasted into the workspace's Claude prompt with its stack trace.

- **Device Mirror** shows a live picture of a booted iOS Simulator (`xcrun simctl`) or an Android device or emulator (`adb`),
  refreshed while the tab is visible. On Android you can click to tap, drag to swipe, type text, and press Back / Home / Recents.
  The iOS Simulator is view-only, because it takes no command-line input. On either platform you can open a URL or deep link,
  copy or save the screenshot, or **Send to Claude**, which pastes the screenshot's file path into the Claude prompt.

- **Agent Activity** is a live timeline of every workspace's agent, built from the hooks Max already installs. It shows prompts,
  tool calls with their duration and result (failed ones in red), questions waiting for you, finished turns (how long they took
  and how many tool calls they used), subagents and context compactions. Cards along the top show what each agent is doing now.
  Filter by workspace, kind or text, and click a row to see the tool's input and output. The timeline holds the last 3,000 events
  of the current run.

- **Converters** collects small offline tools: encode/decode (Base64, Base64 URL, URL, HTML entities, JSON string, hex),
  a JWT decoder with expiry, timestamps (s/ms/µs/ns or any date), a regex tester with groups and replace, text diff, hashes,
  UUIDs, case conversion, number bases and colours (with Swift/Android forms and contrast).

- **Tasks** is a kanban board (To do / In progress / Done). Each task can have a due date and time, a priority, #tags, notes and subtasks.
  Quick add understands `#tag` and `!` / `!!` / `!!!` for priority. Due badges turn amber within the hour and red when overdue.
  When a task falls due you get a macOS notification, and clicking it opens the task. Reminders run while Max is running,
  even with the window hidden. Anything that fell due while Max was quit is notified at the next launch.

## Shortcuts

| Keys | Action |
|---|---|
| ⌘N | New workspace |
| ⌘K | Command menu |
| ⌘1–9 | Switch workspace |
| ⌘⇧[ / ⌘⇧] | Previous / next workspace |
| ⌘J | Jump to next workspace needing attention |
| ⌘T / ⌘⇧A | New tab |
| ⌘W | Close tab (in Files, open editors close first) |
| ⌘⇧T | Reopen closed tab |
| ⌃Tab / ⌃⇧Tab | Next / previous tab |
| ⌃1–8 / ⌃9 | Go to tab 1–8 / the last tab |
| ⌘⇧D | Review tab (VS Code–style diff, list/tree) |
| ⌘⇧E | Files tab: browse the worktree, with rendered Markdown (Preview / Source) |
| ⌘P | Go to file: fuzzy-find by name (`name:42` jumps to line 42) |
| ⌘⇧F | Search in files (ripgrep): match case, whole word, regex, files to include/exclude |
| ⌘← / ⌘→ | Start / end of line in the terminal (⌘⌫ deletes to line start) |
| ⌥← / ⌥→ | Previous / next word in the terminal |
| ⌘\` | Shell tab (on a shell already: a new one) |
| ⌘⇧R | Restart Claude (resume) |
| ⇧↵ | Newline in Claude's prompt |

Double-click a workspace to rename it. Drag workspaces to reorder them.

## Notes

- Claude asks you to trust each new worktree folder once.
- State is stored in `~/Library/Application Support/max/state.json`.
- Agents start lazily the first time you open their workspace.
- The window has no close/minimize/zoom buttons. Use ⌘Q to quit, ⌘M to minimize and ⌃⌘F for full screen. Drag the window by the sidebar header or the toolbar.
- **Theme is defined in `main/app-theme.js`**: font, size, line height, background/foreground, the 16 ANSI colours (also used for syntax, status and diff colours), selection, cursor, window opacity and blur (a translucent window over a native macOS blur), terminal padding, scrollback and the accent colour. Edit it and restart to restyle Max.
  - The diff view's syntax colours are taken from the same ANSI palette.
  - Exceptions: changing the opacity between 1 and below 1 needs an app restart, and FiraCode ligatures are not rendered.
- File and folder icons come from the Material Icon Theme (`material-icon-theme` npm package), matched the way VS Code matches them.
