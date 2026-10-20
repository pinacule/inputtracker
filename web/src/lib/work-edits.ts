/**
 * Optimistic work override cache, 404 fallback layer, and Undo toast bus
 * for InputTracker v2.1.
 *
 * Ensures that quick ratings, work edits, hiding/unhiding, and channel topic
 * updates apply optimistically in 0ms across every view with 1-click Undo,
 * and degrade gracefully when v2.1 backend endpoints return 404.
 */

import {
  editWork,
  getLibraryWork,
  getHiddenWorks,
  saveAnnotation,
  setChannelTopic,
  type Category,
  type LibraryWork,
  type LibraryWorkDetail,
  type WorkEdit,
  type WorkStatus,
} from "../api";

export interface StoredWorkOverride {
  key: string;
  title?: string | null;
  category?: Category | null;
  status?: WorkStatus | null;
  rating?: number | null;
  note?: string | null;
  hidden?: boolean;
  meta?: WorkEdit["meta"];
  topic?: string | null;
  snapshot?: Partial<LibraryWork>;
  updatedAt: string;
}

const OVERRIDES_Map = new Map<string, StoredWorkOverride>();
const CHANNEL_TOPICS_MAP = new Map<string, string | null>();
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // Ignore listener errors.
    }
  }
}

export function subscribeWorkEdits(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getWorkOverride(key: string): StoredWorkOverride | undefined {
  return OVERRIDES_Map.get(key);
}

export function getWorkRatingOverride(
  key: string,
  fallbackRating: number | null = null
): number | null {
  const ov = OVERRIDES_Map.get(key);
  if (ov && ov.rating !== undefined) {
    return ov.rating;
  }
  return fallbackRating;
}

export function getChannelTopicOverride(
  channel: string,
  fallbackTopic: string | null = null
): string | null {
  const norm = channel.trim().toLowerCase();
  if (CHANNEL_TOPICS_MAP.has(norm)) {
    return CHANNEL_TOPICS_MAP.get(norm) ?? null;
  }
  return fallbackTopic;
}

/**
 * Applies optimistic overrides to a list of `LibraryWork`s, removing works
 * marked `hidden: true`.
 */
export function applyWorkOverridesToList(
  works: readonly LibraryWork[]
): LibraryWork[] {
  const result: LibraryWork[] = [];
  for (const work of works) {
    const ov = OVERRIDES_Map.get(work.key);
    if (ov?.hidden === true) {
      continue;
    }
    const chTopic =
      work.category === "youtube" && work.channel
        ? getChannelTopicOverride(work.channel, work.topic)
        : work.topic;

    if (!ov) {
      if (chTopic !== work.topic) {
        result.push({ ...work, topic: chTopic });
      } else {
        result.push(work);
      }
      continue;
    }

    result.push({
      ...work,
      title: ov.title !== undefined && ov.title !== null ? ov.title : work.title,
      category:
        ov.category !== undefined && ov.category !== null
          ? ov.category
          : work.category,
      status:
        ov.status !== undefined && ov.status !== null ? ov.status : work.status,
      rating: ov.rating !== undefined ? ov.rating : work.rating,
      topic: ov.topic !== undefined ? ov.topic : chTopic,
      edited: true,
    });
  }
  return result;
}

/**
 * Applies optimistic overrides to a single `LibraryWorkDetail`.
 */
export function applyWorkOverrideToDetail(
  detail: LibraryWorkDetail
): LibraryWorkDetail {
  const ov = OVERRIDES_Map.get(detail.key);
  if (!ov) {
    return detail;
  }
  return {
    ...detail,
    title: ov.title !== undefined && ov.title !== null ? ov.title : detail.title,
    category:
      ov.category !== undefined && ov.category !== null
        ? ov.category
        : detail.category,
    status:
      ov.status !== undefined && ov.status !== null ? ov.status : detail.status,
    rating: ov.rating !== undefined ? ov.rating : detail.rating,
    note: ov.note !== undefined ? ov.note : detail.note,
    topic: ov.topic !== undefined ? ov.topic : detail.topic,
    edited: true,
  };
}

export interface PerformWorkEditContext {
  title?: string;
  category?: Category;
  status?: WorkStatus;
  rating?: number | null;
  note?: string | null;
  topic?: string | null;
  cover_url?: string | null;
  total_minutes?: number;
  units?: number;
  source?: string;
}

/**
 * Optimistically applies `edit` to `workKey`, sends `POST /api/library/work/edit`,
 * degrades gracefully on 404, and returns an `undo()` function.
 */
export async function performWorkEdit(
  workKey: string,
  edit: WorkEdit,
  context?: PerformWorkEditContext
): Promise<{
  detail: LibraryWorkDetail | null;
  undo: () => Promise<void>;
}> {
  const prevOverride = OVERRIDES_Map.get(workKey);
  const reverseEdit: WorkEdit = {};

  if ("title" in edit) {
    reverseEdit.title =
      prevOverride?.title !== undefined
        ? prevOverride.title
        : (context?.title ?? null);
  }
  if ("category" in edit) {
    reverseEdit.category =
      prevOverride?.category !== undefined
        ? prevOverride.category
        : (context?.category ?? null);
  }
  if ("status" in edit) {
    reverseEdit.status =
      prevOverride?.status !== undefined
        ? prevOverride.status
        : (context?.status ?? null);
  }
  if ("rating" in edit) {
    reverseEdit.rating =
      prevOverride?.rating !== undefined
        ? prevOverride.rating
        : (context?.rating ?? null);
  }
  if ("note" in edit) {
    reverseEdit.note =
      prevOverride?.note !== undefined
        ? prevOverride.note
        : (context?.note ?? null);
  }
  if ("hidden" in edit) {
    reverseEdit.hidden = prevOverride?.hidden ?? false;
  }
  if ("topic" in edit) {
    reverseEdit.topic =
      prevOverride?.topic !== undefined
        ? prevOverride.topic
        : (context?.topic ?? null);
  }
  if ("meta" in edit) {
    if (prevOverride?.meta !== undefined) {
      reverseEdit.meta = prevOverride.meta;
    } else {
      // null is now an explicit unlink, not "undo to the archive's original link".
      // Capture the actual stored provider before a link/unlink so Undo cannot drop it.
      const previousDetail = await getLibraryWork(workKey).catch(() => null);
      const snapshot = previousDetail?.work_snapshot;
      if (snapshot) {
        reverseEdit.meta = snapshot.provider !== "manual"
          ? { provider: snapshot.provider, provider_id: snapshot.provider_id }
          : null;
      }
      // A missing/failed detail response cannot establish that the work was manual.
      // Do not invent an unlink for Undo when the previous link is unknown.
    }
  }

  const nextOverride: StoredWorkOverride = {
    ...(prevOverride ?? { key: workKey }),
    ...edit,
    snapshot: {
      ...(prevOverride?.snapshot ?? {}),
      key: workKey,
      title: edit.title ?? context?.title ?? prevOverride?.snapshot?.title ?? workKey,
      category:
        edit.category ??
        context?.category ??
        prevOverride?.snapshot?.category ??
        "other",
      cover_url: context?.cover_url ?? prevOverride?.snapshot?.cover_url ?? null,
      total_minutes:
        context?.total_minutes ?? prevOverride?.snapshot?.total_minutes ?? 0,
      units: context?.units ?? prevOverride?.snapshot?.units ?? 1,
      status:
        edit.status ??
        context?.status ??
        prevOverride?.snapshot?.status ??
        "unknown",
      rating:
        edit.rating !== undefined
          ? edit.rating
          : (context?.rating ?? prevOverride?.snapshot?.rating ?? null),
    },
    updatedAt: new Date().toISOString(),
  };

  OVERRIDES_Map.set(workKey, nextOverride);
  notifyListeners();

  const undo = async () => {
    if (prevOverride) {
      OVERRIDES_Map.set(workKey, prevOverride);
    } else {
      OVERRIDES_Map.delete(workKey);
    }
    notifyListeners();
    try {
      await editWork(workKey, reverseEdit);
      notifyListeners();
    } catch {
      // Ignore 404/network error on undo fallback.
    }
  };

  try {
    const detail = await editWork(workKey, edit);
    notifyListeners();
    return { detail, undo };
  } catch {
    // Graceful degradation when backend v2.1 route is not yet mounted (404):
    // If rating or note was edited and we have a title, also save an annotation
    // when rating is an integer 1..10 so legacy endpoints stay in sync.
    if (
      (edit.rating !== undefined || edit.note !== undefined) &&
      context?.title
    ) {
      const roundedRating =
        edit.rating !== null && edit.rating !== undefined
          ? Math.max(1, Math.min(10, Math.round(edit.rating)))
          : null;
      await saveAnnotation({
        source: context.source ?? "manual",
        title: context.title,
        rating: roundedRating,
        note: edit.note ?? context.note ?? null,
      }).catch(() => null);
    }
    return { detail: null, undo };
  }
}

/**
 * Fetches hidden works from `/api/library/hidden`, degrading gracefully on 404
 * by returning works hidden in the current session.
 */
export async function fetchHiddenWorksGraceful(): Promise<LibraryWork[]> {
  const localHidden: LibraryWork[] = [];
  for (const ov of OVERRIDES_Map.values()) {
    if (ov.hidden === true && ov.snapshot) {
      localHidden.push({
        key: ov.key,
        category: ov.snapshot.category ?? "other",
        title: ov.snapshot.title ?? ov.key,
        cover_url: ov.snapshot.cover_url ?? null,
        total_minutes: ov.snapshot.total_minutes ?? 0,
        units: ov.snapshot.units ?? 1,
        first_at: null,
        last_at: ov.updatedAt,
        status: ov.snapshot.status ?? "unknown",
        rating: ov.snapshot.rating ?? null,
        sources: ["manual"],
        edited: true,
        channel: null,
        topic: ov.topic ?? null,
        progress: null,
        creator: null,
      });
    }
  }

  try {
    const res = await getHiddenWorks();
    const serverWorks = res.works ?? [];
    const seen = new Set(serverWorks.map((w) => w.key));
    for (const loc of localHidden) {
      if (!seen.has(loc.key)) {
        serverWorks.push(loc);
      }
    }
    return serverWorks;
  } catch {
    return localHidden;
  }
}

/**
 * Optimistically sets a YouTube channel's topic and calls `POST /api/youtube/channel-topic`,
 * degrading gracefully on 404.
 */
export async function performSetChannelTopic(
  channel: string,
  topic: string | null,
  previousTopic: string | null = null
): Promise<{ undo: () => Promise<void> }> {
  const norm = channel.trim().toLowerCase();
  const normalizedTopic = topic && topic.trim() !== "" ? topic.trim() : null;
  CHANNEL_TOPICS_MAP.set(norm, normalizedTopic);
  notifyListeners();

  const undo = async () => {
    CHANNEL_TOPICS_MAP.set(norm, previousTopic);
    notifyListeners();
    await setChannelTopic(channel, previousTopic).catch(() => null);
  };

  await setChannelTopic(channel, normalizedTopic).catch(() => null);
  return { undo };
}

// --- Global Toast Bus (with Undo Action Support) ---------------------------

export interface AppToast {
  readonly id: string;
  readonly message: string;
  readonly variant?: "info" | "success" | "warning" | "danger";
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}

let activeToasts: AppToast[] = [];
const toastListeners = new Set<(toasts: readonly AppToast[]) => void>();

function notifyToastListeners(): void {
  const snapshot = [...activeToasts];
  for (const fn of toastListeners) {
    try {
      fn(snapshot);
    } catch {
      // Ignore listener errors.
    }
  }
}

export function subscribeToasts(
  listener: (toasts: readonly AppToast[]) => void
): () => void {
  toastListeners.add(listener);
  listener([...activeToasts]);
  return () => {
    toastListeners.delete(listener);
  };
}

export function dismissToast(id: string): void {
  activeToasts = activeToasts.filter((t) => t.id !== id);
  notifyToastListeners();
}

export function pushToast(
  toast: Omit<AppToast, "id"> & { id?: string; durationMs?: number }
): string {
  const id = toast.id ?? `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const entry: AppToast = {
    id,
    message: toast.message,
    variant: toast.variant ?? "success",
    actionLabel: toast.actionLabel,
    onAction: toast.onAction,
  };
  activeToasts = [...activeToasts.slice(-3), entry];
  notifyToastListeners();

  const durationMs = toast.durationMs ?? 5500;
  if (durationMs > 0 && typeof setTimeout === "function") {
    setTimeout(() => {
      dismissToast(id);
    }, durationMs);
  }
  return id;
}
