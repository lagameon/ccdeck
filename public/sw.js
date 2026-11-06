// ccdeck service worker: shows server-sent pushes, opens the session on tap. Never caches.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: "ccdeck", body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "ccdeck", {
    body: d.body || "", tag: d.tag, renotify: true, data: { url: d.url || "/" }, icon: "/icon-192.png", badge: "/icon-192.png",
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) { try { await w.focus(); if ("navigate" in w) await w.navigate(url); return; } catch {} }
    await self.clients.openWindow(url);
  })());
});
