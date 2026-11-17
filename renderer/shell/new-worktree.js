/* global deck */
'use strict';

// ---------- new workspace modal ----------
const modal = $('#modal');
const f = {
  repo: $('#f-repo'),
  base: $('#f-base'),
  name: $('#f-name'),
  worktree: $('#f-worktree'),
  prompt: $('#f-prompt'),
  setup: $('#f-setup'),
  claudeCmd: $('#f-claude-cmd'),
  setupWrap: $('#f-setup-wrap'),
  error: $('#f-error'),
  submit: $('#f-submit'),
};

function recentRepos() {
  const fromWs = S.workspaces.map((w) => w.repo);
  const known = Object.entries(S.repos)
    .sort((a, b) => (b[1].lastUsed || 0) - (a[1].lastUsed || 0))
    .map(([r]) => r);
  return [...new Set([...known, ...fromWs])];
}

async function loadRepo(dir) {
  f.error.textContent = '';
  f.base.replaceChildren();
  try {
    const info = await deck.inspectRepo(dir);
    if (![...f.repo.options].some((o) => o.value === info.root)) f.repo.prepend(h('option', { value: info.root }, shortPath(info.root)));
    f.repo.value = info.root;
    f.base.replaceChildren(...info.branches.map((b) => h('option', { value: b, selected: b === info.current }, b)));
    f.setup.value = info.setup;
    f.claudeCmd.value = info.claudeCommand;
    f.submit.disabled = false;
  } catch (e) {
    f.error.textContent = `Not a git repository: ${ipcError(e)}`;
    f.submit.disabled = true;
  }
}

async function openModal(preferRepo) {
  const repos = recentRepos();
  f.repo.replaceChildren(...repos.map((r) => h('option', { value: r }, shortPath(r))));
  f.name.value = '';
  f.prompt.value = '';
  f.error.textContent = '';
  modal.classList.remove('hidden');
  const current = (typeof preferRepo === 'string' && preferRepo) || wsById(S.activeId)?.repo || repos[0];
  if (current) {
    await loadRepo(current);
    f.prompt.focus();
  } else {
    f.submit.disabled = true;
    const dir = await deck.pickRepo();
    if (dir) await loadRepo(dir);
  }
}
const closeModal = () => {
  modal.classList.add('hidden');
  focusActive();
};

$('#f-browse').addEventListener('click', async () => {
  const dir = await deck.pickRepo();
  if (dir) loadRepo(dir);
});
f.repo.addEventListener('change', () => loadRepo(f.repo.value));
f.worktree.addEventListener('change', () => {
  f.setupWrap.classList.toggle('hidden', !f.worktree.checked);
  // Without a worktree the repo root itself is switched to this branch.
  $('#f-base-label').textContent = f.worktree.checked ? 'Base branch' : 'Branch (checked out in the repo)';
});
$('#f-cancel').addEventListener('click', closeModal);
modal.addEventListener('mousedown', (e) => e.target === modal && closeModal());
modal.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && e.metaKey) {
    e.preventDefault();
    $('#new-form').requestSubmit();
  }
});
$('#new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (f.submit.disabled) return;
  f.submit.disabled = true;
  f.error.textContent = '';
  try {
    const ws = await deck.createWorkspace({
      repo: f.repo.value,
      name: f.name.value.trim(),
      useWorktree: f.worktree.checked,
      baseBranch: f.base.value,
      prompt: f.prompt.value.trim(),
      setup: f.setup.value.trim(),
      claudeCommand: f.claudeCmd.value.trim(),
    });
    S.workspaces.push(ws);
    S.repos[ws.repo] = { ...(S.repos[ws.repo] || {}), setup: f.setup.value.trim(), claudeCommand: f.claudeCmd.value.trim() || undefined, lastUsed: Date.now() };
    modal.classList.add('hidden');
    select(ws.id);
    // The setup command runs in a background Shell tab; Claude keeps the focus.
    if (ws.pendingSetup) openTab(ws.id, 'shell', { activate: false });
  } catch (err) {
    f.error.textContent = ipcError(err);
  } finally {
    f.submit.disabled = false;
  }
});
$('#btn-new-empty').addEventListener('click', () => openModal());
