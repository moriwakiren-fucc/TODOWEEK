// sw.js - TodoWeek Service Worker

const CACHE_NAME = 'todoweek10.4';
const CACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './apple-touch-icon.png',
  'https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Noto+Sans+JP:wght@400;500;700;900&display=swap',
];

// ── インストール：静的ファイルをキャッシュ ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_URLS))
  );
  self.skipWaiting();
});

// ── アクティベート：古いキャッシュを削除 ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

// ── フェッチ：キャッシュファースト戦略 ──
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Cloudflare Worker へのAPIリクエストはネットワーク優先
  if (url.hostname.includes('workers.dev')) {
    e.respondWith(
      fetch(e.request).catch(() => {
        // オフライン時はAPIリクエストを失敗させる（script.js側でハンドリング）
        return new Response(JSON.stringify({ offline: true }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      })
    );
    return;
  }

  // 静的ファイルはキャッシュファースト
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        // 成功したレスポンスをキャッシュに追加
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => {
        // オフラインでキャッシュもない場合はindex.htmlを返す
        return caches.match('./index.html');
      });
    })
  );
});

// ── App Badge（バックグラウンド更新用） ──
// バッジ＝期日を過ぎた未完了タスク数。画面側 (script.js) が IndexedDB に保存した値を読む。
// ※ activate で CACHE_NAME 以外のキャッシュを消すため、保存先は Cache API ではなく IndexedDB
const BADGE_DB_NAME   = 'todoweek-badge';
const BADGE_STORE     = 'state';
const BADGE_KEY       = 'overdueCount';
const BADGE_DATES_KEY = 'pendingDates';

function badgeDbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BADGE_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(BADGE_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function readBadgeState(key) {
  try {
    const db = await badgeDbOpen();
    return await new Promise(resolve => {
      const req = db.transaction(BADGE_STORE, 'readonly').objectStore(BADGE_STORE).get(key);
      req.onsuccess = () => { db.close(); resolve(req.result); };
      req.onerror   = () => { db.close(); resolve(undefined); };
    });
  } catch (err) { return undefined; }
}

async function writeBadgeCount(count) {
  try {
    const db = await badgeDbOpen();
    await new Promise(resolve => {
      const tx = db.transaction(BADGE_STORE, 'readwrite');
      tx.objectStore(BADGE_STORE).put(count, BADGE_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = tx.onabort = () => { db.close(); resolve(); };
    });
  } catch (err) {}
}

function todayStrLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// push 受信時のバッジ更新。決して reject しない（通知表示を妨げないため）
//  優先順位: ① pushペイロードの badge（サーバーが期限切れ未完了数を載せた場合）
//            ② 保存済みの未完了タスク日付から「今日」基準で再計算（日付をまたいでも正確）
//            ③ 画面側が最後に保存した数
//  どれも無ければバッジには触れない
async function updateBadgeOnPush(payload) {
  try {
    if (!self.navigator || !('setAppBadge' in self.navigator)) return;

    let count;
    const raw = payload && payload.badge;
    const n = Number(raw);
    if (raw !== undefined && raw !== null && raw !== '' && Number.isInteger(n) && n >= 0) {
      count = n;
      await writeBadgeCount(count);
    } else {
      const dates = await readBadgeState(BADGE_DATES_KEY);
      if (Array.isArray(dates)) {
        const today = todayStrLocal();
        count = dates.filter(d => typeof d === 'string' && d < today).length;
        await writeBadgeCount(count);
      } else {
        count = await readBadgeState(BADGE_KEY);
      }
    }
    if (!Number.isInteger(count) || count < 0) return;

    if (count > 0) await self.navigator.setAppBadge(count);
    else           await self.navigator.clearAppBadge();
  } catch (err) {
    // 非対応・権限なし等は握りつぶす
  }
}

// ── プッシュ通知を受信 ──
self.addEventListener('push', e => {
  let data = { title: '【リマインド】', body: 'TODOが近づいています' };
  try { data = e.data.json(); } catch(err) {}

  e.waitUntil(Promise.all([
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    'apple-touch-icon.png',
      badge:   'apple-touch-icon.png',
      tag:     data.tag || 'todoweek-remind',
      data:    { url: self.registration.scope },
    }),
    updateBadgeOnPush(data), // アイコンバッジも更新
  ]));
});

// ── 通知タップで画面を開く ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.startsWith(url) && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// ── オンライン復帰を検知してクライアントに通知 ──
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
