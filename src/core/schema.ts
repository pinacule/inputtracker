export interface EventRow {
  id: number;
  record_hash: string;
  source: string;
  source_kind: string;
  source_id: string;
  external_ids: string | null;
  media_type: string;
  title: string | null;
  parent_title: string | null;
  season: number | null;
  episode: number | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  progress: number | null;
  device: string | null;
  raw: string | null;
  ingested_at: string;
  ingest_run_id: number | null;
}

export type IngestRunStatus = "running" | "ok" | "failed";

export interface IngestRunRow {
  id: number;
  source: string;
  kind: string | null;
  started_at: string;
  finished_at: string | null;
  status: IngestRunStatus;
  rows_seen: number;
  rows_inserted: number;
  error: string | null;
}

export interface SyncStateRow {
  source: string;
  cursor: string | null;
  updated_at: string;
}

export interface SchemaMigrationRow {
  version: number;
  applied_at: string;
}

export interface GoalRow {
  id: number;
  record_hash: string;
  goal_id: string;
  rev_id: string;
  year: number;
  metric: string;
  source: string | null;
  media_type: string | null;
  target: number;
  archived: number;
  created_at: string;
}

export interface AnnotationRow {
  id: number;
  record_hash: string;
  source: string;
  title: string;
  rev_id: string;
  rating: number | null;
  note: string | null;
  created_at: string;
}

export type YoutubeEnrichmentStatus = "ok" | "not_found" | "failed";

export interface YoutubeVideoRow {
  id: number;
  video_id: string;
  title: string | null;
  channel: string | null;
  channel_url: string | null;
  channel_id: string | null;
  thumbnail_url: string | null;
  genre: string | null;
  status: YoutubeEnrichmentStatus;
  http_status: number | null;
  retry_after: string | null;
  fetched_at: string;
}

export interface YoutubeChannelTopicRow {
  id: number;
  record_hash: string;
  channel: string;
  normalized_channel: string;
  topic: string | null;
  created_at: string;
}
