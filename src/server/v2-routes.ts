/**
 * HTTP route registration for v2 archive, library, reviews, series and settings
 * (`registerV2Routes(app, deps)`).
 */

import type { Hono } from "hono";
import type { AppDeps } from "./app.ts";
import {
  ArchiveNotFoundError,
  ArchiveValidationError,
  deleteArchiveEntry,
  listArchiveEntries,
  saveArchiveEntry,
} from "./archive.ts";
import { redactString } from "../core/config.ts";
import {
  editLibraryWork,
  getHiddenLibraryWorks,
  getLibrary,
  getLibraryWorkDetail,
  isValidLibrarySort,
  type LibrarySort,
  refreshLibraryWorkMetadata,
} from "./library.ts";
import { ProviderError } from "./metadata/index.ts";
import {
  CategoryFilterValidationError,
  parseCategoryFilter,
  WorkOverrideNotFoundError,
  WorkOverrideValidationError,
} from "./overrides.ts";
import { getMonthReview, getSeries, getYearReviewV2 } from "./review.ts";
import { getSettings } from "./settings.ts";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_RE = /^\d{4}$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function isValidDateStr(str: string): boolean {
  if (!DATE_RE.test(str)) {
    return false;
  }
  const [yStr, mStr, dStr] = str.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
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

export function registerV2Routes(app: Hono, deps: AppDeps): void {
  const { db, config } = deps;
  const tz = config.timezone;

  // POST /api/archive
  app.post("/api/archive", async (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (caught) {
      return c.json(
        {
          error: `Invalid JSON body: ${
            caught instanceof Error ? caught.message : String(caught)
          }`,
        },
        400
      );
    }

    try {
      const result = saveArchiveEntry(db, body, tz);
      return c.json(result);
    } catch (caught) {
      if (caught instanceof ArchiveValidationError) {
        return c.json({ error: caught.message }, 400);
      }
      throw caught;
    }
  });

  // POST /api/archive/:entry_id/delete
  app.post("/api/archive/:entry_id/delete", (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const entryId = c.req.param("entry_id");
    try {
      const result = deleteArchiveEntry(db, entryId);
      return c.json(result);
    } catch (caught) {
      if (caught instanceof ArchiveValidationError) {
        return c.json({ error: caught.message }, 400);
      }
      if (caught instanceof ArchiveNotFoundError) {
        return c.json({ error: caught.message }, 404);
      }
      throw caught;
    }
  });

  // GET /api/archive?category=&exclude=
  app.get("/api/archive", (c) => {
    const err = validateQueryParams(c.req.url, ["category", "exclude"]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    try {
      return c.json(
        listArchiveEntries(db, c.req.query("category"), c.req.query("exclude"))
      );
    } catch (caught) {
      if (caught instanceof CategoryFilterValidationError) {
        return c.json({ error: caught.message }, 400);
      }
      throw caught;
    }
  });

  // GET /api/library?category=<Category,...>&exclude=<Category,...>&q=&sort=recent|time|title
  app.get("/api/library", (c) => {
    const err = validateQueryParams(c.req.url, [
      "category",
      "exclude",
      "q",
      "sort",
    ]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const q = c.req.query("q");
    if (q !== undefined && q.length > 200) {
      return c.json(
        { error: `Invalid q: too long (${q.length} characters, max 200)` },
        400
      );
    }

    const sortRaw = c.req.query("sort");
    let sort: LibrarySort = "recent";
    if (sortRaw !== undefined && sortRaw !== "") {
      if (!isValidLibrarySort(sortRaw)) {
        return c.json(
          {
            error: `Invalid sort: '${sortRaw}' (expected recent, time, title, category or creator)`,
          },
          400
        );
      }
      sort = sortRaw;
    }

    try {
      return c.json(
        getLibrary(db, {
          category: c.req.query("category"),
          exclude: c.req.query("exclude"),
          q,
          sort,
          tz,
          config,
        })
      );
    } catch (caught) {
      if (caught instanceof CategoryFilterValidationError) {
        return c.json({ error: caught.message }, 400);
      }
      throw caught;
    }
  });

  // GET /api/library/work?key=
  app.get("/api/library/work", (c) => {
    const err = validateQueryParams(c.req.url, ["key"]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const key = c.req.query("key");
    if (key === undefined || key === "") {
      return c.json({ error: "Missing required query parameter: key" }, 400);
    }
    if (key.length > 500) {
      return c.json(
        { error: `Invalid key: too long (${key.length} characters, max 500)` },
        400
      );
    }

    const detail = getLibraryWorkDetail(db, key, tz, config);
    if (detail === null) {
      return c.json({ error: "Work not found" }, 404);
    }
    return c.json(detail);
  });

  // POST /api/library/work/edit?key=
  app.post("/api/library/work/edit", async (c) => {
    const err = validateQueryParams(c.req.url, ["key"]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const key = c.req.query("key");
    if (key === undefined || key === "") {
      return c.json({ error: "Missing required query parameter: key" }, 400);
    }
    if (key.length > 500) {
      return c.json(
        { error: `Invalid key: too long (${key.length} characters, max 500)` },
        400
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (caught) {
      return c.json(
        {
          error: `Invalid JSON body: ${
            caught instanceof Error ? caught.message : String(caught)
          }`,
        },
        400
      );
    }

    try {
      const detail = await editLibraryWork(db, key, body, {
        tz,
        config,
        fetch: deps.fetchImage,
      });
      return c.json(detail);
    } catch (caught) {
      if (caught instanceof WorkOverrideValidationError) {
        return c.json({ error: caught.message }, 400);
      }
      if (caught instanceof WorkOverrideNotFoundError) {
        return c.json({ error: caught.message }, 404);
      }
      throw caught;
    }
  });

  // POST /api/library/work/refresh-metadata?key=
  app.post("/api/library/work/refresh-metadata", async (c) => {
    const err = validateQueryParams(c.req.url, ["key"]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const key = c.req.query("key");
    if (key === undefined || key === "") {
      return c.json({ error: "Missing required query parameter: key" }, 400);
    }
    if (key.length > 500) {
      return c.json(
        { error: `Invalid key: too long (${key.length} characters, max 500)` },
        400
      );
    }

    try {
      const result = await refreshLibraryWorkMetadata(db, key, {
        tz,
        config,
        fetch: deps.fetchImage,
        now: deps.nowMs,
      });
      return c.json(result);
    } catch (caught) {
      if (caught instanceof WorkOverrideValidationError) {
        return c.json({ error: caught.message }, 400);
      }
      if (caught instanceof WorkOverrideNotFoundError) {
        return c.json({ error: caught.message }, 404);
      }
      if (caught instanceof ProviderError) {
        return c.json({ error: redactString(caught.message, config) }, 502);
      }
      throw caught;
    }
  });

  // GET /api/library/hidden
  app.get("/api/library/hidden", (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }

    return c.json(getHiddenLibraryWorks(db, tz, config));
  });

  // GET /api/series?bucket=day|week|month&from=YYYY-MM-DD&to=YYYY-MM-DD[&category=][&exclude=]
  app.get("/api/series", (c) => {
    const err = validateQueryParams(c.req.url, [
      "bucket",
      "from",
      "to",
      "category",
      "exclude",
    ]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const bucketRaw = c.req.query("bucket");
    if (
      bucketRaw !== "day" &&
      bucketRaw !== "week" &&
      bucketRaw !== "month"
    ) {
      return c.json(
        {
          error: `Invalid or missing bucket: '${
            bucketRaw ?? ""
          }' (expected day, week or month)`,
        },
        400
      );
    }

    const from = c.req.query("from");
    if (!from || !isValidDateStr(from)) {
      return c.json(
        {
          error: `Invalid or missing from date: '${
            from ?? ""
          }' (expected YYYY-MM-DD)`,
        },
        400
      );
    }

    const to = c.req.query("to");
    if (!to || !isValidDateStr(to)) {
      return c.json(
        {
          error: `Invalid or missing to date: '${
            to ?? ""
          }' (expected YYYY-MM-DD)`,
        },
        400
      );
    }

    if (from > to) {
      return c.json({ error: "'from' date must not be after 'to' date" }, 400);
    }

    try {
      return c.json(
        getSeries(db, {
          bucket: bucketRaw,
          from,
          to,
          category: c.req.query("category"),
          exclude: c.req.query("exclude"),
          tz,
        })
      );
    } catch (caught) {
      if (caught instanceof CategoryFilterValidationError) {
        return c.json({ error: caught.message }, 400);
      }
      throw caught;
    }
  });

  // GET /api/review/month?month=YYYY-MM[&category=][&exclude=]
  app.get("/api/review/month", (c) => {
    const err = validateQueryParams(c.req.url, [
      "month",
      "category",
      "exclude",
    ]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const month = c.req.query("month");
    if (!month) {
      return c.json({ error: "Missing required query parameter: month" }, 400);
    }
    if (!MONTH_RE.test(month)) {
      return c.json(
        { error: `Invalid month format: '${month}' (expected YYYY-MM)` },
        400
      );
    }

    try {
      const filter = parseCategoryFilter(
        c.req.query("category"),
        c.req.query("exclude")
      );
      return c.json(getMonthReview(db, month, tz, filter));
    } catch (caught) {
      if (caught instanceof CategoryFilterValidationError) {
        return c.json({ error: caught.message }, 400);
      }
      throw caught;
    }
  });

  // GET /api/review/year?year=YYYY[&category=][&exclude=]
  app.get("/api/review/year", (c) => {
    const err = validateQueryParams(c.req.url, [
      "year",
      "category",
      "exclude",
    ]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const yearRaw = c.req.query("year");
    if (!yearRaw) {
      return c.json({ error: "Missing required query parameter: year" }, 400);
    }
    if (!YEAR_RE.test(yearRaw)) {
      return c.json(
        { error: `Invalid year format: '${yearRaw}' (expected YYYY)` },
        400
      );
    }

    try {
      const filter = parseCategoryFilter(
        c.req.query("category"),
        c.req.query("exclude")
      );
      return c.json(getYearReviewV2(db, Number(yearRaw), tz, filter));
    } catch (caught) {
      if (caught instanceof CategoryFilterValidationError) {
        return c.json({ error: caught.message }, 400);
      }
      throw caught;
    }
  });

  // GET /api/settings
  app.get("/api/settings", (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }

    return c.json(
      getSettings({
        db,
        config,
        readSimklToken: deps.readSimklToken,
      })
    );
  });
}
