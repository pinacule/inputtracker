/**
 * HTTP routes for metadata lookup and cached metadata covers:
 * - `GET /api/lookup/search?q=<1..200>&category=<Category|any>`
 * - `GET /api/lookup/work/:provider/:id`
 * - `GET /api/meta-cover/:provider/:id`
 */

import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { isCategory, type Category } from "../core/category.ts";
import { type Config, redactString } from "../core/config.ts";
import {
  getMetaCover,
  isMetaProvider,
  isValidProviderId,
  type Limiter,
  lookupSearch,
  lookupWork,
  type MetadataDeps,
  ProviderError,
} from "./metadata/index.ts";

export interface LookupRouteDeps {
  config: Config;
  db?: Database;
  /** Injectable fetch for tests; falls back to `fetchImage` from `AppDeps` or global `fetch`. */
  fetch?: typeof fetch;
  fetchImage?: typeof fetch;
  limiter?: Limiter;
  timeoutMs?: number;
  nowMs?: () => number;
}

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

function toMetadataDeps(deps: LookupRouteDeps): MetadataDeps {
  return {
    config: deps.config,
    fetch: deps.fetch ?? deps.fetchImage ?? globalThis.fetch,
    limiter: deps.limiter,
    timeoutMs: deps.timeoutMs,
    now: deps.nowMs,
  };
}

export function registerLookupRoutes(app: Hono, deps: LookupRouteDeps): void {
  // GET /api/lookup/search?q=<1..200 chars>&category=<Category|any>
  app.get("/api/lookup/search", async (c) => {
    const err = validateQueryParams(c.req.url, ["q", "category"]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const q = c.req.query("q");
    if (q === undefined || q.trim() === "") {
      return c.json({ error: "Missing required query parameter: q" }, 400);
    }
    if (q.length > 200) {
      return c.json(
        { error: `Invalid q: too long (${q.length} characters, max 200)` },
        400
      );
    }

    const categoryParam = c.req.query("category");
    let category: Category | "any" = "any";
    if (categoryParam !== undefined && categoryParam !== "" && categoryParam !== "any") {
      if (!isCategory(categoryParam)) {
        return c.json({ error: `Invalid category: '${categoryParam}'` }, 400);
      }
      category = categoryParam;
    }

    const result = await lookupSearch(q, category, toMetadataDeps(deps));
    return c.json(result);
  });

  // GET /api/lookup/work/:provider/:id
  app.get("/api/lookup/work/:provider/:id", async (c) => {
    const err = validateQueryParams(c.req.url, ["category"]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const provider = c.req.param("provider");
    if (!isMetaProvider(provider)) {
      return c.json({ error: "Invalid metadata provider" }, 400);
    }

    const id = c.req.param("id");
    if (!isValidProviderId(id)) {
      return c.json({ error: "Invalid provider id" }, 400);
    }

    const categoryParam = c.req.query("category");
    let categoryOverride: Category | undefined;
    if (categoryParam !== undefined && categoryParam !== "") {
      if (!isCategory(categoryParam)) {
        return c.json({ error: `Invalid category: '${categoryParam}'` }, 400);
      }
      categoryOverride = categoryParam;
    }

    try {
      const work = await lookupWork(
        provider,
        id,
        toMetadataDeps(deps),
        categoryOverride
      );
      if (work === null) {
        return c.json({ error: "Work not found" }, 404);
      }
      return c.json(work);
    } catch (caught) {
      const rawMsg =
        caught instanceof ProviderError || caught instanceof Error
          ? caught.message
          : String(caught);
      return c.json({ error: redactString(rawMsg, deps.config) }, 502);
    }
  });

  // Reject malformed /api/lookup/work/... paths with extra/missing segments.
  app.all("/api/lookup/work/*", (c) => {
    const err = validateQueryParams(c.req.url, ["category"]);
    if (err) {
      return c.json({ error: err }, 400);
    }
    return c.json({ error: "Invalid lookup work path" }, 400);
  });

  // GET /api/meta-cover/:provider/:id
  app.get("/api/meta-cover/:provider/:id", async (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const provider = c.req.param("provider");
    if (!isMetaProvider(provider)) {
      return c.json({ error: "Invalid metadata provider" }, 400);
    }

    const id = c.req.param("id");
    if (!isValidProviderId(id)) {
      return c.json({ error: "Invalid provider id" }, 400);
    }

    const cover = await getMetaCover(provider, id, toMetadataDeps(deps));
    if (cover === null) {
      return c.json({ error: "Cover not available" }, 404);
    }

    return new Response(cover.bytes, {
      status: 200,
      headers: {
        "Content-Type": cover.contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  });

  // Reject malformed /api/meta-cover/... paths with extra/missing segments.
  app.all("/api/meta-cover/*", (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }
    return c.json({ error: "Invalid meta-cover path" }, 400);
  });
}
