/* Offline-Cache für Musik */
const CACHE = "musik-v3";
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

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => (req.mode === "navigate" ? caches.match("index.html") : Response.error()));
    })
  );
});
