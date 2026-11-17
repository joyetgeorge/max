'use strict';

// VS Code-style file navigation for the Files tab:
//   QuickOpen   — ⌘P: fuzzy-find a file by name (`name:42` jumps to a line).
//   SearchPanel — ⌘⇧F: search file contents (ripgrep), shown in the Files tab's sidebar.
(() => {
  const { node, btn, ph, icon, store, baseName, dirName, fileIcon } = window.Kit;

  // Text with the given [start, end) ranges wrapped in <mark>.
  function highlighted(text, ranges) {
    const out = [];
    let at = 0;
    for (const [s, e] of ranges) {
      if (s < at) continue;
      if (s > at) out.push(text.slice(at, s));
      const m = document.createElement('mark');
      m.textContent = text.slice(s, e);
      out.push(m);
      at = e;
    }
    out.push(text.slice(at));
    return out;
  }

  // ---------- fuzzy matching (VS Code-like) ----------
  // Every query character must appear in order. Matches inside the file name score far above
  // matches spread over folders; runs of consecutive characters and word starts score extra.
  function fuzzy(q, path) {
    const lower = path.toLowerCase();
    const baseAt = path.lastIndexOf('/') + 1;
    const run = (from) => {
      const pos = [];
      let i = from;
      for (const ch of q) {
        i = lower.indexOf(ch, i);
        if (i < 0) return null;
        pos.push(i++);
      }
      return pos;
    };
    // Prefer a match entirely within the file name; fall back to the whole path.
    let pos = run(baseAt);
    const inBase = !!pos;
    pos ??= run(0);
    if (!pos) return null;
    let score = inBase ? 1000 : 0;
    for (let k = 0; k < pos.length; k++) {
      const p = pos[k];
      if (k && pos[k - 1] === p - 1) score += 15; // consecutive
      const prev = path[p - 1];
      if (p === baseAt) score += 40; // start of the file name
      else if (!prev || '/._- '.includes(prev) || (path[p] >= 'A' && path[p] <= 'Z' && prev >= 'a' && prev <= 'z')) score += 10; // word start
    }
    if (inBase && lower.slice(baseAt).startsWith(q)) score += 200;
    if (inBase && lower.slice(baseAt, lower.lastIndexOf('.') > baseAt ? lower.lastIndexOf('.') : undefined) === q) score += 300; // exact name
    score -= path.length * 0.5; // shorter paths first
    return { score, pos };
  }

  // ---------- ⌘P: Quick Open ----------
  const QuickOpen = (() => {
    let root = null;
    let input;
    let listEl;
    let files = [];
    let items = [];
    let sel = 0;
    let wsId = null;
    let onPick = null;
    const recentKey = (id) => `deck.quickopen.recent.${id}`;
    const recent = (id) => store.json(recentKey(id), []);
    const remember = (id, path) => store.setJson(recentKey(id), [path, ...recent(id).filter((p) => p !== path)].slice(0, 30));

    function build() {
      input = node('input', 'cmdk-input');
      input.placeholder = 'Search files by name (append :line to go to a line)';
      input.spellcheck = false;
      listEl = node('div', 'cmdk-list qo-list');
      input.addEventListener('input', () => {
        sel = 0;
        render();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
          e.preventDefault();
          sel = Math.min(items.length - 1, sel + 1);
          paintSel();
        } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
          e.preventDefault();
          sel = Math.max(0, sel - 1);
          paintSel();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          pick(sel);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
      });
      root = node(
        'div',
        'cmdk-overlay hidden',
        node(
          'div',
          'cmdk qo',
          node('div', 'cmdk-search', icon('file-magnifying-glass'), input, node('kbd', '', 'esc')),
          listEl,
          node(
            'div',
            'cmdk-foot',
            node('span', '', node('kbd', '', '↑'), node('kbd', '', '↓'), ' navigate'),
            node('span', '', node('kbd', '', '↵'), ' open'),
            node('span', '', node('kbd', '', '⌘P'), ' close'),
          ),
        ),
      );
      root.addEventListener('mousedown', (e) => e.target === root && close());
      document.body.append(root);
    }

    const parse = () => {
      const raw = input.value.trim();
      const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(raw);
      return { q: (m[1] || '').replace(/\s+/g, '').toLowerCase(), line: m[2] ? Number(m[2]) : null, col: m[3] ? Number(m[3]) : null };
    };
    function render() {
      const { q } = parse();
      if (!q) {
        // Nothing typed: recently opened files, then the rest.
        const rec = recent(wsId).filter((p) => files.includes(p));
        items = [...rec, ...files.filter((p) => !rec.includes(p))].slice(0, 80).map((path) => ({ path, pos: [], recent: rec.includes(path) }));
      } else {
        const hits = [];
        for (const path of files) {
          const r = fuzzy(q, path);
          if (r) hits.push({ path, ...r });
        }
        hits.sort((a, b) => b.score - a.score);
        items = hits.slice(0, 80);
      }
      sel = Math.min(sel, Math.max(0, items.length - 1));
      listEl.replaceChildren(
        ...items.map((it, i) => {
          const name = baseName(it.path);
          const baseAt = it.path.length - name.length;
          const namePos = it.pos.filter((p) => p >= baseAt).map((p) => [p - baseAt, p - baseAt + 1]);
          const dirPos = it.pos.filter((p) => p < baseAt).map((p) => [p, p + 1]);
          const row = node(
            'div',
            `cmdk-item qo-item${i === sel ? ' sel' : ''}`,
            fileIcon(name),
            node('span', 'qo-name', ...highlighted(name, namePos)),
            node('span', 'qo-dir', ...highlighted(dirName(it.path), dirPos)),
            it.recent ? node('span', 'qo-tag', 'recently opened') : null,
          );
          row.dataset.i = i;
          row.addEventListener('mousemove', () => {
            if (sel !== i) {
              sel = i;
              paintSel();
            }
          });
          row.addEventListener('click', () => pick(i));
          return row;
        }),
        items.length ? null : node('div', 'cmdk-empty', files.length ? 'No matching files' : 'Loading files…'),
      );
    }
    function paintSel() {
      listEl.querySelectorAll('.qo-item').forEach((el) => el.classList.toggle('sel', Number(el.dataset.i) === sel));
      listEl.querySelector('.qo-item.sel')?.scrollIntoView({ block: 'nearest' });
    }
    function pick(i) {
      const it = items[i];
      if (!it) return;
      const { line, col } = parse();
      remember(wsId, it.path);
      close(false);
      onPick(it.path, line ? { line, col: col ? col - 1 : 0, len: 0 } : null);
    }
    async function open(id, pickFn, onDismiss) {
      if (isOpen()) return close();
      if (!root) build();
      wsId = id;
      onPick = pickFn;
      QuickOpen.onDismiss = onDismiss;
      input.value = '';
      sel = 0;
      files = [];
      render();
      root.classList.remove('hidden');
      input.focus();
      try {
        files = (await deck.listFiles(id)) || [];
      } catch {
        files = [];
      }
      if (isOpen() && wsId === id) render();
    }
    function close(refocus = true) {
      if (!isOpen()) return;
      root.classList.add('hidden');
      if (refocus) QuickOpen.onDismiss?.();
    }
    const isOpen = () => !!root && !root.classList.contains('hidden');
    return { open, close, isOpen, onDismiss: null };
  })();

  // ---------- ⌘⇧F: Search panel (lives in the Files tab's sidebar) ----------
  const OPTS_KEY = 'deck.search.opts';
  class SearchPanel {
    constructor(wsId, { onOpen }) {
      this.wsId = wsId;
      this.onOpen = onOpen;
      this.collapsed = new Set();
      this.seq = 0;
      const saved = store.json(OPTS_KEY, {});
      this.opts = { caseSensitive: !!saved.caseSensitive, wholeWord: !!saved.wholeWord, regex: !!saved.regex, include: saved.include || '', exclude: saved.exclude || '', details: !!saved.details };
      this.build();
    }

    build() {
      this.input = node('input', 'sp-input');
      this.input.placeholder = 'Search';
      this.input.spellcheck = false;
      const toggle = (key, label, title) => {
        const b = node('button', `sp-opt${this.opts[key] ? ' on' : ''}`, label);
        b.title = title;
        b.addEventListener('click', () => {
          this.opts[key] = !this.opts[key];
          b.classList.toggle('on', this.opts[key]);
          this.saveOpts();
          this.run(true);
          this.input.focus();
        });
        return b;
      };
      const box = node(
        'div',
        'sp-box',
        this.input,
        toggle('caseSensitive', 'Aa', 'Match case'),
        toggle('wholeWord', node('span', 'sp-ww', 'ab'), 'Match whole word'),
        toggle('regex', '.*', 'Use regular expression'),
      );
      this.include = node('input', 'sp-input sp-glob');
      this.include.placeholder = 'files to include  (e.g. src/**, *.ts)';
      this.include.value = this.opts.include;
      this.exclude = node('input', 'sp-input sp-glob');
      this.exclude.placeholder = 'files to exclude  (e.g. *.test.ts, dist)';
      this.exclude.value = this.opts.exclude;
      this.details = node('div', `sp-details${this.opts.details ? '' : ' hidden'}`, this.include, this.exclude);
      const detailsBtn = btn('rv-icon sm', 'Toggle search details', ph('dots-three'), () => {
        this.opts.details = !this.opts.details;
        this.details.classList.toggle('hidden', !this.opts.details);
        this.saveOpts();
      });
      this.summary = node('div', 'sp-summary');
      this.results = node('div', 'sp-results');
      this.results.tabIndex = 0;
      this.el = node('div', 'sp hidden', node('div', 'sp-form', box, node('div', 'sp-detail-row', detailsBtn), this.details), this.summary, this.results);

      let t = null;
      const later = () => {
        clearTimeout(t);
        t = setTimeout(() => this.run(), 280);
      };
      for (const inp of [this.input, this.include, this.exclude]) {
        inp.addEventListener('input', () => {
          if (inp !== this.input) {
            this.opts.include = this.include.value;
            this.opts.exclude = this.exclude.value;
            this.saveOpts();
          }
          later();
        });
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            clearTimeout(t);
            this.run(true);
          } else if (e.key === 'ArrowDown' && inp === this.input) {
            e.preventDefault();
            this.results.querySelector('.sp-line')?.focus();
          }
        });
      }
      // Arrow keys move between result lines; Enter opens.
      this.results.addEventListener('keydown', (e) => {
        const lines = [...this.results.querySelectorAll('.sp-line')];
        const i = lines.indexOf(document.activeElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (i < 0) return lines[0]?.focus();
          if (e.key === 'ArrowUp' && i === 0) return this.input.focus();
          lines[Math.max(0, Math.min(lines.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
        } else if (e.key === 'Enter' && i >= 0) {
          e.preventDefault();
          lines[i].click();
        }
      });
    }

    saveOpts() {
      store.setJson(OPTS_KEY, this.opts);
    }
    show(prefill) {
      this.el.classList.remove('hidden');
      if (prefill) {
        this.input.value = prefill;
        this.run(true);
      }
      requestAnimationFrame(() => {
        this.input.focus();
        this.input.select();
      });
    }
    hide() {
      this.el.classList.add('hidden');
    }
    get visible() {
      return !this.el.classList.contains('hidden');
    }

    async run(force) {
      const query = this.input.value;
      const key = JSON.stringify([query, this.opts.caseSensitive, this.opts.wholeWord, this.opts.regex, this.include.value, this.exclude.value]);
      if (!force && key === this.lastKey) return;
      this.lastKey = key;
      const seq = ++this.seq;
      if (!query) {
        deck.cancelSearch(this.wsId);
        this.summary.textContent = '';
        this.results.replaceChildren();
        return;
      }
      this.summary.textContent = 'Searching…';
      const t0 = performance.now();
      let res;
      try {
        res = await deck.searchFiles(this.wsId, { query, ...this.opts, include: this.include.value, exclude: this.exclude.value });
      } catch (e) {
        res = { files: [], total: 0, error: String(e.message || e) };
      }
      if (seq !== this.seq || res.cancelled) return; // a newer search took over
      this.render(res, query, Math.round(performance.now() - t0));
    }

    render(res, query, ms) {
      if (res.error) {
        this.summary.replaceChildren(node('span', 'sp-err', res.error.replace(/^rg: /, '')));
        this.results.replaceChildren();
        return;
      }
      const files = res.files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
      this.summary.textContent = res.total
        ? `${res.total.toLocaleString()} result${res.total === 1 ? '' : 's'} in ${files.length.toLocaleString()} file${files.length === 1 ? '' : 's'}${res.truncated ? ' (showing the first 5,000)' : ''} · ${ms} ms`
        : `No results for “${query}”`;
      const frag = document.createDocumentFragment();
      for (const f of files) {
        const collapsed = this.collapsed.has(f.path);
        const count = f.matches.reduce((n, m) => n + (m.ranges.length || 1), 0);
        const head = node(
          'div',
          `sp-file${collapsed ? ' collapsed' : ''}`,
          node('span', 'sp-caret', icon('caret-down')),
          fileIcon(baseName(f.path)),
          node('span', 'sp-fname', baseName(f.path)),
          node('span', 'sp-fdir', dirName(f.path)),
          node('span', 'sp-count', String(count)),
        );
        head.title = f.path;
        head.dataset.path = f.path;
        head.addEventListener('click', () => {
          if (this.collapsed.has(f.path)) this.collapsed.delete(f.path);
          else this.collapsed.add(f.path);
          head.classList.toggle('collapsed');
          group.classList.toggle('hidden');
        });
        const group = node('div', `sp-lines${collapsed ? ' hidden' : ''}`);
        for (const m of f.matches) {
          // Long lines: start a little before the first match so it's visible.
          const first = m.ranges[0]?.[0] ?? 0;
          const lead = m.text.match(/^\s*/)[0].length;
          const cut = first - lead > 40 ? first - 30 : lead;
          const shown = m.text.slice(cut);
          const ranges = m.ranges.map(([s, e]) => [s - cut, e - cut]).filter(([s]) => s >= 0);
          const line = node('div', 'sp-line', node('span', 'sp-text', cut > lead ? '…' : '', ...highlighted(shown, ranges)), node('span', 'sp-ln', String(m.line)));
          line.tabIndex = -1;
          line.title = `${f.path}:${m.line}`;
          line.addEventListener('click', () => {
            this.results.querySelectorAll('.sp-line.sel').forEach((x) => x.classList.remove('sel'));
            line.classList.add('sel');
            const [s, e] = m.ranges[0] || [0, 0];
            this.onOpen(f.path, { line: m.line, col: s, len: e - s });
          });
          group.append(line);
        }
        frag.append(head, group);
      }
      this.results.replaceChildren(frag);
    }

    collapseAll() {
      const all = [...this.results.querySelectorAll('.sp-file')];
      const anyOpen = all.some((h) => !h.classList.contains('collapsed'));
      for (const h of all) {
        const { path } = h.dataset;
        if (anyOpen) this.collapsed.add(path);
        else this.collapsed.delete(path);
        h.classList.toggle('collapsed', anyOpen);
        h.nextElementSibling.classList.toggle('hidden', anyOpen);
      }
    }
    clear() {
      this.input.value = '';
      this.run(true);
      this.input.focus();
    }
  }

  window.QuickOpen = QuickOpen;
  window.SearchPanel = SearchPanel;
})();
