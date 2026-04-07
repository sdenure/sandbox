/* ============================================================
   TaskGrid — app.js
   ============================================================ */

// ── Constants ──────────────────────────────────────────────
const STORAGE_TASKS   = 'taskgrid_tasks';
const STORAGE_AXIS    = 'taskgrid_axis';
const STORAGE_SORT    = 'taskgrid_sort';
const STORAGE_VERSION = 'taskgrid_version';
const CURRENT_VERSION = '1';
const DOT_SIZE        = 38;

const COLOR_PALETTE = [
  '#6c63ff', '#2ecc8e', '#f04760', '#f0a347',
  '#4ec9f0', '#e05ce0', '#f06060', '#a0e060',
];

const AXIS_OPTIONS = [
  { key: 'effort',   label: 'Effort',   lowLabel: 'Trivial',    highLabel: 'Enormous'     },
  { key: 'urgency',  label: 'Urgency',  lowLabel: 'Not urgent', highLabel: 'ASAP'         },
  { key: 'impact',   label: 'Impact',   lowLabel: 'Minimal',    highLabel: 'Game-changer' },
  { key: 'priority', label: 'Priority', lowLabel: 'Low',        highLabel: 'Critical'     },
];

const AXIS_MAP = Object.fromEntries(AXIS_OPTIONS.map(a => [a.key, a]));

// Quadrant labels change based on axis selection
const QUADRANT_LABELS = {
  'effort-priority':  ['Quick Wins', 'Major Projects', 'Fill-ins', 'Time Wasters'],
  'effort-urgency':   ['Easy & Urgent', 'Hard & Urgent', 'Easy, No Rush', 'Hard, No Rush'],
  'effort-impact':    ['High Leverage', 'Big Bets', 'Low Hanging', 'Sinkholes'],
  'urgency-priority': ['Do First', 'Schedule', 'Delegate', 'Eliminate'],
  'urgency-impact':   ['Act Now', 'Plan It', 'Quick Win', 'Ignore'],
  'impact-priority':  ['Core Work', 'High Value', 'Nice to Have', 'Noise'],
};

function getQuadrantLabels(xAxis, yAxis) {
  const key1 = `${xAxis}-${yAxis}`;
  const key2 = `${yAxis}-${xAxis}`;
  if (QUADRANT_LABELS[key1]) return QUADRANT_LABELS[key1];
  if (QUADRANT_LABELS[key2]) {
    const [tl, tr, bl, br] = QUADRANT_LABELS[key2];
    return [tl, bl, tr, br]; // swap
  }
  return ['Top-Left', 'Top-Right', 'Bottom-Left', 'Bottom-Right'];
}

// ── State ──────────────────────────────────────────────────
let tasks         = [];
let axisConfig    = { xAxis: 'effort', yAxis: 'priority' };
let sortField     = 'priority';
let activeCategory = null;   // null = show all
let editingId     = null;    // task id being edited, null = new task
let dragState     = null;    // { id, startX, startY }
let pendingCoords = null;    // { effort, priority, urgency, impact } from canvas click
let touchDragState = null;

// ── Persistence ────────────────────────────────────────────
function loadState() {
  try {
    const version = localStorage.getItem(STORAGE_VERSION);
    if (!version) {
      localStorage.setItem(STORAGE_VERSION, CURRENT_VERSION);
    }
    const rawTasks = localStorage.getItem(STORAGE_TASKS);
    if (rawTasks) {
      tasks = JSON.parse(rawTasks);
    }
    const rawAxis = localStorage.getItem(STORAGE_AXIS);
    if (rawAxis) {
      axisConfig = JSON.parse(rawAxis);
    }
    const rawSort = localStorage.getItem(STORAGE_SORT);
    if (rawSort) {
      sortField = rawSort;
    }
  } catch (e) {
    console.warn('TaskGrid: failed to load state', e);
    tasks = [];
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_TASKS, JSON.stringify(tasks));
    localStorage.setItem(STORAGE_AXIS, JSON.stringify(axisConfig));
    localStorage.setItem(STORAGE_SORT, sortField);
    localStorage.setItem(STORAGE_VERSION, CURRENT_VERSION);
  } catch (e) {
    console.warn('TaskGrid: failed to save state', e);
  }
  render();
}

// ── Utilities ──────────────────────────────────────────────
function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function formatDueDate(dateStr) {
  if (!dateStr) return null;
  const due   = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff  = Math.round((due - today) / 86400000);
  if (diff < 0)  return { text: `${Math.abs(diff)}d overdue`, cls: 'overdue' };
  if (diff === 0) return { text: 'Due today', cls: 'due-soon' };
  if (diff <= 3)  return { text: `Due in ${diff}d`, cls: 'due-soon' };
  const opts = { month: 'short', day: 'numeric' };
  return { text: due.toLocaleDateString(undefined, opts), cls: '' };
}

function isDueSoon(dateStr) {
  if (!dateStr) return false;
  const due   = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff  = Math.round((due - today) / 86400000);
  return diff >= 0 && diff <= 3;
}

function getCategories() {
  const cats = new Set(tasks.map(t => t.category).filter(Boolean));
  return Array.from(cats).sort();
}

function dotPosition(task) {
  const canvas = document.getElementById('grid-canvas');
  if (!canvas) return { left: 0, top: 0 };
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  const xVal = task[axisConfig.xAxis] ?? 0.5;
  const yVal = task[axisConfig.yAxis] ?? 0.5;
  const left = clamp(xVal * w, DOT_SIZE / 2, w - DOT_SIZE / 2);
  const top  = clamp((1 - yVal) * h, DOT_SIZE / 2, h - DOT_SIZE / 2);
  return { left, top };
}

function coordsFromEvent(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const rawX = (clientX - rect.left) / rect.width;
  const rawY = (clientY - rect.top)  / rect.height;
  return {
    [axisConfig.xAxis]: clamp(rawX, 0, 1),
    [axisConfig.yAxis]: clamp(1 - rawY, 0, 1),
  };
}

// ── Rendering ──────────────────────────────────────────────
function render() {
  renderAxisSelects();
  renderAxisLabels();
  renderGrid();
  renderSidebar();
  renderCategoryFilters();
  updateEmptyState();
}

function renderAxisSelects() {
  const xSel = document.getElementById('x-axis-select');
  const ySel = document.getElementById('y-axis-select');
  if (xSel && xSel.value !== axisConfig.xAxis) xSel.value = axisConfig.xAxis;
  if (ySel && ySel.value !== axisConfig.yAxis) ySel.value = axisConfig.yAxis;
  const sortSel = document.getElementById('sort-select');
  if (sortSel && sortSel.value !== sortField) sortSel.value = sortField;
}

function renderAxisLabels() {
  const xInfo = AXIS_MAP[axisConfig.xAxis];
  const yInfo = AXIS_MAP[axisConfig.yAxis];
  el('x-axis-low').textContent  = `${xInfo.lowLabel}`;
  el('x-axis-high').textContent = `${xInfo.highLabel}`;
  el('y-axis-high').textContent = `${yInfo.highLabel}`;
  el('y-axis-low').textContent  = `${yInfo.lowLabel}`;

  const [ql1, ql2, ql3, ql4] = getQuadrantLabels(axisConfig.xAxis, axisConfig.yAxis);
  el('q-tl-label').textContent = ql1;
  el('q-tr-label').textContent = ql2;
  el('q-bl-label').textContent = ql3;
  el('q-br-label').textContent = ql4;
}

function renderGrid() {
  const container = document.getElementById('dots-container');
  if (!container) return;

  // Reconcile: update existing, create new, remove deleted
  const existingDots = new Map(
    Array.from(container.querySelectorAll('.task-dot'))
      .map(d => [d.dataset.id, d])
  );

  const toKeep = new Set();
  tasks.forEach(task => {
    toKeep.add(task.id);
    const pos = dotPosition(task);
    let dot = existingDots.get(task.id);
    if (!dot) {
      dot = createDotElement(task);
      container.appendChild(dot);
    } else {
      updateDotElement(dot, task);
    }
    dot.style.left = `${pos.left}px`;
    dot.style.top  = `${pos.top}px`;
  });

  existingDots.forEach((dot, id) => {
    if (!toKeep.has(id)) dot.remove();
  });

  applyDimming();
}

function createDotElement(task) {
  const dot = document.createElement('div');
  dot.className = 'task-dot';
  dot.dataset.id = task.id;
  dot.innerHTML = `<span class="dot-check">✓</span>`;
  dot.draggable = true;

  dot.addEventListener('click', onDotClick);
  dot.addEventListener('dragstart', onDotDragStart);
  dot.addEventListener('mouseenter', () => highlightCard(task.id, true));
  dot.addEventListener('mouseleave', () => highlightCard(task.id, false));
  // Touch drag
  dot.addEventListener('touchstart', onTouchDotStart, { passive: false });

  updateDotElement(dot, task);
  return dot;
}

function updateDotElement(dot, task) {
  dot.dataset.id     = task.id;
  dot.dataset.status = task.status;
  dot.style.background = task.color;
  dot.style.boxShadow  = `0 2px 10px ${task.color}55`;

  // Tooltip
  let tooltip = task.title;
  if (task.category) tooltip += `\n${task.category}`;
  if (task.dueDate)  tooltip += `\n${formatDueDate(task.dueDate)?.text || task.dueDate}`;
  dot.dataset.tooltip = tooltip;

  // Due soon pulse
  dot.classList.toggle('due-soon', isDueSoon(task.dueDate));
}

function renderSidebar() {
  const listEl = document.getElementById('task-list');
  const emptyEl = document.getElementById('sidebar-empty');
  if (!listEl) return;

  const sorted = sortTasks([...tasks], sortField);

  // Reconcile cards
  const existing = new Map(
    Array.from(listEl.querySelectorAll('.task-card'))
      .map(c => [c.dataset.id, c])
  );

  // Clear and re-insert in sort order (simpler than full reconcile for sidebar)
  listEl.innerHTML = '';
  sorted.forEach(task => {
    const card = createCardElement(task);
    listEl.appendChild(card);
  });

  emptyEl.classList.toggle('hidden', tasks.length > 0);
  applyDimming();
}

function createCardElement(task) {
  const card = document.createElement('div');
  card.className = 'task-card';
  card.dataset.id = task.id;
  card.dataset.status = task.status;

  const due = task.dueDate ? formatDueDate(task.dueDate) : null;

  card.innerHTML = `
    <div class="card-color-dot" style="background:${task.color}"></div>
    <div class="card-body">
      <div class="card-title">${escapeHtml(task.title)}</div>
      <div class="card-meta">
        ${task.category ? `<span class="card-category">${escapeHtml(task.category)}</span>` : ''}
        ${due ? `<span class="card-due ${due.cls}">${due.text}</span>` : ''}
      </div>
    </div>
    <div class="card-status" data-status="${task.status}"></div>
  `;

  card.addEventListener('click', () => openModal(task.id));
  card.addEventListener('mouseenter', () => highlightDot(task.id, true));
  card.addEventListener('mouseleave', () => highlightDot(task.id, false));

  return card;
}

function renderCategoryFilters() {
  const filtersEl = document.getElementById('category-filters');
  if (!filtersEl) return;

  const cats = getCategories();
  filtersEl.innerHTML = '';

  if (cats.length === 0) return;

  const allChip = document.createElement('button');
  allChip.className = 'category-chip' + (activeCategory === null ? ' active' : '');
  allChip.textContent = 'All';
  allChip.addEventListener('click', () => { activeCategory = null; render(); });
  filtersEl.appendChild(allChip);

  cats.forEach(cat => {
    const chip = document.createElement('button');
    chip.className = 'category-chip' + (activeCategory === cat ? ' active' : '');
    chip.textContent = cat;
    chip.addEventListener('click', () => {
      activeCategory = (activeCategory === cat) ? null : cat;
      render();
    });
    filtersEl.appendChild(chip);
  });
}

function updateEmptyState() {
  const emptyEl = document.getElementById('empty-state');
  if (emptyEl) emptyEl.classList.toggle('hidden', tasks.length > 0);
}

function sortTasks(arr, field) {
  return arr.sort((a, b) => {
    if (field === 'dueDate') {
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    }
    if (field === 'createdAt') return b.createdAt - a.createdAt;
    return (b[field] ?? 0) - (a[field] ?? 0);
  });
}

function applyDimming() {
  const filter = activeCategory;
  // Dots
  document.querySelectorAll('.task-dot').forEach(dot => {
    const task = tasks.find(t => t.id === dot.dataset.id);
    const dim = filter !== null && task && task.category !== filter;
    dot.classList.toggle('dimmed', dim);
  });
  // Cards
  document.querySelectorAll('.task-card').forEach(card => {
    const task = tasks.find(t => t.id === card.dataset.id);
    const dim = filter !== null && task && task.category !== filter;
    card.classList.toggle('dimmed', dim);
  });
}

function highlightCard(taskId, on) {
  const card = document.querySelector(`.task-card[data-id="${taskId}"]`);
  if (!card) return;
  card.classList.toggle('highlighted', on);
  if (on) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function highlightDot(taskId, on) {
  const dot = document.querySelector(`.task-dot[data-id="${taskId}"]`);
  if (!dot) return;
  dot.classList.toggle('highlighted', on);
}

// ── Grid Interaction ───────────────────────────────────────
function onCanvasClick(e) {
  // Ignore if click landed on a dot
  if (e.target.closest('.task-dot')) return;
  const canvas = document.getElementById('grid-canvas');
  const coords = coordsFromEvent(canvas, e.clientX, e.clientY);
  pendingCoords = { effort: 0.5, urgency: 0.5, impact: 0.5, priority: 0.5, ...coords };
  openModal(null, pendingCoords);
}

function onDotClick(e) {
  e.stopPropagation();
  const id = e.currentTarget.dataset.id;
  openModal(id);
}

// ── Drag and Drop (Desktop) ────────────────────────────────
function onDotDragStart(e) {
  const id = e.currentTarget.dataset.id;
  dragState = { id };
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id);
  // Use a ghost image offset so the dot doesn't jump
  try {
    e.dataTransfer.setDragImage(e.currentTarget, DOT_SIZE / 2, DOT_SIZE / 2);
  } catch (_) {}
}

function onCanvasDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.getElementById('grid-canvas').classList.add('drag-over');
}

function onCanvasDragLeave(e) {
  const canvas = document.getElementById('grid-canvas');
  if (!canvas.contains(e.relatedTarget)) {
    canvas.classList.remove('drag-over');
  }
}

function onCanvasDrop(e) {
  e.preventDefault();
  const canvas = document.getElementById('grid-canvas');
  canvas.classList.remove('drag-over');

  const id = e.dataTransfer.getData('text/plain') || dragState?.id;
  if (!id) return;

  const coords = coordsFromEvent(canvas, e.clientX, e.clientY);
  const task   = tasks.find(t => t.id === id);
  if (task) {
    Object.assign(task, coords);
    task.updatedAt = Date.now();
    saveState();
  }

  // Clean up drag class
  document.querySelectorAll('.task-dot.dragging').forEach(d => d.classList.remove('dragging'));
  dragState = null;
}

function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.getElementById('grid-canvas')?.classList.remove('drag-over');
  dragState = null;
}

// ── Touch Drag ─────────────────────────────────────────────
function onTouchDotStart(e) {
  e.preventDefault();
  const dot  = e.currentTarget;
  const id   = dot.dataset.id;
  const touch = e.touches[0];

  touchDragState = { id, dot };
  dot.classList.add('dragging');

  function onTouchMove(ev) {
    ev.preventDefault();
    const t = ev.touches[0];
    const canvas = document.getElementById('grid-canvas');
    if (!canvas) return;
    const rect   = canvas.getBoundingClientRect();
    if (t.clientX < rect.left || t.clientX > rect.right ||
        t.clientY < rect.top  || t.clientY > rect.bottom) return;

    const coords = coordsFromEvent(canvas, t.clientX, t.clientY);
    const task   = tasks.find(tk => tk.id === id);
    if (task) {
      Object.assign(task, coords);
      // Live move without saving (update dot position directly)
      const pos = dotPosition(task);
      dot.style.left = `${pos.left}px`;
      dot.style.top  = `${pos.top}px`;
    }
  }

  function onTouchEnd() {
    dot.classList.remove('dragging');
    const task = tasks.find(tk => tk.id === id);
    if (task) {
      task.updatedAt = Date.now();
      saveState();
    }
    touchDragState = null;
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('touchend', onTouchEnd);
  }

  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('touchend', onTouchEnd);
}

// ── Modal ──────────────────────────────────────────────────
function openModal(taskId, preCoords) {
  editingId = taskId;
  const task = taskId ? tasks.find(t => t.id === taskId) : null;

  const overlay = document.getElementById('modal-overlay');
  el('modal-title').textContent = task ? 'Edit Task' : 'Add Task';

  // Populate fields
  el('field-title').value       = task?.title       || '';
  el('field-description').value = task?.description || '';
  el('field-due-date').value    = task?.dueDate      || '';
  el('field-category').value    = task?.category     || '';

  // Sliders
  const defaults = { priority: 0.5, effort: 0.5, urgency: 0.5, impact: 0.5 };
  const vals = task ? task : { ...defaults, ...preCoords };
  AXIS_OPTIONS.forEach(({ key }) => {
    const slider = document.getElementById(`slider-${key}`);
    const valEl  = document.getElementById(`val-${key}`);
    if (slider) slider.value = Math.round((vals[key] ?? 0.5) * 100);
    if (valEl)  valEl.textContent = Math.round((vals[key] ?? 0.5) * 100);
    // Highlight active axes
    const row = slider?.closest('.slider-row');
    if (row) row.classList.toggle('active-axis',
      key === axisConfig.xAxis || key === axisConfig.yAxis);
  });

  // Status
  const statusBtns = document.querySelectorAll('.status-btn');
  statusBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.status === (task?.status || 'todo'));
  });

  // Color
  buildColorPalette(task?.color || COLOR_PALETTE[0]);

  // Delete button
  const deleteBtn = document.getElementById('btn-delete');
  deleteBtn.classList.toggle('hidden', !task);
  deleteBtn.textContent = 'Delete';
  deleteBtn.classList.remove('confirm');

  // Category autocomplete
  updateCategoryDatalist();

  overlay.classList.remove('hidden');
  el('field-title').focus();
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  editingId     = null;
  pendingCoords = null;
}

function buildColorPalette(selectedColor) {
  const palette = document.getElementById('color-palette');
  palette.innerHTML = '';
  COLOR_PALETTE.forEach(hex => {
    const swatch = document.createElement('button');
    swatch.className = 'color-swatch' + (hex === selectedColor ? ' selected' : '');
    swatch.style.background = hex;
    swatch.title = hex;
    swatch.type  = 'button';
    swatch.addEventListener('click', () => {
      palette.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      swatch.classList.add('selected');
    });
    palette.appendChild(swatch);
  });
}

function getSelectedColor() {
  const sel = document.querySelector('.color-swatch.selected');
  return sel ? sel.style.background : COLOR_PALETTE[0];
}

function getSelectedStatus() {
  const btn = document.querySelector('.status-btn.active');
  return btn ? btn.dataset.status : 'todo';
}

function getSliderValues() {
  const vals = {};
  AXIS_OPTIONS.forEach(({ key }) => {
    const slider = document.getElementById(`slider-${key}`);
    vals[key] = slider ? parseInt(slider.value, 10) / 100 : 0.5;
  });
  return vals;
}

function updateCategoryDatalist() {
  const dl = document.getElementById('category-list');
  if (!dl) return;
  dl.innerHTML = '';
  getCategories().forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    dl.appendChild(opt);
  });
}

function onSave() {
  const title = el('field-title').value.trim();
  if (!title) {
    el('field-title').focus();
    el('field-title').style.borderColor = 'var(--color-danger)';
    setTimeout(() => { el('field-title').style.borderColor = ''; }, 1200);
    return;
  }

  const sliderVals = getSliderValues();
  const now = Date.now();

  if (editingId) {
    // Edit existing
    const idx = tasks.findIndex(t => t.id === editingId);
    if (idx !== -1) {
      tasks[idx] = {
        ...tasks[idx],
        title:       title,
        description: el('field-description').value.trim(),
        dueDate:     el('field-due-date').value || null,
        category:    el('field-category').value.trim(),
        status:      getSelectedStatus(),
        color:       getSelectedColor(),
        updatedAt:   now,
        ...sliderVals,
      };
    }
  } else {
    // New task
    tasks.push({
      id:          generateId(),
      title:       title,
      description: el('field-description').value.trim(),
      dueDate:     el('field-due-date').value || null,
      category:    el('field-category').value.trim(),
      status:      getSelectedStatus(),
      color:       getSelectedColor(),
      createdAt:   now,
      updatedAt:   now,
      ...sliderVals,
    });
  }

  saveState();
  closeModal();
}

function onDelete() {
  const deleteBtn = document.getElementById('btn-delete');
  if (!deleteBtn.classList.contains('confirm')) {
    deleteBtn.classList.add('confirm');
    deleteBtn.textContent = 'Confirm delete?';
    return;
  }
  tasks = tasks.filter(t => t.id !== editingId);
  // Reset category filter if it no longer exists
  if (activeCategory && !getCategories().includes(activeCategory)) {
    activeCategory = null;
  }
  saveState();
  closeModal();
}

// Live slider preview: update value display and dot position
function onSliderInput(e) {
  const key    = e.target.dataset.axis;
  const value  = parseInt(e.target.value, 10);
  const valEl  = document.getElementById(`val-${key}`);
  if (valEl) valEl.textContent = value;

  // Live-update dot on the grid if editing
  if (!editingId) return;
  const task = tasks.find(t => t.id === editingId);
  if (!task) return;
  task[key] = value / 100;

  const dot = document.querySelector(`.task-dot[data-id="${editingId}"]`);
  if (dot) {
    const pos = dotPosition(task);
    dot.style.left = `${pos.left}px`;
    dot.style.top  = `${pos.top}px`;
  }
}

// ── Axis Selector ──────────────────────────────────────────
function onAxisChange() {
  const xSel = document.getElementById('x-axis-select');
  const ySel = document.getElementById('y-axis-select');
  let xVal = xSel.value;
  let yVal = ySel.value;

  // Prevent same axis on both
  if (xVal === yVal) {
    // Pick a fallback for the other selector
    const others = AXIS_OPTIONS.map(a => a.key).filter(k => k !== xVal);
    if (this === xSel) {
      yVal = others[0];
      ySel.value = yVal;
    } else {
      xVal = others[0];
      xSel.value = xVal;
    }
  }

  axisConfig = { xAxis: xVal, yAxis: yVal };
  saveState();
}

// ── Helper ─────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Bootstrap ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadState();

  // Wire up axis selects
  const xSel = document.getElementById('x-axis-select');
  const ySel = document.getElementById('y-axis-select');
  if (xSel) { xSel.value = axisConfig.xAxis; xSel.addEventListener('change', onAxisChange.bind(xSel)); }
  if (ySel) { ySel.value = axisConfig.yAxis; ySel.addEventListener('change', onAxisChange.bind(ySel)); }

  // Wire up sort
  const sortSel = document.getElementById('sort-select');
  if (sortSel) {
    sortSel.value = sortField;
    sortSel.addEventListener('change', () => {
      sortField = sortSel.value;
      saveState();
    });
  }

  // Wire up canvas
  const canvas = document.getElementById('grid-canvas');
  if (canvas) {
    canvas.addEventListener('click',     onCanvasClick);
    canvas.addEventListener('dragover',  onCanvasDragOver);
    canvas.addEventListener('dragleave', onCanvasDragLeave);
    canvas.addEventListener('drop',      onCanvasDrop);
  }

  // Wire up header Add Task button
  document.getElementById('btn-add-task')?.addEventListener('click', () => {
    pendingCoords = null;
    openModal(null, { effort: 0.5, urgency: 0.5, impact: 0.5, priority: 0.5 });
  });

  // Wire up modal buttons
  document.getElementById('btn-save')?.addEventListener('click', onSave);
  document.getElementById('btn-cancel')?.addEventListener('click', closeModal);
  document.getElementById('btn-modal-close')?.addEventListener('click', closeModal);
  document.getElementById('btn-delete')?.addEventListener('click', onDelete);

  // Wire up modal overlay click-outside to close
  document.getElementById('modal-overlay')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  // Wire up status toggle buttons
  document.querySelectorAll('.status-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.status-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Wire up axis sliders (live preview)
  document.querySelectorAll('.axis-slider').forEach(slider => {
    slider.addEventListener('input', onSliderInput);
  });

  // Keyboard: Escape closes modal, Enter in title saves
  document.addEventListener('keydown', (e) => {
    const overlay = document.getElementById('modal-overlay');
    if (overlay.classList.contains('hidden')) return;
    if (e.key === 'Escape') { closeModal(); return; }
    if (e.key === 'Enter' && e.target === el('field-title')) { e.preventDefault(); onSave(); }
  });

  // Focus trap inside modal
  document.getElementById('modal-card')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = document.getElementById('modal-card')
      .querySelectorAll('button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])');
    const first = focusable[0];
    const last  = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  });

  // Re-render dots when window resizes (positions are pixel-based)
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderGrid(), 100);
  });

  // Initial render
  render();
});
