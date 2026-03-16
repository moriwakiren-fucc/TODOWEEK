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
const CUSTOM_COLOR   = { bg: '#ffeaf5', fg: '#cc2266', border: '#ffb3d9' };
const DEFAULT_COLOR  = { bg: '#f0f2f5', fg: '#6b7594', border: '#dde1ea' };

function getColor(subject) {
  if (!subject || subject === 'なし') return DEFAULT_COLOR;
  if (SUBJECT_COLORS[subject]) return SUBJECT_COLORS[subject];
  return CUSTOM_COLOR;
}

// ── PALETTE for color picker ──
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
// 振替休日は月曜が祝日扱い（「振替」ラベル）
// 固定祝日 + 移動祝日 2024-2030
const HOLIDAY_MAP = {}; // dateStr -> label

(function buildHolidays() {
  // ヘルパー：第N週の特定曜日
  function nthWeekday(year, month, dow, n) {
    // month: 1-12, dow: 0=日 .. 6=土, n: 1-5
    const d = new Date(year, month - 1, 1);
    let count = 0;
    while (true) {
      if (d.getDay() === dow) { count++; if (count === n) return new Date(d); }
      d.setDate(d.getDate() + 1);
    }
  }
  function fmt(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function add(d, label) { HOLIDAY_MAP[fmt(d)] = label; }
  function addYMD(y,m,day,label) { add(new Date(y,m-1,day), label); }

  for (let y = 2024; y <= 2030; y++) {
    addYMD(y,1,1,'元日');
    // 成人の日：1月第2月曜
    add(nthWeekday(y,1,1,2),'成人の日');
    addYMD(y,2,11,'建国記念の日');
    addYMD(y,2,23,'天皇誕生日');
    // 春分の日（概算）
    const shunbun = [2024,2025,2026,2027,2028,2029,2030].indexOf(y);
    const shunbunDays = [20,20,20,21,20,20,20];
    addYMD(y,3,shunbunDays[shunbun],'春分の日');
    addYMD(y,4,29,'昭和の日');
    addYMD(y,5,3,'憲法記念日');
    addYMD(y,5,4,'みどりの日');
    addYMD(y,5,5,'こどもの日');
    // 海の日：7月第3月曜
    add(nthWeekday(y,7,1,3),'海の日');
    addYMD(y,8,11,'山の日');
    // 敬老の日：9月第3月曜
    add(nthWeekday(y,9,1,3),'敬老の日');
    // 秋分の日（概算）
    const shubunDays = [22,23,23,23,22,23,23];
    addYMD(y,9,shubunDays[shunbun],'秋分の日');
    // スポーツの日：10月第2月曜
    add(nthWeekday(y,10,1,2),'スポーツの日');
    addYMD(y,11,3,'文化の日');
    addYMD(y,11,23,'勤労感謝の日');
  }

  // 振替休日を追加（祝日が日曜→翌月曜）
  const entries = Object.entries(HOLIDAY_MAP);
  const toAdd = {};
  entries.forEach(([ds, label]) => {
    const d = new Date(ds);
    if (d.getDay() === 0) { // 日曜
      const next = new Date(d); next.setDate(d.getDate() + 1);
      const nk = fmt(next);
      if (!HOLIDAY_MAP[nk]) toAdd[nk] = '振替休日';
    }
  });
  // 国民の休日（祝日に挟まれた平日）も簡易対応
  Object.assign(HOLIDAY_MAP, toAdd);

  // 特定の振替休日（手動補足）
  const extraSubstitutes = [
    '2025-05-06', // こどもの日振替
    '2026-05-06', // 憲法記念日振替
    '2028-01-03', // 元日振替
  ];
  extraSubstitutes.forEach(ds => {
    if (!HOLIDAY_MAP[ds]) HOLIDAY_MAP[ds] = '振替休日';
  });
})();

function isHoliday(dateStr) { return !!HOLIDAY_MAP[dateStr]; }

// ── HELPERS ──
const DAY = ['日','月','火','水','木','金','土'];

function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function getWeekDates(offset = 0) {
  const t = new Date(); t.setHours(0,0,0,0);
  t.setDate(t.getDate() + offset * 7);
  return Array.from({length:7}, (_,i) => { const d=new Date(t); d.setDate(t.getDate()+i); return d; });
}
function getTodayStr() { return toDateStr(new Date()); }
function genId() { return Math.random().toString(36).slice(2,9) + Date.now().toString(36); }
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── SYNC ──
function setSyncUI(state, label) {
  document.getElementById('sync-dot').className = state;
  document.getElementById('sync-label').textContent = label;
}
async function pushToCloud() {
  if (!config.userId) return;
  setSyncUI('syncing','同期中…');
  try {
    const r = await fetch(`${WORKER_URL}/tasks/${config.userId}`,{
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

// ── RENDER ──
function render() {
  const dates    = getWeekDates(weekOffset);
  const todayStr = getTodayStr();

  // Colgroup
  document.getElementById('cols').innerHTML = dates.map(()=>'<col>').join('');

  // Goal row
  const goalRow = document.getElementById('goal-row');
  goalRow.innerHTML = '';
  const goalTd = document.createElement('td');
  goalTd.colSpan = 7;
  const nav = document.createElement('div'); nav.className = 'goal-nav';
  const prevBtn = document.createElement('button');
  prevBtn.className='goal-nav-btn'; prevBtn.textContent='＜'; prevBtn.title='前の週';
  prevBtn.addEventListener('click', ()=>{ weekOffset--; render(); });
  const goalInput = document.createElement('input');
  goalInput.type='text'; goalInput.id='goal-input';
  goalInput.placeholder='📌 長期的な目標を入力…';
  goalInput.value=loadGoal();
  goalInput.addEventListener('input', ()=>saveGoal(goalInput.value));
  const nextBtn = document.createElement('button');
  nextBtn.className='goal-nav-btn'; nextBtn.textContent='＞'; nextBtn.title='次の週';
  nextBtn.addEventListener('click', ()=>{ weekOffset++; render(); });
  nav.appendChild(prevBtn); nav.appendChild(goalInput); nav.appendChild(nextBtn);
  goalTd.appendChild(nav); goalRow.appendChild(goalTd);

  // Date headers
  document.getElementById('date-row').innerHTML = dates.map(d => {
    const ds  = toDateStr(d);
    const dow = d.getDay();
    const hol = isHoliday(ds);
    const isToday = ds === todayStr;
    let cls = '';
    if      (isToday)  cls = 'today-col';
    else if (hol)      cls = 'hol-col';
    else if (dow === 0) cls = 'sun-col';
    else if (dow === 6) cls = 'sat-col';
    let dowLabel = DAY[dow];
    if (hol) dowLabel = DAY[dow] + '祝';
    return `<th class="${cls}"><span class="day-num">${d.getDate()}</span>${d.getMonth()+1}/${d.getDate()}(${dowLabel})</th>`;
  }).join('');

  // Columns wrap（各列独立スクロール）
  const wrap = document.getElementById('columns-wrap');
  wrap.innerHTML = '';
  dates.forEach(d => {
    const ds  = toDateStr(d);
    const dow = d.getDay();
    const hol = isHoliday(ds);
    const col = document.createElement('div');
    col.className = 'col-body';
    if (ds === todayStr)          col.classList.add('today-col');
    else if (hol || dow === 0)    col.classList.add('sun-col-bg');
    else if (dow === 6)           col.classList.add('sat-col-bg');

    const colTasks = tasks.filter(t => t.date === ds);
    colTasks.forEach(t => col.appendChild(makeTaskEl(t)));
    const btn = document.createElement('button');
    btn.className='new-btn'; btn.textContent='＋';
    btn.addEventListener('click', ()=>openModal(null, ds));
    col.appendChild(btn);
    wrap.appendChild(col);
  });

  renderOverdue();
}

// ── FORMAT HELPERS ──
function fmtStyle(task) {
  const f = task.format || {};
  let td = ''; if (f.underline) td = 'underline'; else if (f['double-underline']) td = 'underline double';
  return {
    fontWeight:      f.bold ? '700' : '',
    textDecoration:  td,
    color:           f.fg   || '',
    backgroundColor: f.bg   || '',
  };
}
function applyStyleToEl(el, style) {
  Object.assign(el.style, style);
}

function makeTaskEl(task, isOverdue = false) {
  const div = document.createElement('div');
  div.className = 'task-item' + (task.done ? ' done' : '');
  const c = getColor(task.subject);
  // 背景は書式.bg があればそちら優先、なければ教科色
  const taskBg     = (task.format && task.format.bg) ? task.format.bg : c.bg;
  const taskBorder = c.fg;   // 枠線色 = 文字色
  div.style.background  = taskBg;
  div.style.borderColor = taskBorder;

  const cb = document.createElement('div');
  cb.className = 'task-cb';
  cb.style.borderColor = c.fg;
  cb.addEventListener('click', e => {
    e.stopPropagation(); task.done = !task.done; schedulePush(); render();
  });

  const lbl = document.createElement('div'); lbl.className = 'task-label';
  const titleEl = document.createElement('div');
  // 書式適用
  const style = fmtStyle(task);
  const baseFg = (task.format && task.format.fg) ? task.format.fg : c.fg;
  titleEl.textContent = task.title;
  titleEl.style.color          = baseFg;
  titleEl.style.fontWeight     = style.fontWeight;
  titleEl.style.textDecoration = style.textDecoration;
  lbl.appendChild(titleEl);

  if (isOverdue) {
    const dl = document.createElement('div'); dl.className='overdue-date-label';
    dl.textContent = task.date; lbl.prepend(dl);
  }
  if (task.subject && task.subject !== 'なし') {
    const tag = document.createElement('span');
    tag.className = 'subject-tag';
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
  const list = document.getElementById('overdue-list');
  list.innerHTML = '';
  od.forEach(t => list.appendChild(makeTaskEl(t, true)));
}
document.getElementById('overdue-header').addEventListener('click', ()=>{
  overdueOpen = !overdueOpen; renderOverdue();
});

// ── FORMAT UI ──
function toggleFmt(key) {
  if (key === 'underline' && !fmt[key]) fmt['double-underline'] = false;
  if (key === 'double-underline' && !fmt[key]) fmt['underline'] = false;
  fmt[key] = !fmt[key];
  updateFmtUI();
}
window.toggleFmt = toggleFmt;

function buildColorPicker(rowId, palette, selectedVal, onSelect) {
  const row = document.getElementById(rowId);
  row.innerHTML = '';
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
  // ボタンのハイライト
  ['bold','underline','double-underline'].forEach(k => {
    const btn = document.getElementById('fmt-' + k);
    if (btn) btn.classList.toggle('active', !!fmt[k]);
  });
  // カラーピッカー再描画
  buildColorPicker('color-fg-row', FG_PALETTE, fmt.fg, color => {
    fmt.fg = color; buildColorPicker('color-fg-row', FG_PALETTE, fmt.fg, arguments.callee); updatePreview();
  });
  buildColorPicker('color-bg-row', BG_PALETTE, fmt.bg, color => {
    fmt.bg = color; buildColorPicker('color-bg-row', BG_PALETTE, fmt.bg, arguments.callee); updatePreview();
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
  fmt.fg = f.fg ?? null;
  fmt.bg = f.bg ?? null;
  updateFmtUI();
}

function updatePreview() {
  const titleVal = document.getElementById('f-title').value || 'テキスト';
  const prev = document.getElementById('format-preview');
  let td = '';
  if (fmt.underline)            td = 'underline';
  if (fmt['double-underline'])  td = 'underline double';
  prev.style.fontWeight      = fmt.bold ? '700' : '400';
  prev.style.textDecoration  = td;
  prev.style.color           = fmt.fg || '';
  prev.style.backgroundColor = fmt.bg || '';
  prev.textContent           = titleVal;
}

window.handleSubjectChange = function(val) {
  document.getElementById('custom-subject-group').style.display = (val === 'カスタム') ? 'block' : 'none';
  // 教科変更時にカラーを教科のデフォルトに更新（書式は維持）
  const subjName = val === 'カスタム'
    ? (document.getElementById('f-custom-subject').value.trim() || 'カスタム')
    : val;
  const c = getColor(subjName);
  if (!fmt.fg || isPaletteColor(fmt.fg)) fmt.fg = c.fg === DEFAULT_COLOR.fg ? null : c.fg;
  if (!fmt.bg || isPaletteColor(fmt.bg)) fmt.bg = c.bg === DEFAULT_COLOR.bg ? null : c.bg;
  updateFmtUI();
};

function isPaletteColor(c) {
  return [...FG_PALETTE, ...BG_PALETTE].includes(c);
}

// ── MODAL ──
function openModal(id, dateStr) {
  editingId = id || null;
  const isEdit = !!id;
  document.getElementById('modal-title-text').textContent = isEdit ? '編集' : '新規作成';

  // 日付欄：編集時のみ表示
  document.getElementById('f-date-group').style.display = isEdit ? 'block' : 'none';
  document.getElementById('custom-subject-group').style.display = 'none';

  // フォーマット初期化
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
    // 新規作成時は教科「なし」のデフォルト色
    initFmtFromSubject('なし');

    document.getElementById('modal-actions').innerHTML = `
      <button class="btn-primary"   id="modal-save">保存する</button>
      <button class="btn-secondary" id="modal-cancel">キャンセル</button>`;
  }

  document.getElementById('modal-save').addEventListener('click', saveTask);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);

  // タイトル変更でプレビュー更新
  document.getElementById('f-title').addEventListener('input', updatePreview);

  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('f-title').focus(), 260);

  updateFmtUI();
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

function getSubjectValue() {
  const sel = document.getElementById('f-subject').value;
  if (sel === 'カスタム') {
    return document.getElementById('f-custom-subject').value.trim() || 'カスタム';
  }
  return sel;
}

function saveTask() {
  const title   = document.getElementById('f-title').value.trim();
  const date    = editingId ? document.getElementById('f-date').value : (tasks.find(t=>t.id===editingId)||{date:''}).date;
  if (!title) { showToast('タイトルを入力してください'); return; }

  // 新規作成時はdateをmodalのdateStrから取得（openModal内で保持）
  const finalDate = editingId
    ? document.getElementById('f-date').value
    : currentDateStr;

  if (!finalDate) { showToast('日付が設定されていません'); return; }

  const remind  = document.getElementById('f-remind').value;
  const subject = getSubjectValue();
  const format  = {
    bold:              fmt.bold,
    underline:         fmt.underline,
    'double-underline': fmt['double-underline'],
    fg:                fmt.fg,
    bg:                fmt.bg,
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

// 新規作成時の日付を保持する変数
let currentDateStr = '';

// openModalを修正して currentDateStr を保存
const _origOpenModal = openModal;
window.openModal = function(id, dateStr) {
  currentDateStr = dateStr || getTodayStr();
  _origOpenModal(id, dateStr);
};

// ── SETUP ──
function showSetup() {
  document.getElementById('setup-uid').value = config.userId || '';
  const wrap   = document.getElementById('setup-current-user-wrap');
  const uidEl  = document.getElementById('setup-current-uid');
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
document.getElementById('setup-logout').addEventListener('click', () => {
  if (!confirm('ログアウトしますか？\nこのデバイスのローカルデータも削除されます。')) return;
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
render();
if (!config.userId) { showSetup(); } else { pullFromCloud(); }
setInterval(() => { const n=new Date(); if(n.getHours()===0&&n.getMinutes()===0) render(); }, 60000);
