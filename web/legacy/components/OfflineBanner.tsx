import { useEffect, useState } from "preact/hooks";

/**
 * Small banner shown while the browser reports that it is offline.
 *
 * The initial value comes from `navigator.onLine`, then follows the
 * `online`/`offline` window events. It renders nothing while online.
 */
export function OfflineBanner() {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    // Re-sync in case the connection changed between render and effect.
    if (typeof navigator !== "undefined") {
      setOnline(navigator.onLine);
    }

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  if (online) {
    return null;
  }

  return (
    <div class="offline-banner" role="status" aria-live="polite">
      Offline — showing saved data
    </div>
  );
}
