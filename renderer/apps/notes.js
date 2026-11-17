/* global deck */
'use strict';

// Notes app: a board of coloured sticky notes, autosaved, shared by all worktrees.
// Drag a note by its top strip, resize from its corner, click to bring it forward. Double-click
// the board (or press +) for a new note. Each note can be recoloured, pinned (locked in place and
// kept above the rest), or deleted (click the bin twice). "Tidy" lines the unpinned ones up in a grid.
// Notes are rich text: pasted formatting (bold, lists, links, headings, code…) is kept, and
// ⌘B / ⌘I / ⌘U work while typing. Colours and fonts from the source are dropped so text stays readable.
(() => {
  const { node: el, icon: ph, store, esc, uid } = window.Kit;
  const { button } = window.DeckApps.ui;

  const NOTE_HTML = {
    ALLOWED_TAGS: ['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'a', 'p', 'br', 'div', 'span', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'code', 'pre', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'style'],
  };
  const KEEP_STYLE = /^(font-weight|font-style|text-decoration(-line)?)$/;
  function cleanHtml(html) {
    const frag = window.DOMPurify.sanitize(html, { ...NOTE_HTML, RETURN_DOM_FRAGMENT: true });
    // Keep only bold/italic/underline/strike from inline styles (Google Docs etc. format with styles).
    for (const node of frag.querySelectorAll('[style]')) {
      const kept = [...node.style].filter((p) => KEEP_STYLE.test(p)).map((p) => `${p}: ${node.style.getPropertyValue(p)}`);
      if (kept.length) node.setAttribute('style', kept.join('; '));
      else node.removeAttribute('style');
    }
    const box = document.createElement('div');
    box.append(frag);
    return box.innerHTML;
  }
  // Old plain-text notes: keep their line breaks and runs of spaces.
  const textToHtml = (t) => esc(t || '').replace(/ {2}/g, ' &nbsp;').replace(/\n/g, '<br>');
  const STICKY_COLORS = [
    { id: 'yellow', bg: '#fde68a', edge: '#f59e0b' },
    { id: 'pink', bg: '#fbcfe8', edge: '#ec4899' },
    { id: 'blue', bg: '#bfdbfe', edge: '#3b82f6' },
    { id: 'green', bg: '#bbf7d0', edge: '#22c55e' },
    { id: 'purple', bg: '#ddd6fe', edge: '#8b5cf6' },
    { id: 'orange', bg: '#fed7aa', edge: '#f97316' },
  ];
  const NOTE_W = 230;
  const NOTE_H = 200;
  const GAP = 18;

  function stickyNotes() {
    const KEY = 'deck.app.stickies';
    let notes = store.json(KEY, []);
    let z = Math.max(0, ...notes.map((n) => n.z || 0));
    // The old single Quick Note becomes the first sticky.
    if (!notes.length && store.get('deck.app.note').trim()) {
      notes.push({ id: uid(), text: store.get('deck.app.note'), color: 'yellow', x: GAP, y: GAP, w: 320, h: 260, z: ++z, updated: Date.now() });
    }
    // Notes from before rich text were plain text.
    for (const n of notes) if (n.html == null) n.html = textToHtml(n.text);
    let saveTimer = null;
    const flush = () => {
      clearTimeout(saveTimer);
      saveTimer = null;
      store.setJson(KEY, notes);
    };
    const save = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, 250);
    };
    // Don't lose the last keystrokes when the window reloads or the app quits.
    window.addEventListener('pagehide', () => saveTimer && flush());
    window.addEventListener('beforeunload', () => saveTimer && flush());
    let query = '';
    const els = new Map(); // note id -> element
    const count = el('span', 'app-title');
    const zoomLabel = el('button', 'sk-zoom-label');
    zoomLabel.title = 'Reset zoom to 100% (⌘0)';
    zoomLabel.addEventListener('click', () => setZoom(1)); // setZoom is hoisted from below
    const handBtn = button('', 'hand', 'Hand tool: drag to move the board (H · hold Space)', () => {
      setHand(!handOn);
      board.focus({ preventScroll: true });
    });
    handBtn.classList.add('sk-hand-btn');

    // Zoom: the canvas is drawn scaled (CSS transform) inside a sizer that has the scaled size,
    // so the board scrolls over exactly the zoomed area. Note positions stay in board units;
    // screen deltas are divided by the zoom wherever the pointer is involved.
    const ZOOM_KEY = 'deck.app.stickies.zoom';
    const MIN_ZOOM = 0.25;
    const MAX_ZOOM = 2.5;
    let zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(store.get(ZOOM_KEY, '1')) || 1));
    const board = el('div', 'sk-board');
    const sizer = el('div', 'sk-sizer');
    const canvas = el('div', 'sk-canvas');
    sizer.append(canvas);
    board.append(sizer);
    const empty = el('div', 'sk-empty', ph('note-blank'), el('div', '', 'No notes yet'), el('div', 'sk-empty-sub', 'Double-click anywhere or press + to add one'));
    board.append(empty);
    // Board units → the canvas's coordinates (what a note's x/y means) for a pointer position.
    const toBoard = (clientX, clientY) => {
      const r = canvas.getBoundingClientRect();
      return { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom };
    };
    const viewW = () => board.clientWidth / zoom; // visible width, in board units

    // Keep the scrollable area big enough for the farthest note (and at least the visible area,
    // so double-clicking anywhere adds a note there).
    function fitCanvas() {
      const w = Math.max(board.clientWidth / zoom, Math.max(0, ...notes.map((n) => n.x + n.w)) + GAP);
      const hh = Math.max(board.clientHeight / zoom, Math.max(0, ...notes.map((n) => n.y + n.h)) + GAP);
      Object.assign(canvas.style, { width: `${w}px`, height: `${hh}px`, transform: `scale(${zoom})` });
      Object.assign(sizer.style, { width: `${w * zoom}px`, height: `${hh * zoom}px` });
      board.style.backgroundSize = `${22 * zoom}px ${22 * zoom}px`;
      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      empty.classList.toggle('hidden', notes.length > 0);
      count.textContent = `${notes.length} note${notes.length === 1 ? '' : 's'} · shared across all worktrees · autosaves`;
    }
    const colorOf = (n) => STICKY_COLORS.find((c) => c.id === n.color) || STICKY_COLORS[0];
    const ago = (t) => {
      const s = Math.round((Date.now() - t) / 1000);
      if (s < 60) return 'just now';
      if (s < 3600) return `${Math.round(s / 60)} min ago`;
      if (s < 86400) return `${Math.round(s / 3600)} h ago`;
      return new Date(t).toLocaleDateString();
    };

    function front(n) {
      if (n.z === z) return;
      n.z = ++z;
      els.get(n.id).style.zIndex = n.pinned ? 100000 + n.z : n.z;
      save();
    }
    function place(n, node) {
      Object.assign(node.style, { left: `${n.x}px`, top: `${n.y}px`, width: `${n.w}px`, height: `${n.h}px`, zIndex: n.pinned ? 100000 + n.z : n.z });
    }

    function noteEl(n) {
      const c = colorOf(n);
      const ta = el('div', 'sk-text');
      ta.contentEditable = 'true';
      ta.spellcheck = true;
      ta.dataset.placeholder = 'Write something…';
      ta.innerHTML = cleanHtml(n.html || '');
      const meta = el('span', 'sk-meta', ago(n.updated));
      const changed = () => {
        // An emptied editor keeps a stray <br>: treat it as empty so the placeholder shows.
        if (!ta.textContent.trim() && !ta.querySelector('img, hr, li')) ta.innerHTML = '';
        n.html = ta.innerHTML;
        n.text = ta.innerText; // for search
        n.updated = Date.now();
        meta.textContent = 'just now';
        save();
      };
      ta.addEventListener('input', changed);
      // Paste keeps the formatting, cleaned (see cleanHtml); plain text stays plain.
      ta.addEventListener('paste', (e) => {
        const html = e.clipboardData?.getData('text/html');
        const text = e.clipboardData?.getData('text/plain') || '';
        e.preventDefault();
        if (html) document.execCommand('insertHTML', false, cleanHtml(html));
        else document.execCommand('insertText', false, text);
      });
      ta.addEventListener('keydown', (e) => {
        e.stopPropagation(); // typing never triggers board shortcuts
        if (e.key === 'Escape') ta.blur();
        if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          document.execCommand(e.shiftKey ? 'outdent' : 'indent');
        }
      });
      // ⌘-click opens a link (a plain click just places the cursor, as in any editor).
      ta.addEventListener('click', (e) => {
        const a = e.target.closest('a[href]');
        if (a && e.metaKey && /^https?:/i.test(a.href)) {
          e.preventDefault();
          deck.openExternal(a.href);
        }
      });
      ta.addEventListener('mouseover', (e) => {
        const a = e.target.closest('a[href]');
        if (a && !a.title) a.title = `${a.href}\n⌘-click to open`;
      });

      const tool = (iconName, title, fn) => {
        const b = el('button', 'sk-btn', ph(iconName));
        b.title = title;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          fn(b);
        });
        return b;
      };
      const swatches = el(
        'div',
        'sk-swatches',
        STICKY_COLORS.map((col) => {
          const s = el('button', `sk-swatch${col.id === n.color ? ' on' : ''}`);
          s.style.background = col.bg;
          s.title = col.id[0].toUpperCase() + col.id.slice(1);
          s.addEventListener('click', (e) => {
            e.stopPropagation();
            n.color = col.id;
            save();
            node.replaceWith(mount(n));
          });
          return s;
        }),
      );
      const pinBtn = tool(n.pinned ? 'push-pin-slash' : 'push-pin', n.pinned ? 'Unpin (lets it move again)' : 'Pin: lock in place, above other notes', () => {
        n.pinned = !n.pinned;
        save();
        node.replaceWith(mount(n));
      });
      const delBtn = tool('trash', 'Delete note', (b) => {
        // Two clicks, like the other apps' Clear: no blocking dialog.
        if (!b.classList.contains('armed') && n.text.trim()) {
          b.classList.add('armed');
          b.title = 'Click again to delete';
          setTimeout(() => {
            b.classList.remove('armed');
            b.title = 'Delete note';
          }, 2000);
          return;
        }
        notes = notes.filter((x) => x !== n);
        els.get(n.id)?.remove();
        els.delete(n.id);
        save();
        fitCanvas();
      });
      const head = el('div', 'sk-head', swatches, el('span', 'app-spacer'), pinBtn, delBtn);
      const foot = el('div', 'sk-foot', meta);
      const node = el('div', `sk-note${n.pinned ? ' pinned' : ''}`, head, ta, foot);
      node.style.setProperty('--sk-bg', c.bg);
      node.style.setProperty('--sk-edge', c.edge);
      // A slight, stable tilt per note, like paper on a board; straightens while you work on it.
      node.style.setProperty('--sk-tilt', `${((parseInt(n.id, 36) % 7) - 3) * 0.35}deg`);
      place(n, node);
      node.addEventListener('pointerdown', () => front(n));

      // Drag by the top strip (not its buttons). Pinned notes stay put.
      head.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('button') || n.pinned) return;
        e.preventDefault();
        const sx = e.clientX;
        const sy = e.clientY;
        const ox = n.x;
        const oy = n.y;
        node.classList.add('dragging');
        head.setPointerCapture(e.pointerId);
        const move = (ev) => {
          n.x = Math.max(0, Math.round(ox + (ev.clientX - sx) / zoom));
          n.y = Math.max(0, Math.round(oy + (ev.clientY - sy) / zoom));
          node.style.left = `${n.x}px`;
          node.style.top = `${n.y}px`;
        };
        const up = () => {
          node.classList.remove('dragging');
          head.removeEventListener('pointermove', move);
          head.removeEventListener('pointerup', up);
          save();
          fitCanvas();
        };
        head.addEventListener('pointermove', move);
        head.addEventListener('pointerup', up);
      });
      // Resize from the corner (CSS resize); remember the size.
      new ResizeObserver(() => {
        if (!node.isConnected || node.offsetWidth === 0 || n.pinned) return;
        if (node.offsetWidth !== n.w || node.offsetHeight !== n.h) {
          n.w = node.offsetWidth;
          n.h = node.offsetHeight;
          save();
          fitCanvas();
        }
      }).observe(node);
      return node;
    }
    function mount(n) {
      const node = noteEl(n);
      els.set(n.id, node);
      applyFilter(n, node);
      return node;
    }
    function render() {
      els.clear();
      canvas.replaceChildren(...notes.map(mount));
      fitCanvas();
    }

    // A new note at a free spot (or where you double-clicked), focused and ready to type.
    function addNote(at) {
      let x = at?.x;
      let y = at?.y;
      if (x == null) {
        const cols = Math.max(1, Math.floor((viewW() - GAP) / (NOTE_W + GAP)));
        for (let i = 0; ; i++) {
          const cx = GAP + (i % cols) * (NOTE_W + GAP);
          const cy = GAP + Math.floor(i / cols) * (NOTE_H + GAP);
          const taken = notes.some((o) => Math.abs(o.x - cx) < NOTE_W / 2 && Math.abs(o.y - cy) < NOTE_H / 2);
          if (!taken) {
            x = cx;
            y = cy;
            break;
          }
        }
      }
      const used = new Set(notes.map((o) => o.color));
      const color = (STICKY_COLORS.find((c) => !used.has(c.id)) || STICKY_COLORS[notes.length % STICKY_COLORS.length]).id;
      const n = { id: uid(), text: '', color, x: Math.max(0, x), y: Math.max(0, y), w: NOTE_W, h: NOTE_H, z: ++z, updated: Date.now() };
      notes.push(n);
      canvas.append(mount(n));
      fitCanvas();
      save();
      requestAnimationFrame(() => {
        els.get(n.id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        els.get(n.id)?.querySelector('.sk-text')?.focus();
      });
    }
    board.addEventListener('dblclick', (e) => {
      if (e.target !== board && e.target !== canvas && e.target !== sizer) return;
      const p = toBoard(e.clientX, e.clientY);
      addNote({ x: Math.round(p.x - NOTE_W / 2), y: Math.round(p.y - 16) });
    });

    // ----- zooming -----
    // Zoom to `z`, keeping the board point under (clientX, clientY) — default: the centre — still.
    function setZoom(z, clientX, clientY) {
      z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
      if (z === zoom) return;
      const br = board.getBoundingClientRect();
      const mx = (clientX ?? br.left + br.width / 2) - br.left;
      const my = (clientY ?? br.top + br.height / 2) - br.top;
      const px = (board.scrollLeft + mx) / zoom;
      const py = (board.scrollTop + my) / zoom;
      zoom = z;
      fitCanvas();
      board.scrollLeft = px * zoom - mx;
      board.scrollTop = py * zoom - my;
      store.set(ZOOM_KEY, String(zoom));
    }
    const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];
    const stepZoom = (dir) => setZoom(dir > 0 ? STEPS.find((s) => s > zoom + 0.001) ?? MAX_ZOOM : [...STEPS].reverse().find((s) => s < zoom - 0.001) ?? MIN_ZOOM);
    // Show every note: zoom so they all fit (never above 100%), and scroll them into view.
    function fitAll() {
      if (!notes.length) return setZoom(1);
      const minX = Math.min(...notes.map((n) => n.x));
      const minY = Math.min(...notes.map((n) => n.y));
      const maxX = Math.max(...notes.map((n) => n.x + n.w));
      const maxY = Math.max(...notes.map((n) => n.y + n.h));
      const z = Math.min(1, (board.clientWidth - 2 * GAP) / (maxX - minX), (board.clientHeight - 2 * GAP) / (maxY - minY));
      setZoom(Math.max(MIN_ZOOM, z));
      board.scrollLeft = minX * zoom - GAP;
      board.scrollTop = minY * zoom - GAP;
    }
    // Trackpad pinch (and ⌃/⌘ + scroll wheel) zooms around the pointer; plain scrolling pans.
    board.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        setZoom(zoom * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01)), e.clientX, e.clientY);
      },
      { passive: false },
    );
    // ----- panning: the hand tool (H, or hold Space) drags the canvas, even over notes;
    // without it, dragging an empty part of the board pans too. -----
    let handOn = false; // toggled tool
    let spaceHeld = false; // temporary hand while Space is down
    const syncHand = () => {
      const on = handOn || spaceHeld;
      board.classList.toggle('hand', on);
      handBtn.classList.toggle('on', handOn);
      // A note being edited would swallow the drag; leave it while the hand is out.
      if (on && document.activeElement?.closest?.('.sk-text')) document.activeElement.blur();
    };
    const setHand = (on) => {
      handOn = on;
      syncHand();
    };
    board.addEventListener(
      'pointerdown',
      (e) => {
        const empty = e.target === board || e.target === sizer || e.target === canvas;
        const hand = board.classList.contains('hand');
        if (!(hand && (e.button === 0 || e.button === 1)) && !(empty && e.button === 0) && e.button !== 1) return;
        // Capture phase: the hand wins over the note under it (no drag, no text cursor).
        e.preventDefault();
        e.stopPropagation();
        board.focus({ preventScroll: true });
        const sx = e.clientX;
        const sy = e.clientY;
        const sl = board.scrollLeft;
        const st = board.scrollTop;
        board.classList.add('panning');
        try {
          board.setPointerCapture(e.pointerId); // keep panning when the pointer leaves the board
        } catch {
          /* pointer already gone */
        }
        const move = (ev) => {
          board.scrollLeft = sl - (ev.clientX - sx);
          board.scrollTop = st - (ev.clientY - sy);
        };
        const up = () => {
          board.classList.remove('panning');
          board.removeEventListener('pointermove', move);
          board.removeEventListener('pointerup', up);
          board.removeEventListener('pointercancel', up);
        };
        board.addEventListener('pointermove', move);
        board.addEventListener('pointerup', up);
        board.addEventListener('pointercancel', up);
      },
      true,
    );
    // While the hand is out, clicks don't reach the notes either (no bring-to-front, no editing).
    board.addEventListener('click', (e) => board.classList.contains('hand') && e.stopPropagation(), true);
    board.addEventListener('dblclick', (e) => board.classList.contains('hand') && e.stopPropagation(), true);
    board.addEventListener('keyup', (e) => {
      if (e.key === ' ' && spaceHeld) {
        spaceHeld = false;
        syncHand();
      }
    });
    window.addEventListener('blur', () => {
      spaceHeld = false;
      syncHand();
    });

    // H: hand tool · Space (held): temporary hand · Esc / V: back to the pointer.
    // ⌘= / ⌘- / ⌘0: zoom. All only while the board (not a note being edited) has focus.
    board.tabIndex = -1;
    board.addEventListener('keydown', (e) => {
      if (e.target.isContentEditable || e.target.closest('input')) return;
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === ' ') {
          e.preventDefault(); // no page scroll
          if (!spaceHeld) {
            spaceHeld = true;
            syncHand();
          }
        } else if (e.key === 'h' || e.key === 'H') setHand(!handOn);
        else if ((e.key === 'Escape' || e.key === 'v' || e.key === 'V') && handOn) {
          e.stopPropagation();
          setHand(false);
        }
        return;
      }
      if (!e.metaKey) return;
      if (e.key === '=' || e.key === '+') stepZoom(1);
      else if (e.key === '-') stepZoom(-1);
      else if (e.key === '0') setZoom(1);
      else return;
      e.preventDefault();
    });
    board.addEventListener('pointerdown', (e) => (e.target === board || e.target === sizer || e.target === canvas) && board.focus({ preventScroll: true }));
    new ResizeObserver(() => fitCanvas()).observe(board);

    // Line the unpinned notes up in a grid (most recently edited first), around the pinned
    // ones, which stay exactly where they are.
    function tidy() {
      const cols = Math.max(1, Math.floor((viewW() - GAP) / (NOTE_W + GAP)));
      const pinned = notes.filter((n) => n.pinned);
      const overlapsPinned = (x, y) => pinned.some((p) => x < p.x + p.w + GAP && x + NOTE_W + GAP > p.x && y < p.y + p.h + GAP && y + NOTE_H + GAP > p.y);
      const loose = notes.filter((n) => !n.pinned).sort((a, b) => b.updated - a.updated);
      let slot = 0;
      for (const n of loose) {
        let x;
        let y;
        do {
          x = GAP + (slot % cols) * (NOTE_W + GAP);
          y = GAP + Math.floor(slot / cols) * (NOTE_H + GAP);
          slot++;
        } while (overlapsPinned(x, y));
        Object.assign(n, { x, y, w: NOTE_W, h: NOTE_H });
      }
      save();
      canvas.classList.add('animating');
      render();
      setTimeout(() => canvas.classList.remove('animating'), 300);
    }

    // Search dims the notes that don't match.
    function applyFilter(n, node) {
      node.classList.toggle('dim', !!query && !n.text.toLowerCase().includes(query));
    }
    const search = el('input', 'nw-search sk-search');
    search.placeholder = 'Search notes';
    search.spellcheck = false;
    search.addEventListener('input', () => {
      query = search.value.trim().toLowerCase();
      for (const n of notes) applyFilter(n, els.get(n.id));
    });
    search.addEventListener('keydown', (e) => e.stopPropagation());

    const bar = el(
      'div',
      'app-bar',
      count,
      el('span', 'app-spacer'),
      search,
      handBtn,
      el(
        'div',
        'sk-zoom',
        button('', 'minus', 'Zoom out (⌘-)', () => stepZoom(-1)),
        zoomLabel,
        button('', 'plus', 'Zoom in (⌘=)', () => stepZoom(1)),
        button('', 'corners-out', 'Fit all notes', fitAll),
      ),
      button('Tidy', 'squares-four', 'Line the notes up in a grid', tidy),
      button('New note', 'plus', 'Add a sticky note', () => addNote()),
    );
    render();
    return {
      el: el('div', 'app app-stickies', bar, board),
      focus: () => {
        if (!notes.length) addNote();
      },
    };
  }

  window.DeckApps.register({ id: 'note', name: 'Notes', desc: 'A board of sticky notes', icon: 'note', mat: 'document', color: 'var(--bot-2)', build: stickyNotes });
})();
