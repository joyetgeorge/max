/* global deck */
'use strict';

// Tasks app: a kanban board with due dates, reminders, priorities, tags and subtasks.
(() => {
  const { node: el, icon: ph, store, uid } = window.Kit;
  const { button } = window.DeckApps.ui;

  const TASK_COLS = [
    { id: 'todo', title: 'To do', icon: 'circle-dashed' },
    { id: 'doing', title: 'In progress', icon: 'circle-half' },
    { id: 'done', title: 'Done', icon: 'check-circle' },
  ];
  const PRIORITIES = [
    { id: 0, label: 'None', color: 'transparent' },
    { id: 1, label: 'Low', color: 'var(--running)' },
    { id: 2, label: 'Medium', color: 'var(--waiting)' },
    { id: 3, label: 'High', color: 'var(--del)' },
  ];

  // One store for the board and the reminder checker, so neither overwrites the other.
  const TaskStore = (() => {
    const KEY = 'deck.app.tasks';
    let cards = store.json(KEY, []);
    const listeners = new Set();
    return {
      get cards() {
        return cards;
      },
      set cards(v) {
        cards = v;
      },
      save() {
        store.setJson(KEY, cards);
        listeners.forEach((fn) => fn());
      },
      onChange: (fn) => listeners.add(fn),
    };
  })();

  // ----- due dates -----
  const pad = (n) => String(n).padStart(2, '0');
  const dayStart = (t) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const toDateInput = (t) => (t ? `${new Date(t).getFullYear()}-${pad(new Date(t).getMonth() + 1)}-${pad(new Date(t).getDate())}` : '');
  const toTimeInput = (t) => (t ? `${pad(new Date(t).getHours())}:${pad(new Date(t).getMinutes())}` : '');
  const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function dueLabel(t) {
    const days = Math.round((dayStart(t) - dayStart(Date.now())) / 86400000);
    const day =
      days === 0 ? 'Today'
      : days === 1 ? 'Tomorrow'
      : days === -1 ? 'Yesterday'
      : days > 1 && days < 7 ? new Date(t).toLocaleDateString([], { weekday: 'short' })
      : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', ...(new Date(t).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
    return `${day}, ${fmtTime(t)}`;
  }
  // overdue | soon (within the hour) | today | later
  function dueState(c) {
    if (!c.due || c.col === 'done') return '';
    const now = Date.now();
    if (c.due <= now) return 'overdue';
    if (c.due - now <= 3600000) return 'soon';
    if (dayStart(c.due) === dayStart(now)) return 'today';
    return 'later';
  }

  // ----- reminders: a notification when a task falls due (runs whether or not the board is open) -----
  function checkDue() {
    const now = Date.now();
    let changed = false;
    for (const c of TaskStore.cards) {
      if (!c.due || c.col === 'done' || c.notified || c.due > now) continue;
      c.notified = true;
      changed = true;
      const late = now - c.due > 5 * 60000;
      deck.notify({
        title: late ? 'Task overdue' : 'Task due',
        body: `${c.text}${late ? ` — was due ${dueLabel(c.due)}` : ''}`,
        tag: `task:${c.id}`,
      });
    }
    if (changed) TaskStore.save();
  }
  setInterval(checkDue, 20000);
  setTimeout(checkDue, 3000); // catch anything that fell due while Max was closed

  function tasksApp() {
    const save = () => TaskStore.save();
    let dragId = null;
    let adding = null; // column id with an open "add" input
    let query = '';
    let view = 'all'; // all | today | overdue | high
    let openId = null; // card shown in the editor

    const board = el('div', 'kb-board');

    function matches(c) {
      if (query && !`${c.text} ${c.notes || ''} ${(c.tags || []).join(' ')}`.toLowerCase().includes(query)) return false;
      const ds = dueState(c);
      if (view === 'today' && !(c.due && c.col !== 'done' && dayStart(c.due) <= dayStart(Date.now()))) return false;
      if (view === 'overdue' && ds !== 'overdue') return false;
      if (view === 'high' && (c.priority || 0) < 3) return false;
      return true;
    }

    function cardEl(c) {
      const ds = dueState(c);
      const subs = c.subtasks || [];
      const doneSubs = subs.filter((s) => s.done).length;
      const check = el('button', 'kb-check', ph(c.col === 'done' ? 'check-circle' : 'circle'));
      check.title = c.col === 'done' ? 'Mark as not done' : 'Mark as done';
      check.addEventListener('click', (e) => {
        e.stopPropagation();
        setCol(c, c.col === 'done' ? 'todo' : 'done');
      });
      const meta = el(
        'div',
        'kb-meta',
        c.due ? el('span', `kb-due ${ds}`, ph(ds === 'overdue' ? 'alarm' : 'calendar-blank'), dueLabel(c.due)) : null,
        subs.length ? el('span', `kb-chip${doneSubs === subs.length ? ' full' : ''}`, ph('list-checks'), `${doneSubs}/${subs.length}`) : null,
        c.notes ? el('span', 'kb-chip', ph('text-align-left')) : null,
        ...(c.tags || []).map((t) => el('span', 'kb-tag', `#${t}`)),
      );
      const card = el(
        'div',
        `kb-card${c.col === 'done' ? ' done' : ''}${c.priority ? ` p${c.priority}` : ''}${ds ? ` due-${ds}` : ''}`,
        el('div', 'kb-card-top', check, el('span', 'kb-card-text', c.text)),
        meta.childNodes.length ? meta : null,
      );
      card.draggable = true;
      card.title = 'Click to open · drag to move';
      card.dataset.id = c.id;
      card.addEventListener('click', () => openEditor(c.id));
      card.addEventListener('dragstart', (e) => {
        dragId = c.id;
        e.dataTransfer.effectAllowed = 'move';
        requestAnimationFrame(() => card.classList.add('dragging'));
      });
      card.addEventListener('dragend', () => {
        dragId = null;
        render();
      });
      return card;
    }

    function setCol(c, col) {
      c.col = col;
      c.completedAt = col === 'done' ? Date.now() : undefined;
      save();
    }

    // Quick add: "#tag" adds a tag, "!" / "!!" / "!!!" sets low / medium / high priority.
    function parseQuick(text) {
      const tags = [];
      let priority = 0;
      const rest = text
        .replace(/(^|\s)#([\w-]+)/g, (_, sp, t) => {
          tags.push(t);
          return sp;
        })
        .replace(/(^|\s)(!{1,3})(?=\s|$)/g, (_, sp, bangs) => {
          priority = bangs.length;
          return sp;
        })
        .replace(/\s+/g, ' ')
        .trim();
      return { text: rest || text.trim(), tags, priority };
    }
    function addRow(col) {
      if (adding !== col.id) {
        const b = el('button', 'kb-add', ph('plus'), 'Add task');
        b.addEventListener('click', () => {
          adding = col.id;
          render();
        });
        return b;
      }
      const ta = el('textarea', 'kb-edit');
      ta.placeholder = 'What needs doing?  #tag  !!! priority  ↵ add · esc cancel';
      const commit = () => {
        const text = ta.value.trim();
        if (text) {
          TaskStore.cards.push({ id: uid(), col: col.id, created: Date.now(), ...parseQuick(text) });
          save();
        }
        return text;
      };
      let finished = false; // re-rendering removes the textarea, firing a synchronous blur
      ta.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          finished = true;
          if (commit()) render(); // keep the input open for rapid entry
          else finished = false;
        } else if (e.key === 'Escape') {
          finished = true;
          adding = null;
          render();
        }
      });
      ta.addEventListener('blur', () => {
        if (finished || adding !== col.id) return;
        finished = true;
        commit();
        adding = null;
        render();
      });
      requestAnimationFrame(() => ta.focus());
      return el('div', 'kb-card editing', ta);
    }

    function dropIndex(list, y) {
      const els = [...list.querySelectorAll('.kb-card:not(.dragging):not(.editing)')];
      const next = els.find((n) => y < n.getBoundingClientRect().top + n.offsetHeight / 2);
      return next ? next.dataset.id : null;
    }

    function render() {
      board.replaceChildren(
        ...TASK_COLS.map((col) => {
          const mine = TaskStore.cards.filter((c) => c.col === col.id);
          const shown = mine.filter(matches);
          const list = el('div', 'kb-list', shown.map(cardEl), addRow(col));
          const colEl = el(
            'div',
            `kb-col kb-${col.id}`,
            el('div', 'kb-col-head', ph(col.icon), el('span', 'kb-col-title', col.title), el('span', 'kb-col-count', shown.length === mine.length ? String(mine.length) : `${shown.length}/${mine.length}`)),
            list,
          );
          colEl.addEventListener('dragover', (e) => {
            if (!dragId) return;
            e.preventDefault();
            colEl.classList.add('over');
            list.querySelectorAll('.kb-drop').forEach((n) => n.remove());
            const before = dropIndex(list, e.clientY);
            const ref = before ? list.querySelector(`[data-id="${before}"]`) : list.querySelector('.kb-add, .kb-card.editing');
            list.insertBefore(el('div', 'kb-drop'), ref);
          });
          colEl.addEventListener('dragleave', (e) => {
            if (colEl.contains(e.relatedTarget)) return;
            colEl.classList.remove('over');
            list.querySelectorAll('.kb-drop').forEach((n) => n.remove());
          });
          colEl.addEventListener('drop', (e) => {
            e.preventDefault();
            const card = TaskStore.cards.find((c) => c.id === dragId);
            if (!card) return;
            const before = dropIndex(list, e.clientY);
            TaskStore.cards = TaskStore.cards.filter((c) => c !== card);
            const at = before ? TaskStore.cards.findIndex((c) => c.id === before) : -1;
            if (at >= 0) TaskStore.cards.splice(at, 0, card);
            else TaskStore.cards.push(card);
            dragId = null;
            if (card.col !== col.id) setCol(card, col.id);
            else save();
          });
          return colEl;
        }),
      );
      const open = TaskStore.cards.filter((c) => c.col !== 'done');
      const overdue = open.filter((c) => dueState(c) === 'overdue').length;
      const today = open.filter((c) => c.due && dayStart(c.due) === dayStart(Date.now())).length;
      summary.replaceChildren(
        `${open.length} open`,
        today ? ` · ${today} due today` : '',
        overdue ? el('span', 'kb-sum-overdue', ` · ${overdue} overdue`) : '',
      );
    }

    // ----- editor (opens over the board) -----
    const editor = el('div', 'kb-editor hidden');
    function closeEditor() {
      openId = null;
      editor.classList.add('hidden');
      editor.replaceChildren();
    }
    editor.addEventListener('mousedown', (e) => e.target === editor && closeEditor());
    function openEditor(id) {
      const c = TaskStore.cards.find((x) => x.id === id);
      if (!c) return;
      openId = id;
      const field = (label, ...kids) => el('div', 'kb-field', el('label', 'kb-label', label), ...kids);
      const input = (cls, value, placeholder) => {
        const i = el('input', cls);
        i.value = value ?? '';
        if (placeholder) i.placeholder = placeholder;
        i.spellcheck = false;
        return i;
      };

      const title = el('textarea', 'kb-title');
      title.value = c.text;
      title.rows = 1;
      const grow = () => {
        title.style.height = 'auto';
        title.style.height = `${title.scrollHeight}px`;
      };
      title.addEventListener('input', () => {
        c.text = title.value.replace(/\n/g, ' ').trim() || c.text;
        grow();
        save();
      });
      title.addEventListener('keydown', (e) => e.key === 'Enter' && e.preventDefault());

      // Status
      const status = el('div', 'kb-seg');
      for (const col of TASK_COLS) {
        const b = el('button', `kb-seg-btn${c.col === col.id ? ' on' : ''}`, ph(col.icon), col.title);
        b.addEventListener('click', () => {
          setCol(c, col.id);
          openEditor(id);
        });
        status.append(b);
      }
      // Priority
      const prio = el('div', 'kb-seg');
      for (const p of PRIORITIES) {
        const b = el('button', `kb-seg-btn${(c.priority || 0) === p.id ? ' on' : ''}`, el('span', 'kb-prio-dot', ''), p.label);
        b.querySelector('.kb-prio-dot').style.background = p.color;
        b.addEventListener('click', () => {
          c.priority = p.id;
          save();
          openEditor(id);
        });
        prio.append(b);
      }
      // Due date + time, with shortcuts. Changing it re-arms the reminder.
      const date = input('kb-input', toDateInput(c.due));
      date.type = 'date';
      const time = input('kb-input', toTimeInput(c.due));
      time.type = 'time';
      const setDue = (t) => {
        c.due = t || undefined;
        c.notified = false;
        save();
        openEditor(id);
      };
      const fromInputs = () => {
        if (!date.value) return setDue(null);
        const [y, m, d] = date.value.split('-').map(Number);
        const [hh, mm] = (time.value || '09:00').split(':').map(Number);
        setDue(new Date(y, m - 1, d, hh, mm).getTime());
      };
      date.addEventListener('change', fromInputs);
      time.addEventListener('change', fromInputs);
      const at = (days, hh, mm = 0) => {
        const d = new Date();
        d.setDate(d.getDate() + days);
        d.setHours(hh, mm, 0, 0);
        return d.getTime();
      };
      const inMin = (m) => Math.ceil((Date.now() + m * 60000) / 60000) * 60000;
      const nextMonday = () => (8 - new Date().getDay()) % 7 || 7;
      const quick = (label, fn) => {
        const b = el('button', 'kb-quick', label);
        b.addEventListener('click', () => setDue(fn()));
        return b;
      };
      const ds = dueState(c);
      const due = field(
        'Due',
        el('div', 'kb-due-row', date, time, c.due ? button('', 'x', 'Remove the due date', () => setDue(null)) : null),
        el(
          'div',
          'kb-quicks',
          quick('In 1 hour', () => inMin(60)),
          quick('Today 5 PM', () => at(0, 17)),
          quick('Tomorrow 9 AM', () => at(1, 9)),
          quick('Next Monday', () => at(nextMonday(), 9)),
        ),
        c.due
          ? el(
              'div',
              `kb-due-note ${ds}`,
              ph(c.col === 'done' ? 'check' : c.notified ? 'bell-ringing' : 'bell'),
              c.col === 'done' ? ' Completed' : c.notified ? ' Reminder sent' : ` Reminder at ${dueLabel(c.due)}`,
            )
          : null,
      );
      // Tags
      const tags = input('kb-input', (c.tags || []).join(', '), 'Comma-separated, e.g. backend, urgent');
      tags.addEventListener('change', () => {
        c.tags = tags.value.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
        save();
      });
      // Notes
      const notes = el('textarea', 'kb-notes');
      notes.value = c.notes || '';
      notes.placeholder = 'Add details, links, context…';
      notes.addEventListener('input', () => {
        c.notes = notes.value;
        save();
      });
      // Subtasks
      const subs = (c.subtasks ||= []);
      const subList = el('div', 'kb-subs');
      const paintSubs = () =>
        subList.replaceChildren(
          ...subs.map((s) => {
            const cb = el('input');
            cb.type = 'checkbox';
            cb.checked = !!s.done;
            cb.addEventListener('change', () => {
              s.done = cb.checked;
              save();
              row.classList.toggle('done', s.done);
            });
            const txt = input('kb-sub-text', s.text);
            txt.addEventListener('input', () => {
              s.text = txt.value;
              save();
            });
            const del = button('', 'x', 'Remove', () => {
              subs.splice(subs.indexOf(s), 1);
              save();
              paintSubs();
            });
            const row = el('div', `kb-sub${s.done ? ' done' : ''}`, cb, txt, del);
            return row;
          }),
        );
      paintSubs();
      const addSub = input('kb-input kb-sub-add', '', 'Add a step and press ↵');
      addSub.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !addSub.value.trim()) return;
        subs.push({ id: uid(), text: addSub.value.trim(), done: false });
        addSub.value = '';
        save();
        paintSubs();
      });

      const del = button('Delete', 'trash', 'Delete this task', () => {
        if (!del.classList.contains('armed')) {
          del.classList.add('armed');
          del.lastChild.textContent = 'Click again';
          setTimeout(() => {
            del.classList.remove('armed');
            del.lastChild.textContent = 'Delete';
          }, 2000);
          return;
        }
        TaskStore.cards = TaskStore.cards.filter((x) => x !== c);
        save();
        closeEditor();
      });
      const created = el('span', 'kb-created', `Created ${new Date(c.created || Date.now()).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`);
      const sheet = el(
        'div',
        'kb-sheet',
        el('div', 'kb-sheet-head', title, button('', 'x', 'Close (esc)', closeEditor)),
        field('Status', status),
        field('Priority', prio),
        due,
        field('Tags', tags),
        field('Notes', notes),
        field(`Subtasks${subs.length ? ` · ${subs.filter((s) => s.done).length}/${subs.length}` : ''}`, subList, addSub),
        el('div', 'kb-sheet-foot', created, el('span', 'app-spacer'), del),
      );
      sheet.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') closeEditor();
      });
      editor.replaceChildren(sheet);
      editor.classList.remove('hidden');
      requestAnimationFrame(() => {
        grow();
        if (!c.text) title.focus();
      });
    }

    // ----- toolbar -----
    const search = el('input', 'nw-search');
    search.placeholder = 'Search tasks, notes, #tags';
    search.spellcheck = false;
    search.addEventListener('input', () => {
      query = search.value.trim().toLowerCase().replace(/^#/, '');
      render();
    });
    search.addEventListener('keydown', (e) => e.stopPropagation());
    const seg = el('div', 'nw-seg');
    const segBtns = {};
    for (const [k, label] of [['all', 'All'], ['today', 'Today'], ['overdue', 'Overdue'], ['high', 'High priority']]) {
      const b = el('button', `nw-seg-btn${k === view ? ' on' : ''}`, label);
      b.addEventListener('click', () => {
        view = k;
        for (const [kk, bb] of Object.entries(segBtns)) bb.classList.toggle('on', kk === k);
        render();
      });
      segBtns[k] = b;
      seg.append(b);
    }
    const clearDone = button('Clear done', 'broom', 'Remove all tasks in Done', () => {
      TaskStore.cards = TaskStore.cards.filter((c) => c.col !== 'done');
      save();
    });
    const summary = el('span', 'app-title');
    const bar = el('div', 'app-bar', summary, el('span', 'app-spacer'), search, seg, clearDone);

    // Re-render on any change (including the reminder checker), and every minute so
    // "due soon" / "overdue" badges stay current.
    TaskStore.onChange(() => {
      render();
      if (openId && !TaskStore.cards.some((c) => c.id === openId)) closeEditor();
    });
    setInterval(render, 60000);
    render();
    return {
      el: el('div', 'app app-tasks', bar, board, editor),
      focus: () => {
        if (!TaskStore.cards.length) {
          adding = 'todo';
          render();
        }
      },
      openTask: (id) => openEditor(id),
    };
  }

  window.DeckApps.register({ id: 'tasks', name: 'Tasks', desc: 'Kanban board with due dates & reminders', icon: 'kanban', mat: 'todo', color: 'var(--bot-1)', build: tasksApp });
})();
