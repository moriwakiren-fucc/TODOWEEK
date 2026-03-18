// sw.js - TodoWeek Service Worker

const CACHE_NAME = 'todoweek-v2';
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

// ── プッシュ通知を受信 ──
self.addEventListener('push', e => {
  let data = { title: '【リマインド】', body: 'TODOが近づいています' };
  try { data = e.data.json(); } catch(err) {}

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    'apple-touch-icon.png',
      badge:   'apple-touch-icon.png',
      tag:     data.tag || 'todoweek-remind',
      data:    { url: self.registration.scope },
    })
  );
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
