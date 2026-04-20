// ── FIXED CONFIG ──
const WORKER_URL = 'https://todoweek-api2.moriwakiren-fucc.workers.dev';
const CFG_KEY    = 'todoweek_config_v1';
const TASKS_KEY  = 'todoweek_tasks_v2';
const GOAL_KEY   = 'todoweek_goal_v1';
const SUB_KEY    = 'todoweek_sub_v1';
const FAV_KEY        = 'todoweek_favorites_v1';
const VERSION_KEY    = 'todoweek_version_v1';
const VERSION_URL    = 'https://moriwakiren-fucc.github.io/TODOWEEK/version.json';

// ── STATE ──
let config = {};
try { config = JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch(e) {}
let tasks = [];
try { tasks = JSON.parse(localStorage.getItem(TASKS_KEY)) || []; } catch(e) {}

let syncTimer      = null;
let editingId      = null;
let dayOffset      = 0;   // 今日から何日ずらして表示するか（日単位）
let visibleCols    = 7;   // 現在表示している列数
let overdueOpen    = true;
let currentDateStr = '';
let cachedVapidKey = null;

// ── FORMAT STATE ──
let fmt = { bold: false, underline: false, 'double-underline': false, fg: null, bg: null };

// ── SUBJECT COLOR MAP ──
const SUBJECT_COLORS = {
  '国語':   { bg: '#ffeaea', fg: '#cc2222' },
  '数学':   { bg: '#e8f0ff', fg: '#1a44cc' },
  '英語':   { bg: '#fffbe0', fg: '#998800' },
  '化学':   { bg: '#eafff0', fg: '#1a8840' },
  '物理':   { bg: '#eafff0', fg: '#1a8840' },
  '生物':   { bg: '#eafff0', fg: '#1a8840' },
  '地理':   { bg: '#f5eaff', fg: '#7722cc' },
  '日本史': { bg: '#f5eaff', fg: '#7722cc' },
  '世界史': { bg: '#f5eaff', fg: '#7722cc' },
  '情報':   { bg: '#e0faff', fg: '#0088aa' },
};
const CUSTOM_COLOR  = { bg: '#ffeaf5', fg: '#cc2266', border: '#ffb3d9' };
const DEFAULT_COLOR = { bg: '#f0f2f5', fg: '#6b7594', border: '#dde1ea' };

// 後方互換：旧notifTime文字列 / 旧notifTimes文字列配列 / 新notifications配列 → {remind, time}[] で返す
function getNotifsArray(task) {
  // 新形式
  if (Array.isArray(task.notifications) && task.notifications.length)
    return task.notifications.filter(n => n && n.time && n.time !== 'none');
  // 旧形式（notifTimes文字列配列）
  const taskRemind = task.remind && task.remind !== '0' ? task.remind : 'today';
  if (Array.isArray(task.notifTimes) && task.notifTimes.length)
    return task.notifTimes.filter(t => t && t !== 'none').map(t => ({ remind: taskRemind, time: t }));
  // 最旧形式（notifTime単一文字列）
  if (task.notifTime && task.notifTime !== 'none')
    return [{ remind: taskRemind, time: task.notifTime }];
  return [];
}

// リマインド日を YYYY-MM-DD で返す（未設定は '9999-99-99'）
function getRemindDate(task) {
  if (!task.remind || task.remind === '0' || !task.date) return '9999-99-99';
  if (task.remind === 'today') return task.date;
  const [y, m, d] = task.date.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d) - parseInt(task.remind, 10) * 86400000;
  const rd = new Date(ms);
  return `${rd.getUTCFullYear()}-${String(rd.getUTCMonth()+1).padStart(2,'0')}-${String(rd.getUTCDate()).padStart(2,'0')}`;
}

function getFirstNotifTime(task) {
  const notifs = getNotifsArray(task);
  return notifs.length ? notifs[0].time : '99:99';
}

// 列内ソート：完了済みは必ず最後、colOrderがあれば優先、なければリマインド日時順
function sortTasksForDate(dateTasks) {
  const undone = dateTasks.filter(t => !t.done);
  const done   = dateTasks.filter(t =>  t.done);

  const sortGroup = arr => {
    const withOrder    = arr.filter(t => t.colOrder !== undefined).sort((a, b) => a.colOrder - b.colOrder);
    const withoutOrder = arr.filter(t => t.colOrder === undefined).sort((a, b) => {
      const ra = getRemindDate(a), rb = getRemindDate(b);
      if (ra !== rb) return ra < rb ? -1 : 1;
      const ta = getFirstNotifTime(a), tb = getFirstNotifTime(b);
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    return [...withOrder, ...withoutOrder];
  };

  return [...sortGroup(undone), ...sortGroup(done)];
}

// お気に入りのリマインド値から表示文字列（通常と同じ値）
const FAV_REMIND_LABELS = {
  '0':'なし','today':'当日','1':'1日前','2':'2日前','3':'3日前',
  '5':'5日前','7':'7日前','10':'10日前','14':'2週間前','30':'30日前'
};

function getColor(subject) {
  if (!subject || subject === 'なし') return DEFAULT_COLOR;
  if (SUBJECT_COLORS[subject]) return SUBJECT_COLORS[subject];
  return CUSTOM_COLOR;
}

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
    while (true) { if (d.getDay() === dow) { count++; if (count === n) return new Date(d); } d.setDate(d.getDate() + 1); }
  }
  function ds(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  function add(d, label) { HOLIDAY_MAP[ds(d)] = label; }
  function addYMD(y,m,day,label) { add(new Date(y,m-1,day), label); }
  const shunbunDays = { 2024:20,2025:20,2026:20,2027:21,2028:20,2029:20,2030:20 };
  const shubunDays  = { 2024:22,2025:23,2026:23,2027:23,2028:22,2029:23,2030:23 };
  for (let y = 2024; y <= 2030; y++) {
    addYMD(y,1,1,'元日'); add(nthWeekday(y,1,1,2),'成人の日');
    addYMD(y,2,11,'建国記念の日'); addYMD(y,2,23,'天皇誕生日');
    addYMD(y,3,shunbunDays[y],'春分の日'); addYMD(y,4,29,'昭和の日');
    addYMD(y,5,3,'憲法記念日'); addYMD(y,5,4,'みどりの日'); addYMD(y,5,5,'こどもの日');
    add(nthWeekday(y,7,1,3),'海の日'); addYMD(y,8,11,'山の日');
    add(nthWeekday(y,9,1,3),'敬老の日'); addYMD(y,9,shubunDays[y],'秋分の日');
    add(nthWeekday(y,10,1,2),'スポーツの日');
    addYMD(y,11,3,'文化の日'); addYMD(y,11,23,'勤労感謝の日');
  }
  const toAdd = {};
  Object.entries(HOLIDAY_MAP).forEach(([dateStr]) => {
    const d = new Date(dateStr);
    if (d.getDay() === 0) {
      const next = new Date(d); next.setDate(d.getDate() + 1);
      const nk = ds(next); if (!HOLIDAY_MAP[nk]) toAdd[nk] = '振替休日';
    }
  });
  Object.assign(HOLIDAY_MAP, toAdd);
  ['2025-05-06','2026-05-06','2028-01-03'].forEach(s => { if (!HOLIDAY_MAP[s]) HOLIDAY_MAP[s] = '振替休日'; });
})();
function isHoliday(ds) { return !!HOLIDAY_MAP[ds]; }

// ── HELPERS ──
const DAY = ['日','月','火','水','木','金','土'];
function toDateStr(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function getVisibleDates(offset = 0, count = 7) {
  const t = new Date(); t.setHours(0,0,0,0); t.setDate(t.getDate() + offset);
  return Array.from({length: count}, (_, i) => { const d = new Date(t); d.setDate(t.getDate() + i); return d; });
}
function getTodayStr() { return toDateStr(new Date()); }
function genId() { return Math.random().toString(36).slice(2,9) + Date.now().toString(36); }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── SYNC ──
const PENDING_KEY = 'todoweek_pending_sync'; // オフライン中の未同期フラグ

function setSyncUI(state, label) {
  document.getElementById('sync-dot').className = state;
  document.getElementById('sync-label').textContent = label;
}

async function pushToCloud() {
  if (!config.userId) return;
  if (!navigator.onLine) {
    // オフライン：未同期フラグを立てておく
    localStorage.setItem(PENDING_KEY, '1');
    setSyncUI('err', 'オフライン');
    return;
  }
  setSyncUI('syncing', '同期中…');
  try {
    const r = await fetch(`${WORKER_URL}/tasks/${config.userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tasks),
    });
    if (!r.ok) throw new Error(r.status);
    localStorage.removeItem(PENDING_KEY);
    setSyncUI('ok', '同期済み ✓');
  } catch(e) {
    localStorage.setItem(PENDING_KEY, '1');
    setSyncUI('err', 'エラー');
  }
}

async function pullFromCloud() {
  if (!config.userId) { setSyncUI('', '未設定'); return; }
  if (!navigator.onLine) {
    // オフライン：localStorageのデータをそのまま使う
    setSyncUI('err', 'オフライン');
    render();
    return;
  }
  setSyncUI('syncing', '読込中…');
  try {
    const r = await fetch(`${WORKER_URL}/tasks/${config.userId}`);
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    if (Array.isArray(data)) {
      // オフライン中に編集があった場合はローカルを優先してサーバーに上書き
      if (localStorage.getItem(PENDING_KEY)) {
        await pushToCloud();
      } else {
        tasks = data;
        localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
      }
    }
    setSyncUI('ok', '同期済み ✓');
    await pullFavoritesFromCloud(); // お気に入りも取得
    render();
  } catch(e) {
    setSyncUI('err', 'エラー');
    render(); // エラーでもローカルデータで表示
  }
}

function schedulePush() {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
  if (!navigator.onLine) {
    localStorage.setItem(PENDING_KEY, '1');
    setSyncUI('err', 'オフライン（復帰時に同期）');
    return;
  }
  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushToCloud, 1500);
}

// ── FAVORITESのクラウド同期 ──
async function pushFavoritesToCloud() {
  if (!config.userId || !navigator.onLine) return;
  try {
    await fetch(`${WORKER_URL}/favorites/${config.userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(favorites),
    });
  } catch(e) { console.warn('fav push failed', e); }
}

async function pullFavoritesFromCloud() {
  if (!config.userId || !navigator.onLine) return;
  try {
    const r = await fetch(`${WORKER_URL}/favorites/${config.userId}`);
    if (!r.ok) return;
    const data = await r.json();
    if (Array.isArray(data)) {
      favorites = data;
      localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
    }
  } catch(e) { console.warn('fav pull failed', e); }
}

function scheduleFavPush() {
  localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
  clearTimeout(window._favSyncTimer);
  window._favSyncTimer = setTimeout(pushFavoritesToCloud, 1500);
}

// ── GOAL ──
function loadGoal() { return localStorage.getItem(GOAL_KEY + '_' + Math.floor(dayOffset / 7)) || ''; }
function saveGoal(v) { localStorage.setItem(GOAL_KEY + '_' + Math.floor(dayOffset / 7), v); }

// ── SERVICE WORKER ──
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const swUrl    = new URL('./sw.js', location.href).href;
    const scopeUrl = new URL('./',      location.href).href;
    return await navigator.serviceWorker.register(swUrl, { scope: scopeUrl });
  } catch(e) { console.error('SW registration failed:', e); return null; }
}

// ── VAPID KEY ──
async function getVapidPublicKey() {
  if (cachedVapidKey) return cachedVapidKey;
  try {
    const r = await fetch(`${WORKER_URL}/vapidPublicKey`);
    const d = await r.json();
    cachedVapidKey = d.key || null;
    return cachedVapidKey;
  } catch(e) { return null; }
}

function urlBase64ToUint8Array(base64String) {
  const cleaned = base64String.trim();
  const base64  = cleaned.replace(/-/g, '+').replace(/_/g, '/');
  const padded  = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
  try {
    const raw = atob(padded);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  } catch(e) {
    throw new Error('VAPIDキーのBase64デコード失敗: ' + e.message);
  }
}

// ── この端末の購読情報を取得 ──
async function getThisDeviceSub() {
  try {
    const swUrl = new URL('./sw.js', location.href).href;
    const reg   = await navigator.serviceWorker.getRegistration(swUrl);
    if (!reg) return null;
    return await reg.pushManager.getSubscription();
  } catch(e) { return null; }
}

// ── 購読 ──
async function subscribeNotification() {
  if (!config.userId) { showToast('先にユーザーIDを設定してください'); return; }
  const reg = await registerServiceWorker();
  if (!reg) { showDebugMsg('Service Workerが使えません'); return; }
  const vapidKey = await getVapidPublicKey();
  if (!vapidKey) { showDebugMsg('VAPIDキー取得失敗'); return; }
  try {
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });
    const postRes = await fetch(`${WORKER_URL}/subscribe/${config.userId}`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(sub.toJSON()),
    });
    if (!postRes.ok) { showDebugMsg(`購読情報の送信失敗 HTTP ${postRes.status}`); return; }
    localStorage.setItem(SUB_KEY, JSON.stringify(sub.toJSON()));
    showToast('通知を許可しました 🔔');
    updateNotifHeaderBtn();
    await refreshNotifModal();
  } catch(e) {
    showDebugMsg(`Subscribe失敗\n${e.name}: ${e.message}`);
  }
}

// ── 購読解除（この端末のみ） ──
async function unsubscribeThisDevice() {
  const sub = await getThisDeviceSub();
  if (sub) {
    if (config.userId) {
      await fetch(`${WORKER_URL}/subscribe/${config.userId}`, {
        method: 'DELETE', headers: {'Content-Type':'application/json'},
        body: JSON.stringify(sub.toJSON()),
      });
    }
    await sub.unsubscribe();
  }
  localStorage.removeItem(SUB_KEY);
  showToast('この端末の通知を解除しました');
  updateNotifHeaderBtn();
  await refreshNotifModal();
}

// ── 特定端末の購読を削除（管理画面から） ──
async function deleteDeviceSub(endpoint) {
  if (!config.userId) return;
  // もしこの端末のendpointなら、SWの購読も解除
  const thisSub = await getThisDeviceSub();
  if (thisSub && thisSub.endpoint === endpoint) {
    await thisSub.unsubscribe();
    localStorage.removeItem(SUB_KEY);
    updateNotifHeaderBtn();
  }
  await fetch(`${WORKER_URL}/subscribe/${config.userId}`, {
    method: 'DELETE', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ endpoint }),
  });
  showToast('端末を削除しました');
  await refreshNotifModal();
}

// ── ヘッダーの🔔ボタン状態更新（ボタン削除のためno-op） ──
async function updateNotifHeaderBtn() {
  // 設定メニューに統合したため何もしない
}

// ── 通知モーダルを開く ──
window.showNotifModal = async function() {
  document.getElementById('notif-debug-msg').style.display = 'none';
  document.getElementById('notif-overlay').classList.add('open');
  await refreshNotifModal();
};

// ── 通知モーダルの内容を更新 ──
async function refreshNotifModal() {
  const statusText = document.getElementById('notif-status-text');
  const toggleBtn  = document.getElementById('notif-toggle-btn');

  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    statusText.textContent = 'このブラウザでは通知を使えません';
    toggleBtn.textContent  = '使用不可';
    toggleBtn.className    = 'btn-notif disabled';
    const testBtn = document.getElementById('notif-test-btn');
    if (testBtn) { testBtn.disabled = true; testBtn.classList.add('disabled'); }
    return;
  }

  const perm    = Notification.permission;
  const thisSub = await getThisDeviceSub();

  if (perm === 'denied') {
    statusText.textContent   = 'ブロックされています（設定から変更してください）';
    toggleBtn.textContent    = '許可できません';
    toggleBtn.className      = 'btn-notif disabled';
    toggleBtn.dataset.state  = 'denied';
  } else if (thisSub) {
    statusText.textContent   = '通知はオンです';
    toggleBtn.textContent    = 'オフにする';
    toggleBtn.className      = 'btn-notif off';
    toggleBtn.dataset.state  = 'on';
  } else {
    statusText.textContent   = '通知はオフです';
    toggleBtn.textContent    = 'オンにする';
    toggleBtn.className      = 'btn-notif';
    toggleBtn.dataset.state  = 'off';
  }
}

// ── 通知ボタン押下ハンドラ ──
window.handleNotifBtn = async function() {
  const btn = document.getElementById('notif-toggle-btn');
  if (btn.dataset.state === 'on') {
    await unsubscribeThisDevice();
  } else {
    await subscribeNotification();
  }
};

// ── テスト通知 ──
window.sendTestNotif = async function() {
  if (!config.userId) { showToast('ユーザーIDが未設定です'); return; }
  const btn = document.getElementById('notif-test-btn');
  btn.disabled = true; btn.innerHTML = '送信中…';
  try {
    const r = await fetch(`${WORKER_URL}/test-push/${config.userId}`);
    const t = await r.text();
    if (t.includes('OK')) {
      showToast('テスト通知を送信しました 📨');
    } else {
      showToast('送信失敗: ' + t.slice(0, 50));
    }
  } catch(e) {
    showToast('通信エラー');
  }
  btn.disabled = false; btn.innerHTML = '📨 テスト通知を送る';
};

function showDebugMsg(msg) {
  const box = document.getElementById('notif-debug-msg');
  if (box) { box.textContent = msg; box.style.display = 'block'; }
}

// 通知モーダルを閉じる
document.getElementById('notif-close-btn').addEventListener('click', () => {
  document.getElementById('notif-overlay').classList.remove('open');
});
document.getElementById('notif-overlay').addEventListener('click', function(e) {
  if (e.target === this) this.classList.remove('open');
});

// ── RENDER ──
// ── 列幅計算 ──
// 基本：画面幅÷7でピッタリ収める
// 例外：1列80px未満になる場合はスクロール有効化（80px固定）
//        画面に収まる整数列数は4以上を保証
function calcColWidth() {
  const W       = window.innerWidth;
  const COL_MIN = 80;
  const TOTAL   = 7;

  const natural = W / TOTAL; // 7列ぴったりの幅
  if (natural >= COL_MIN) {
    // 7列が画面にピッタリ収まる → 割り切れる幅に
    visibleCols = 7;
    return Math.floor(W / TOTAL);
  }
  // 画面に収まる列数（最低2列）
  visibleCols = Math.max(2, Math.floor(W / COL_MIN));
  return Math.floor(W / visibleCols);
}

function render() {
  const dates    = getVisibleDates(dayOffset, visibleCols);
  const todayStr = getTodayStr();
  const colW     = calcColWidth();

  // CSS変数として列幅を設定
  document.documentElement.style.setProperty('--col-w', colW + 'px');

  // scroll-innerの幅を表示列数分にピッタリ設定（横スクロールなし）
  const scrollInner = document.getElementById('scroll-inner');
  if (scrollInner) scrollInner.style.width = (colW * visibleCols) + 'px';

  // ── Goal row ──
  const goalWrap = document.getElementById('goal-row-wrap');
  if (goalWrap) {
    goalWrap.innerHTML = '';
    const nav = document.createElement('div'); nav.className = 'goal-nav';
    const prevBtn = document.createElement('button');
    prevBtn.className = 'goal-nav-btn'; prevBtn.textContent = '＜'; prevBtn.title = '前の週';
    prevBtn.addEventListener('click', () => { dayOffset -= visibleCols; render(); });
    const goalInput = document.createElement('input');
    goalInput.type = 'text'; goalInput.id = 'goal-input';
    goalInput.placeholder = '📌 長期的な目標を入力…';
    goalInput.value = loadGoal();
    goalInput.addEventListener('input', () => saveGoal(goalInput.value));
    const nextBtn = document.createElement('button');
    nextBtn.className = 'goal-nav-btn'; nextBtn.textContent = '＞'; nextBtn.title = '次の週';
    nextBtn.addEventListener('click', () => { dayOffset += visibleCols; render(); });
    nav.appendChild(prevBtn); nav.appendChild(goalInput); nav.appendChild(nextBtn);
    goalWrap.appendChild(nav);
  }

  // ── Date headers ──
  const dateRowWrap = document.getElementById('date-row-wrap');
  if (dateRowWrap) {
    dateRowWrap.innerHTML = '';
    dates.forEach(d => {
      const ds       = toDateStr(d); const dow = d.getDay(); const hol = isHoliday(ds);
      const isToday  = ds === todayStr;
      let cls = '';
      if (isToday)    cls = 'today-col';
      else if (hol)   cls = 'hol-col';
      else if (dow === 0) cls = 'sun-col';
      else if (dow === 6) cls = 'sat-col';
      const dowLabel = hol ? DAY[dow] + '祝' : DAY[dow];
      const th = document.createElement('div');
      th.className = 'date-col-header ' + cls;
      th.innerHTML = `<span class="day-num">${d.getDate()}</span>${d.getMonth()+1}/${d.getDate()}(${dowLabel})`;
      dateRowWrap.appendChild(th);
    });
  }

  // ── Columns ──
  const wrap = document.getElementById('columns-wrap');
  if (wrap) {
    wrap.innerHTML = '';
    dates.forEach(d => {
      const ds  = toDateStr(d); const dow = d.getDay(); const hol = isHoliday(ds);
      const col = document.createElement('div'); col.className = 'col-body';
      if (ds === todayStr) col.classList.add('today-col');
      sortTasksForDate(tasks.filter(t => t.date === ds))
        .forEach(t => col.appendChild(makeTaskEl(t)));
      const btn = document.createElement('button');
      btn.className = 'new-btn'; btn.textContent = '＋';
      btn.addEventListener('click', () => openModal(null, ds));
      col.appendChild(btn);
      wrap.appendChild(col);
    });
  }

  renderOverdue();
}

// リサイズ時に完全再描画
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 100);
});

function makeTaskEl(task, isOverdue = false) {
  const div = document.createElement('div');
  div.className = 'task-item' + (task.done ? ' done' : '') + (task.isEvent ? ' is-event' : '');
  div.dataset.taskId = task.id;
  const c = getColor(task.subject);
  const effectiveFg = (task.format && task.format.fg) ? task.format.fg : c.fg;
  div.style.background  = (task.format && task.format.bg) ? task.format.bg : c.bg;
  div.style.borderColor = effectiveFg;

  const cb = document.createElement('div'); cb.className = 'task-cb';
  cb.style.borderColor = effectiveFg;
  cb.addEventListener('click', e => {
    e.stopPropagation();
    if (task.isEvent) return; // 予定タスクは完了不可
    task.done = !task.done; schedulePush(); render();
  });

  const lbl = document.createElement('div'); lbl.className = 'task-label';
  const f = task.format || {};
  let td = ''; if (f.underline) td = 'underline'; else if (f['double-underline']) td = 'underline double';

  // 日付ラベル（overdue時のみ）
  if (isOverdue) {
    const dl = document.createElement('div'); dl.className='overdue-date-label';
    dl.textContent = task.date; lbl.appendChild(dl);
  }

  // タイトル行
  const titleEl = document.createElement('div'); titleEl.className = 'task-title-line';
  titleEl.textContent          = task.title;
  titleEl.style.color          = effectiveFg;
  titleEl.style.fontWeight     = f.bold ? '700' : '600';
  titleEl.style.textDecoration = td;
  lbl.appendChild(titleEl);

  // サブ情報行（教科＋リマインド）
  const hasSubject = task.subject && task.subject !== 'なし';
  const hasRemind  = task.remind && task.remind !== '0';
  if (hasSubject || hasRemind) {
    const sub = document.createElement('div'); sub.className = 'task-sub-line';
    if (hasSubject) {
      const tag = document.createElement('span'); tag.className = 'subject-tag';
      tag.textContent = task.subject;
      tag.style.background = 'transparent';
      tag.style.color = effectiveFg; tag.style.border = `1.5px solid ${effectiveFg}`;
      sub.appendChild(tag);
    }
    if (hasRemind) {
      const notifs = getNotifsArray(task);
      const ri = document.createElement('div'); ri.className = 'remind-info';
      if (notifs.length) {
        // 通知ごとに「X日前 HH:MM」を並べる
        ri.textContent = '⏰ ' + notifs.map(n => {
          const dayLabel = n.remind === 'today' ? '当日' : `${n.remind}日前`;
          return `${dayLabel} ${n.time}`;
        }).join(' / ');
      } else {
        const remindLabel = task.remind === 'today' ? '当日' : `${task.remind}日前`;
        ri.textContent = `⏰ ${remindLabel}`;
      }
      sub.appendChild(ri);
    }
    lbl.appendChild(sub);
  }
  div.appendChild(cb); div.appendChild(lbl);
  div.addEventListener('click', ()=>openModal(task.id));

  // ── ドラッグ開始（マウス） ──
  let dragStarted = false;
  let mouseDownX = 0, mouseDownY = 0;
  div.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    mouseDownX = e.clientX; mouseDownY = e.clientY;
    dragStarted = false;
    const onMove = mv => {
      const dx = Math.abs(mv.clientX - mouseDownX);
      const dy = Math.abs(mv.clientY - mouseDownY);
      if (!dragStarted && (dx > 6 || dy > 6)) {
        dragStarted = true;
        initDrag(div, task, mouseDownX, mouseDownY);
        moveDragClone(mv.clientX, mv.clientY);
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',  onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
  div.addEventListener('click', e => {
    if (dragStarted) { e.stopImmediatePropagation(); dragStarted = false; }
  }, true);

  // ── ドラッグ開始（タッチ） ──
  let touchTimer = null;
  div.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    touchTimer = setTimeout(() => {
      // 長押し（400ms）でドラッグ開始
      initDrag(div, task, t.clientX, t.clientY);
      // バイブレーション（対応端末のみ）
      if (navigator.vibrate) navigator.vibrate(40);
    }, 400);
  }, { passive: true });
  div.addEventListener('touchmove', () => {
    if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
  }, { passive: true });
  div.addEventListener('touchend', () => {
    if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
  });

  return div;
}

// ── 複数通知UI（リマインド日＋時刻） ──
const NOTIF_REMIND_OPTIONS = [
  { value: 'none', label: 'なし（通知しない）' },
  { value: 'today', label: '当日' },
  { value: '1',  label: '1日前' },
  { value: '2',  label: '2日前' },
  { value: '3',  label: '3日前' },
  { value: '5',  label: '5日前' },
  { value: '7',  label: '7日前' },
  { value: '10', label: '10日前' },
  { value: '14', label: '2週間前' },
  { value: '30', label: '30日前' },
];

function buildNotifTimesList(selectedNotifs, groupId) {
  const gid   = groupId || 'f-notif-time-group';
  const group = document.getElementById(gid);
  if (!group) return;
  group.innerHTML = '';

  const label = document.createElement('label');
  label.className = 'form-label'; label.textContent = '通知';
  group.appendChild(label);

  const listId = gid + '-list';
  const list   = document.createElement('div');
  list.id = listId; list.className = 'notif-times-list';
  group.appendChild(list);

  // 初期値：{remind, time}オブジェクト配列を期待、文字列の場合は変換
  // 通知なし（空配列）の場合は「なし」1行を表示
  const notifs = (selectedNotifs && selectedNotifs.length)
    ? selectedNotifs.map(n => typeof n === 'string' ? { remind: 'today', time: n } : n)
    : [{ remind: 'none', time: '07:00' }];
  notifs.forEach((n, i) => list.appendChild(makeNotifTimeRow(n, listId, i === 0)));
  updateRemoveButtons(listId);

  const addBtn = document.createElement('button');
  addBtn.type = 'button'; addBtn.className = 'notif-time-add-btn';
  addBtn.textContent = '＋ 通知を追加';
  addBtn.addEventListener('click', () => {
    const rows = document.querySelectorAll(`#${listId} .notif-time-row`);
    document.getElementById(listId).appendChild(makeNotifTimeRow({ remind: 'today', time: '07:00' }, listId, false));
    updateRemoveButtons(listId);
  });
  group.appendChild(addBtn);
}

function makeNotifTimeRow(notif, listId, isFirst) {
  const safeRemind = notif.remind || 'today';
  const safeTime   = (notif.time && notif.time !== 'none') ? notif.time : '07:00';
  const row = document.createElement('div'); row.className = 'notif-time-row';

  // リマインド日セレクト
  const selRemind = document.createElement('select'); selRemind.className = 'form-select notif-remind-sel';
  NOTIF_REMIND_OPTIONS.forEach(opt => {
    // 1行目以外は「なし」を除外
    if (!isFirst && opt.value === 'none') return;
    const o = document.createElement('option'); o.value = opt.value; o.textContent = opt.label;
    if (opt.value === safeRemind) o.selected = true;
    selRemind.appendChild(o);
  });

  // 時刻セレクト
  const wrap = document.createElement('div'); wrap.className = 'time-select-row';
  const selH = document.createElement('select'); selH.className = 'form-select time-select-h';
  for (let h = 0; h < 24; h++) {
    const v = String(h).padStart(2,'0');
    const o = document.createElement('option'); o.value = v; o.textContent = `${h}時`;
    if (safeTime.slice(0,2) === v) o.selected = true;
    selH.appendChild(o);
  }
  const sep = document.createElement('span'); sep.className = 'time-select-sep'; sep.textContent = ':';
  const selM = document.createElement('select'); selM.className = 'form-select time-select-m';
  for (let m = 0; m < 60; m += 5) {
    const v = String(m).padStart(2,'0');
    const o = document.createElement('option'); o.value = v; o.textContent = `${v}分`;
    if (safeTime.slice(3,5) === v) o.selected = true;
    selM.appendChild(o);
  }
  wrap.appendChild(selH); wrap.appendChild(sep); wrap.appendChild(selM);

  // なし選択時は時刻を薄く
  const updateTimeDisabled = () => {
    const isNone = selRemind.value === 'none';
    selH.disabled = isNone; selM.disabled = isNone;
    wrap.style.opacity = isNone ? '0.35' : '1';
  };
  selRemind.addEventListener('change', updateTimeDisabled);
  updateTimeDisabled();

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button'; removeBtn.className = 'notif-time-remove-btn';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', () => {
    row.remove();
    if (listId) updateRemoveButtons(listId);
  });

  row.appendChild(selRemind); row.appendChild(wrap); row.appendChild(removeBtn);
  return row;
}

function updateRemoveButtons(listId) {
  const list = document.getElementById(listId);
  if (!list) return;
  const rows = list.querySelectorAll('.notif-time-row');
  rows.forEach((row, i) => {
    const btn = row.querySelector('.notif-time-remove-btn');
    if (btn) btn.style.visibility = (i === 0 || rows.length <= 1) ? 'hidden' : 'visible';
  });
}

// {remind, time}[] を返す
function getNotifTimesFromGroup(gid) {
  const listId = (gid || 'f-notif-time-group') + '-list';
  const rows   = document.querySelectorAll(`#${listId} .notif-time-row`);
  return Array.from(rows)
    .map(row => ({
      remind: row.querySelector('.notif-remind-sel').value,
      time:   row.querySelector('.time-select-h').value + ':' + row.querySelector('.time-select-m').value,
    }))
    .filter(n => n.remind !== 'none'); // なし選択は除外
}

// お気に入り用：noneも保持して保存
function getFavNotifTimesFromGroup(gid) {
  const listId = (gid || 'fav-f-notif-time-group') + '-list';
  const rows   = document.querySelectorAll(`#${listId} .notif-time-row`);
  return Array.from(rows).map(row => ({
    remind: row.querySelector('.notif-remind-sel').value,
    time:   row.querySelector('.time-select-h').value + ':' + row.querySelector('.time-select-m').value,
  }));
}


function updateNotifTimeVisibility(gid) {
  const remindSel = document.getElementById(gid === 'fav-f-notif-time-group' ? 'fav-f-remind' : 'f-remind');
  const groupId   = gid || 'f-notif-time-group';
  const group     = document.getElementById(groupId);
  if (!group) return;
  if (remindSel && remindSel.value === '0') {
    group.style.display = 'none';
  } else {
    group.style.display = '';
    if (!group.querySelector('.notif-times-list')) buildNotifTimesList(['07:00'], groupId);
  }
}
function renderOverdue() {
  const todayStr = getTodayStr();
  const od = tasks.filter(t => !t.done && !t.isEvent && t.date < todayStr);
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
  od.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const ta = getFirstNotifTime(a), tb = getFirstNotifTime(b);
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
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
  const row = document.getElementById(rowId); if (!row) return; row.innerHTML = '';
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
  buildColorPicker('color-fg-row', FG_PALETTE, fmt.fg, color => { fmt.fg = color; syncCustomColor('fg'); updateFmtUI(); });
  buildColorPicker('color-bg-row', BG_PALETTE, fmt.bg, color => { fmt.bg = color; syncCustomColor('bg'); updateFmtUI(); });

  // カスタムカラー入力欄の値を同期
  syncCustomColor('fg');
  syncCustomColor('bg');

  // カスタムカラー入力のイベント（重複登録防止のため一度だけ）
  const fgIn = document.getElementById('color-fg-custom');
  const bgIn = document.getElementById('color-bg-custom');
  if (fgIn && !fgIn._bound) {
    fgIn._bound = true;
    fgIn.addEventListener('input', () => { fmt.fg = fgIn.value; buildColorPicker('color-fg-row', FG_PALETTE, null, color => { fmt.fg = color; syncCustomColor('fg'); updateFmtUI(); }); updatePreview(); });
  }
  if (bgIn && !bgIn._bound) {
    bgIn._bound = true;
    bgIn.addEventListener('input', () => { fmt.bg = bgIn.value; buildColorPicker('color-bg-row', BG_PALETTE, null, color => { fmt.bg = color; syncCustomColor('bg'); updateFmtUI(); }); updatePreview(); });
  }

  updatePreview();
}

function syncCustomColor(type) {
  const val = type === 'fg' ? fmt.fg : fmt.bg;
  const el  = document.getElementById(`color-${type}-custom`);
  if (!el) return;
  // パレット外のカラーならカスタム入力に反映
  const palette = type === 'fg' ? FG_PALETTE : BG_PALETTE;
  if (val && !palette.includes(val)) {
    el.value = val;
  } else if (val) {
    el.value = val;
  }
}

function initFmtFromSubject(subject) {
  const c = getColor(subject);
  fmt.fg = c.fg === DEFAULT_COLOR.fg ? null : c.fg;
  fmt.bg = c.bg === DEFAULT_COLOR.bg ? null : c.bg;
  updateFmtUI();
}
function initFmtFromTask(task) {
  const f = task.format || {};
  fmt.bold = !!f.bold; fmt.underline = !!f.underline; fmt['double-underline'] = !!f['double-underline'];
  fmt.fg = f.fg ?? null; fmt.bg = f.bg ?? null;
  updateFmtUI();
}
function updatePreview() {
  const titleVal = document.getElementById('f-title')?.value || 'テキスト';
  const prev = document.getElementById('format-preview'); if (!prev) return;
  let td = '';
  if (fmt.underline) td = 'underline'; if (fmt['double-underline']) td = 'underline double';
  prev.style.fontWeight = fmt.bold ? '700' : '400';
  prev.style.textDecoration = td;
  prev.style.color = fmt.fg || ''; prev.style.backgroundColor = fmt.bg || '';
  prev.textContent = titleVal;
}

window.handleSubjectChange = function(val) {
  document.getElementById('custom-subject-group').style.display = (val === 'カスタム') ? 'block' : 'none';
  const subjName = val === 'カスタム' ? (document.getElementById('f-custom-subject').value.trim() || 'カスタム') : val;
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
  // カスタムカラー入力のイベント再バインドを許可
  const fgIn = document.getElementById('color-fg-custom');
  const bgIn = document.getElementById('color-bg-custom');
  if (fgIn) fgIn._bound = false;
  if (bgIn) bgIn._bound = false;

  if (isEdit) {
    const t = tasks.find(t => t.id === id);
    document.getElementById('f-title').value    = t.title  || '';
    document.getElementById('f-date').value     = t.date   || '';
    document.getElementById('f-remind').value   = t.remind || '0';
    document.getElementById('f-is-event').checked = !!t.isEvent;
    const existingNotifs = Array.isArray(t.notifications) && t.notifications.length
      ? t.notifications
      : getNotifsArray(t); // 後方互換変換
    buildNotifTimesList(existingNotifs, 'f-notif-time-group');
    const presets = ['なし','国語','数学','英語','化学','物理','生物','地理','日本史','世界史','情報'];
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
      <button class="btn-primary" id="modal-save">保存する</button>
      <button class="btn-danger" id="modal-delete">削除</button>
      <button class="btn-secondary" id="modal-cancel">キャンセル</button>`;
    document.getElementById('modal-delete').addEventListener('click', deleteTask);
  } else {
    document.getElementById('f-title').value   = '';
    document.getElementById('f-remind').value  = '2';
    document.getElementById('f-subject').value = 'なし';
    document.getElementById('f-custom-subject').value = '';
    document.getElementById('f-is-event').checked = false;
    buildNotifTimesList(['07:00'], 'f-notif-time-group');
    initFmtFromSubject('なし');
    document.getElementById('modal-actions').innerHTML = `
      <button class="btn-primary" id="modal-save">保存する</button>
      <button class="btn-secondary" id="modal-cancel">キャンセル</button>`;
  }
  populateFavDropdown();
  document.getElementById('modal-save').addEventListener('click', saveTask);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('f-title').addEventListener('input', updatePreview);
  document.getElementById('f-remind').addEventListener('change', () => {});
  // 通知UIは常に表示（リマインドプルダウンは非表示のため）
  if (!document.getElementById('f-notif-time-group').querySelector('.notif-times-list')) {
    buildNotifTimesList([], 'f-notif-time-group');
  }
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
  const title = document.getElementById('f-title').value.trim();
  if (!title) { showToast('タイトルを入力してください'); return; }
  const finalDate = editingId ? document.getElementById('f-date').value : currentDateStr;
  if (!finalDate) { showToast('日付が設定されていません'); return; }
  const isEvent       = document.getElementById('f-is-event').checked;
  const notifications = getNotifTimesFromGroup('f-notif-time-group');
  // f-remindは非表示だが後方互換のため通知から自動算出
  const remind = notifications.length
    ? (notifications.some(n => n.remind === 'today') ? 'today'
      : String(Math.max(...notifications.map(n => parseInt(n.remind) || 0))))
    : '0';
  const subject = getSubjectValue();
  const format        = { bold:fmt.bold, underline:fmt.underline, 'double-underline':fmt['double-underline'], fg:fmt.fg, bg:fmt.bg };
  if (editingId) {
    const i = tasks.findIndex(t => t.id === editingId);
    if (i >= 0) {
      const prev    = tasks[i];
      const updated = { ...prev, title, date:finalDate, remind, isEvent, notifications, subject, format };
      if (!isEvent) { if (updated.done === undefined) updated.done = false; }
      else          { delete updated.done; }
      if (prev.date !== finalDate || prev.remind !== remind) delete updated.colOrder;
      delete updated.notifTime; delete updated.notifTimes;
      tasks[i] = updated;
    }
    showToast('更新しました ✓');
  } else {
    const newTask = { id:genId(), title, date:finalDate, remind, isEvent, notifications, subject, format };
    if (!isEvent) newTask.done = false;
    tasks.push(newTask);
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
// 画面外タップで閉じる
document.getElementById('setup-overlay').addEventListener('click', function(e) {
  if (e.target === this) this.classList.remove('open');
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
  await unsubscribeThisDevice();
  config = {}; tasks = [];
  localStorage.removeItem(CFG_KEY); localStorage.removeItem(TASKS_KEY);
  document.getElementById('setup-overlay').classList.remove('open');
  setSyncUI('','未設定'); render(); showToast('ログアウトしました');
  setTimeout(showSetup, 400);
});

// ── ⚙️ 設定メニュー ──
(function initSettingsMenu() {
  const btn  = document.getElementById('settings-btn');
  const menu = document.getElementById('settings-menu');
  if (!btn || !menu) return;

  btn.addEventListener('click', e => {
    e.stopPropagation();
    menu.classList.toggle('open');
  });

  // メニュー外クリックで閉じる
  document.addEventListener('click', () => menu.classList.remove('open'));
  menu.addEventListener('click', e => e.stopPropagation());

  // お気に入り設定
  document.getElementById('settings-fav').addEventListener('click', () => {
    menu.classList.remove('open');
    openFavModal();
  });

  // 通知設定
  document.getElementById('settings-notif').addEventListener('click', () => {
    menu.classList.remove('open');
    showNotifModal();
  });

  // キャッシュをクリアして再読み込み
  document.getElementById('settings-cache').addEventListener('click', async () => {
    menu.classList.remove('open');
    if (!confirm('キャッシュをクリアして再読み込みしますか？\n最新の更新が反映されます。')) return;
    await safeCacheClean();
  });
})();

// ── お気に入り ──
let favorites = [];
try { favorites = JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch(e) {}
let favFmt = { bold:false, underline:false, 'double-underline':false, fg:null, bg:null };
let editingFavId = null;

function saveFavorites() {
  localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
  scheduleFavPush();
}

function populateFavDropdown() {
  const sel = document.getElementById('f-fav-apply');
  if (!sel) return;
  sel.innerHTML = '<option value="">⭐ お気に入り</option>';
  favorites.forEach(fav => {
    const opt = document.createElement('option');
    opt.value = fav.id;
    const subPart = (fav.subject && fav.subject !== 'なし') ? fav.subject + '　' : '';
    opt.textContent = subPart + (fav.title || '（タイトルなし）');
    sel.appendChild(opt);
  });
  if (!sel._favBound) {
    sel._favBound = true;
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      const fav = favorites.find(f => f.id === sel.value);
      if (!fav) return;
      applyFavToModal(fav);
      sel.value = '';
    });
  }
}

function applyFavToModal(fav) {
  if (fav.title) document.getElementById('f-title').value = fav.title;
  // 予定フラグ
  document.getElementById('f-is-event').checked = !!fav.isEvent;
  // 教科
  const presets = ['なし','国語','数学','英語','化学','物理','生物','地理','日本史','世界史','情報'];
  if (fav.subject && presets.includes(fav.subject)) {
    document.getElementById('f-subject').value = fav.subject;
    document.getElementById('custom-subject-group').style.display = 'none';
  } else if (fav.subject && fav.subject !== 'なし') {
    document.getElementById('f-subject').value = 'カスタム';
    document.getElementById('f-custom-subject').value = fav.subject;
    document.getElementById('custom-subject-group').style.display = 'block';
  }
  // 通知（{remind,time}配列）- noneも含めてそのまま渡す
  const favNotifs = Array.isArray(fav.notifications) && fav.notifications.length
    ? fav.notifications
    : (getNotifsArray(fav).length ? getNotifsArray(fav) : [{ remind: 'none', time: '07:00' }]);
  buildNotifTimesList(favNotifs, 'f-notif-time-group');
  // 書式
  if (fav.format) {
    fmt.bold = !!fav.format.bold;
    fmt.underline = !!fav.format.underline;
    fmt['double-underline'] = !!fav.format['double-underline'];
    fmt.fg = fav.format.fg ?? null;
    fmt.bg = fav.format.bg ?? null;
    updateFmtUI();
  }
  updatePreview();
  showToast('お気に入りを適用しました ✓');
}

function openFavModal(favId) {
  editingFavId = favId || null;
  const listSec = document.getElementById('fav-list-section');
  const editSec = document.getElementById('fav-edit-section');

  if (!favId) {
    // リスト表示
    listSec.style.display = ''; editSec.style.display = 'none';
    renderFavList();
  } else {
    // 編集フォーム表示
    listSec.style.display = 'none'; editSec.style.display = '';
    const fav = favorites.find(f => f.id === favId) || {};
    document.getElementById('fav-f-title').value   = fav.title || '';
    document.getElementById('fav-f-remind').value  = fav.remind || '0';
    document.getElementById('fav-f-is-event').checked = !!fav.isEvent;
    const presets = ['なし','国語','数学','英語','化学','物理','生物','地理','日本史','世界史','情報'];
    if (fav.subject && presets.includes(fav.subject)) {
      document.getElementById('fav-f-subject').value = fav.subject;
      document.getElementById('fav-custom-subject-group').style.display = 'none';
    } else if (fav.subject && fav.subject !== 'なし') {
      document.getElementById('fav-f-subject').value = 'カスタム';
      document.getElementById('fav-f-custom-subject').value = fav.subject;
      document.getElementById('fav-custom-subject-group').style.display = 'block';
    } else {
      document.getElementById('fav-f-subject').value = 'なし';
    }
    const favNotifs = Array.isArray(fav.notifications) && fav.notifications.length
      ? fav.notifications : getNotifsArray(fav);
    const initNotifs = favNotifs.length ? favNotifs : [{ remind: 'none', time: '07:00' }];
    buildNotifTimesList(initNotifs, 'fav-f-notif-time-group');
    favFmt = { bold:!!(fav.format&&fav.format.bold), underline:!!(fav.format&&fav.format.underline),
      'double-underline':!!(fav.format&&fav.format['double-underline']),
      fg:(fav.format&&fav.format.fg)||null, bg:(fav.format&&fav.format.bg)||null };
    updateFavFmtUI();
    // アクション
    document.getElementById('fav-modal-title-text').textContent = favId === '__new__' ? '⭐ お気に入りを追加' : '⭐ お気に入りを編集';
    const actions = document.getElementById('fav-modal-actions');
    actions.innerHTML = `
      <button class="btn-primary" id="fav-save-btn">保存する</button>
      ${favId !== '__new__' ? '<button class="btn-danger" id="fav-delete-btn">削除</button>' : ''}
      <button class="btn-secondary" id="fav-back-btn">戻る</button>`;
    document.getElementById('fav-save-btn').addEventListener('click', saveFav);
    document.getElementById('fav-back-btn').addEventListener('click', () => openFavModal());
    if (document.getElementById('fav-delete-btn')) {
      document.getElementById('fav-delete-btn').addEventListener('click', () => {
        if (!confirm('このお気に入りを削除しますか？')) return;
        favorites = favorites.filter(f => f.id !== editingFavId);
        saveFavorites(); openFavModal(); showToast('削除しました');
      });
    }
    // fav-f-remind は非表示のためリスナー不要
    document.getElementById('fav-f-title').addEventListener('input', updateFavPreview);
  }
  document.getElementById('fav-modal-overlay').classList.add('open');
}

function renderFavList() {
  const list = document.getElementById('fav-list');
  list.innerHTML = '';
  if (!favorites.length) {
    list.innerHTML = '<div class="fav-empty">お気に入りはまだありません</div>';
    return;
  }
  favorites.forEach(fav => {
    const item = document.createElement('div'); item.className = 'fav-item';
    const subPart = (fav.subject && fav.subject !== 'なし') ? `<span style="opacity:.7">${esc(fav.subject)}　</span>` : '';
    const remind  = FAV_REMIND_LABELS[fav.remind] || 'なし';
    item.innerHTML = `
      <div class="fav-item-label">
        <div class="fav-item-name">${subPart}${esc(fav.title||'（タイトルなし）')}</div>
        <div class="fav-item-sub">リマインド：${remind}</div>
      </div>
      <button class="fav-item-edit">編集</button>
      <button class="fav-item-delete">削除</button>`;
    item.querySelector('.fav-item-edit').addEventListener('click', () => openFavModal(fav.id));
    item.querySelector('.fav-item-delete').addEventListener('click', () => {
      if (!confirm('削除しますか？')) return;
      favorites = favorites.filter(f => f.id !== fav.id);
      saveFavorites(); renderFavList(); showToast('削除しました');
      populateFavDropdown();
    });
    list.appendChild(item);
  });
}

function saveFav() {
  const title   = document.getElementById('fav-f-title').value.trim();
  const isEvent = document.getElementById('fav-f-is-event').checked;
  const subjEl  = document.getElementById('fav-f-subject').value;
  const subject = subjEl === 'カスタム'
    ? (document.getElementById('fav-f-custom-subject').value.trim() || 'カスタム')
    : subjEl;
  const notifications = getFavNotifTimesFromGroup('fav-f-notif-time-group'); // noneも保持
  // 実際の有効通知数（none以外）
  const effectiveNotifs = notifications.filter(n => n.remind !== 'none');
  // fav-f-remindは非表示のため通知から自動算出（noneを除く）
  const remind = effectiveNotifs.length
    ? (effectiveNotifs.some(n => n.remind === 'today') ? 'today'
      : String(Math.max(...effectiveNotifs.map(n => parseInt(n.remind) || 0))))
    : '0';
  const format = { bold:favFmt.bold, underline:favFmt.underline, 'double-underline':favFmt['double-underline'], fg:favFmt.fg, bg:favFmt.bg };

  // 1項目でも内容があれば保存可
  if (!title && subject === 'なし' && !effectiveNotifs.length) {
    showToast('内容を1つ以上入力してください'); return;
  }

  if (editingFavId && editingFavId !== '__new__') {
    const i = favorites.findIndex(f => f.id === editingFavId);
    if (i >= 0) favorites[i] = { ...favorites[i], title, remind, isEvent, subject, notifications, format };
  } else {
    favorites.push({ id: genId(), title, remind, isEvent, subject, notifications, format });
  }
  saveFavorites();
  populateFavDropdown();
  openFavModal();
  showToast('お気に入りを保存しました ✓');
}

document.getElementById('fav-new-btn').addEventListener('click', () => openFavModal('__new__'));
document.getElementById('fav-modal-close').addEventListener('click', () => {
  document.getElementById('fav-modal-overlay').classList.remove('open');
});
document.getElementById('fav-modal-overlay').addEventListener('click', function(e) {
  if (e.target === this) this.classList.remove('open');
});

// お気に入りモーダルの書式UI
window.toggleFavFmt = function(key) {
  if (key === 'underline' && !favFmt[key]) favFmt['double-underline'] = false;
  if (key === 'double-underline' && !favFmt[key]) favFmt['underline'] = false;
  favFmt[key] = !favFmt[key]; updateFavFmtUI();
};
window.handleFavSubjectChange = function(val) {
  document.getElementById('fav-custom-subject-group').style.display = (val === 'カスタム') ? 'block' : 'none';
  const subjName = val === 'カスタム' ? (document.getElementById('fav-f-custom-subject').value.trim() || 'カスタム') : val;
  const c = getColor(subjName);
  favFmt.fg = c.fg === DEFAULT_COLOR.fg ? null : c.fg;
  favFmt.bg = c.bg === DEFAULT_COLOR.bg ? null : c.bg;
  updateFavFmtUI();
};
function updateFavFmtUI() {
  ['bold','underline','double-underline'].forEach(k => {
    const btn = document.getElementById('fav-fmt-' + k);
    if (btn) btn.classList.toggle('active', !!favFmt[k]);
  });
  buildColorPicker('fav-color-fg-row', FG_PALETTE, favFmt.fg, color => { favFmt.fg = color; updateFavFmtUI(); });
  buildColorPicker('fav-color-bg-row', BG_PALETTE, favFmt.bg, color => { favFmt.bg = color; updateFavFmtUI(); });
  const fgIn = document.getElementById('fav-color-fg-custom');
  const bgIn = document.getElementById('fav-color-bg-custom');
  if (fgIn && !fgIn._bound) { fgIn._bound = true; fgIn.addEventListener('input', () => { favFmt.fg = fgIn.value; updateFavFmtUI(); }); }
  if (bgIn && !bgIn._bound) { bgIn._bound = true; bgIn.addEventListener('input', () => { favFmt.bg = bgIn.value; updateFavFmtUI(); }); }
  updateFavPreview();
}
function updateFavPreview() {
  const titleVal = document.getElementById('fav-f-title')?.value || 'テキスト';
  const prev = document.getElementById('fav-format-preview'); if (!prev) return;
  let td = ''; if (favFmt.underline) td='underline'; if (favFmt['double-underline']) td='underline double';
  prev.style.fontWeight = favFmt.bold ? '700' : '400';
  prev.style.textDecoration = td;
  prev.style.color = favFmt.fg || '';
  prev.style.backgroundColor = favFmt.bg || '';
  prev.textContent = titleVal;
}

// ── バージョンチェック・アップデート ──
let versionLog = []; // version.jsonの全エントリ

async function checkVersion() {
  try {
    const r = await fetch(VERSION_URL + '?t=' + Date.now());
    if (!r.ok) return;
    versionLog = await r.json();
    if (!Array.isArray(versionLog) || !versionLog.length) return;

    const latestVersion = versionLog[0].version;
    const savedVersion  = localStorage.getItem(VERSION_KEY);

    if (savedVersion !== latestVersion) {
      // 未アップデートバージョンを絞り込む
      const pendingVersions = savedVersion
        ? versionLog.filter(e => e.version > savedVersion)
        : versionLog;
      showUpdateBanner(pendingVersions.length ? pendingVersions : versionLog);
    }
  } catch(e) {
    console.warn('version check failed:', e);
  }
}

function showUpdateBanner(pendingEntries) {
  const banner = document.getElementById('update-banner');
  if (banner) banner.style.display = '';
  // バナークリックでモーダル
  document.getElementById('update-banner-text').onclick = () => showUpdateModal(pendingEntries);
}

function showUpdateModal(entries) {
  const log = document.getElementById('update-log');
  log.innerHTML = '';
  (entries || versionLog).forEach(entry => {
    const div = document.createElement('div'); div.className = 'update-entry';
    const changesList = (entry.changes || []).map(c => `<li>${esc(c)}</li>`).join('');
    div.innerHTML = `
      <div class="update-entry-version">${esc(entry.version)}</div>
      <div class="update-entry-date">${esc(entry.date)}</div>
      <ul class="update-entry-changes">${changesList}</ul>`;
    log.appendChild(div);
  });
  document.getElementById('update-modal-overlay').classList.add('open');
}

document.getElementById('update-modal-close').addEventListener('click', () => {
  document.getElementById('update-modal-overlay').classList.remove('open');
});
document.getElementById('update-modal-overlay').addEventListener('click', function(e) {
  if (e.target === this) this.classList.remove('open');
});
document.getElementById('update-do-btn').addEventListener('click', () => {
  document.getElementById('update-modal-overlay').classList.remove('open');
  safeCacheClean();
});

// ── 安全なキャッシュクリア（同期確認付き） ──
async function safeCacheClean() {
  // オフラインチェック
  if (!navigator.onLine) {
    alert('インターネットに接続してから再度お試しください');
    return;
  }
  // 未ログインチェック
  if (!config.userId) {
    const ok = confirm('ログインされていないので、このまま進むと保存されたデータが全て失われますがよろしいですか？');
    if (!ok) return;
  } else {
    // 同期を試みる
    showToast('同期中…');
    try {
      await pushToCloud();
      await pushFavoritesToCloud();
    } catch(e) {
      alert('インターネットに接続してから再度お試しください');
      return;
    }
  }
  showToast('キャッシュをクリア中…');
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    // 最新バージョンを記録してからリロード
    if (versionLog.length) localStorage.setItem(VERSION_KEY, versionLog[0].version);
  } catch(e) {
    console.warn('Cache clear error:', e);
  }
  window.location.reload();
}

// ── EVENTS ──
document.getElementById('modal-overlay').addEventListener('click', function(e) {
  if (e.target !== this) return;
  const title = document.getElementById('f-title').value.trim();
  if (!title) { closeModal(); return; }
  saveTask();
});
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('sync-status').addEventListener('click', showSetup);
document.getElementById('logo-btn').addEventListener('click', showSetup);

// setup-overlay: ログイン済みの場合のみ外クリックで閉じる
document.getElementById('setup-overlay').addEventListener('click', function(e) {
  if (e.target === this && config.userId) {
    this.classList.remove('open');
  }
});

// ── TOAST ──
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// ── INIT ──
registerServiceWorker();
getVapidPublicKey();
render();
updateNotifHeaderBtn();
if (!config.userId) { showSetup(); } else { pullFromCloud(); }
checkVersion();
setInterval(() => { const n=new Date(); if(n.getHours()===0&&n.getMinutes()===0) render(); }, 60000);

// オンライン復帰時に未同期データを自動送信
window.addEventListener('online', async () => {
  setSyncUI('syncing', '再接続中…');
  if (config.userId && localStorage.getItem(PENDING_KEY)) {
    showToast('オンラインに復帰しました。同期中…');
    await pushToCloud();
    showToast('同期完了 ✓');
  } else {
    setSyncUI('ok', '同期済み ✓');
  }
});

window.addEventListener('offline', () => {
  setSyncUI('err', 'オフライン');
});

// ── ピンチズームをブロック（タッチ・トラックパッド両方） ──
document.addEventListener('touchstart', e => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });
document.addEventListener('touchmove', e => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

// トラックパッドのピンチ（ctrlキー付きwheelイベント）をブロック
document.addEventListener('wheel', e => {
  if (e.ctrlKey) e.preventDefault();
}, { passive: false });

// ── ドラッグ＆ドロップで日付変更 ──
let dragTask  = null; // ドラッグ中のタスクオブジェクト
let dragEl    = null; // ドラッグ中のDOM要素
let dragClone = null; // ドラッグ中のゴースト要素
let dragOffX  = 0;
let dragOffY  = 0;

function initDrag(taskEl, task, startX, startY) {
  dragTask = task;
  dragEl   = taskEl;
  document.body.classList.add('dragging-active');

  // ゴースト要素を作成
  dragClone = taskEl.cloneNode(true);
  dragClone.style.cssText = `
    position: fixed; z-index: 1000; pointer-events: none;
    opacity: 0.85; transform: scale(1.04) rotate(1deg);
    box-shadow: 0 8px 32px rgba(0,0,0,0.22);
    width: ${taskEl.offsetWidth}px;
    transition: none;
  `;
  document.body.appendChild(dragClone);

  // オフセット計算
  const rect = taskEl.getBoundingClientRect();
  dragOffX = startX - rect.left;
  dragOffY = startY - rect.top;
  moveDragClone(startX, startY);

  // 元要素を薄く
  taskEl.style.opacity = '0.35';
}

function moveDragClone(x, y) {
  if (!dragClone) return;
  dragClone.style.left = (x - dragOffX) + 'px';
  dragClone.style.top  = (y - dragOffY) + 'px';

  // ホバー中の列をハイライト
  document.querySelectorAll('.col-body').forEach(c => c.classList.remove('drag-over'));
  const col = getColBodyAt(x, y);
  if (col) col.classList.add('drag-over');
}

function getColBodyAt(x, y) {
  // 座標にある .col-body を取得
  const els = document.elementsFromPoint(x, y);
  return els.find(el => el.classList.contains('col-body'));
}

function getDateFromColBody(col) {
  const wrap = document.getElementById('columns-wrap');
  const cols = Array.from(wrap.children);
  const idx  = cols.indexOf(col);
  if (idx < 0) return null;
  const dates = getVisibleDates(dayOffset, visibleCols);
  return dates[idx] ? toDateStr(dates[idx]) : null;
}

function endDrag(x, y) {
  if (!dragTask || !dragEl) return;

  const col     = getColBodyAt(x, y);
  const newDate = col ? getDateFromColBody(col) : null;

  if (newDate && newDate !== dragTask.date) {
    // 別列へ移動（日付変更）
    const i = tasks.findIndex(t => t.id === dragTask.id);
    if (i >= 0) {
      tasks[i].date = newDate;
      delete tasks[i].colOrder;
      schedulePush();
      showToast(`${newDate} に移動しました`);
    }
  } else if (newDate && newDate === dragTask.date && col) {
    // 同列内で縦並び替え
    const taskEls  = Array.from(col.querySelectorAll('.task-item'));
    const otherEls = taskEls.filter(el => el !== dragEl);
    let insertIdx  = otherEls.length;
    for (let i = 0; i < otherEls.length; i++) {
      const rect = otherEls[i].getBoundingClientRect();
      if (y < rect.top + rect.height / 2) { insertIdx = i; break; }
    }
    const newOrder = otherEls.map(el => el.dataset.taskId);
    newOrder.splice(insertIdx, 0, dragTask.id);
    newOrder.forEach((id, idx) => {
      const t = tasks.find(obj => obj.id === id);
      if (t) t.colOrder = idx;
    });
    schedulePush();
  }

  document.querySelectorAll('.col-body').forEach(c => c.classList.remove('drag-over'));
  document.body.classList.remove('dragging-active');
  if (dragClone) { dragClone.remove(); dragClone = null; }
  if (dragEl)    { dragEl.style.opacity = ''; dragEl = null; }
  dragTask = null;
  render();
}

function cancelDrag() {
  document.querySelectorAll('.col-body').forEach(c => c.classList.remove('drag-over'));
  document.body.classList.remove('dragging-active');
  if (dragClone) { dragClone.remove(); dragClone = null; }
  if (dragEl)    { dragEl.style.opacity = ''; dragEl = null; }
  dragTask = null;
}

// マウスイベント（PC）
document.addEventListener('mousemove', e => {
  if (dragTask) moveDragClone(e.clientX, e.clientY);
});
document.addEventListener('mouseup', e => {
  if (dragTask) endDrag(e.clientX, e.clientY);
});

// タッチイベント（スマホ・タブレット）
document.addEventListener('touchmove', e => {
  if (!dragTask) return;
  if (e.touches.length === 1) {
    e.preventDefault();
    moveDragClone(e.touches[0].clientX, e.touches[0].clientY);
  }
}, { passive: false });
document.addEventListener('touchend', e => {
  if (!dragTask) return;
  const t = e.changedTouches[0];
  endDrag(t.clientX, t.clientY);
});
document.addEventListener('touchcancel', cancelDrag);
