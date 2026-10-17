/**
 * Offline queue logic against an in-memory store and fake send functions.
 * Synthetic data only; no network, no DOM, no IndexedDB.
 */

import { describe, expect, test } from "bun:test";
import { ApiError } from "../web/src/api.ts";
import type { AddEventResult, ManualEventInput } from "../web/src/api.ts";
import {
  classifySendError,
  createLocalStorageStore,
  createMemoryStore,
  enqueueEntry,
  flushQueue,
  newClientId,
  notifyQueueChanged,
  removeQueuedEntry,
  subscribeQueue,
  type QueueSend,
  type QueuedEntry,
  type QueueStore,
} from "../web/src/lib/offline-queue.ts";

const T0 = "2026-10-17T21:00:00.000Z";
const T1 = "2026-10-17T22:00:00.000Z";
const T2 = "2026-10-17T23:00:00.000Z";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function body(overrides: Partial<ManualEventInput> = {}): ManualEventInput {
  return {
    media_type: "movie",
    title: "Synthetic Movie",
    started_at: "2026-10-17 21:30",
    ...overrides,
  };
}

function entry(
  id: string,
  createdAt: string,
  overrides: Partial<QueuedEntry> = {}
): QueuedEntry {
  return {
    client_id: id,
    body: body({ client_id: id, title: `Synthetic ${id}` }),
    created_at: createdAt,
    attempts: 0,
    last_attempt_at: null,
    last_error: null,
    status: "pending",
    ...overrides,
  };
}

async function seed(store: QueueStore, ...entries: QueuedEntry[]): Promise<void> {
  for (const queued of entries) {
    await store.put(queued);
  }
}

/** A sender that records each attempted `client_id` and succeeds. */
function okSend(
  calls: string[],
  result: Partial<AddEventResult> = {}
): QueueSend {
  return async (sent) => {
    calls.push(sent.client_id ?? "?");
    return { id: `id-${sent.client_id ?? "?"}`, inserted: 1, ...result };
  };
}

/** A sender that records the attempt and always fails with `err`. */
function failSend(calls: string[], err: unknown): QueueSend {
  return async (sent) => {
    calls.push(sent.client_id ?? "?");
    throw err;
  };
}

function networkError(): ApiError {
  return new ApiError("network", null, "Could not reach the server: offline");
}

function timeoutError(): ApiError {
  return new ApiError("network", null, "Request timed out after 10000 ms");
}

function httpError(status: number, message?: string): ApiError {
  return new ApiError(
    "http",
    status,
    message ?? `Request failed with status ${status}`
  );
}

class FakeStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

describe("flushQueue", () => {
  test("sends pending entries oldest created_at first", async () => {
    const store = createMemoryStore();
    await seed(
      store,
      entry("b", T1),
      entry("a", T0),
      entry("c", T2)
    );

    const calls: string[] = [];
    const result = await flushQueue(store, okSend(calls));

    expect(calls).toEqual(["a", "b", "c"]);
    expect(result).toEqual({ sent: 3, remaining: 0, rejected: 0 });
    expect(await store.list()).toEqual([]);
  });

  test("success removes the entry; inserted: 0 counts as success too", async () => {
    const store = createMemoryStore();
    await seed(store, entry("a", T0), entry("b", T1));

    const calls: string[] = [];
    const result = await flushQueue(store, okSend(calls, { inserted: 0 }));

    expect(result.sent).toBe(2);
    expect(result.remaining).toBe(0);
    expect(await store.list()).toEqual([]);
  });

  test("network error keeps the entry with attempts + last_error and stops the flush", async () => {
    const store = createMemoryStore();
    await seed(store, entry("a", T0), entry("b", T1));

    const calls: string[] = [];
    const result = await flushQueue(store, failSend(calls, networkError()), () => T2);

    expect(calls).toEqual(["a"]);
    expect(result).toEqual({ sent: 0, remaining: 2, rejected: 0 });

    const [a] = await store.list();
    expect(a?.client_id).toBe("a");
    expect(a?.status).toBe("pending");
    expect(a?.attempts).toBe(1);
    expect(a?.last_attempt_at).toBe(T2);
    expect(a?.last_error).toBe("Could not reach the server: offline");
  });

  test("timeout, 503 and 429 are retryable: kept, one attempt, flush stops", async () => {
    for (const err of [timeoutError(), httpError(503), httpError(429)]) {
      const store = createMemoryStore();
      await seed(store, entry("a", T0), entry("b", T1));

      const calls: string[] = [];
      const result = await flushQueue(store, failSend(calls, err));

      expect(calls).toEqual(["a"]);
      expect(result.sent).toBe(0);
      const [kept] = await store.list();
      expect(kept?.attempts).toBe(1);
      expect(kept?.last_error).toBe(err.message);
    }
  });

  test("400 marks the entry rejected and continues with the next", async () => {
    const store = createMemoryStore();
    await seed(store, entry("a", T0), entry("b", T1));

    const calls: string[] = [];
    const send: QueueSend = async (sent) => {
      calls.push(sent.client_id ?? "?");
      if (sent.client_id === "a") {
        throw httpError(400, "Invalid started_at: bad");
      }
      return { id: "id-b", inserted: 1 };
    };
    const result = await flushQueue(store, send, () => T2);

    expect(calls).toEqual(["a", "b"]);
    expect(result).toEqual({ sent: 1, remaining: 0, rejected: 1 });

    const [a] = await store.list();
    expect(a?.client_id).toBe("a");
    expect(a?.status).toBe("rejected");
    expect(a?.attempts).toBe(1);
    expect(a?.last_attempt_at).toBe(T2);
    expect(a?.last_error).toBe("Invalid started_at: bad");
  });

  test("422 is rejected as well", async () => {
    const store = createMemoryStore();
    await seed(store, entry("a", T0));

    const calls: string[] = [];
    const result = await flushQueue(store, failSend(calls, httpError(422)));

    expect(calls).toEqual(["a"]);
    expect(result.rejected).toBe(1);
    const [a] = await store.list();
    expect(a?.status).toBe("rejected");
  });

  test("rejected entries are not resent by later flushes", async () => {
    const store = createMemoryStore();
    await seed(store, entry("a", T0), entry("b", T1));

    const rejecting: QueueSend = async (sent) => {
      if (sent.client_id === "a") {
        throw httpError(400, "Invalid started_at: bad");
      }
      return { id: "id-b", inserted: 1 };
    };
    await flushQueue(store, rejecting);

    const calls: string[] = [];
    const second = await flushQueue(store, okSend(calls));

    // Only the still-pending "b" remains to be sent; "a" is skipped.
    expect(calls).toEqual([]);
    expect(second).toEqual({ sent: 0, remaining: 0, rejected: 0 });
  });

  test("attempts accumulate across flushes", async () => {
    const store = createMemoryStore();
    await seed(store, entry("a", T0));

    await flushQueue(store, failSend([], networkError()), () => T1);
    await flushQueue(store, failSend([], networkError()), () => T2);

    const [a] = await store.list();
    expect(a?.attempts).toBe(2);
    expect(a?.last_attempt_at).toBe(T2);
  });

  test("two concurrent flushes send each entry exactly once", async () => {
    const store = createMemoryStore();
    await seed(store, entry("a", T0), entry("b", T1));

    const calls: string[] = [];
    const send: QueueSend = async (sent) => {
      calls.push(sent.client_id ?? "?");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { id: `id-${sent.client_id}`, inserted: 1 };
    };

    const [first, second] = await Promise.all([
      flushQueue(store, send),
      flushQueue(store, send),
    ]);

    const counts = new Map<string, number>();
    for (const id of calls) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({ a: 1, b: 1 });
    expect(first.sent + second.sent).toBe(2);
    expect(await store.list()).toEqual([]);
  });
});

describe("classifySendError", () => {
  test("network failures and timeouts are retry", () => {
    expect(classifySendError(networkError())).toBe("retry");
    expect(classifySendError(timeoutError())).toBe("retry");
  });

  test("HTTP 408/425/429/5xx are retry", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(classifySendError(httpError(status))).toBe("retry");
    }
  });

  test("other 4xx are rejected", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(classifySendError(httpError(status))).toBe("rejected");
    }
  });

  test("unknown errors are retry (never drop an entry on a guess)", () => {
    expect(classifySendError(new Error("boom"))).toBe("retry");
    expect(classifySendError("boom")).toBe("retry");
  });
});

describe("newClientId", () => {
  test("default path returns a v4 UUID", () => {
    expect(newClientId()).toMatch(UUID_V4_RE);
  });

  test("fallback path builds a v4 UUID from getRandomValues", () => {
    const deterministic = newClientId({
      getRandomValues: (array: Uint8Array) => array.fill(7),
    });
    expect(deterministic).toMatch(UUID_V4_RE);
    expect(deterministic).toBe("07070707-0707-4707-8707-070707070707");
  });
});

describe("enqueueEntry", () => {
  test("stamps created_at and writes the client_id into the body", async () => {
    const store = createMemoryStore();
    const input = body({ title: "Synthetic Offline" });

    const queued = await enqueueEntry(store, input, { now: () => T0 });

    expect(queued.created_at).toBe(T0);
    expect(queued.status).toBe("pending");
    expect(queued.attempts).toBe(0);
    expect(queued.last_attempt_at).toBeNull();
    expect(queued.last_error).toBeNull();
    expect(queued.client_id).toMatch(UUID_V4_RE);
    expect(input.client_id).toBe(queued.client_id);

    const [stored] = await store.list();
    expect(stored?.body.client_id).toBe(queued.client_id);
    expect(stored?.body.title).toBe("Synthetic Offline");
  });

  test("records a failed attempt when enqueueing after a send error", async () => {
    const store = createMemoryStore();
    const queued = await enqueueEntry(store, body({ client_id: "a" }), {
      now: () => T0,
      attempts: 1,
      lastError: "Request timed out after 10000 ms",
      lastAttemptAt: T0,
    });

    expect(queued.attempts).toBe(1);
    expect(queued.last_error).toBe("Request timed out after 10000 ms");
    expect(queued.last_attempt_at).toBe(T0);
  });
});

describe("localStorage store", () => {
  test("keeps entries under one key; put updates by client_id; remove deletes", async () => {
    const storage = new FakeStorage();
    const store = createLocalStorageStore(storage);

    await store.put(entry("a", T0));
    await store.put(entry("b", T1));
    expect(storage.map.size).toBe(1);
    expect(storage.map.has("inputtracker.queue")).toBe(true);
    expect((await store.list()).map((e) => e.client_id)).toEqual(["a", "b"]);

    await store.put({ ...entry("a", T0), attempts: 2 });
    const afterUpdate = await store.list();
    expect(afterUpdate).toHaveLength(2);
    expect(afterUpdate.find((e) => e.client_id === "a")?.attempts).toBe(2);

    await store.remove("a");
    expect((await store.list()).map((e) => e.client_id)).toEqual(["b"]);
  });

  test("tolerates corrupt JSON", async () => {
    const storage = new FakeStorage();
    storage.setItem("inputtracker.queue", "{not json");
    const store = createLocalStorageStore(storage);

    expect(await store.list()).toEqual([]);

    await store.put(entry("a", T0));
    expect((await store.list()).map((e) => e.client_id)).toEqual(["a"]);
  });
});

describe("queue subscription", () => {
  test("notified on enqueue, remove and status change", async () => {
    const reasons: string[] = [];
    const unsubscribe = subscribeQueue((reason) => reasons.push(reason));
    try {
      const store = createMemoryStore();

      await enqueueEntry(store, body({ client_id: "a" }), { now: () => T0 });
      expect(reasons).toEqual(["enqueue"]);

      await flushQueue(store, failSend([], httpError(400, "Invalid started_at")));
      expect(reasons).toEqual(["enqueue", "update"]);

      await removeQueuedEntry(store, "a");
      expect(reasons).toEqual(["enqueue", "update", "remove"]);

      await enqueueEntry(store, body({ client_id: "b" }), { now: () => T0 });
      await flushQueue(store, okSend([]));
      expect(reasons).toEqual([
        "enqueue",
        "update",
        "remove",
        "enqueue",
        "remove",
      ]);
    } finally {
      unsubscribe();
    }
  });

  test("unsubscribe stops the notifications; listener errors are contained", async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeQueue(() => {
      seen.push("first");
      throw new Error("listener bug");
    });

    // A throwing listener must not break notifyQueueChanged.
    expect(() => notifyQueueChanged("enqueue")).not.toThrow();
    expect(seen).toEqual(["first"]);

    unsubscribe();
    notifyQueueChanged("remove");
    expect(seen).toEqual(["first"]);
  });
});
