/**
 * ActivityWatch types.
 *
 * Models the local REST API shapes from ActivityWatch and aw-watcher-web:
 * - Bucket metadata: id, type ("web.tab.current"), client, hostname, etc.
 * - Events: id, timestamp (ISO 8601 UTC), duration (float seconds), data
 *   (url, title, audible, incognito, tabCount).
 */

export interface AwBucket {
  id: string;
  type: string;
  client?: string;
  hostname?: string;
  [key: string]: unknown;
}

export interface AwEventData {
  url?: string;
  title?: string;
  audible?: boolean;
  incognito?: boolean;
  tabCount?: number;
  [key: string]: unknown;
}

export interface AwRawEvent {
  id?: number;
  timestamp: string;
  duration: number;
  data?: AwEventData;
}
