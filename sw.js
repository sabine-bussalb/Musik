/* Offline-Cache für Musik */
const CACHE = "musik-v10";
const FILES = [
  "./",
  "index.html",
  "css/style.css",
  "js/app.js",
  "manifest.webmanifest",
  "fonts/inter-latin-400-normal.woff2",
  "fonts/inter-latin-500-normal.woff2",
  "fonts/inter-latin-600-normal.woff2",
  "fonts/inter-latin-700-normal.woff2",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "samples/A0.mp3",
  "samples/A1.mp3",
  "samples/A2.mp3",
  "samples/A3.mp3",
  "samples/A4.mp3",
  "samples/A5.mp3",
  "samples/A6.mp3",
  "samples/A7.mp3",
  "samples/C1.mp3",
  "samples/C2.mp3",
  "samples/C3.mp3",
  "samples/C4.mp3",
  "samples/C5.mp3",
  "samples/C6.mp3",
  "samples/C7.mp3",
  "samples/C8.mp3",
  "samples/Ds1.mp3",
  "samples/Ds2.mp3",
  "samples/Ds3.mp3",
  "samples/Ds4.mp3",
  "samples/Ds5.mp3",
  "samples/Ds6.mp3",
  "samples/Ds7.mp3",
  "samples/Fs1.mp3",
  "samples/Fs2.mp3",
  "samples/Fs3.mp3",
  "samples/Fs4.mp3",
  "samples/Fs5.mp3",
  "samples/Fs6.mp3",
  "samples/Fs7.mp3",
];

// Beim Installieren alles frisch vom Server holen (nicht aus dem Browser-Zwischenspeicher!)
self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(FILES.map(async (f) => {
      const url = new URL(f, self.registration.scope).href;
      const bust = url + (url.includes("?") ? "&" : "?") + "v=" + CACHE;
      const res = await fetch(new Request(bust, { cache: "reload" }));
      if (!res.ok) throw new Error(f + ": " + res.status);
      await c.put(url, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// App-Dateien (Seite, CSS, JS): zuerst Netz, damit Änderungen sofort ankommen; offline aus dem Speicher.
// Klänge, Schrift, Icons: zuerst Speicher (ändern sich nie).
const isShell = (url, req) =>
  req.mode === "navigate" || /\.(html|css|js|webmanifest)$/.test(url.pathname) || url.pathname.endsWith("/");

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;

  if (isShell(url, req)) {
    e.respondWith((async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        const res = await fetch(new Request(req, { cache: "no-cache", signal: ctrl.signal }));
        clearTimeout(timer);
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      } catch {
        return (await caches.match(req, { ignoreSearch: true })) ||
               (await caches.match("index.html", { ignoreSearch: true })) || Response.error();
      }
    })());
    return;
  }

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }))
  );
});
