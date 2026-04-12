// SpeakNote Service Worker - Self-destruct mode
// 過去のSWを完全に無効化し、キャッシュも全削除する
self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 全キャッシュ削除
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    // 自分自身を登録解除
    await self.registration.unregister();
    // 全クライアントに再読み込みを指示
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      client.navigate(client.url);
    }
  })());
});

// fetchイベントは完全にネットワーク透過（キャッシュしない）
self.addEventListener('fetch', () => {});
