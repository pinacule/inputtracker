import { render } from "preact";
import { App } from "./App";
import { startQueueSync } from "./lib/offline-queue";
import "./style.css";

const root = document.getElementById("app");
if (root !== null) {
  render(<App />, root);
}

// Keep unsent offline entries moving: flush on start, `online`, visibility and
// every 60 s while entries are pending. Failures here must never break the app.
startQueueSync();

// Register the service worker in production builds only. Failures (unsupported
// browser, insecure context, blocked storage) must never break the app.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  try {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Ignore registration failures; the app still works online.
    });
  } catch {
    // Ignore synchronous registration errors.
  }
}
