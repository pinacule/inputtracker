/**
 * InputTracker HTTP server entry point.
 */

export * from "./aggregate.ts";
export * from "./app.ts";
export * from "./main.ts";

import { main } from "./main.ts";

if (import.meta.main) {
  main();
}
