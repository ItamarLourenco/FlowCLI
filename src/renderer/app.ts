import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export {};

// ─── Types ────────────────────────────────────────────────────────────────────

type Column = 'todo' | 'doing' | 'review' | 'done';
type BadgeState = 'running' | 'thinking' | 'finish' | 'done';

interface Task {
  id: string;
  title: string;
  description: string;
  column: Column;
  createdAt: number;
}

interface Project {
  id: string;
  name: string;
  directory: string;
  tasks: Task[];
}

declare global {
  interface Window {
    electronAPI: {
      loadProjects: () => Promise<Project[]>;
      saveProjects: (p: Project[]) => Promise<void>;
      pickDirectory: () => Promise<string | null>;
      spawnTerminal: (id: string, cols: number, rows: number, cwd?: string) => Promise<void>;
      sendInput: (id: string, data: string) => Promise<void>;
      resizePty: (id: string, cols: number, rows: number) => Promise<void>;
      killTerminal: (id: string) => Promise<void>;
      onOutput: (cb: (p: { id: string; data: string }) => void) => void;
      onStatus: (cb: (p: { id: string; status: string }) => void) => void;
      onTerminalState: (cb: (p: { id: string; state: string }) => void) => void;
      onLastMessage: (cb: (p: { id: string; message: string }) => void) => void;
    };
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const COLUMNS: { id: Column; label: string }[] = [
  { id: 'todo',   label: 'A fazer'   },
  { id: 'doing',  label: 'Fazendo'   },
  { id: 'review', label: 'Revisão'   },
  { id: 'done',   label: 'Concluído' },
];

// Terminal state → column auto-transition
const STATE_TO_COLUMN: Partial<Record<BadgeState, Column>> = {
  thinking: 'doing',
  finish:   'review',
};

const STATE_META: Record<BadgeState, { label: string; pulse: boolean }> = {
  running:  { label: 'Running',   pulse: false },
  thinking: { label: 'Thinking',  pulse: true  },
  finish:   { label: 'Finish',    pulse: false },
  done:     { label: 'Concluído', pulse: false },
};

// ─── State ────────────────────────────────────────────────────────────────────

let projects: Project[] = [];
let activeProjectId: string | null = null;
let editingTaskId: string | null = null;
let pendingTaskColumn: Column = 'todo';

// DOM card elements kept alive across re-renders
const cardEls = new Map<string, HTMLElement>();
// xterm instances per task
const termMap = new Map<string, { term: Terminal; fit: FitAddon }>();
// Tasks that have received at least one user input (unlocks auto-transition out of todo)
const activatedTasks = new Set<string>();
// Last Claude message per task (shown as tooltip in review column)
const lastMessages = new Map<string, string>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const esc = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const save = () => window.electronAPI.saveProjects(projects);
const activeProject = () => projects.find(p => p.id === activeProjectId);

// ─── Selectors ────────────────────────────────────────────────────────────────

const tabsEl       = document.getElementById('tabs')!;
const mainEl       = document.getElementById('main')!;
const emptyState   = document.getElementById('empty-state')!;
const modalProject = document.getElementById('modal-project')!;
const modalTask    = document.getElementById('modal-task')!;

// ─── Terminal per task ────────────────────────────────────────────────────────

function mountTerminal(taskId: string, cwd: string, firstPrompt?: string) {
  const container = document.getElementById(`terminal-${taskId}`);
  if (!container || termMap.has(taskId)) return;

  const term = new Terminal({
    theme: { background: '#111', foreground: '#d4d4d4', cursor: '#a78bfa', selectionBackground: '#7c3aed44' },
    fontFamily: '"JetBrains Mono","Fira Code","Courier New",monospace',
    fontSize: 11,
    lineHeight: 1.45,
    cursorBlink: true,
    scrollback: 2000,
    convertEol: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fit.fit();

  term.onData(data => {
    activatedTasks.add(taskId);
    window.electronAPI.sendInput(taskId, data);
  });
  termMap.set(taskId, { term, fit });

  window.electronAPI.spawnTerminal(taskId, term.cols, term.rows, cwd);

  // Auto-launch Claude after the shell initializes (doesn't count as user input)
  setTimeout(() => {
    window.electronAPI.sendInput(taskId, 'claude --dangerously-skip-permissions\r');
  }, 800);

  // Type first prompt into Claude's input after it loads (~3s from spawn), but don't submit
  if (firstPrompt?.trim()) {
    setTimeout(() => {
      window.electronAPI.sendInput(taskId, firstPrompt.trim());
    }, 3000);
  }

  const observer = new ResizeObserver(() => {
    fit.fit();
    window.electronAPI.resizePty(taskId, term.cols, term.rows);
  });
  observer.observe(container);
}

function destroyTerminal(taskId: string) {
  const t = termMap.get(taskId);
  if (t) { t.term.dispose(); termMap.delete(taskId); }
  window.electronAPI.killTerminal(taskId);
}

function updateBadge(taskId: string, state: BadgeState) {
  const badge = document.getElementById(`badge-${taskId}`);
  if (!badge) return;
  const meta = STATE_META[state];
  badge.className = `status-badge ${state}`;
  badge.innerHTML = `<span class="status-dot ${meta.pulse ? 'pulse' : ''}"></span>${meta.label}`;
}

function moveTask(taskId: string, col: Column) {
  const proj = activeProject();
  if (!proj) return;
  const task = proj.tasks.find(t => t.id === taskId);
  const el   = cardEls.get(taskId);
  const zone = document.getElementById(`col-${col}`);
  if (!task || !el || !zone || task.column === col) return;

  task.column = col;
  zone.appendChild(el);
  save();
  updateColCounts();

  if (col === 'done') {
    updateBadge(taskId, 'done');
    const wrap   = document.getElementById(`wrap-${taskId}`);
    const minBtn = el.querySelector<HTMLButtonElement>('.btn-minimize-task');
    if (wrap && !wrap.classList.contains('hidden')) {
      wrap.classList.add('hidden');
      if (minBtn) minBtn.textContent = '+';
    }
  }
}

// ─── Card element ─────────────────────────────────────────────────────────────

function createCardEl(task: Task): HTMLElement {
  const el = document.createElement('div');
  el.className = 'task-card';
  el.dataset.taskId = task.id;
  el.draggable = true;

  el.innerHTML = `
    <div class="task-header">
      <span class="task-title" id="title-${task.id}">${esc(task.title)}</span>
      <div class="task-actions">
        <span class="status-badge running" id="badge-${task.id}">
          <span class="status-dot pulse"></span>Running
        </span>
        <button class="task-btn btn-maximize-task"  data-task-id="${task.id}" title="Maximize">⤢</button>
        <button class="task-btn btn-minimize-task" data-task-id="${task.id}" title="Minimize">−</button>
        <button class="task-btn btn-edit-task"     data-task-id="${task.id}" title="Edit">✏️</button>
        <button class="task-btn btn-delete-task"   data-task-id="${task.id}" title="Delete">🗑</button>
      </div>
    </div>
    ${task.description ? `<div class="task-desc" id="desc-${task.id}">${esc(task.description)}</div>` : ''}
    <div class="task-terminal-wrap" id="wrap-${task.id}">
      <div class="task-terminal" id="terminal-${task.id}"></div>
    </div>
  `;

  // Drag events
  el.addEventListener('dragstart', () => { dragTaskId = task.id; el.classList.add('dragging'); });
  el.addEventListener('dragend',   () => el.classList.remove('dragging'));

  // Tooltip with last Claude message when hovering a review card
  el.addEventListener('mouseenter', (e) => {
    const proj = activeProject();
    const t = proj?.tasks.find(t => t.id === task.id);
    if (t?.column !== 'review') return;
    const msg = lastMessages.get(task.id);
    if (!msg) return;
    const tooltip = document.getElementById('task-tooltip')!;
    tooltip.textContent = msg;
    tooltip.classList.remove('hidden');
    const rect = el.getBoundingClientRect();
    const top = rect.bottom + 8;
    const left = Math.min(rect.left, window.innerWidth - 440);
    tooltip.style.top  = `${top}px`;
    tooltip.style.left = `${Math.max(8, left)}px`;
  });
  el.addEventListener('mouseleave', () => {
    document.getElementById('task-tooltip')?.classList.add('hidden');
  });

  // Maximize toggle
  el.querySelector<HTMLButtonElement>('.btn-maximize-task')!.addEventListener('click', () => {
    const btn  = el.querySelector<HTMLButtonElement>('.btn-maximize-task')!;
    const maximized = el.classList.toggle('maximized');
    btn.textContent = maximized ? '⤡' : '⤢';
    el.draggable = !maximized;
    if (maximized) {
      // Ensure terminal is visible
      document.getElementById(`wrap-${task.id}`)?.classList.remove('hidden');
      el.querySelector<HTMLButtonElement>('.btn-minimize-task')!.textContent = '−';
    }
    const t = termMap.get(task.id);
    if (t) setTimeout(() => {
      t.fit.fit();
      window.electronAPI.resizePty(task.id, t.term.cols, t.term.rows);
    }, 30);
  });

  // Minimize toggle
  el.querySelector<HTMLButtonElement>('.btn-minimize-task')!.addEventListener('click', () => {
    const wrap = document.getElementById(`wrap-${task.id}`)!;
    const btn  = el.querySelector<HTMLButtonElement>('.btn-minimize-task')!;
    const minimized = wrap.classList.toggle('hidden');
    btn.textContent = minimized ? '+' : '−';
    if (!minimized) {
      const t = termMap.get(task.id);
      if (t) setTimeout(() => {
        t.fit.fit();
        window.electronAPI.resizePty(task.id, t.term.cols, t.term.rows);
      }, 50);
    }
  });

  // Edit
  el.querySelector<HTMLButtonElement>('.btn-edit-task')!.addEventListener('click', () => {
    editingTaskId = task.id;
    openTaskModal('Edit Task', task.title, task.description);
  });

  // Delete
  el.querySelector<HTMLButtonElement>('.btn-delete-task')!.addEventListener('click', () => {
    const proj = activeProject();
    if (!proj) return;
    destroyTerminal(task.id);
    cardEls.delete(task.id);
    el.remove();
    proj.tasks = proj.tasks.filter(t => t.id !== task.id);
    save();
    updateColCounts();
  });

  cardEls.set(task.id, el);
  return el;
}

// ─── Board render ─────────────────────────────────────────────────────────────

function renderBoard() {
  const proj = activeProject();

  if (!proj) {
    emptyState.style.display = 'flex';
    document.getElementById('kanban-board')?.remove();
    return;
  }

  emptyState.style.display = 'none';

  // Build board skeleton if needed
  let board = document.getElementById('kanban-board');
  if (!board) {
    board = document.createElement('div');
    board.id = 'kanban-board';
    board.className = 'kanban-board';

    COLUMNS.forEach(col => {
      const colEl = document.createElement('div');
      colEl.className = 'kanban-col';
      colEl.dataset.col = col.id;
      const minimizeAllBtn = col.id === 'doing'
        ? `<button class="btn-col-minimize-all" data-col="${col.id}" title="Minimizar todos">−</button>`
        : '';
      colEl.innerHTML = `
        <div class="col-header">
          <span class="col-title">${col.label}</span>
          <div style="display:flex;align-items:center;gap:6px;">
            ${minimizeAllBtn}
            <span class="col-count" id="count-${col.id}">0</span>
          </div>
        </div>
        <div class="col-tasks" id="col-${col.id}" data-col="${col.id}"></div>
        <button class="btn-add-task" data-col="${col.id}">+ Add task</button>
      `;
      board!.appendChild(colEl);
    });

    board.addEventListener('click', e => {
      const t = e.target as HTMLElement;
      if (t.classList.contains('btn-add-task')) {
        pendingTaskColumn = (t.dataset.col as Column) ?? 'todo';
        editingTaskId = null;
        openTaskModal('New Task');
      }
      if (t.classList.contains('btn-col-minimize-all')) {
        const proj = activeProject();
        if (!proj) return;
        const doingTasks = proj.tasks.filter(t => t.column === 'doing');
        const anyVisible = doingTasks.some(task => {
          const wrap = document.getElementById(`wrap-${task.id}`);
          return wrap && !wrap.classList.contains('hidden');
        });
        doingTasks.forEach(task => {
          const wrap = document.getElementById(`wrap-${task.id}`);
          const btn  = cardEls.get(task.id)?.querySelector<HTMLButtonElement>('.btn-minimize-task');
          if (!wrap) return;
          if (anyVisible) {
            wrap.classList.add('hidden');
            if (btn) btn.textContent = '+';
          } else {
            wrap.classList.remove('hidden');
            if (btn) btn.textContent = '−';
            const t = termMap.get(task.id);
            if (t) setTimeout(() => {
              t.fit.fit();
              window.electronAPI.resizePty(task.id, t.term.cols, t.term.rows);
            }, 50);
          }
        });
        t.textContent = anyVisible ? '+' : '−';
      }
    });

    setupDropZones(board);
    mainEl.appendChild(board);
  }

  // Place existing cards (or create new ones) in correct columns
  proj.tasks.forEach(task => {
    let el = cardEls.get(task.id);
    if (!el) el = createCardEl(task);

    const colEl = document.getElementById(`col-${task.column}`);
    if (colEl && el.parentElement !== colEl) colEl.appendChild(el);
  });

  // Mount terminals (no-op if already mounted)
  proj.tasks.forEach(task => {
    requestAnimationFrame(() => mountTerminal(task.id, proj.directory, task.description));
  });

  updateColCounts();
}

function updateColCounts() {
  const proj = activeProject();
  if (!proj) return;
  COLUMNS.forEach(col => {
    const el = document.getElementById(`count-${col.id}`);
    if (el) el.textContent = String(proj.tasks.filter(t => t.column === col.id).length);
  });
}

// ─── Drag & drop (moves DOM element directly, no re-render) ──────────────────

let dragTaskId: string | null = null;

function setupDropZones(board: HTMLElement) {
  board.addEventListener('dragover', e => {
    e.preventDefault();
    const zone = (e.target as HTMLElement).closest<HTMLElement>('.col-tasks');
    document.querySelectorAll('.col-tasks').forEach(z => z.classList.remove('drag-over'));
    zone?.classList.add('drag-over');
  });

  board.addEventListener('dragleave', e => {
    if (!(e.relatedTarget as HTMLElement)?.closest?.('.col-tasks'))
      document.querySelectorAll('.col-tasks').forEach(z => z.classList.remove('drag-over'));
  });

  board.addEventListener('drop', e => {
    e.preventDefault();
    document.querySelectorAll('.col-tasks').forEach(z => z.classList.remove('drag-over'));
    if (!dragTaskId) return;

    const zone = (e.target as HTMLElement).closest<HTMLElement>('.col-tasks');
    if (!zone) return;

    const col = zone.dataset.col as Column;
    moveTask(dragTaskId, col);
    dragTaskId = null;
  });
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function renderTabs() {
  tabsEl.innerHTML = projects.map(p => `
    <div class="tab ${p.id === activeProjectId ? 'active' : ''}" data-id="${p.id}">
      <span class="tab-dot"></span>
      <span class="tab-name">${esc(p.name)}</span>
      <button class="tab-close" data-id="${p.id}">×</button>
    </div>
  `).join('');
}

tabsEl.addEventListener('click', e => {
  const target = e.target as HTMLElement;

  if (target.classList.contains('tab-close')) {
    e.stopPropagation();
    const id = target.dataset.id!;
    // Kill all terminals for this project
    projects.find(p => p.id === id)?.tasks.forEach(t => destroyTerminal(t.id));
    cardEls.forEach((el, tid) => { if (!projects.find(p => p.id !== id && p.tasks.some(t => t.id === tid))) cardEls.delete(tid); });
    projects = projects.filter(p => p.id !== id);
    if (activeProjectId === id) {
      activeProjectId = projects[projects.length - 1]?.id ?? null;
      document.getElementById('kanban-board')?.remove();
    }
    save();
    renderTabs();
    renderBoard();
    return;
  }

  const tab = target.closest<HTMLElement>('.tab');
  if (tab && tab.dataset.id !== activeProjectId) {
    document.getElementById('kanban-board')?.remove();
    activeProjectId = tab.dataset.id!;
    renderTabs();
    renderBoard();
  }
});

// ─── Project modal ────────────────────────────────────────────────────────────

function openProjectModal() {
  (document.getElementById('proj-name') as HTMLInputElement).value = '';
  (document.getElementById('proj-dir')  as HTMLInputElement).value = '';
  modalProject.classList.remove('hidden');
  setTimeout(() => (document.getElementById('proj-name') as HTMLInputElement).focus(), 50);
}

document.getElementById('btn-new-project')!.addEventListener('click', openProjectModal);
document.getElementById('btn-empty-create')!.addEventListener('click', openProjectModal);
document.getElementById('btn-proj-cancel')!.addEventListener('click', () => modalProject.classList.add('hidden'));

document.getElementById('btn-pick-dir')!.addEventListener('click', async () => {
  const dir = await window.electronAPI.pickDirectory();
  if (dir) (document.getElementById('proj-dir') as HTMLInputElement).value = dir;
});

document.getElementById('btn-proj-confirm')!.addEventListener('click', () => {
  const name = (document.getElementById('proj-name') as HTMLInputElement).value.trim();
  const dir  = (document.getElementById('proj-dir')  as HTMLInputElement).value.trim();
  if (!name || !dir) return;
  const proj: Project = { id: uid(), name, directory: dir, tasks: [] };
  projects.push(proj);
  activeProjectId = proj.id;
  save();
  modalProject.classList.add('hidden');
  document.getElementById('kanban-board')?.remove();
  renderTabs();
  renderBoard();
});

modalProject.addEventListener('keydown', e => {
  if (e.key === 'Escape') modalProject.classList.add('hidden');
});

// ─── Task modal ───────────────────────────────────────────────────────────────

function openTaskModal(title: string, taskTitle = '', taskDesc = '') {
  (document.getElementById('modal-task-title')!).textContent = title;
  (document.getElementById('task-title-input') as HTMLInputElement).value = taskTitle;
  (document.getElementById('task-desc-input')  as HTMLTextAreaElement).value = taskDesc;
  modalTask.classList.remove('hidden');
  setTimeout(() => (document.getElementById('task-title-input') as HTMLInputElement).focus(), 50);
}

document.getElementById('btn-task-cancel')!.addEventListener('click', () => {
  modalTask.classList.add('hidden');
  editingTaskId = null;
});

document.getElementById('btn-task-confirm')!.addEventListener('click', () => {
  const title = (document.getElementById('task-title-input') as HTMLInputElement).value.trim();
  if (!title) return;
  const description = (document.getElementById('task-desc-input') as HTMLTextAreaElement).value.trim();
  const proj = activeProject();
  if (!proj) return;

  if (editingTaskId) {
    const task = proj.tasks.find(t => t.id === editingTaskId);
    if (task) {
      task.title = title;
      task.description = description;
      const titleEl = document.getElementById(`title-${task.id}`);
      const descEl  = document.getElementById(`desc-${task.id}`);
      if (titleEl) titleEl.textContent = title;
      if (descEl)  descEl.textContent  = description;
    }
    editingTaskId = null;
  } else {
    const task: Task = { id: uid(), title, description, column: pendingTaskColumn, createdAt: Date.now() };
    proj.tasks.push(task);
    const el = createCardEl(task);
    document.getElementById(`col-${task.column}`)?.appendChild(el);
    requestAnimationFrame(() => mountTerminal(task.id, proj.directory, task.description));
    updateColCounts();
  }

  save();
  modalTask.classList.add('hidden');
});

modalTask.addEventListener('keydown', e => {
  if (e.key === 'Escape') { modalTask.classList.add('hidden'); editingTaskId = null; }
});

// ─── Terminal events ──────────────────────────────────────────────────────────

window.electronAPI.onOutput(({ id, data }) => {
  termMap.get(id)?.term.write(data);
});

window.electronAPI.onStatus(({ id, status }) => {
  // process exit — just keep current badge, don't show exited/error
});

window.electronAPI.onTerminalState(({ id, state }) => {
  const badge = state as BadgeState;
  updateBadge(id, badge);
  const col = STATE_TO_COLUMN[badge];
  if (!col) return;

  const proj = activeProject();
  const task = proj?.tasks.find(t => t.id === id);
  if (!task) return;

  // Never auto-move out of 'todo' unless the user has already typed something
  if (task.column === 'todo' && !activatedTasks.has(id)) return;

  moveTask(id, col);
});

window.electronAPI.onLastMessage(({ id, message }) => {
  lastMessages.set(id, message);
});

// Escape exits maximized task
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const maximized = document.querySelector<HTMLElement>('.task-card.maximized');
  if (!maximized) return;
  maximized.classList.remove('maximized');
  maximized.draggable = true;
  const btn = maximized.querySelector<HTMLButtonElement>('.btn-maximize-task');
  if (btn) btn.textContent = '⤢';
  const taskId = maximized.dataset.taskId;
  if (taskId) {
    const t = termMap.get(taskId);
    if (t) setTimeout(() => {
      t.fit.fit();
      window.electronAPI.resizePty(taskId, t.term.cols, t.term.rows);
    }, 30);
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  projects = await window.electronAPI.loadProjects();
  activeProjectId = projects[0]?.id ?? null;
  renderTabs();
  renderBoard();
})();
