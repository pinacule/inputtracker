/**
 * Small, DOM-free helpers for the progressive-web-app behaviour.
 *
 * The service worker itself (`web/public/sw.js`) is deliberately
 * self-contained so it can be served verbatim; this module mirrors its
 * caching decisions in TypeScript so the app and tests can reason about them.
 */

/**
 * Returns `true` when a `GET /api/...` response may be cached by the service
 * worker.
 *
 * Non-GET requests are never cacheable, and the export, import and sync
 * endpoints are excluded because they are either large downloads or mutating
 * operations.
 */
export function shouldCacheApi(url: string, method: string): boolean {
  if (method.toUpperCase() !== "GET") {
    return false;
  }

  let path: string;
  try {
    path = new URL(url, "http://localhost").pathname;
  } catch {
    return false;
  }

  if (path !== "/api" && !path.startsWith("/api/")) {
    return false;
  }

  if (path.startsWith("/api/export")) return false;
  if (path.startsWith("/api/sync")) return false;
  if (path.startsWith("/api/import")) return false;

  return true;
}
