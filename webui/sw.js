/*
 * Service Worker — einfacher App-Shell-Cache.
 *  - Precache der App-Shell (index.html, app.css, /js/**, /vendor/**, Icons).
 *  - Statische GETs (gleicher Origin): cache-first mit Hintergrund-Update.
 *  - /api/** IMMER Netzwerk, NIE cachen (Cookie-Session, Live-Daten).
 *  - Navigationsanfragen → index.html (SPA-Shell), damit Offline der App-Rahmen lädt.
 */

const CACHE = "vh-shell-v1";

// Bekannte Shell-Dateien (Best Effort — fehlende Einträge brechen Install nicht ab).
const PRECACHE = [
  "/",
  "/index.html",
  "/app.css",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/js/app.js",
  "/js/api.js",
  "/js/format.js",
  "/js/app-tabbar.js",
  "/js/views/login-view.js",
  "/js/views/dashboard-view.js",
  "/js/views/agents-view.js",
  "/js/views/agent-form-view.js",
  "/js/views/requests-view.js",
  "/js/views/request-detail-view.js",
  "/vendor/glasskit/glasskit.min.css",
  "/vendor/glasskit-elements/glasskit-elements.min.js",
  "/vendor/hybrids/index.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Einzeln cachen, damit ein fehlender Eintrag nicht den ganzen Install kippt.
      await Promise.all(
        PRECACHE.map((url) =>
          cache.add(url).catch(() => {
            /* ignore missing */
          }),
        ),
      );
      self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Nur GET behandeln; alles andere (POST/PATCH/DELETE) direkt durchreichen.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Fremde Origins nicht anfassen.
  if (url.origin !== self.location.origin) return;

  // API NIE cachen — immer Netzwerk.
  if (url.pathname.startsWith("/api/")) return;

  // Den SW selbst nicht cachen.
  if (url.pathname === "/sw.js") return;

  // Navigationsanfragen (HTML) → App-Shell (index.html) als Fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          const cache = await caches.open(CACHE);
          return (await cache.match("/index.html")) || (await cache.match("/")) || Response.error();
        }
      })(),
    );
    return;
  }

  // Statische Assets: cache-first + Hintergrund-Aktualisierung.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      return cached || (await network) || Response.error();
    })(),
  );
});
