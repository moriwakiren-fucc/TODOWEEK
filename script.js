// ── FIXED CONFIG ──
const WORKER_URL  = 'https://todoweek-api.moriwakiren-fucc.workers.dev';
const CFG_KEY     = 'todoweek_config_v1';
const TASKS_KEY   = 'todoweek_tasks_v2';
const GOAL_KEY    = 'todoweek_goal_v1';

// ── STATE ──
let config = {};
try { config = JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch(e) {}
let tasks = [];
try { tasks = JSON.parse(localStorage.getItem(TASKS_KEY)) || []; } catch(e) {}

let syncTimer = null;
let editingId = null;

// ── HELPERS ──
const DAY = ['日','月','火','水','木','金','土'];

function toDateStr(d) {
  const y   = d.getFullYear();
  const m   = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getWeekDates() {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(t);
    d.setDate(t.getDate() + i);
    return d;
  });
}

function genId() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── SYNC ──
function setSyncUI(state, label) {
  document.getElementById('sync-dot').className    = state;
  document.getElementById('sync-label').textContent = label;
}

async function pushToCloud() {
  if (!config.userId) return;
  setSyncUI('syncing', '同期中…');
  try {
    const r = await fetch(`${WORKER_URL}/tasks/${config.userId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(tasks),
    });
    if (!r.ok) throw new Error(r.status);
    setSyncUI('ok', '同期済み ✓');
  } catch(e) {
    setSyncUI('err', 'エラー');
  }
}

async function pullFromCloud() {
  if (!config.userId) { setSyncUI('', '未設定'); return; }
  setSyncUI('syncing', '読込中…');
  try {
    const r = await fetch(`${WORKER_URL}/tasks/${config.userId}`);
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    if (Array.isArray(data)) {
      tasks = data;
      localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
    }
    setSyncUI('ok', '同期済み ✓');
    render();
  } catch(e) {
    setSyncUI('err', 'エラー');
  }
}

function schedulePush() {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushToCloud, 1500);
}

// ── WEEKLY GOAL ──
function loadGoal() {
  return localStorage.getItem(GOAL_KEY) || '';
}
function saveGoal(val) {
  localStorage.setItem(GOAL_KEY, val);
}

// ── RENDER ──
function render() {
  const dates = getWeekDates();

  // Colgroup
  document.getElementById('cols').innerHTML = dates.map(() => '<col>').join('');

  // ── Goal row (colspan=7) ──
  const goalRow = document.getElementById('goal-row');
  goalRow.innerHTML = '';
  const goalTd = document.createElement('td');
  goalTd.colSpan = 7;
  const goalInput = document.createElement('input');
  goalInput.type        = 'text';
  goalInput.id          = 'goal-input';
  goalInput.placeholder = '📌 今週の目標を入力…';
  goalInput.value       = loadGoal();
  goalInput.addEventListener('input', () => saveGoal(goalInput.value));
  goalTd.appendChild(goalInput);
  goalRow.appendChild(goalTd);

  // ── Date headers ──
  document.getElementById('date-row').innerHTML = dates.map((d, i) => `
    <th class="${i === 0 ? 'today-col' : ''}">
      <span class="day-num">${d.getDate()}</span>
      ${d.getMonth() + 1}/${d.getDate()}(${DAY[d.getDay()]})
    </th>
  `).join('');

  // ── Task columns ──
  const cols7 = dates.map(d => tasks.filter(t => t.date === toDateStr(d)));

  const tbody = document.getElementById('task-body');
  tbody.innerHTML = '';
  const row = document.createElement('tr');

  dates.forEach((d, ci) => {
    const ds = toDateStr(d);
    const td = document.createElement('td');
    if (ci === 0) td.classList.add('today-col');

    cols7[ci].forEach(t => td.appendChild(makeTaskEl(t)));

    const btn = document.createElement('button');
    btn.className   = 'new-btn';
    btn.textContent = '＋';
    btn.addEventListener('click', () => openModal(null, ds));
    td.appendChild(btn);

    row.appendChild(td);
  });

  tbody.appendChild(row);
}

function makeTaskEl(task) {
  const div = document.createElement('div');
  div.className = 'task-item' + (task.done ? ' done' : '');

  // Checkbox
  const cb = document.createElement('div');
  cb.className = 'task-cb';
  cb.addEventListener('click', e => {
    e.stopPropagation();
    task.done = !task.done;
    schedulePush();
    render();
  });

  // Label
  const lbl = document.createElement('div');
  lbl.className = 'task-label';
  let inner = `<div>${esc(task.title)}</div>`;
  if (task.subject && task.subject !== 'なし') {
    inner += `<span class="subject-tag subj-${task.subject}">${esc(task.subject)}</span>`;
  }
  if (task.remind) {
    inner += `<div class="remind-info">⏰ ${task.remind}日前</div>`;
  }
  lbl.innerHTML = inner;

  div.appendChild(cb);
  div.appendChild(lbl);
  div.addEventListener('click', () => openModal(task.id));
  return div;
}

// ── TASK MODAL ──
function openModal(id, dateStr) {
  editingId = id || null;
  document.getElementById('modal-title-text').textContent = id ? '編集' : '新規作成';

  if (id) {
    const t = tasks.find(t => t.id === id);
    document.getElementById('f-title').value   = t.title   || '';
    document.getElementById('f-date').value    = t.date    || '';
    document.getElementById('f-remind').value  = t.remind  || '2';
    document.getElementById('f-subject').value = t.subject || 'なし';
    document.getElementById('modal-actions').innerHTML = `
      <button class="btn-primary"   id="modal-save">保存する</button>
      <button class="btn-danger"    id="modal-delete">削除</button>
      <button class="btn-secondary" id="modal-cancel">キャンセル</button>`;
    document.getElementById('modal-delete').addEventListener('click', deleteTask);
  } else {
    document.getElementById('f-title').value   = '';
    document.getElementById('f-date').value    = dateStr || toDateStr(new Date());
    document.getElementById('f-remind').value  = '2';
    document.getElementById('f-subject').value = 'なし';
    document.getElementById('modal-actions').innerHTML = `
      <button class="btn-primary"   id="modal-save">保存する</button>
      <button class="btn-secondary" id="modal-cancel">キャンセル</button>`;
  }

  document.getElementById('modal-save').addEventListener('click', saveTask);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('f-title').focus(), 260);
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

function saveTask() {
  const title   = document.getElementById('f-title').value.trim();
  const date    = document.getElementById('f-date').value;
  if (!title) { showToast('タイトルを入力してください'); return; }
  if (!date)  { showToast('日付を選択してください');    return; }
  const remind  = document.getElementById('f-remind').value;
  const subject = document.getElementById('f-subject').value;

  if (editingId) {
    const i = tasks.findIndex(t => t.id === editingId);
    if (i >= 0) tasks[i] = { ...tasks[i], title, date, remind, subject };
    showToast('更新しました ✓');
  } else {
    tasks.push({ id: genId(), title, date, remind, subject, done: false });
    showToast('追加しました ✓');
  }
  schedulePush();
  closeModal();
  render();
}

function deleteTask() {
  if (!editingId || !confirm('この予定を削除しますか？')) return;
  tasks = tasks.filter(t => t.id !== editingId);
  schedulePush();
  closeModal();
  render();
  showToast('削除しました');
}

// ── SETUP MODAL ──
function showSetup() {
  document.getElementById('setup-uid').value = config.userId || '';

  const wrap    = document.getElementById('setup-current-user-wrap');
  const uidEl   = document.getElementById('setup-current-uid');
  const btnSkip = document.getElementById('setup-skip');
  const btnOut  = document.getElementById('setup-logout');

  if (config.userId) {
    uidEl.textContent     = config.userId;
    wrap.style.display    = 'flex';
    btnOut.style.display  = 'block';
    btnSkip.style.display = 'none';
  } else {
    wrap.style.display    = 'none';
    btnOut.style.display  = 'none';
    btnSkip.style.display = 'block';
  }

  document.getElementById('setup-overlay').classList.add('open');
}

document.getElementById('setup-save').addEventListener('click', async () => {
  const uid = document.getElementById('setup-uid').value.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!uid) { showToast('ユーザーIDを入力してください'); return; }
  config = { userId: uid };
  localStorage.setItem(CFG_KEY, JSON.stringify(config));
  document.getElementById('setup-overlay').classList.remove('open');
  await pullFromCloud();
  showToast('同期を開始しました ✓');
});

document.getElementById('setup-skip').addEventListener('click', () => {
  document.getElementById('setup-overlay').classList.remove('open');
  setSyncUI('', 'ローカルのみ');
});

document.getElementById('setup-logout').addEventListener('click', () => {
  if (!confirm('ログアウトしますか？\nこのデバイスのローカルデータも削除されます。')) return;
  config = {};
  tasks  = [];
  localStorage.removeItem(CFG_KEY);
  localStorage.removeItem(TASKS_KEY);
  document.getElementById('setup-overlay').classList.remove('open');
  setSyncUI('', '未設定');
  render();
  showToast('ログアウトしました');
  setTimeout(showSetup, 400);
});

// ── HEADER EVENTS ──
document.getElementById('global-add-btn').addEventListener('click', () => {
  const val = document.getElementById('global-input').value.trim();
  document.getElementById('global-input').value = '';
  openModal(null, null);
  if (val) setTimeout(() => { document.getElementById('f-title').value = val; }, 50);
});

document.getElementById('global-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('global-add-btn').click();
});

document.getElementById('modal-overlay').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('sync-status').addEventListener('click', showSetup);
document.getElementById('logo-btn').addEventListener('click', showSetup);

// ── TOAST ──
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// ── INIT ──
render();
if (!config.userId) {
  showSetup();
} else {
  pullFromCloud();
}

// Midnight re-render
setInterval(() => {
  const n = new Date();
  if (n.getHours() === 0 && n.getMinutes() === 0) render();
}, 60000);
