import { render } from "preact";
import { App } from "./App";
import "./style.css";

const root = document.getElementById("app");
if (root !== null) {
  render(<App />, root);
}

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
