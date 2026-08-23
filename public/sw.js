/*
 * The offline shell, and nothing else.
 *
 * KARLA is a static site, so a service worker can hold the whole app — markup, bundle, styles,
 * icons — and still be honest, because the one thing it must never hold is a departure. Feed reads
 * go to another origin (projekte.kvv-efa.de) and are left entirely to the network: a request this
 * worker does not answer cannot be answered from a cache, so a board is never re-served as if it
 * were live. Offline the rider gets the app and its own retained-board handling, which already
 * states how old a reading is — not a silent replay of yesterday's departures.
 *
 * Bump APP_SHELL_CACHE_NAME whenever the stable precache list or caching behaviour changes.
 */
const APP_CACHE_PREFIX = "karla-app-shell-";
const APP_SHELL_CACHE_NAME = `${APP_CACHE_PREFIX}v2`;
const BUILD_MANIFEST_URL = "./vite-manifest.json";
const STATIC_SHELL_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./favicon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable.svg",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
];

/** Every emitted file named by Vite's manifest, resolved within this worker's own scope. */
async function getBuildAssetUrls() {
  const response = await fetch(BUILD_MANIFEST_URL);
  if (!response.ok) throw new Error(`Build-Manifest nicht verfügbar (${response.status})`);

  const manifest = await response.json();
  const assetPaths = new Set();
  for (const entry of Object.values(manifest)) {
    if (entry.file) assetPaths.add(entry.file);
    for (const path of entry.css ?? []) assetPaths.add(path);
    for (const path of entry.assets ?? []) assetPaths.add(path);
  }
  return [...assetPaths].map((path) => new URL(path, self.registration.scope).href);
}

async function precacheAppShell() {
  const cache = await caches.open(APP_SHELL_CACHE_NAME);
  const buildAssetUrls = await getBuildAssetUrls();
  await cache.addAll([...STATIC_SHELL_URLS, BUILD_MANIFEST_URL, ...buildAssetUrls]);
}

self.addEventListener("install", (event) => {
  // The shell is small and every entry is on the critical path of a cold, offline start.
  event.waitUntil(precacheAppShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          // This origin may host other applications; only KARLA owns caches with its own prefix.
          .filter(
            (cacheName) =>
              cacheName.startsWith(APP_CACHE_PREFIX) && cacheName !== APP_SHELL_CACHE_NAME,
          )
          .map((cacheName) => caches.delete(cacheName)),
      );
      await self.clients.claim();
    })(),
  );
});

/** Network first, so a deployed change is picked up on the next launch rather than the one after. */
async function networkFirstWithShellFallback(request, fallbackUrl) {
  const cache = await caches.open(APP_SHELL_CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(fallbackUrl, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(fallbackUrl);
    if (cached) return cached;
    throw error;
  }
}

/** Hashed build output never changes under its name, so the cached copy is the right answer. */
async function cacheFirst(request) {
  const cache = await caches.open(APP_SHELL_CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Anything off this origin — the KVV feed above all — is the network's business alone.
  if (url.origin !== self.location.origin) return;
  // And anything outside the app's own directory belongs to whatever else is published there.
  const appScopeUrl = new URL("./", self.location.href);
  if (!url.pathname.startsWith(appScopeUrl.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstWithShellFallback(request, "./index.html"));
    return;
  }
  event.respondWith(cacheFirst(request));
});
