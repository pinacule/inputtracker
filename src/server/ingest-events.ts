import type { Context } from "hono";
import { finishRun, insertEvents, startRun } from "../core/events.ts";
import { MAX_EVENT_BODY_BYTES, parseEventBatch, EventBatchValidationError } from "../core/ingest-events.ts";
import { bearerToken, tokensEqual, type IngestHandlerDeps } from "./ingest.ts";

/** A streaming cap also protects requests without a declared Content-Length. */
export async function handleEventBatch(c: Context, deps: IngestHandlerDeps & { afterIngest?: () => Promise<void> }): Promise<Response> {
  const token = deps.config.ingest?.token ?? "";
  if (!token) return c.json({ error: "ingest is disabled" }, 503);
  const provided = bearerToken(c.req.header("Authorization"));
  if (!provided || !tokensEqual(provided, token)) return c.json({ error: "unauthorized" }, 401);
  if (Number(c.req.header("Content-Length")) > MAX_EVENT_BODY_BYTES) return c.json({ error: "body too large (max 1 MB)" }, 413);
  const reader = c.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_EVENT_BODY_BYTES) {
          await reader.cancel();
          return c.json({ error: "body too large (max 1 MB)" }, 413);
        }
        chunks.push(value);
      }
    }
  } catch { return c.json({ error: "invalid request body" }, 400); }
  let events;
  try { events = parseEventBatch(JSON.parse(Buffer.concat(chunks).toString("utf8")), (deps.nowMs ?? Date.now)()); }
  catch (error) { return c.json({ error: error instanceof EventBatchValidationError ? error.message : "invalid JSON body" }, 400); }
  let runId: number | null = null;
  try {
    runId = startRun(deps.db, "activitywatch", "push");
    const result = deps.db.transaction(() => {
      const result = insertEvents(deps.db, runId, events);
      finishRun(deps.db, runId!, { status: "ok", rowsSeen: result.seen, rowsInserted: result.inserted });
      return result;
    })();
    // Independent of acknowledgement: metadata failures must never lose confirmed plays.
    void Promise.resolve().then(() => deps.afterIngest?.()).catch(() => {});
    return c.json({ accepted: result.seen, inserted: result.inserted }, 200);
  } catch {
    if (runId !== null) try { finishRun(deps.db, runId, { status: "failed", error: "ingest failed" }); } catch {}
    return c.json({ error: "ingest failed" }, 500);
  }
}
