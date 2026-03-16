// script.js
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

let syncTimer   = null;
let editingId   = null;
let weekOffset  = 0;
let overdueOpen = true;
let currentDateStr = '';

// ── FORMAT STATE ──
let fmt = { bold: false, underline: false, 'double-underline': false, fg: null, bg: null };

// ── SUBJECT COLOR MAP ──
const SUBJECT_COLORS = {
  '国語':   { bg: '#ffeaea', fg: '#cc2222', border: '#ffb3b3' },
  '数学':   { bg: '#e8f0ff', fg: '#1a44cc', border: '#b3c8ff' },
  '英語':   { bg: '#fffbe0', fg: '#998800', border: '#ffe680' },
  '化学':   { bg: '#eafff0', fg: '#1a8840', border: '#b3eec8' },
  '生物':   { bg: '#eafff0', fg: '#1a8840', border: '#b3eec8' },
  '日本史': { bg: '#f5eaff', fg: '#7722cc', border: '#ddb3ff' },
  '情報':   { bg: '#e0faff', fg: '#0088aa', border: '#b3eeff' },
};
const CUSTOM_COLOR  = { bg: '#ffeaf5', fg: '#cc2266', border: '#ffb3d9' };
const DEFAULT_COLOR = { bg: '#f0f2f5', fg: '#6b7594', border: '#dde1ea' };

function getColor(subject) {
  if (!subject || subject === 'なし') return DEFAULT_COLOR;
  if (SUBJECT_COLORS[subject]) return SUBJECT_COLORS[subject];
  return CUSTOM_COLOR;
}

// ── PALETTE ──
const FG_PALETTE = [
  null,
  '#cc2222','#cc6600','#998800','#1a8840','#0088aa','#1a44cc','#7722cc','#cc2266',
  '#1a1e2e','#6b7594','#ffffff',
];
const BG_PALETTE = [
  null,
  '#ffeaea','#fff3e0','#fffbe0','#eafff0','#e0faff','#e8f0ff','#f5eaff','#ffeaf5',
  '#f0f2f5','#fffbe8','#ffffff',
];

// ── JAPANESE HOLIDAYS ──
const HOLIDAY_MAP = {};
(function buildHolidays() {
  function nthWeekday(year, month, dow, n) {
    const d = new Date(year, month - 1, 1); let count = 0;
    while (true) {
      if (d.getDay() === dow) { count++; if (count === n) return new Date(d); }
      d.setDate(d.getDate() + 1);
    }
  }
  function ds(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function add(d, label) { HOLIDAY_MAP[ds(d)] = label; }
  function addYMD(y,m,day,label) { add(new Date(y,m-1,day), label); }

  const shunbunDays  = { 2024:20,2025:20,2026:20,2027:21,2028:20,2029:20,2030:20 };
  const shubunDays   = { 2024:22,2025:23,2026:23,2027:23,2028:22,2029:23,2030:23 };

  for (let y = 2024; y <= 2030; y++) {
    addYMD(y,1,1,'元日');
    add(nthWeekday(y,1,1,2),'成人の日');
    addYMD(y,2,11,'建国記念の日');
    addYMD(y,2,23,'天皇誕生日');
    addYMD(y,3,shunbunDays[y],'春分の日');
    addYMD(y,4,29,'昭和の日');
    addYMD(y,5,3,'憲法記念日');
    addYMD(y,5,4,'みどりの日');
    addYMD(y,5,5,'こどもの日');
    add(nthWeekday(y,7,1,3),'海の日');
    addYMD(y,8,11,'山の日');
    add(nthWeekday(y,9,1,3),'敬老の日');
    addYMD(y,9,shubunDays[y],'秋分の日');
    add(nthWeekday(y,10,1,2),'スポーツの日');
    addYMD(y,11,3,'文化の日');
    addYMD(y,11,23,'勤労感謝の日');
  }
  // 振替休日（祝日が日曜→翌月曜）
  const toAdd = {};
  Object.entries(HOLIDAY_MAP).forEach(([dateStr]) => {
    const d = new Date(dateStr);
    if (d.getDay() === 0) {
      const next = new Date(d); next.setDate(d.getDate() + 1);
      const nk = ds(next);
      if (!HOLIDAY_MAP[nk]) toAdd[nk] = '振替休日';
    }
  });
  Object.assign(HOLIDAY_MAP, toAdd);
  // 手動補足
  ['2025-05-06','2026-05-06','2028-01-03'].forEach(s => {
    if (!HOLIDAY_MAP[s]) HOLIDAY_MAP[s] = '振替休日';
  });
})();
function isHoliday(ds) { return !!HOLIDAY_MAP[ds]; }

// ── HELPERS ──
const DAY = ['日','月','火','水','木','金','土'];
function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function getWeekDates(offset = 0) {
  const t = new Date(); t.setHours(0,0,0,0); t.setDate(t.getDate() + offset * 7);
  return Array.from({length:7}, (_,i) => { const d=new Date(t); d.setDate(t.getDate()+i); return d; });
}
function getTodayStr() { return toDateStr(new Date()); }
function genId() { return Math.random().toString(36).slice(2,9) + Date.now().toString(36); }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── SYNC ──
function setSyncUI(state, label) {
  document.getElementById('sync-dot').className = state;
  document.getElementById('sync-label').textContent = label;
}
async function pushToCloud() {
  if (!config.userId) return;
  setSyncUI('syncing','同期中…');
  try {
    const r = await fetch(`${WORKER_URL}/tasks/${config.userId}`, {
      method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(tasks)
    });
    if (!r.ok) throw new Error(r.status);
    setSyncUI('ok','同期済み ✓');
  } catch(e) { setSyncUI('err','エラー'); }
}
async function pullFromCloud() {
  if (!config.userId) { setSyncUI('','未設定'); return; }
  setSyncUI('syncing','読込中…');
  try {
    const r = await fetch(`${WORKER_URL}/tasks/${config.userId}`);
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    if (Array.isArray(data)) { tasks = data; localStorage.setItem(TASKS_KEY, JSON.stringify(tasks)); }
    setSyncUI('ok','同期済み ✓');
    render();
  } catch(e) { setSyncUI('err','エラー'); }
}
function schedulePush() {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
  clearTimeout(syncTimer); syncTimer = setTimeout(pushToCloud, 1500);
}

// ── GOAL ──
function loadGoal() { return localStorage.getItem(GOAL_KEY + '_' + weekOffset) || ''; }
function saveGoal(v) { localStorage.setItem(GOAL_KEY + '_' + weekOffset, v); }

// ── PUSH NOTIFICATION ──
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    // 相対パスで登録（サブディレクトリ対応）
    const swUrl    = new URL('./sw.js', location.href).href;
    const scopeUrl = new URL('./',      location.href).href;
    const reg = await navigator.serviceWorker.register(swUrl, { scope: scopeUrl });
    return reg;
  } catch(e) { console.error('SW registration failed:', e); return null; }
}
}

async function getVapidPublicKey() {
  try {
    const r = await fetch(`${WORKER_URL}/vapidPublicKey`);
    const d = await r.json();
    return d.key;
  } catch(e) { return null; }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function subscribeNotification() {
  if (!config.userId) { showToast('先にユーザーIDを設定してください'); return; }
  const reg = await registerServiceWorker();
  if (!reg) { showToast('Service Workerが使えません'); return; }

  const vapidKey = await getVapidPublicKey();
  if (!vapidKey) { showToast('サーバーとの通信に失敗しました'); return; }

  try {
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });
    // サーバーに購読情報を送信
    await fetch(`${WORKER_URL}/subscribe/${config.userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    });
    localStorage.setItem('todoweek_sub', JSON.stringify(sub.toJSON()));
    updateNotifUI();
    showToast('通知を許可しました 🔔');
  } catch(e) {
    console.error('Subscribe failed:', e);
    showToast('通知の設定に失敗しました');
  }
}

async function unsubscribeNotification() {
  const swUrl = new URL('./sw.js', location.href).href;
  const reg   = await navigator.serviceWorker.getRegistration(swUrl);
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    if (config.userId) {
      await fetch(`${WORKER_URL}/subscribe/${config.userId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
    }
    await sub.unsubscribe();
  }
  localStorage.removeItem('todoweek_sub');
  updateNotifUI();
  showToast('通知を解除しました');
}

async function updateNotifUI() {
  const btn  = document.getElementById('notif-btn');
  const text = document.getElementById('notif-status-text');
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    text.textContent = 'このブラウザでは通知を使えません';
    btn.style.display = 'none'; return;
  }
  const perm = Notification.permission;
  if (perm === 'denied') {
    text.textContent = '通知がブロックされています（設定から変更してください）';
    btn.textContent = '許可できません'; btn.className = 'btn-notif denied'; return;
  }
  // SW の購読状態を確認
  let isSubscribed = false;
  try {
    const swUrl = new URL('./sw.js', location.href).href;
    const reg   = await navigator.serviceWorker.getRegistration(swUrl);
    if (reg) {
      const sub = await reg.pushManager.getSubscription();
      isSubscribed = !!sub;
    }
  } catch(e) {}

  if (isSubscribed) {
    text.textContent = '通知がオンです（毎日20:00に送信）';
    btn.textContent  = '通知を解除する';
    btn.className    = 'btn-notif granted';
    btn.onclick      = unsubscribeNotification;
  } else {
    text.textContent = '通知を許可するとリマインドが届きます';
    btn.textContent  = '許可する';
    btn.className    = 'btn-notif';
    btn.onclick      = subscribeNotification;
  }
}

// ── RENDER ──
function render() {
  const dates    = getWeekDates(weekOffset);
  const todayStr = getTodayStr();

  document.getElementById('cols').innerHTML = dates.map(()=>'<col>').join('');

  // Goal row
  const goalRow = document.getElementById('goal-row');
  goalRow.innerHTML = '';
  const goalTd = document.createElement('td'); goalTd.colSpan = 7;
  const nav = document.createElement('div'); nav.className = 'goal-nav';
  const prevBtn = document.createElement('button');
  prevBtn.className='goal-nav-btn'; prevBtn.textContent='＜'; prevBtn.title='前の週';
  prevBtn.addEventListener('click', ()=>{ weekOffset--; render(); });
  const goalInput = document.createElement('input');
  goalInput.type='text'; goalInput.id='goal-input';
  goalInput.placeholder='📌 長期的な目標を入力…'; goalInput.value=loadGoal();
  goalInput.addEventListener('input', ()=>saveGoal(goalInput.value));
  const nextBtn = document.createElement('button');
  nextBtn.className='goal-nav-btn'; nextBtn.textContent='＞'; nextBtn.title='次の週';
  nextBtn.addEventListener('click', ()=>{ weekOffset++; render(); });
  nav.appendChild(prevBtn); nav.appendChild(goalInput); nav.appendChild(nextBtn);
  goalTd.appendChild(nav); goalRow.appendChild(goalTd);

  // Date headers
  document.getElementById('date-row').innerHTML = dates.map(d => {
    const ds  = toDateStr(d); const dow = d.getDay(); const hol = isHoliday(ds);
    const isToday = ds === todayStr;
    let cls = '';
    if (isToday) cls = 'today-col';
    else if (hol) cls = 'hol-col';
    else if (dow === 0) cls = 'sun-col';
    else if (dow === 6) cls = 'sat-col';
    const dowLabel = hol ? DAY[dow] + '祝' : DAY[dow];
    return `<th class="${cls}"><span class="day-num">${d.getDate()}</span>${d.getMonth()+1}/${d.getDate()}(${dowLabel})</th>`;
  }).join('');

  // Columns
  const wrap = document.getElementById('columns-wrap'); wrap.innerHTML = '';
  dates.forEach(d => {
    const ds  = toDateStr(d); const dow = d.getDay(); const hol = isHoliday(ds);
    const col = document.createElement('div'); col.className = 'col-body';
    if (ds === todayStr) col.classList.add('today-col');
    tasks.filter(t => t.date === ds).forEach(t => col.appendChild(makeTaskEl(t)));
    const btn = document.createElement('button');
    btn.className='new-btn'; btn.textContent='＋';
    btn.addEventListener('click', ()=>openModal(null, ds));
    col.appendChild(btn); wrap.appendChild(col);
  });

  renderOverdue();
}

// ── TASK ELEMENT ──
function makeTaskEl(task, isOverdue = false) {
  const div = document.createElement('div');
  div.className = 'task-item' + (task.done ? ' done' : '');
  const c = getColor(task.subject);
  const taskBg = (task.format && task.format.bg) ? task.format.bg : c.bg;
  div.style.background  = taskBg;
  div.style.borderColor = c.fg;

  const cb = document.createElement('div'); cb.className = 'task-cb';
  cb.style.borderColor = c.fg;
  cb.addEventListener('click', e => {
    e.stopPropagation(); task.done = !task.done; schedulePush(); render();
  });

  const lbl = document.createElement('div'); lbl.className = 'task-label';
  const titleEl = document.createElement('div');
  const baseFg = (task.format && task.format.fg) ? task.format.fg : c.fg;
  const f = task.format || {};
  let td = ''; if (f.underline) td = 'underline'; else if (f['double-underline']) td = 'underline double';
  titleEl.textContent         = task.title;
  titleEl.style.color         = baseFg;
  titleEl.style.fontWeight    = f.bold ? '700' : '';
  titleEl.style.textDecoration = td;
  lbl.appendChild(titleEl);

  if (isOverdue) {
    const dl = document.createElement('div'); dl.className='overdue-date-label';
    dl.textContent = task.date; lbl.prepend(dl);
  }
  if (task.subject && task.subject !== 'なし') {
    const tag = document.createElement('span'); tag.className = 'subject-tag';
    tag.textContent = task.subject;
    tag.style.background = 'transparent';
    tag.style.color      = c.fg;
    tag.style.border     = `1.5px solid ${c.fg}`;
    lbl.appendChild(tag);
  }
  if (task.remind && task.remind !== '0') {
    const ri = document.createElement('div'); ri.className='remind-info';
    ri.textContent = `⏰ ${task.remind}日前`; lbl.appendChild(ri);
  }
  div.appendChild(cb); div.appendChild(lbl);
  div.addEventListener('click', ()=>openModal(task.id));
  return div;
}

// ── OVERDUE ──
function renderOverdue() {
  const todayStr = getTodayStr();
  const od = tasks.filter(t => !t.done && t.date < todayStr);
  const sec = document.getElementById('overdue-section');
  if (!od.length) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  if (overdueOpen) {
    sec.classList.remove('collapsed');
    document.getElementById('overdue-toggle').textContent = '▼ 閉じる';
  } else {
    sec.classList.add('collapsed');
    document.getElementById('overdue-toggle').textContent = '▲ 開く';
  }
  od.sort((a,b)=>a.date<b.date?-1:1);
  const list = document.getElementById('overdue-list'); list.innerHTML = '';
  od.forEach(t => list.appendChild(makeTaskEl(t, true)));
}
document.getElementById('overdue-header').addEventListener('click', ()=>{
  overdueOpen = !overdueOpen; renderOverdue();
});

// ── FORMAT UI ──
window.toggleFmt = function(key) {
  if (key === 'underline' && !fmt[key]) fmt['double-underline'] = false;
  if (key === 'double-underline' && !fmt[key]) fmt['underline'] = false;
  fmt[key] = !fmt[key]; updateFmtUI();
};

function buildColorPicker(rowId, palette, selectedVal, onSelect) {
  const row = document.getElementById(rowId); row.innerHTML = '';
  palette.forEach(color => {
    const chip = document.createElement('div');
    chip.className = 'color-chip' + (color === null ? ' none-chip' : '');
    if (color) chip.style.background = color;
    if (color === selectedVal || (color === null && selectedVal === null)) chip.classList.add('selected');
    chip.addEventListener('click', () => { onSelect(color); });
    row.appendChild(chip);
  });
}

function updateFmtUI() {
  ['bold','underline','double-underline'].forEach(k => {
    const btn = document.getElementById('fmt-' + k);
    if (btn) btn.classList.toggle('active', !!fmt[k]);
  });
  buildColorPicker('color-fg-row', FG_PALETTE, fmt.fg, color => {
    fmt.fg = color; updateFmtUI();
  });
  buildColorPicker('color-bg-row', BG_PALETTE, fmt.bg, color => {
    fmt.bg = color; updateFmtUI();
  });
  updatePreview();
}

function initFmtFromSubject(subject) {
  const c = getColor(subject);
  fmt.fg = c.fg === DEFAULT_COLOR.fg ? null : c.fg;
  fmt.bg = c.bg === DEFAULT_COLOR.bg ? null : c.bg;
  updateFmtUI();
}
function initFmtFromTask(task) {
  const f = task.format || {};
  fmt.bold              = !!f.bold;
  fmt.underline         = !!f.underline;
  fmt['double-underline'] = !!f['double-underline'];
  fmt.fg = f.fg ?? null; fmt.bg = f.bg ?? null;
  updateFmtUI();
}
function updatePreview() {
  const titleVal = document.getElementById('f-title').value || 'テキスト';
  const prev = document.getElementById('format-preview');
  let td = '';
  if (fmt.underline)           td = 'underline';
  if (fmt['double-underline']) td = 'underline double';
  prev.style.fontWeight      = fmt.bold ? '700' : '400';
  prev.style.textDecoration  = td;
  prev.style.color           = fmt.fg || '';
  prev.style.backgroundColor = fmt.bg || '';
  prev.textContent           = titleVal;
}

window.handleSubjectChange = function(val) {
  document.getElementById('custom-subject-group').style.display = (val === 'カスタム') ? 'block' : 'none';
  const subjName = val === 'カスタム'
    ? (document.getElementById('f-custom-subject').value.trim() || 'カスタム')
    : val;
  const c = getColor(subjName);
  fmt.fg = c.fg === DEFAULT_COLOR.fg ? null : c.fg;
  fmt.bg = c.bg === DEFAULT_COLOR.bg ? null : c.bg;
  updateFmtUI();
};

// ── MODAL ──
function openModal(id, dateStr) {
  currentDateStr = dateStr || getTodayStr();
  editingId = id || null;
  const isEdit = !!id;
  document.getElementById('modal-title-text').textContent = isEdit ? '編集' : '新規作成';
  document.getElementById('f-date-group').style.display = isEdit ? 'block' : 'none';
  document.getElementById('custom-subject-group').style.display = 'none';
  fmt = { bold:false, underline:false, 'double-underline':false, fg:null, bg:null };

  if (isEdit) {
    const t = tasks.find(t => t.id === id);
    document.getElementById('f-title').value  = t.title  || '';
    document.getElementById('f-date').value   = t.date   || '';
    document.getElementById('f-remind').value = t.remind || '0';
    const presets = ['なし','国語','数学','英語','化学','生物','日本史','情報'];
    if (presets.includes(t.subject)) {
      document.getElementById('f-subject').value = t.subject;
    } else if (t.subject) {
      document.getElementById('f-subject').value = 'カスタム';
      document.getElementById('f-custom-subject').value = t.subject;
      document.getElementById('custom-subject-group').style.display = 'block';
    } else {
      document.getElementById('f-subject').value = 'なし';
    }
    initFmtFromTask(t);
    document.getElementById('modal-actions').innerHTML = `
      <button class="btn-primary"   id="modal-save">保存する</button>
      <button class="btn-danger"    id="modal-delete">削除</button>
      <button class="btn-secondary" id="modal-cancel">キャンセル</button>`;
    document.getElementById('modal-delete').addEventListener('click', deleteTask);
  } else {
    document.getElementById('f-title').value   = '';
    document.getElementById('f-remind').value  = '0';
    document.getElementById('f-subject').value = 'なし';
    document.getElementById('f-custom-subject').value = '';
    initFmtFromSubject('なし');
    document.getElementById('modal-actions').innerHTML = `
      <button class="btn-primary"   id="modal-save">保存する</button>
      <button class="btn-secondary" id="modal-cancel">キャンセル</button>`;
  }
  document.getElementById('modal-save').addEventListener('click', saveTask);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('f-title').addEventListener('input', updatePreview);
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('f-title').focus(), 260);
  updateFmtUI();
}

function closeModal() { document.getElementById('modal-overlay').classList.remove('open'); }

function getSubjectValue() {
  const sel = document.getElementById('f-subject').value;
  if (sel === 'カスタム') return document.getElementById('f-custom-subject').value.trim() || 'カスタム';
  return sel;
}

function saveTask() {
  const title  = document.getElementById('f-title').value.trim();
  if (!title) { showToast('タイトルを入力してください'); return; }
  const finalDate = editingId ? document.getElementById('f-date').value : currentDateStr;
  if (!finalDate) { showToast('日付が設定されていません'); return; }
  const remind  = document.getElementById('f-remind').value;
  const subject = getSubjectValue();
  const format  = {
    bold: fmt.bold, underline: fmt.underline,
    'double-underline': fmt['double-underline'],
    fg: fmt.fg, bg: fmt.bg,
  };
  if (editingId) {
    const i = tasks.findIndex(t => t.id === editingId);
    if (i >= 0) tasks[i] = { ...tasks[i], title, date: finalDate, remind, subject, format };
    showToast('更新しました ✓');
  } else {
    tasks.push({ id: genId(), title, date: finalDate, remind, subject, done: false, format });
    showToast('追加しました ✓');
  }
  schedulePush(); closeModal(); render();
}

function deleteTask() {
  if (!editingId || !confirm('この予定を削除しますか？')) return;
  tasks = tasks.filter(t => t.id !== editingId);
  schedulePush(); closeModal(); render(); showToast('削除しました');
}

// ── SETUP ──
function showSetup() {
  document.getElementById('setup-uid').value = config.userId || '';
  const wrap    = document.getElementById('setup-current-user-wrap');
  const uidEl   = document.getElementById('setup-current-uid');
  const btnSkip = document.getElementById('setup-skip');
  const btnOut  = document.getElementById('setup-logout');
  if (config.userId) {
    uidEl.textContent = config.userId;
    wrap.style.display = 'flex'; btnOut.style.display = 'block'; btnSkip.style.display = 'none';
  } else {
    wrap.style.display = 'none'; btnOut.style.display = 'none'; btnSkip.style.display = 'block';
  }
  document.getElementById('setup-overlay').classList.add('open');
  setTimeout(() => document.getElementById('setup-uid').focus(), 100);
  updateNotifUI();
}

document.getElementById('setup-uid').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('setup-save').click();
});
document.getElementById('setup-save').addEventListener('click', async () => {
  const uid = document.getElementById('setup-uid').value.trim().replace(/[^a-zA-Z0-9_-]/g,'');
  if (!uid) { showToast('ユーザーIDを入力してください'); return; }
  config = { userId: uid };
  localStorage.setItem(CFG_KEY, JSON.stringify(config));
  document.getElementById('setup-overlay').classList.remove('open');
  await pullFromCloud();
  showToast('同期を開始しました ✓');
});
document.getElementById('setup-skip').addEventListener('click', () => {
  document.getElementById('setup-overlay').classList.remove('open');
  setSyncUI('','ローカルのみ');
});
document.getElementById('setup-logout').addEventListener('click', async () => {
  if (!confirm('ログアウトしますか？\nこのデバイスのローカルデータも削除されます。')) return;
  await unsubscribeNotification();
  config = {}; tasks = [];
  localStorage.removeItem(CFG_KEY); localStorage.removeItem(TASKS_KEY);
  document.getElementById('setup-overlay').classList.remove('open');
  setSyncUI('','未設定'); render(); showToast('ログアウトしました');
  setTimeout(showSetup, 400);
});

// ── EVENTS ──
document.getElementById('modal-overlay').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('sync-status').addEventListener('click', showSetup);
document.getElementById('logo-btn').addEventListener('click', showSetup);

// ── TOAST ──
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// ── INIT ──
registerServiceWorker();
render();
if (!config.userId) { showSetup(); } else { pullFromCloud(); }
setInterval(() => { const n=new Date(); if(n.getHours()===0&&n.getMinutes()===0) render(); }, 60000);
