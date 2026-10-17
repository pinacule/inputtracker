/*
 * InputTracker service worker.
 *
 * Plain, self-contained JavaScript (no imports, no build step) so it can be
 * served verbatim from `web/public/`. Caching strategy:
 *
 *   - install: precache the app shell (`/`) and the manifest/icon;
 *   - same-origin static GETs: stale-while-revalidate;
 *   - same-origin `GET /api/*`: network-first, falling back to the last good
 *     response when offline (export/import/sync endpoints are never cached);
 *   - navigations: network-first, falling back to the cached `/` offline;
 *   - non-GET requests are never intercepted or cached.
 *
 * Bump `CACHE_VERSION` whenever the caching logic changes; older
 * `inputtracker-*` caches are deleted on activate.
 */

const CACHE_PREFIX = "inputtracker";
const CACHE_VERSION = "v1";
const CACHE_NAME = `${CACHE_PREFIX}-${CACHE_VERSION}`;
const SHELL_URL = "/";

/** Fetched during install so the shell is usable on the very first offline load. */
const PRECACHE_URLS = [SHELL_URL, "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            const response = await fetch(url, { cache: "reload" });
            if (response && response.ok) {
              await cache.put(url, response);
            }
          } catch {
            // A missing precache entry must not block installation.
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (key) => key.startsWith(`${CACHE_PREFIX}-`) && key !== CACHE_NAME
          )
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isApi(url) {
  return url.pathname === "/api" || url.pathname.startsWith("/api/");
}

/** GET /api responses that are safe to cache (never export, sync or import). */
function isCacheableApi(url) {
  const path = url.pathname;
  if (path.startsWith("/api/export")) return false;
  if (path.startsWith("/api/sync")) return false;
  if (path.startsWith("/api/import")) return false;
  return true;
}

/** Stores a copy of `response` when it is a cacheable success. Best effort. */
async function cachePut(request, response) {
  if (!response || !response.ok) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  } catch {
    // Cache writes are best effort; never fail the request because of one.
  }
}

/** Network-first with a cached fallback (used for cacheable `GET /api/*`). */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    await cachePut(request, response);
    return response;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    return cached || Response.error();
  }
}

/** Serve the cached copy immediately, refreshing it from the network. */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request).then((response) => {
    cachePut(request, response);
    return response;
  });

  if (cached) {
    network.catch(() => {});
    return cached;
  }

  try {
    return await network;
  } catch {
    return Response.error();
  }
}

/** Network-first navigation with the cached app shell as the offline fallback. */
async function navigationHandler(request) {
  try {
    const response = await fetch(request);
    cachePut(request, response);
    return response;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const cached = (await cache.match(SHELL_URL)) || (await cache.match(request));
    return cached || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Never intercept or cache anything but reads.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (!isSameOrigin(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(navigationHandler(request));
    return;
  }

  if (isApi(url)) {
    if (!isCacheableApi(url)) return;
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
