// ── FIXED CONFIG ──
const WORKER_URL = 'https://todoweek-api.moriwakiren-fucc.workers.dev';
const CFG_KEY    = 'todoweek_config_v1';
const TASKS_KEY  = 'todoweek_tasks_v2';
const GOAL_KEY   = 'todoweek_goal_v1';

// ── STATE ──
let config = {};
try { config = JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch(e) {}
let tasks = [];
try { tasks = JSON.parse(localStorage.getItem(TASKS_KEY)) || []; } catch(e) {}

let syncTimer    = null;
let editingId    = null;
let weekOffset   = 0;   // 0=今週, -1=先週, 1=来週 …
let overdueOpen  = true;

// ── SUBJECT COLOR MAP ──
const SUBJECT_COLORS = {
  '国語':   { bg: '#ffeaea', fg: '#cc2222', border: '#ffb3b3' },
  '数学':   { bg: '#e8f0ff', fg: '#1a44cc', border: '#b3c8ff' },
  '英語':   { bg: '#fffbe0', fg: '#998800', border: '#ffe680' },
  '化学':   { bg: '#fffbe0', fg: '#998800', border: '#ffe680' },
  '生物':   { bg: '#eafff0', fg: '#1a8840', border: '#b3eec8' },
  '日本史': { bg: '#f5eaff', fg: '#7722cc', border: '#ddb3ff' },
  '情報':   { bg: '#e0faff', fg: '#0088aa', border: '#b3eeff' },
};
const CUSTOM_COLOR = { bg: '#ffeaf5', fg: '#cc2266', border: '#ffb3d9' };
const DEFAULT_COLOR = { bg: '#f0f2f5', fg: '#6b7594', border: '#dde1ea' };

function getColor(subject) {
  if (!subject || subject === 'なし') return DEFAULT_COLOR;
  if (SUBJECT_COLORS[subject]) return SUBJECT_COLORS[subject];
  return CUSTOM_COLOR; // カスタム教科
}

// ── HELPERS ──
const DAY = ['日','月','火','水','木','金','土'];

function toDateStr(d) {
  const y   = d.getFullYear();
  const m   = String(d.getMonth() + 1).padStart(2, '0');
  const dd  = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function getWeekDates(offset = 0) {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  t.setDate(t.getDate() + offset * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(t);
    d.setDate(t.getDate() + i);
    return d;
  });
}

function getTodayStr() {
  return toDateStr(new Date());
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
  document.getElementById('sync-dot').className     = state;
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

// ── GOAL ──
function getGoalKey() {
  // 週ごとにキーを分ける（週の月曜日の日付で管理）
  return GOAL_KEY + '_' + weekOffset;
}
function loadGoal() {
  return localStorage.getItem(getGoalKey()) || '';
}
function saveGoal(val) {
  localStorage.setItem(getGoalKey(), val);
}

// ── RENDER ──
function render() {
  const dates   = getWeekDates(weekOffset);
  const todayStr = getTodayStr();

  // Colgroup
  document.getElementById('cols').innerHTML = dates.map(() => '<col>').join('');

  // ── Goal row ──
  const goalRow = document.getElementById('goal-row');
  goalRow.innerHTML = '';
  const goalTd = document.createElement('td');
  goalTd.colSpan = 7;

  const nav = document.createElement('div');
  nav.className = 'goal-nav';

  const prevBtn = document.createElement('button');
  prevBtn.className   = 'goal-nav-btn';
  prevBtn.textContent = '＜';
  prevBtn.title       = '前の週';
  prevBtn.addEventListener('click', () => { weekOffset--; render(); });

  const goalInput = document.createElement('input');
  goalInput.type        = 'text';
  goalInput.id          = 'goal-input';
  goalInput.placeholder = '📌 長期的な目標を入力…';
  goalInput.value       = loadGoal();
  goalInput.addEventListener('input', () => saveGoal(goalInput.value));

  const nextBtn = document.createElement('button');
  nextBtn.className   = 'goal-nav-btn';
  nextBtn.textContent = '＞';
  nextBtn.title       = '次の週';
  nextBtn.addEventListener('click', () => { weekOffset++; render(); });

  nav.appendChild(prevBtn);
  nav.appendChild(goalInput);
  nav.appendChild(nextBtn);
  goalTd.appendChild(nav);
  goalRow.appendChild(goalTd);

  // ── Date headers ──
  document.getElementById('date-row').innerHTML = dates.map((d, i) => {
    const ds  = toDateStr(d);
    const cls = ds === todayStr ? 'today-col' : '';
    return `<th class="${cls}">
      <span class="day-num">${d.getDate()}</span>
      ${d.getMonth() + 1}/${d.getDate()}(${DAY[d.getDay()]})
    </th>`;
  }).join('');

  // ── Task columns ──
  const cols7 = dates.map(d => tasks.filter(t => t.date === toDateStr(d)));

  const tbody = document.getElementById('task-body');
  tbody.innerHTML = '';
  const row = document.createElement('tr');

  dates.forEach((d, ci) => {
    const ds  = toDateStr(d);
    const td  = document.createElement('td');
    if (ds === todayStr) td.classList.add('today-col');

    cols7[ci].forEach(t => td.appendChild(makeTaskEl(t)));

    const btn = document.createElement('button');
    btn.className   = 'new-btn';
    btn.textContent = '＋';
    btn.addEventListener('click', () => openModal(null, ds));
    td.appendChild(btn);

    row.appendChild(td);
  });

  tbody.appendChild(row);

  // ── Overdue section ──
  renderOverdue();
}

function applyTaskStyle(el, subject) {
  const c = getColor(subject);
  el.style.background   = c.bg;
  el.style.borderColor  = c.border;
}

function makeTaskEl(task, isOverdue = false) {
  const div = document.createElement('div');
  div.className = 'task-item' + (task.done ? ' done' : '');
  applyTaskStyle(div, task.subject);

  // Checkbox
  const cb = document.createElement('div');
  cb.className = 'task-cb';
  cb.style.borderColor = getColor(task.subject).border;
  cb.addEventListener('click', e => {
    e.stopPropagation();
    task.done = !task.done;
    schedulePush();
    render();
  });

  // Label
  const lbl = document.createElement('div');
  lbl.className = 'task-label';
  const c = getColor(task.subject);

  let inner = '';
  if (isOverdue) {
    inner += `<div class="overdue-date-label">${task.date}</div>`;
  }
  inner += `<div style="color:${c.fg};font-weight:600;">${esc(task.title)}</div>`;

  if (task.subject && task.subject !== 'なし') {
    inner += `<span class="subject-tag" style="background:${c.bg};color:${c.fg};border:1px solid ${c.border};">${esc(task.subject)}</span>`;
  }
  if (task.remind && task.remind !== '0') {
    inner += `<div class="remind-info">⏰ ${task.remind}日前</div>`;
  }
  lbl.innerHTML = inner;

  div.appendChild(cb);
  div.appendChild(lbl);
  div.addEventListener('click', () => openModal(task.id));
  return div;
}

// ── OVERDUE ──
function renderOverdue() {
  const todayStr = getTodayStr();
  const overdueTasks = tasks.filter(t => !t.done && t.date < todayStr);
  const section = document.getElementById('overdue-section');
  const list    = document.getElementById('overdue-list');

  if (overdueTasks.length === 0) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  if (overdueOpen) {
    section.classList.remove('collapsed');
    document.getElementById('overdue-toggle').textContent = '▼ 閉じる';
  } else {
    section.classList.add('collapsed');
    document.getElementById('overdue-toggle').textContent = '▶ 開く';
  }

  // 日付昇順でソート
  overdueTasks.sort((a, b) => a.date < b.date ? -1 : 1);

  list.innerHTML = '';
  overdueTasks.forEach(t => list.appendChild(makeTaskEl(t, true)));
}

document.getElementById('overdue-header').addEventListener('click', () => {
  overdueOpen = !overdueOpen;
  renderOverdue();
});

// ── TASK MODAL ──
function handleSubjectChange(val) {
  const g = document.getElementById('custom-subject-group');
  g.style.display = (val === 'カスタム') ? 'block' : 'none';
}

function openModal(id, dateStr) {
  editingId = id || null;
  document.getElementById('modal-title-text').textContent = id ? '編集' : '新規作成';

  // カスタムフィールドリセット
  document.getElementById('custom-subject-group').style.display = 'none';

  if (id) {
    const t = tasks.find(t => t.id === id);

    // 教科がプリセットかカスタムか判定
    const presets = ['なし','国語','数学','英語','化学','生物','日本史','情報','カスタム'];
    const isPreset = presets.includes(t.subject);

    if (isPreset) {
      document.getElementById('f-subject').value = t.subject;
      document.getElementById('f-custom-subject').value = '';
      if (t.subject === 'カスタム') {
        document.getElementById('custom-subject-group').style.display = 'block';
      }
    } else {
      // カスタム名が保存されている
      document.getElementById('f-subject').value = 'カスタム';
      document.getElementById('f-custom-subject').value = t.subject;
      document.getElementById('custom-subject-group').style.display = 'block';
    }

    document.getElementById('f-title').value  = t.title  || '';
    document.getElementById('f-date').value   = t.date   || '';
    document.getElementById('f-remind').value = t.remind || '0';

    document.getElementById('modal-actions').innerHTML = `
      <button class="btn-primary"   id="modal-save">保存する</button>
      <button class="btn-danger"    id="modal-delete">削除</button>
      <button class="btn-secondary" id="modal-cancel">キャンセル</button>`;
    document.getElementById('modal-delete').addEventListener('click', deleteTask);
  } else {
    document.getElementById('f-title').value   = '';
    document.getElementById('f-date').value    = dateStr || getTodayStr();
    document.getElementById('f-remind').value  = '0';
    document.getElementById('f-subject').value = 'なし';
    document.getElementById('f-custom-subject').value = '';

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

function getSubjectValue() {
  const sel = document.getElementById('f-subject').value;
  if (sel === 'カスタム') {
    const custom = document.getElementById('f-custom-subject').value.trim();
    return custom || 'カスタム';
  }
  return sel;
}

function saveTask() {
  const title   = document.getElementById('f-title').value.trim();
  const date    = document.getElementById('f-date').value;
  if (!title) { showToast('タイトルを入力してください'); return; }
  if (!date)  { showToast('日付を選択してください');    return; }
  const remind  = document.getElementById('f-remind').value;
  const subject = getSubjectValue();

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

document.getElementById('setup-uid').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('setup-save').click();
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
