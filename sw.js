// sw.js - TodoWeek Service Worker

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// プッシュ通知を受信したときの処理
self.addEventListener('push', e => {
  let data = { title: '【リマインド】', body: 'TODOが近づいています' };
  try { data = e.data.json(); } catch(err) {}

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    '/apple-touch-icon.png',
      badge:   '/apple-touch-icon.png',
      tag:     data.tag || 'todoweek-remind',
      data:    { url: self.location.origin },
    })
  );
});

// 通知タップで画面を開く
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.location.origin;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.startsWith(url) && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
