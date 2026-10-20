import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { themeBootstrapScript } from "./src/lib/theme.ts";

/**
 * Vite config for the InputTracker web app.
 *
 * `root` is `web/` so the dev server and build both operate on this folder and
 * resolve `src/`, `public/` and `dist/` relative to it.
 *
 * The dev server proxies `/api` to the local Hono server so the SPA can use
 * relative URLs (`/api/...`) in production (same origin) and in development.
 */
export default defineConfig({
  root: "web",
  plugins: [
    preact(),
    {
      name: "inputtracker-theme-bootstrap",
      transformIndexHtml: {
        order: "pre",
        handler: (html) => html.replace(
          "/* inputtracker-theme-bootstrap */",
          themeBootstrapScript()
        ),
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
