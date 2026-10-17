/**
 * Offline queue for manual entries.
 *
 * When the server is unreachable, an unsent Add-form entry is kept on this
 * device (IndexedDB, falling back to localStorage) and sent again once the
 * server answers. Every entry carries a `client_id`; the server turns it into
 * the row's `source_id`, so sending the same body twice never creates a second
 * row — a retry after a lost response is safe. The queued copy is deleted as
 * soon as the server confirms the entry.
 *
 * Browser-only facilities (IndexedDB, localStorage, Web Locks, timers, the
 * `online`/`visibilitychange` events) are reached through `globalThis` with
 * minimal structural types, so this module stays testable under Bun with no
 * DOM and no new dependencies.
 */

import { ApiError, addEvent } from "../api";
import type { AddEventResult, ManualEventInput } from "../api";

// --- Types -----------------------------------------------------------------

export type QueueEntryStatus = "pending" | "rejected";

/**
 * One unsent entry kept on this device. `rejected` means the server answered
 * and refused the body (4xx): it needs the user, so flushes skip it.
 */
export interface QueuedEntry {
  /** Also sent to the server; the row's `source_id` becomes `client:<uuid>`. */
  client_id: string;
  /** Exactly what the Add form built, including `client_id`. */
  body: ManualEventInput;
  /** UTC ISO — queue order, oldest first. */
  created_at: string;
  attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
  status: QueueEntryStatus;
}

export interface QueueStore {
  list(): Promise<QueuedEntry[]>;
  put(entry: QueuedEntry): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Sends one queued body; resolves on any 2xx (including `inserted: 0`). */
export type QueueSend = (body: ManualEventInput) => Promise<AddEventResult>;

/** Why the queue changed: something was added, removed, or updated in place. */
export type QueueChangeReason = "enqueue" | "remove" | "update";
export type QueueListener = (reason: QueueChangeReason) => void;

// --- In-memory store (tests) ------------------------------------------------

export function createMemoryStore(): QueueStore {
  const entries = new Map<string, QueuedEntry>();
  return {
    async list() {
      return [...entries.values()];
    },
    async put(entry) {
      entries.set(entry.client_id, entry);
    },
    async remove(id) {
      entries.delete(id);
    },
  };
}

// --- Minimal structural types for browser globals ---------------------------

interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface MinimalWindow {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface MinimalDocument {
  hidden: boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface MinimalLockManager {
  request<T>(name: string, grantedCallback: () => Promise<T>): Promise<T>;
}

interface MinimalNavigator {
  onLine?: boolean;
  locks?: MinimalLockManager;
  storage?: { persist?: () => Promise<boolean> };
}

function browserGlobal<T>(name: string): T | null {
  const value = (globalThis as unknown as Record<string, unknown>)[name];
  return typeof value === "object" && value !== null ? (value as T) : null;
}

function getNavigator(): MinimalNavigator | null {
  return browserGlobal<MinimalNavigator>("navigator");
}

function getWindow(): MinimalWindow | null {
  return browserGlobal<MinimalWindow>("window");
}

function getDocument(): MinimalDocument | null {
  return browserGlobal<MinimalDocument>("document");
}

// --- localStorage store (fallback) ------------------------------------------

export const LOCAL_STORAGE_KEY = "inputtracker.queue";

/** Queue store over a `localStorage`-like object (injectable for tests). */
export function createLocalStorageStore(storage: MinimalStorage): QueueStore {
  const read = (): QueuedEntry[] => {
    const raw = storage.getItem(LOCAL_STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as QueuedEntry[]) : [];
    } catch {
      return [];
    }
  };
  const write = (entries: QueuedEntry[]): void => {
    storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(entries));
  };
  return {
    async list() {
      return read();
    },
    async put(entry) {
      const entries = read();
      const index = entries.findIndex((e) => e.client_id === entry.client_id);
      if (index >= 0) {
        entries[index] = entry;
      } else {
        entries.push(entry);
      }
      write(entries);
    },
    async remove(id) {
      write(read().filter((e) => e.client_id !== id));
    },
  };
}

// --- IndexedDB store (browser) ----------------------------------------------

interface IdbRequestLike {
  readonly result: unknown;
  readonly error: unknown;
  onsuccess: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

interface IdbObjectStoreLike {
  getAll(): IdbRequestLike;
  put(value: unknown): IdbRequestLike;
  delete(key: string): IdbRequestLike;
}

interface IdbTransactionLike {
  objectStore(name: string): IdbObjectStoreLike;
}

interface IdbDatabaseLike {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options?: { keyPath?: string }): unknown;
  transaction(name: string): IdbTransactionLike;
}

interface IdbOpenRequestLike extends IdbRequestLike {
  onupgradeneeded: ((event: unknown) => void) | null;
}

interface IdbFactoryLike {
  open(name: string): IdbOpenRequestLike;
}

export const IDB_NAME = "inputtracker";
export const IDB_STORE_NAME = "queue";

function idbError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function requestToPromise(request: IdbRequestLike): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(idbError(request.error, "IndexedDB request failed"));
  });
}

function openIdbDatabase(factory: IdbFactoryLike): Promise<IdbDatabaseLike> {
  return new Promise((resolve, reject) => {
    const request = factory.open(IDB_NAME);
    request.onupgradeneeded = () => {
      const db = request.result as IdbDatabaseLike;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.createObjectStore(IDB_STORE_NAME, { keyPath: "client_id" });
      }
    };
    request.onsuccess = () => resolve(request.result as IdbDatabaseLike);
    request.onerror = () =>
      reject(idbError(request.error, "Could not open IndexedDB"));
  });
}

/** Thin `QueueStore` over one object store; all queue logic lives elsewhere. */
function createIdbStore(db: IdbDatabaseLike): QueueStore {
  return {
    async list() {
      const request = db
        .transaction(IDB_STORE_NAME)
        .objectStore(IDB_STORE_NAME)
        .getAll();
      const result = await requestToPromise(request);
      return Array.isArray(result) ? (result as QueuedEntry[]) : [];
    },
    async put(entry) {
      const request = db
        .transaction(IDB_STORE_NAME)
        .objectStore(IDB_STORE_NAME)
        .put(entry);
      await requestToPromise(request);
    },
    async remove(id) {
      const request = db
        .transaction(IDB_STORE_NAME)
        .objectStore(IDB_STORE_NAME)
        .delete(id);
      await requestToPromise(request);
    },
  };
}

function createBrowserLocalStorageStore(): QueueStore | null {
  const storage = browserGlobal<MinimalStorage>("localStorage");
  if (
    storage === null ||
    typeof storage.getItem !== "function" ||
    typeof storage.setItem !== "function"
  ) {
    return null;
  }
  try {
    // Probe once: privacy modes can throw here even though the type exists.
    storage.getItem(LOCAL_STORAGE_KEY);
    return createLocalStorageStore(storage);
  } catch {
    return null;
  }
}

/**
 * The browser queue store: IndexedDB (`inputtracker` / `queue`), falling back
 * to `localStorage` when IndexedDB is unavailable or throws. Returns `null`
 * when neither works — the caller must then tell the user the entry could not
 * be saved offline instead of pretending it was.
 */
export async function createIndexedDbStore(): Promise<QueueStore | null> {
  const factory = browserGlobal<IdbFactoryLike>("indexedDB");
  if (factory !== null && typeof factory.open === "function") {
    try {
      return createIdbStore(await openIdbDatabase(factory));
    } catch {
      // IndexedDB unavailable or broken (e.g. private mode): try localStorage.
    }
  }
  return createBrowserLocalStorageStore();
}

let defaultStorePromise: Promise<QueueStore | null> | null = null;

/** The process-wide browser store, created once on first use. */
export function getDefaultStore(): Promise<QueueStore | null> {
  if (defaultStorePromise === null) {
    defaultStorePromise = createIndexedDbStore().catch(() => null);
  }
  return defaultStorePromise;
}

// --- Client ids ---------------------------------------------------------------

interface RandomSourceLike {
  getRandomValues(array: Uint8Array): Uint8Array;
  randomUUID?: () => string;
}

function uuidV4FromRandomValues(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4 …
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // … variant 10
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}`;
}

/**
 * A fresh v4 UUID for an entry's `client_id`: `crypto.randomUUID()` when
 * available, else built from `crypto.getRandomValues`.
 */
export function newClientId(random?: RandomSourceLike): string {
  const source = random ?? browserGlobal<RandomSourceLike>("crypto");
  if (source === null) {
    throw new Error("crypto is not available to generate a client_id");
  }
  if (typeof source.randomUUID === "function") {
    return source.randomUUID();
  }
  return uuidV4FromRandomValues(source.getRandomValues(new Uint8Array(16)));
}

// --- Subscription -------------------------------------------------------------

const listeners = new Set<QueueListener>();

/** Subscribes to queue changes; returns an unsubscribe function. */
export function subscribeQueue(listener: QueueListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Notifies every listener that the queue changed (best effort). */
export function notifyQueueChanged(reason: QueueChangeReason = "update"): void {
  for (const listener of [...listeners]) {
    try {
      listener(reason);
    } catch {
      // A broken listener must not break the queue.
    }
  }
}

// --- Enqueue / update / remove helpers -----------------------------------------

let persistentStorageRequested = false;

/** Best-effort `navigator.storage.persist()` so the browser keeps the queue. */
export async function requestPersistentStorage(): Promise<boolean | null> {
  if (persistentStorageRequested) {
    return null;
  }
  persistentStorageRequested = true;
  try {
    return (await getNavigator()?.storage?.persist?.()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Adds an unsent entry to the queue. The body is stored exactly as the Add
 * form built it; when it has no `client_id` yet, one is generated and written
 * back into the body so the queued copy always carries the id it will be sent
 * with.
 */
export async function enqueueEntry(
  store: QueueStore,
  body: ManualEventInput,
  options: {
    now?: () => string;
    attempts?: number;
    lastError?: string | null;
    lastAttemptAt?: string | null;
  } = {}
): Promise<QueuedEntry> {
  const client_id = body.client_id ?? newClientId();
  body.client_id = client_id;
  const now = options.now ?? (() => new Date().toISOString());
  const entry: QueuedEntry = {
    client_id,
    body,
    created_at: now(),
    attempts: options.attempts ?? 0,
    last_attempt_at: options.lastAttemptAt ?? null,
    last_error: options.lastError ?? null,
    status: "pending",
  };
  await store.put(entry);
  void requestPersistentStorage();
  notifyQueueChanged("enqueue");
  return entry;
}

/** Overwrites an entry (after an edit or a failed attempt) and notifies. */
export async function putQueuedEntry(
  store: QueueStore,
  entry: QueuedEntry
): Promise<void> {
  await store.put(entry);
  notifyQueueChanged("update");
}

/** Deletes one unsent copy from this device; nothing on the server changes. */
export async function removeQueuedEntry(
  store: QueueStore,
  id: string
): Promise<void> {
  await store.remove(id);
  notifyQueueChanged("remove");
}

// --- Flush ---------------------------------------------------------------------

export type SendErrorKind = "retry" | "rejected";

const RETRY_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

/**
 * Decides what a failed send means: `"retry"` (network failure, timeout, HTTP
 * 408/425/429/5xx) keeps the entry queued for a later flush; `"rejected"`
 * (any other 4xx) marks it for the user. Unknown, non-`ApiError` failures
 * count as `"retry"` — an entry must never be dropped on a guess.
 */
export function classifySendError(err: unknown): SendErrorKind {
  if (!(err instanceof ApiError)) {
    return "retry";
  }
  if (err.kind === "network" || err.status === null) {
    return "retry";
  }
  if (err.status >= 500 || RETRY_HTTP_STATUSES.has(err.status)) {
    return "retry";
  }
  return "rejected";
}

export interface FlushResult {
  /** Entries sent with a 2xx response (including `inserted: 0`) and removed. */
  sent: number;
  /** Pending entries still in the store when the flush ended. */
  remaining: number;
  /** Entries the server rejected (4xx) during this flush. */
  rejected: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function byCreatedOldestFirst(a: QueuedEntry, b: QueuedEntry): number {
  if (a.created_at < b.created_at) {
    return -1;
  }
  if (a.created_at > b.created_at) {
    return 1;
  }
  return 0;
}

const QUEUE_LOCK_NAME = "inputtracker-queue";

let lockTail: Promise<unknown> = Promise.resolve();

function withInModuleLock<T>(run: () => Promise<T>): Promise<T> {
  const next = lockTail.then(run, run);
  lockTail = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/** Serialises flushes across tabs (Web Locks) or, failing that, in-module. */
function withQueueLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = getNavigator()?.locks;
  if (locks && typeof locks.request === "function") {
    return locks.request(QUEUE_LOCK_NAME, run);
  }
  return withInModuleLock(run);
}

async function runFlush(
  store: QueueStore,
  send: QueueSend,
  now: () => string
): Promise<FlushResult> {
  const pending = (await store.list())
    .filter((entry) => entry.status === "pending")
    .sort(byCreatedOldestFirst);

  let sent = 0;
  let rejected = 0;

  for (const entry of pending) {
    try {
      await send(entry.body);
      await store.remove(entry.client_id);
      sent += 1;
      notifyQueueChanged("remove");
    } catch (err) {
      const failed: QueuedEntry = {
        ...entry,
        attempts: entry.attempts + 1,
        last_attempt_at: now(),
        last_error: errorMessage(err),
      };
      if (classifySendError(err) === "retry") {
        await store.put(failed);
        notifyQueueChanged("update");
        // The server is unreachable: stop the flush instead of hammering it.
        return countRemaining();
      }
      failed.status = "rejected";
      await store.put(failed);
      rejected += 1;
      notifyQueueChanged("update");
    }
  }

  return countRemaining();

  async function countRemaining(): Promise<FlushResult> {
    const left = await store.list();
    return {
      sent,
      remaining: left.filter((entry) => entry.status === "pending").length,
      rejected,
    };
  }
}

/**
 * Sends pending entries, oldest `created_at` first.
 *
 * Any 2xx (including `inserted: 0` — the server already had the row) counts as
 * success and removes the entry. A `"retry"` failure bumps `attempts`, records
 * `last_error`/`last_attempt_at` and **stops** the flush. A `"rejected"`
 * failure marks the entry `rejected` with the server's message and continues
 * with the next one.
 *
 * Single flight: concurrent calls — also across tabs, via the Web Locks API
 * when available — serialise on a lock, so no entry is ever sent twice.
 */
export function flushQueue(
  store: QueueStore,
  send: QueueSend,
  now: () => string = () => new Date().toISOString()
): Promise<FlushResult> {
  return withQueueLock(() => runFlush(store, send, now));
}

// --- Background triggers --------------------------------------------------------

export interface QueueSyncOptions {
  /** Use a specific store (tests); default: the process-wide browser store. */
  store?: QueueStore;
  /** Use a specific sender (tests); default: `addEvent` from `../api`. */
  send?: QueueSend;
  /** Poll interval in ms while pending entries exist (default 60 000). */
  intervalMs?: number;
}

export interface QueueSyncHandle {
  /** Triggers a flush attempt now (no-op while offline or without storage). */
  flushNow: () => void;
  /** Removes the listeners and stops the timer. */
  stop: () => void;
}

const DEFAULT_FLUSH_INTERVAL_MS = 60_000;

/**
 * Wires the flush triggers: app start, the `online` event, the page becoming
 * visible, right after something is queued or removed (via the queue
 * subscription), and a 60 s timer while pending entries exist and the page is
 * visible. Never flushes while `navigator.onLine` is `false`.
 */
export function startQueueSync(options: QueueSyncOptions = {}): QueueSyncHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const send =
    options.send ?? ((queuedBody: ManualEventInput) => addEvent(queuedBody));
  const storePromise = options.store
    ? Promise.resolve(options.store)
    : getDefaultStore();

  let pumping = false;
  let pumpRequested = false;

  const pump = async (): Promise<void> => {
    if (pumping) {
      pumpRequested = true;
      return;
    }
    pumping = true;
    try {
      do {
        pumpRequested = false;
        if (getNavigator()?.onLine === false) {
          return;
        }
        const store = await storePromise;
        if (store === null) {
          return;
        }
        try {
          await flushQueue(store, send);
        } catch {
          // Storage failed; the entries stay queued and a later trigger
          // retries. Nothing here may pretend a send happened.
        }
      } while (pumpRequested);
    } finally {
      pumping = false;
    }
  };

  // "update" (attempts / status marks from a flush) must not re-trigger a
  // flush, or a permanently unreachable server would loop forever.
  const unsubscribe = subscribeQueue((reason) => {
    if (reason === "enqueue" || reason === "remove") {
      void pump();
    }
  });

  const win = getWindow();
  const doc = getDocument();
  const onOnline = () => void pump();
  const onVisibilityChange = () => {
    if (doc?.hidden === false) {
      void pump();
    }
  };
  win?.addEventListener("online", onOnline);
  doc?.addEventListener("visibilitychange", onVisibilityChange);

  let timer: ReturnType<typeof setInterval> | null = null;
  if (intervalMs > 0) {
    timer = setInterval(() => {
      if (doc?.hidden === true) {
        return;
      }
      void (async () => {
        const store = await storePromise;
        if (store === null) {
          return;
        }
        const entries = await store.list().catch(() => [] as QueuedEntry[]);
        if (entries.some((entry) => entry.status === "pending")) {
          void pump();
        }
      })();
    }, intervalMs);
  }

  void pump(); // app start

  return {
    flushNow: () => void pump(),
    stop: () => {
      unsubscribe();
      win?.removeEventListener("online", onOnline);
      doc?.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer !== null) {
        clearInterval(timer);
      }
    },
  };
}
