/* global hljs, deck */
// VS Code–style change review: file list/tree on the left, full-file diff on the right.
'use strict';

(function () {
  const { esc, node, btn, ph, segmented, crumbs, sidePanelSash, loadPrefs, ipcError, baseName, isMarkdown, fileIcon, folderIcon, iconsReady } = window.Kit;
  const { GIT_STATUS: STATUS, GIT_STATUS_RANK: STATUS_RANK } = window.Kit;
  const [prefs, savePrefs] = loadPrefs('deck.review.prefs', { tree: true, layout: 'inline', scope: 'all', mode: 'full', sideW: 280 });

  const SVG = {
    chevron: ph('caret-right'),
    list: ph('list'),
    tree: ph('tree-structure'),
    refresh: ph('arrow-clockwise'),
    collapse: ph('arrows-in-line-vertical'),
    open: ph('arrow-square-out'),
    revert: ph('arrow-counter-clockwise'),
    up: ph('arrow-up'),
    down: ph('arrow-down'),
    close: ph('x'),
  };

  // ---------- highlighting ----------
  const LANG_BY_EXT = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', md: 'markdown', css: 'css', scss: 'scss', html: 'xml', xml: 'xml', plist: 'xml', svg: 'xml',
    gql: 'graphql', graphql: 'graphql', yml: 'yaml', yaml: 'yaml', sh: 'bash', zsh: 'bash', swift: 'swift', kt: 'kotlin',
    java: 'java', m: 'objectivec', mm: 'objectivec', h: 'objectivec', rb: 'ruby', py: 'python', gradle: 'groovy', diff: 'diff',
  };
  function langFor(p) {
    const base = p.split('/').pop();
    if (/^(Podfile|Gemfile|Fastfile|Appfile)$/.test(base)) return 'ruby';
    if (base === 'Dockerfile') return 'dockerfile';
    const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
    const lang = LANG_BY_EXT[ext];
    return lang && hljs.getLanguage(lang) ? lang : null;
  }

  // Highlight a whole file, then split into per-line HTML that keeps spans balanced,
  // so multi-line tokens (comments, template strings) colour correctly.
  function highlightLines(lines, lang) {
    const text = lines.join('\n');
    if (!lang || text.length > 400000) return lines.map(esc);
    let html;
    try {
      html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    } catch {
      return lines.map(esc);
    }
    const out = [];
    const stack = [];
    let cur = '';
    const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)/g;
    let m;
    while ((m = re.exec(html))) {
      if (m[1]) {
        stack.push(m[1]);
        cur += m[1];
      } else if (m[2]) {
        stack.pop();
        cur += m[2];
      } else if (m[3]) {
        out.push(cur + '</span>'.repeat(stack.length));
        cur = stack.join('');
      } else cur += m[4];
    }
    out.push(cur);
    return out.length === lines.length ? out : lines.map(esc);
  }

  // ---------- intra-line (word) diff ----------
  const tokenize = (s) => s.match(/\w+|\s+|[^\w\s]/g) || [];
  function wordDiff(a, b) {
    const A = tokenize(a);
    const B = tokenize(b);
    const n = A.length;
    const m = B.length;
    if (!n || !m || n * m > 200000) return null;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const keepA = new Array(n).fill(false);
    const keepB = new Array(m).fill(false);
    let common = 0;
    for (let i = 0, j = 0; i < n && j < m; ) {
      if (A[i] === B[j]) {
        keepA[i++] = true;
        keepB[j++] = true;
        common += A[i - 1].length;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    const nonWs = (s) => s.replace(/\s/g, '').length;
    if (common / Math.max(a.length, b.length, 1) < 0.35 || nonWs(a) === 0 || nonWs(b) === 0) return null;
    const ranges = (toks, keep) => {
      const r = [];
      let pos = 0;
      toks.forEach((t, i) => {
        if (!keep[i]) {
          const last = r[r.length - 1];
          if (last && last[1] === pos) last[1] += t.length;
          else r.push([pos, pos + t.length]);
        }
        pos += t.length;
      });
      return r;
    };
    return { del: ranges(A, keepA), add: ranges(B, keepB), ratio: common / Math.max(a.length, b.length, 1) };
  }

  // Wrap character ranges of an already-highlighted line in <span class=cls>, staying innermost.
  function markRanges(html, ranges, cls) {
    if (!ranges || !ranges.length) return html;
    const open = `<span class="${cls}">`;
    let out = '';
    let pos = 0;
    let ri = 0;
    let inMark = false;
    for (let i = 0; i < html.length; ) {
      if (html[i] === '<') {
        const j = html.indexOf('>', i);
        const tag = html.slice(i, j + 1);
        out += inMark ? `</span>${tag}${open}` : tag;
        i = j + 1;
        continue;
      }
      let ch;
      if (html[i] === '&') {
        const j = html.indexOf(';', i);
        ch = html.slice(i, j + 1);
        i = j + 1;
      } else ch = html[i++];
      while (ri < ranges.length && pos >= ranges[ri][1]) ri++;
      const want = ri < ranges.length && pos >= ranges[ri][0];
      if (want && !inMark) (out += open), (inMark = true);
      else if (!want && inMark) (out += '</span>'), (inMark = false);
      out += ch;
      pos++;
    }
    return inMark ? `${out}</span>` : out;
  }

  // ---------- diff model ----------
  // rows: { t: 'ctx'|'add'|'del'|'gap', o, n, html, block }
  function parseUnified(diff) {
    const rows = [];
    let o = 0;
    let n = 0;
    let started = false;
    for (const line of diff.split('\n')) {
      const hm = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hm) {
        const no = parseInt(hm[1], 10);
        const nn = parseInt(hm[2], 10);
        if (started ? no > o + 1 : no > 1) rows.push({ t: 'gap', count: no - (started ? o + 1 : 1) });
        o = no - 1;
        n = nn - 1;
        started = true;
        continue;
      }
      if (!started || line.startsWith('\\')) continue;
      const c = line[0];
      const text = line.slice(1);
      if (c === ' ') rows.push({ t: 'ctx', o: ++o, n: ++n, text });
      else if (c === '-') rows.push({ t: 'del', o: ++o, text });
      else if (c === '+') rows.push({ t: 'add', n: ++n, text });
    }
    return rows;
  }

  function decorate(rows, lang) {
    const oldLines = [];
    const newLines = [];
    for (const r of rows) {
      if (r.t === 'ctx' || r.t === 'del') oldLines.push(r.text);
      if (r.t === 'ctx' || r.t === 'add') newLines.push(r.text);
    }
    const oldHtml = highlightLines(oldLines, lang);
    const newHtml = highlightLines(newLines, lang);
    let oi = 0;
    let ni = 0;
    for (const r of rows) {
      if (r.t === 'ctx') {
        r.html = newHtml[ni++];
        oi++;
      } else if (r.t === 'del') r.html = oldHtml[oi++];
      else if (r.t === 'add') r.html = newHtml[ni++];
    }
    // Change blocks + word-level highlights for paired del/add lines.
    let block = -1;
    for (let i = 0; i < rows.length; ) {
      if (rows[i].t !== 'del' && rows[i].t !== 'add') {
        i++;
        continue;
      }
      block++;
      const dels = [];
      const adds = [];
      while (i < rows.length && rows[i].t === 'del') dels.push(rows[i++]);
      while (i < rows.length && rows[i].t === 'add') adds.push(rows[i++]);
      [...dels, ...adds].forEach((r) => (r.block = block));
      (dels[0] || adds[0]).blockStart = true;
      // Pair each removed line with its most similar added line (order-preserving),
      // so a line that moved down a row still gets a precise word diff.
      if (dels.length && adds.length && dels.length * adds.length <= 400) {
        let from = 0;
        for (const d of dels) {
          if (d.text.length > 400) continue;
          let best = null;
          let bestIdx = -1;
          for (let k = from; k < adds.length; k++) {
            if (adds[k].text.length > 400) continue;
            const wd = wordDiff(d.text, adds[k].text);
            if (wd && (!best || wd.ratio > best.ratio)) (best = wd), (bestIdx = k);
          }
          if (!best) continue;
          d.html = markRanges(d.html, best.del, 'wd-del');
          adds[bestIdx].html = markRanges(adds[bestIdx].html, best.add, 'wd-add');
          from = bestIdx + 1;
        }
      }
    }
    return block + 1;
  }

  // Collapse unchanged runs (in "changes" mode) into fold rows.
  function foldRows(rows, expanded, ctx = 3) {
    const changed = rows.map((r) => r.t === 'add' || r.t === 'del');
    const near = new Array(rows.length).fill(false);
    changed.forEach((c, i) => {
      if (!c) return;
      for (let k = Math.max(0, i - ctx); k <= Math.min(rows.length - 1, i + ctx); k++) near[k] = true;
    });
    const out = [];
    for (let i = 0; i < rows.length; ) {
      if (near[i] || rows[i].t === 'gap') {
        out.push(rows[i++]);
        continue;
      }
      let j = i;
      while (j < rows.length && !near[j] && rows[j].t !== 'gap') j++;
      if (j - i < 4 || expanded.has(i)) out.push(...rows.slice(i, j));
      else out.push({ t: 'fold', start: i, count: j - i });
      i = j;
    }
    return out;
  }

  // ---------- tree ----------
  function buildTree(files) {
    const root = { name: '', path: '', dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split('/');
      let cur = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts.slice(0, i + 1).join('/');
        if (!cur.dirs.has(parts[i])) cur.dirs.set(parts[i], { name: parts[i], path: p, dirs: new Map(), files: [] });
        cur = cur.dirs.get(parts[i]);
      }
      cur.files.push(f);
    }
    const compact = (d) => {
      for (const [k, child] of d.dirs) {
        let c = child;
        const names = [c.name];
        while (c.dirs.size === 1 && c.files.length === 0) {
          c = [...c.dirs.values()][0];
          names.push(c.name);
        }
        c.names = names;
        d.dirs.set(k, c);
        compact(c);
      }
    };
    compact(root);
    return root;
  }
  function worstStatus(d) {
    let best = null;
    const visit = (x) => {
      for (const f of x.files) if (!best || STATUS_RANK[f.status] > STATUS_RANK[best]) best = f.status;
      for (const c of x.dirs.values()) visit(c);
    };
    visit(d);
    return best;
  }

  // ---------- component ----------
  class Review {
    constructor(wsId, hooks) {
      this.wsId = wsId;
      this.hooks = hooks;
      this.files = [];
      this.selected = null;
      this.collapsed = new Set();
      this.expandedFolds = new Set();
      this.current = null; // { file, rows, blocks }
      this.blockIdx = -1;
      this.loadToken = 0;
      this.build();
    }

    build() {
      this.listEl = node('div', 'rv-files');
      this.listEl.tabIndex = 0;
      this.countEl = node('span', 'rv-count');
      this.viewToggle = btn('rv-icon', '', '', () => {
        prefs.tree = !prefs.tree;
        savePrefs();
        this.syncToggles();
        this.renderList();
      });
      this.collapseBtn = btn('rv-icon', 'Collapse all folders', SVG.collapse, () => {
        const all = new Set();
        const visit = (d) => d.dirs.forEach((c) => (all.add(c.path), visit(c)));
        visit(buildTree(this.files));
        this.collapsed = this.collapsed.size >= all.size ? new Set() : all;
        this.renderList();
      });
      // Segmented controls: each sets a pref, then redraws what depends on it.
      const pick = (pref, redraw) => (k) => {
        prefs[pref] = k;
        savePrefs();
        this.syncToggles();
        redraw();
      };
      const scope = segmented([['all', 'Branch'], ['uncommitted', 'Uncommitted']], pick('scope', () => this.refresh()));
      const layout = segmented([['inline', 'Inline'], ['split', 'Side by side']], pick('layout', () => this.renderDiff(true)));
      const mode = segmented([['full', 'Full file'], ['changes', 'Changes only']], pick('mode', () => this.renderDiff(true)));
      this.segs = { scope, layout, mode };
      this.baseEl = node('span', 'rv-base');

      const side = node(
        'aside',
        'rv-side',
        node(
          'div',
          'rv-side-head',
          node('span', 'rv-title', 'Changes'),
          this.countEl,
          node('span', 'rv-spacer'),
          this.viewToggle,
          this.collapseBtn,
          btn('rv-icon', 'Refresh', SVG.refresh, () => this.refresh()),
        ),
        node('div', 'rv-scope', scope.el, this.baseEl),
        this.listEl,
      );
      const sash = node('div', 'rv-sash');
      sidePanelSash(sash, side, prefs, savePrefs);

      // Main editor area
      this.tabIcon = node('span');
      this.tabName = node('span', 'rv-tab-name');
      this.tabDesc = node('span', 'rv-tab-desc');
      this.tabStatus = node('span', 'rv-tab-status');
      this.navPos = node('span', 'rv-navpos');
      this.prevBtn = btn('rv-icon', 'Previous change (⌥↑)', SVG.up, () => this.gotoBlock(-1));
      this.nextBtn = btn('rv-icon', 'Next change (⌥↓)', SVG.down, () => this.gotoBlock(1));
      this.openBtn = btn('rv-icon', 'Open file in VS Code', SVG.open, () => this.selected && deck.openFile(this.wsId, this.selected.path, this.firstChangedLine()));
      this.previewBtn = btn('rv-icon hidden', 'Preview Markdown', ph('eye'), () => this.selected && this.hooks.onPreview?.(this.selected.path));
      this.revertBtn = btn('rv-icon', 'Discard changes in this file', SVG.revert, () => this.selected && this.revert(this.selected));

      this.crumbs = node('div', 'rv-crumbs');
      this.body = node('div', 'rv-body hl');
      this.body.addEventListener('click', (e) => {
        const fold = e.target.closest('[data-fold]');
        if (fold) {
          this.expandedFolds.add(Number(fold.dataset.fold));
          this.renderDiff(false);
        }
      });
      this.body.addEventListener('dblclick', (e) => {
        const row = e.target.closest('[data-line]');
        if (row && this.selected) deck.openFile(this.wsId, this.selected.path, Number(row.dataset.line));
      });

      const main = node(
        'section',
        'rv-main',
        node(
          'div',
          'rv-tabbar',
          node('div', 'rv-tab', this.tabIcon, this.tabName, this.tabDesc, this.tabStatus),
          node('span', 'rv-spacer'),
          this.navPos,
          this.prevBtn,
          this.nextBtn,
          this.previewBtn,
          this.openBtn,
          this.revertBtn,
          node('span', 'rv-sep'),
          btn('rv-icon', 'Close review (Esc)', SVG.close, () => this.hooks.onClose()),
        ),
        node('div', 'rv-subbar', this.crumbs, mode.el, layout.el),
        this.body,
      );

      this.el = node('div', 'review hidden', side, sash, main);
      let lastSplit = null;
      new ResizeObserver(() => {
        const wantSplit = prefs.layout === 'split' && this.body.clientWidth >= 900;
        if (this.current && lastSplit !== null && wantSplit !== lastSplit) this.renderDiff(false);
        lastSplit = wantSplit;
      }).observe(this.body);
      this.el.tabIndex = -1;
      this.el.addEventListener('keydown', (e) => this.onKey(e));
      this.syncToggles();
    }

    syncToggles() {
      this.viewToggle.innerHTML = prefs.tree ? SVG.list : SVG.tree;
      this.viewToggle.title = prefs.tree ? 'View as list' : 'View as tree';
      this.collapseBtn.classList.toggle('hidden', !prefs.tree);
      for (const [pref, seg] of Object.entries(this.segs)) for (const [k, b] of Object.entries(seg.btns)) b.classList.toggle('on', prefs[pref] === k);
    }

    show() {
      this.el.classList.remove('hidden');
      this.refresh();
      this.listEl.focus();
    }
    hide() {
      this.el.classList.add('hidden');
    }
    get visible() {
      return !this.el.classList.contains('hidden');
    }

    async refresh() {
      await iconsReady;
      let res;
      try {
        res = await deck.gitChanges(this.wsId, prefs.scope);
      } catch (e) {
        this.listEl.innerHTML = `<div class="rv-empty">${esc(ipcError(e))}</div>`;
        return;
      }
      if (!res) return;
      this.files = res.files;
      this.countEl.textContent = String(res.files.length);
      this.baseEl.textContent = `vs ${res.base}`;
      // Keep the selection if the file is still changed; otherwise pick the first.
      const keep = this.selected && this.files.find((f) => f.path === this.selected.path);
      this.renderList();
      if (keep) this.select(keep, { keepScroll: true });
      else if (this.files.length) this.select(this.files[0]);
      else this.showEmpty('No changes', prefs.scope === 'uncommitted' ? 'Working tree matches HEAD.' : `Nothing differs from ${res.base} yet.`);
    }

    // ----- file list -----
    renderList() {
      this.listEl.replaceChildren();
      if (!this.files.length) {
        this.listEl.append(node('div', 'rv-empty', 'No changes'));
        return;
      }
      if (!prefs.tree) {
        for (const f of this.files) this.listEl.append(this.fileRow(f, 0, true));
        return;
      }
      const walk = (d, depth) => {
        const dirs = [...d.dirs.values()].sort((a, b) => a.names.join('/').localeCompare(b.names.join('/')));
        for (const c of dirs) {
          const open = !this.collapsed.has(c.path);
          const row = node('div', `rv-row rv-dir${open ? ' open' : ''}`);
          row.style.paddingLeft = `${8 + depth * 14}px`;
          const chev = node('span', 'rv-chev');
          chev.innerHTML = SVG.chevron;
          const ico = folderIcon(c.names[c.names.length - 1], open);
          const name = node('span', 'rv-name');
          c.names.forEach((n, i) => {
            if (i) name.append(node('span', 'rv-slash', '/'));
            name.append(n);
          });
          const st = worstStatus(c);
          const dot = node('span', `rv-dot ${STATUS[st]?.cls || ''}`);
          row.append(chev, ico, name, dot);
          row.title = c.path;
          row.addEventListener('click', () => {
            if (open) this.collapsed.add(c.path);
            else this.collapsed.delete(c.path);
            this.renderList();
          });
          this.listEl.append(row);
          if (open) walk(c, depth + 1);
        }
        for (const f of [...d.files].sort((a, b) => a.path.localeCompare(b.path))) this.listEl.append(this.fileRow(f, depth, false));
      };
      walk(buildTree(this.files), 0);
    }

    fileRow(f, depth, showDir) {
      const base = baseName(f.path);
      const dir = f.path.slice(0, -base.length - 1);
      const s = STATUS[f.status] || STATUS.M;
      const row = node('div', `rv-row rv-file ${s.cls}${this.selected?.path === f.path ? ' selected' : ''}${f.status === 'D' ? ' deleted' : ''}`);
      row.style.paddingLeft = `${(prefs.tree ? 24 : 10) + depth * 14}px`;
      row.dataset.path = f.path;
      row.title = `${f.path}${f.oldPath ? `\nrenamed from ${f.oldPath}` : ''}\n${s.label} · +${f.add} −${f.del}`;
      const name = node('span', 'rv-name', node('span', 'rv-base-name', base));
      if (showDir && dir) name.append(node('span', 'rv-dirname', dir));
      const actions = node(
        'span',
        'rv-actions',
        btn('rv-icon sm', 'Open file', SVG.open, (e) => {
          e.stopPropagation();
          deck.openFile(this.wsId, f.path, 1);
        }),
        btn('rv-icon sm', 'Discard changes', SVG.revert, (e) => {
          e.stopPropagation();
          this.revert(f);
        }),
      );
      const counts = node('span', 'rv-counts');
      counts.innerHTML = f.binary ? 'bin' : `<span class="add">+${f.add}</span> <span class="del">−${f.del}</span>`;
      row.append(fileIcon(base), name, actions, counts, node('span', `rv-letter ${s.cls}`, f.status));
      row.addEventListener('click', () => this.select(f));
      return row;
    }

    async revert(f) {
      try {
        const done = await deck.revertFile(this.wsId, prefs.scope, f);
        if (done) {
          if (this.selected?.path === f.path) this.selected = null;
          await this.refresh();
          this.hooks.onChanged?.();
        }
      } catch (e) {
        this.showEmpty('Could not discard', ipcError(e));
      }
    }

    visibleFiles() {
      return [...this.listEl.querySelectorAll('.rv-file')].map((r) => this.files.find((f) => f.path === r.dataset.path));
    }

    // ----- selection + diff -----
    async select(f, { keepScroll = false } = {}) {
      this.selected = f;
      this.listEl.querySelectorAll('.rv-file').forEach((r) => r.classList.toggle('selected', r.dataset.path === f.path));
      this.listEl.querySelector('.rv-file.selected')?.scrollIntoView({ block: 'nearest' });
      const base = baseName(f.path);
      const s = STATUS[f.status] || STATUS.M;
      this.tabIcon.replaceChildren(fileIcon(base));
      this.tabName.textContent = base;
      this.tabName.classList.toggle('deleted', f.status === 'D');
      this.tabDesc.textContent = f.untracked ? '(Untracked)' : prefs.scope === 'uncommitted' ? '(Working Tree)' : `(${this.baseEl.textContent.replace(/^vs /, '')} ↔ Working Tree)`;
      this.tabStatus.textContent = f.status;
      this.previewBtn.classList.toggle('hidden', f.status === 'D' || !isMarkdown(f.path));
      this.tabStatus.className = `rv-tab-status ${s.cls}`;
      this.crumbs.replaceChildren(
        ...(f.oldPath ? [node('span', 'rv-crumb-old', f.oldPath), node('span', 'rv-crumb-sep', '→')] : []),
        ...crumbs(f.path),
      );

      const token = ++this.loadToken;
      const scrollTop = this.body.scrollTop;
      if (!keepScroll) this.body.innerHTML = '<div class="rv-empty">Loading…</div>';
      let res;
      try {
        res = await deck.gitFileDiff(this.wsId, prefs.scope, f);
      } catch (e) {
        if (token === this.loadToken) this.showEmpty('Could not load diff', ipcError(e), true);
        return;
      }
      if (token !== this.loadToken) return;
      if (res.binary) return this.showEmpty('Binary file', 'Binary changes can’t be shown.', true);
      if (res.tooLarge) return this.showEmpty('File too large', 'Open it in VS Code to review.', true);
      const rows = res.untracked
        ? res.text.replace(/\n$/, '').split('\n').map((text, i) => ({ t: 'add', n: i + 1, text }))
        : parseUnified(res.diff || '');
      const blocks = decorate(rows, langFor(f.path));
      if (!keepScroll || this.current?.file.path !== f.path) this.expandedFolds = new Set();
      this.current = { file: f, rows, blocks };
      this.blockIdx = -1;
      this.renderDiff(!keepScroll);
      if (keepScroll) this.body.scrollTop = scrollTop;
    }

    showEmpty(title, detail, keepHeader) {
      if (!keepHeader) {
        this.tabIcon.replaceChildren();
        this.tabName.textContent = '';
        this.tabDesc.textContent = '';
        this.tabStatus.textContent = '';
        this.crumbs.replaceChildren();
        this.current = null;
      }
      this.navPos.textContent = '';
      this.body.innerHTML = `<div class="rv-empty"><strong>${esc(title)}</strong><br>${esc(detail || '')}</div>`;
    }

    renderDiff(scrollToFirst) {
      if (!this.current) return;
      const { rows, blocks } = this.current;
      const shown = prefs.mode === 'changes' ? foldRows(rows, this.expandedFolds) : rows;
      // Like VS Code, fall back to inline when there isn't room for two columns.
      const tooNarrow = this.body.clientWidth > 0 && this.body.clientWidth < 900;
      const split = prefs.layout === 'split' && !tooNarrow;
      this.segs.layout.btns.split.title = tooNarrow ? 'Not enough room — showing inline until the pane is wider' : '';
      this.segs.layout.el.classList.toggle('degraded', prefs.layout === 'split' && tooNarrow);
      const parts = [];
      const sign = { add: '+', del: '−', ctx: '' };
      const gutter = (t, o, n) => `<span class="ln">${o ?? ''}</span><span class="ln">${n ?? ''}</span><span class="sg">${sign[t]}</span>`;
      const fullRow = (r) =>
        r.t === 'fold'
          ? `<div class="rv-fold" data-fold="${r.start}">${ph('dots-three-outline')} ${r.count} unchanged lines — click to expand</div>`
          : `<div class="rv-fold static">${ph('dots-three-outline')} ${r.count} lines not shown</div>`;

      if (!split) {
        for (const r of shown) {
          if (r.t === 'fold' || r.t === 'gap') {
            parts.push(fullRow(r));
            continue;
          }
          const line = r.n ?? r.o;
          const attrs = `${r.blockStart ? ` data-block="${r.block}"` : ''} data-line="${line}"`;
          parts.push(`<div class="rl t-${r.t}"${attrs}>${gutter(r.t, r.o, r.n)}<span class="cd">${r.html || ' '}</span></div>`);
        }
      } else {
        const half = (r, side) => {
          if (!r) return '<div class="half filler"><span class="ln"></span><span class="sg"></span><span class="cd"></span></div>';
          const t = r.t === 'ctx' ? 'ctx' : r.t;
          const num = side === 'l' ? r.o : r.n;
          return `<div class="half t-${t}" data-line="${num}"><span class="ln">${num ?? ''}</span><span class="sg">${sign[t]}</span><span class="cd">${r.html || ' '}</span></div>`;
        };
        for (let i = 0; i < shown.length; ) {
          const r = shown[i];
          if (r.t === 'fold' || r.t === 'gap') {
            parts.push(fullRow(r));
            i++;
          } else if (r.t === 'ctx') {
            parts.push(`<div class="rs">${half(r, 'l')}${half(r, 'r')}</div>`);
            i++;
          } else {
            const dels = [];
            const adds = [];
            const start = r;
            while (i < shown.length && shown[i].t === 'del') dels.push(shown[i++]);
            while (i < shown.length && shown[i].t === 'add') adds.push(shown[i++]);
            for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
              const attr = k === 0 && start.blockStart ? ` data-block="${start.block}"` : '';
              parts.push(`<div class="rs"${attr}>${half(dels[k], 'l')}${half(adds[k], 'r')}</div>`);
            }
          }
        }
      }
      this.body.className = `rv-body hl ${split ? 'layout-split' : 'layout-inline'}`;
      // Width of line-number gutter follows the largest line number.
      const maxLine = rows.reduce((m, r) => Math.max(m, r.o || 0, r.n || 0), 0);
      this.body.style.setProperty('--ln-ch', String(Math.max(3, String(maxLine).length) + 1));
      this.body.innerHTML = parts.join('') || '<div class="rv-empty">No textual changes (mode or permissions only).</div>';
      this.navPos.textContent = blocks ? `${blocks} change${blocks === 1 ? '' : 's'}` : '';
      this.prevBtn.disabled = this.nextBtn.disabled = !blocks;
      if (scrollToFirst) {
        this.body.scrollTop = 0;
        if (blocks && prefs.mode === 'full') {
          this.blockIdx = -1;
          this.gotoBlock(1, true);
        }
      }
    }

    firstChangedLine() {
      const r = this.current?.rows.find((x) => x.t === 'add' || x.t === 'del');
      return r ? r.n || r.o : 1;
    }

    gotoBlock(dir, quiet) {
      const blocks = this.current?.blocks || 0;
      if (!blocks) return;
      this.blockIdx = (this.blockIdx + dir + blocks) % blocks;
      const el = this.body.querySelector(`[data-block="${this.blockIdx}"]`);
      if (!el) return;
      const top = el.offsetTop - this.body.clientHeight / 3;
      this.body.scrollTo({ top: Math.max(0, top), behavior: quiet ? 'auto' : 'smooth' });
      this.navPos.textContent = `${this.blockIdx + 1} of ${blocks}`;
    }

    onKey(e) {
      if (e.target.closest('input, textarea')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hooks.onClose();
      } else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        this.gotoBlock(e.key === 'ArrowDown' ? 1 : -1);
      } else if (!e.metaKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'j' || e.key === 'k')) {
        if (e.target !== this.listEl && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) return; // let the diff scroll
        e.preventDefault();
        const list = this.visibleFiles();
        if (!list.length) return;
        const i = list.findIndex((f) => f.path === this.selected?.path);
        const next = list[Math.min(list.length - 1, Math.max(0, i + (e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1)))];
        if (next) this.select(next);
      }
    }
  }

  window.Review = Review;
})();
