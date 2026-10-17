/**
 * Server entry point: loads config, opens database, and starts Bun.serve.
 */

import { loadConfig, type Config } from "../core/config.ts";
import { openDb } from "../core/db.ts";
import { createApp } from "./app.ts";

export interface MainDeps {
  loadConfig?: () => Config;
  openDb?: (path: string) => ReturnType<typeof openDb>;
}

export function main(deps: MainDeps = {}) {
  const doLoadConfig = deps.loadConfig ?? loadConfig;
  const doOpenDb = deps.openDb ?? openDb;

  const config = doLoadConfig();
  const db = doOpenDb(config.storage.db_path);
  const app = createApp({ db, config });

  const server = Bun.serve({
    hostname: config.server.bind,
    port: config.server.port,
    fetch: app.fetch,
  });

  console.log(
    `InputTracker server listening on http://${config.server.bind}:${config.server.port}`
  );

  return { server, db, app, config };
}

if (import.meta.main) {
  main();
}
