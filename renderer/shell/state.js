/* global deck */
'use strict';

// The shell: sidebar, workspace views and their tabs, command menu, shortcuts. Its scripts are
// plain (no modules) and share one global scope, so they load in the order index.html lists:
// state → terminals → tabs → sidebar → new-worktree → tooltip → palette → app (events, keys, boot).
// `deck` is the API exposed by main/preload.js; `Kit` holds the helpers every script shares.
const { $, h, icon, store, trackDrag, escapeRe, ipcError, matIconSrc } = window.Kit;

const STATUS_TEXT = {
  dormant: 'Not started',
  starting: 'Starting…',
  idle: 'Ready',
  running: 'Working…',
  waiting: 'Needs input',
  done: 'Done — review',
  exited: 'Exited',
};

// workspaces/repos/activeId/home come from the main process at boot; runtime is each workspace's
// live status (pushed by the main process), git its branch + diff stat (polled).
const S = { workspaces: [], runtime: {}, activeId: null, repos: {}, git: {}, home: '' };
const views = new Map(); // wsId -> view
const terms = new Map(); // key -> { term, fit, host, wsId, kind }

const statusOf = (id) => S.runtime[id]?.status || 'dormant';
const wsById = (id) => S.workspaces.find((w) => w.id === id);

const repoName = (repo) => repo.split('/').filter(Boolean).pop() || repo;
const shortPath = (p) => (S.home && p.startsWith(S.home) ? `~${p.slice(S.home.length)}` : p);
// Every worktree branch starts with deck/; that's noise in the UI.
const shortBranch = (b) => (b || '').replace(/^deck\//, '');
