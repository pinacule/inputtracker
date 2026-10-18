/**
 * HTTP route registration for Achriom library import
 * (`POST /api/import/achriom[?dry_run=1]`).
 */

import type { Hono } from "hono";
import { redactString } from "../core/config.ts";
import { CsvParseError } from "../io/csv.ts";
import {
  AchriomImportError,
  importAchriom,
} from "../io/import-achriom.ts";
import { ZipError } from "../io/zip.ts";
import type { AppDeps } from "./app.ts";
import { ArchiveValidationError } from "./archive.ts";

/** Maximum uploaded archive/CSV file size: 10 MB. */
export const MAX_ACHRIOM_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Maximum total uncompressed size across all entries in an uploaded zip: 25 MB. */
export const MAX_ACHRIOM_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;

function validateQueryParams(
  urlStr: string,
  allowed: readonly string[]
): string | null {
  const url = new URL(urlStr);
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) {
      return `Unknown query parameter: '${key}'`;
    }
  }
  return null;
}

export function registerAchriomRoutes(app: Hono, deps: AppDeps): void {
  const { db, config } = deps;

  app.post("/api/import/achriom", async (c) => {
    const queryErr = validateQueryParams(c.req.url, ["dry_run"]);
    if (queryErr) {
      return c.json({ error: queryErr }, 400);
    }

    const dryRunParam = c.req.query("dry_run");
    let dryRun = false;
    if (dryRunParam !== undefined && dryRunParam !== "") {
      if (dryRunParam === "1" || dryRunParam === "true") {
        dryRun = true;
      } else if (dryRunParam === "0" || dryRunParam === "false") {
        dryRun = false;
      } else {
        return c.json(
          { error: `Invalid dry_run parameter: '${dryRunParam}' (expected 1 or 0)` },
          400
        );
      }
    }

    const contentLengthHeader = c.req.header("Content-Length");
    if (contentLengthHeader !== undefined) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > MAX_ACHRIOM_UPLOAD_BYTES) {
        return c.json({ error: "File too large (max 10 MB)" }, 413);
      }
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody();
    } catch (caught) {
      return c.json(
        {
          error: `Bad form data: ${
            caught instanceof Error ? caught.message : String(caught)
          }`,
        },
        400
      );
    }

    const file = body["file"];
    if (!file) {
      return c.json(
        { error: "Missing required 'file' in multipart form" },
        400
      );
    }

    let bytes: Uint8Array;
    let filename = "";

    if (typeof file === "string") {
      bytes = new TextEncoder().encode(file);
    } else if (
      file instanceof Blob ||
      typeof (file as { arrayBuffer?: unknown }).arrayBuffer === "function"
    ) {
      const blob = file as Blob & { name?: unknown };
      if (typeof blob.size === "number" && blob.size > MAX_ACHRIOM_UPLOAD_BYTES) {
        return c.json({ error: "File too large (max 10 MB)" }, 413);
      }
      if (typeof blob.name === "string") {
        filename = blob.name;
      }
      bytes = new Uint8Array(await blob.arrayBuffer());
    } else {
      return c.json({ error: "Invalid file uploaded" }, 400);
    }

    if (bytes.byteLength > MAX_ACHRIOM_UPLOAD_BYTES) {
      return c.json({ error: "File too large (max 10 MB)" }, 413);
    }
    if (bytes.byteLength === 0) {
      return c.json({ error: "Uploaded file is empty" }, 400);
    }

    try {
      const fetchFn =
        (deps as { fetch?: typeof fetch }).fetch ??
        deps.fetchImage ??
        globalThis.fetch;

      const result = await importAchriom({
        db,
        config,
        input: bytes,
        filename,
        dryRun,
        fetch: fetchFn,
        now: deps.nowMs,
        zipOptions: {
          maxArchiveBytes: MAX_ACHRIOM_UPLOAD_BYTES,
          maxEntryBytes: MAX_ACHRIOM_UPLOAD_BYTES,
          maxTotalUncompressedBytes: MAX_ACHRIOM_UNCOMPRESSED_BYTES,
        },
      });
      return c.json(result);
    } catch (caught) {
      const rawMsg =
        caught instanceof AchriomImportError ||
        caught instanceof ArchiveValidationError ||
        caught instanceof ZipError ||
        caught instanceof CsvParseError ||
        caught instanceof Error
          ? caught.message
          : String(caught);
      return c.json({ error: redactString(rawMsg, config) }, 400);
    }
  });
}
