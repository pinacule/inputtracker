/**
 * Demo server with realistic synthetic data on a throw-away database.
 *
 * Workers building skins or testing the UI can run this server to explore
 * the full app without touching personal data or needing external sync tokens.
 *
 * Usage:
 *   bun scripts/demo-server.ts [--port 8790] [--dir <tmp dir>] [--today YYYY-MM-DD]
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CATEGORIES, categoryOf, type Category } from "../src/core/category.ts";
import { loadConfig } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { finishRun, insertEvents, startRun, type NewEvent } from "../src/core/events.ts";
import { localToUtcIso } from "../src/core/time.ts";
import { formatLocalParts } from "../src/server/aggregate.ts";
import { saveAnnotation } from "../src/server/annotations.ts";
import { saveArchiveEntry } from "../src/server/archive.ts";
import { main } from "../src/server/main.ts";
import { groupEventsIntoWorkComponents, workOverrideRecordHash } from "../src/server/overrides.ts";

export const DEMO_TITLES = [
  // Anime episodes & film & planned
  "The Resonance Exam",
  "Starlight Weaver",
  "Gravity Drift",
  "The Iron Comet",
  "Binary Pulse",
  "Forbidden Frequency",
  "Nebula Choir",
  "Solar Flare Protocol",
  "Fracture Point",
  "Astral Beacon",
  "The Quiet Orbit",
  "Dawn Across the Expanse",
  "Rain on Chrome",
  "Memory Alley",
  "Cybernetic Ghost",
  "Subway Katana",
  "Signal in the Smoke",
  "Underground Cipher",
  "Skyward Whispers",
  "Chrono Compass",

  // Series episodes & planned
  "Hello World",
  "Stack Overflow",
  "Concurrency",
  "Deadlock",
  "Garbage Collection",
  "Latency",
  "Race Condition",
  "Memory Leak",
  "Zero Day",
  "Clean Shutdown",
  "Descent",
  "Pressure Warning",
  "Thermal Vent",
  "The Abyss Signal",
  "Containment",
  "Station Horizon",

  // Films & planned
  "The Glass Orchard",
  "Echoes of Jupiter",
  "Shadows in the Mist",
  "The Clockwork Forest",

  // Books & planned
  "Chronicles of Rust",
  "The Architecture of Silence",
  "Quantum Garden",

  // Audiobooks & planned
  "Echoes of the Deep",
  "Winds of Aethelgard",
  "The Last Cartographer",

  // YouTube
  "Why Quantum Computers Freeze",
  "The Mystery of Fast Radio Bursts",
  "Is Time Real or Emergent?",
  "The Physics of Black Hole Acoustics",
  "Restoring a 200-Year-Old Workbench",
  "Hand-Carving a Walnut Bowl",
  "Japanese Joinery Without Nails",
  "Can You Browse the Modern Web on a 486?",
  "Building the Ultimate 90s Sound Card",
  "Overclocking Vintage Silicon",
  "The Science of Sourdough Hydration",
  "Perfecting Neapolitan Crust at Home",

  // Podcast
  "Ep 41: Attention Economy and Solitude",
  "Ep 42: The Architecture of Sleep",
  "Ep 43: How Language Shapes Perception",
  "Ep 44: The Future of Neurotechnology",
  "Ep 12: Crafting Pixel Art Aesthetics",
  "Ep 13: Roguelike Mechanics and Replayability",
  "Ep 14: Solo Dev Survival Guide",

  // Music
  "Midnight Neon",
  "Analog Sunset",
  "Low-Poly Dreams",
  "Stellar Drift",
  "Solar Wind",
  "Aurora Borealis",
  "Rainy Café Reverie",
  "Cobblestone Waltzes",
  "Autumn in Prague",

  // Shortform
  "Daily Shorts Feed",
  "Micro-Video Stream",

  // Other
  "Interactive Nebula Exhibit",
  "Live Coding Jam Session",
  "Virtual Museum Tour: Antiquities",
] as const;

export const DEMO_PARENT_TITLES = [
  "Starfall Academy",
  "Neon Ronin: 2099",
  "Silicon Horizons",
  "Deep Trench Outpost",
  "Elena Vance",
  "Kaelen Voss",
  "Dr. Evelyn Stone",
  "Marcus Sterling",
  "Rowan Ashcroft",
  "Mira Thorne",
  "Pocket Physics",
  "Artisan Woodcraft",
  "Retro Hardware Lab",
  "Culinary Geometry",
  "Modern Mindscape",
  "Indie Game Odyssey",
  "Velvet Frequency",
  "Cosmic Cascade",
  "The Paper Orchids",
] as const;

export interface DemoServerOptions {
  port?: number;
  dir?: string;
  today?: string;
  seed?: number;
}

export interface DemoServerInstance {
  server: ReturnType<typeof Bun.serve>;
  db: Database;
  dir: string;
  port: number;
  configPath: string;
  stop: () => void;
}

export interface SeedResult {
  inserted: number;
  daysSeeded: number;
  totalEvents: number;
}

function createRng(seed: number) {
  let s = seed >>> 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function getDateMinusDays(baseDateStr: string, days: number): string {
  const [y, m, d] = baseDateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - days, 12, 0, 0));
  const year = dt.getUTCFullYear();
  const month = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function resolveDemoDir(customDir?: string): string {
  if (customDir) {
    return resolve(customDir);
  }
  const taskDir = resolve(".task");
  if (existsSync(taskDir) && statSync(taskDir).isDirectory()) {
    return resolve(".task/demo");
  }
  return mkdtempSync(join(tmpdir(), "inputtracker-demo-"));
}

export function createDemoConfig(
  dir: string,
  port: number
): { configPath: string; dbPath: string; backupDir: string } {
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "inputtracker.db");
  const backupDir = join(dir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const configPath = join(dir, "inputtracker.config.toml");

  const tomlContent = [
    'timezone = "Europe/Bratislava"',
    "",
    "[server]",
    'bind = "127.0.0.1"',
    `port = ${port}`,
    "",
    "[storage]",
    `db_path = "${dbPath}"`,
    `backup_dir = "${backupDir}"`,
    "backup_keep = 14",
    "",
    "[covers]",
    "external = false",
    "",
    "[metadata]",
    "enabled = false",
    "",
  ].join("\n");

  writeFileSync(configPath, tomlContent, "utf8");
  return { configPath, dbPath, backupDir };
}

interface RawPoolItem {
  category: Category;
  media_type: NewEvent["media_type"];
  title: string;
  parent_title: string | null;
  duration_seconds: number;
  external_ids?: Record<string, unknown> | null;
  progress?: number | null;
  season?: number | null;
  episode?: number | null;
}

export function seedDemoData(
  db: Database,
  options: { today?: string; seed?: number } = {}
): SeedResult {
  const existing = db
    .query<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM events WHERE source = 'manual'"
    )
    .get();

  if (existing && existing.count > 0) {
    return { inserted: 0, daysSeeded: 0, totalEvents: existing.count };
  }

  const initialCount =
    db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM events;").get()
      ?.count ?? 0;

  const today =
    options.today ??
    formatLocalParts(new Date().toISOString(), "Europe/Bratislava").date;

  const seed = options.seed ?? hashString(today);
  const rng = createRng(seed);

  const starfallTitles = [
    "The Resonance Exam",
    "Starlight Weaver",
    "Gravity Drift",
    "The Iron Comet",
    "Binary Pulse",
    "Forbidden Frequency",
    "Nebula Choir",
    "Solar Flare Protocol",
    "Fracture Point",
    "Astral Beacon",
    "The Quiet Orbit",
    "Dawn Across the Expanse",
  ];

  const siliconTitles = [
    "Hello World",
    "Stack Overflow",
    "Concurrency",
    "Deadlock",
    "Garbage Collection",
    "Latency",
    "Race Condition",
    "Memory Leak",
    "Zero Day",
    "Clean Shutdown",
  ];

  const roninTitles = [
    "Rain on Chrome",
    "Memory Alley",
    "Cybernetic Ghost",
    "Subway Katana",
    "Signal in the Smoke",
    "Underground Cipher",
  ];

  const trenchTitles = [
    "Descent",
    "Pressure Warning",
    "Thermal Vent",
    "The Abyss Signal",
    "Containment",
  ];

  // Specific arc placements: dayOffset -> RawPoolItem[]
  const scheduledArc = new Map<number, RawPoolItem[]>();
  function scheduleItem(offset: number, item: RawPoolItem) {
    let list = scheduledArc.get(offset);
    if (!list) {
      list = [];
      scheduledArc.set(offset, list);
    }
    list.push(item);
  }

  // Finished Anime: Starfall Academy (12 episodes)
  const starfallOffsets = [116, 111, 106, 101, 95, 90, 84, 79, 73, 67, 61, 55];
  for (let i = 0; i < 12; i++) {
    scheduleItem(starfallOffsets[i]!, {
      category: "anime",
      media_type: "episode",
      title: starfallTitles[i]!,
      parent_title: "Starfall Academy",
      season: 1,
      episode: i + 1,
      duration_seconds: 1440,
      external_ids: { mal: 70001, anilist: 80001 },
    });
  }

  // Finished Series: Silicon Horizons (10 episodes)
  const siliconOffsets = [114, 109, 103, 97, 92, 86, 80, 74, 69, 63];
  for (let i = 0; i < 10; i++) {
    scheduleItem(siliconOffsets[i]!, {
      category: "series",
      media_type: "episode",
      title: siliconTitles[i]!,
      parent_title: "Silicon Horizons",
      season: 1,
      episode: i + 1,
      duration_seconds: 2700,
      external_ids: { tvmaze: 30001 },
    });
  }

  // Finished Book: Chronicles of Rust (8 sessions)
  const rustOffsets = [118, 112, 105, 98, 91, 83, 76, 68];
  const rustProgress = [0.15, 0.3, 0.45, 0.6, 0.75, 0.85, 0.95, 1.0];
  for (let i = 0; i < 8; i++) {
    scheduleItem(rustOffsets[i]!, {
      category: "book",
      media_type: "book",
      title: "Chronicles of Rust",
      parent_title: "Elena Vance",
      duration_seconds: 2400,
      progress: rustProgress[i],
      external_ids: { openlibrary: "OL99001M" },
    });
  }

  // Finished Audiobook: Echoes of the Deep (10 sessions)
  const deepOffsets = [117, 110, 104, 96, 89, 81, 75, 66, 58, 51];
  const deepProgress = [0.1, 0.2, 0.35, 0.45, 0.6, 0.7, 0.8, 0.9, 0.98, 1.0];
  for (let i = 0; i < 10; i++) {
    scheduleItem(deepOffsets[i]!, {
      category: "audiobook",
      media_type: "audiobook",
      title: "Echoes of the Deep",
      parent_title: "Marcus Sterling",
      duration_seconds: 2700,
      progress: deepProgress[i],
      external_ids: { abs_item: "abs-demo-001" },
    });
  }

  // Finished Films
  scheduleItem(85, {
    category: "film",
    media_type: "movie",
    title: "The Glass Orchard",
    parent_title: null,
    duration_seconds: 6840,
    external_ids: { imdb: "tt9900001" },
  });

  scheduleItem(70, {
    category: "anime",
    media_type: "movie",
    title: "Skyward Whispers",
    parent_title: null,
    duration_seconds: 6300,
    external_ids: { mal: 70003, anilist: 80003 },
  });

  scheduleItem(45, {
    category: "film",
    media_type: "movie",
    title: "Echoes of Jupiter",
    parent_title: null,
    duration_seconds: 7920,
    external_ids: { imdb: "tt9900002" },
  });

  // In-Progress Anime: Neon Ronin: 2099 (6 episodes)
  const roninOffsets = [35, 28, 22, 16, 9, 3];
  for (let i = 0; i < 6; i++) {
    scheduleItem(roninOffsets[i]!, {
      category: "anime",
      media_type: "episode",
      title: roninTitles[i]!,
      parent_title: "Neon Ronin: 2099",
      season: 1,
      episode: i + 1,
      duration_seconds: 1440,
      external_ids: { mal: 70002, anilist: 80002 },
    });
  }

  // In-Progress Series: Deep Trench Outpost (5 episodes)
  const trenchOffsets = [38, 30, 21, 12, 4];
  for (let i = 0; i < 5; i++) {
    scheduleItem(trenchOffsets[i]!, {
      category: "series",
      media_type: "episode",
      title: trenchTitles[i]!,
      parent_title: "Deep Trench Outpost",
      season: 1,
      episode: i + 1,
      duration_seconds: 2880,
      external_ids: { tvmaze: 30002 },
    });
  }

  // In-Progress Book: The Architecture of Silence (5 sessions)
  const silenceOffsets = [42, 32, 23, 13, 5];
  const silenceProgress = [0.15, 0.28, 0.4, 0.52, 0.6];
  for (let i = 0; i < 5; i++) {
    scheduleItem(silenceOffsets[i]!, {
      category: "book",
      media_type: "book",
      title: "The Architecture of Silence",
      parent_title: "Kaelen Voss",
      duration_seconds: 2100,
      progress: silenceProgress[i],
      external_ids: { openlibrary: "OL99002M" },
    });
  }

  // In-Progress Audiobook: Winds of Aethelgard (4 sessions)
  const windsOffsets = [37, 26, 15, 6];
  const windsProgress = [0.12, 0.25, 0.35, 0.45];
  for (let i = 0; i < 4; i++) {
    scheduleItem(windsOffsets[i]!, {
      category: "audiobook",
      media_type: "audiobook",
      title: "Winds of Aethelgard",
      parent_title: "Rowan Ashcroft",
      duration_seconds: 2400,
      progress: windsProgress[i],
      external_ids: { abs_item: "abs-demo-002" },
    });
  }

  // In-Progress Film: Shadows in the Mist
  scheduleItem(2, {
    category: "film",
    media_type: "movie",
    title: "Shadows in the Mist",
    parent_title: null,
    duration_seconds: 3300,
    progress: 0.55,
    external_ids: { imdb: "tt9900003" },
  });

  // Recurrent pool for YouTube, Music, Podcast, Shortform, Other
  const recurrentPool: RawPoolItem[] = [
    // YouTube
    { category: "youtube", media_type: "video", title: "Why Quantum Computers Freeze", parent_title: "Pocket Physics", duration_seconds: 840, external_ids: { youtube_video: "demo_yt_001", youtube_channel: "UC_pocketphysics" } },
    { category: "youtube", media_type: "video", title: "The Mystery of Fast Radio Bursts", parent_title: "Pocket Physics", duration_seconds: 1080, external_ids: { youtube_video: "demo_yt_002", youtube_channel: "UC_pocketphysics" } },
    { category: "youtube", media_type: "video", title: "Is Time Real or Emergent?", parent_title: "Pocket Physics", duration_seconds: 1320, external_ids: { youtube_video: "demo_yt_003", youtube_channel: "UC_pocketphysics" } },
    { category: "youtube", media_type: "video", title: "The Physics of Black Hole Acoustics", parent_title: "Pocket Physics", duration_seconds: 960, external_ids: { youtube_video: "demo_yt_004", youtube_channel: "UC_pocketphysics" } },
    { category: "youtube", media_type: "video", title: "Restoring a 200-Year-Old Workbench", parent_title: "Artisan Woodcraft", duration_seconds: 1440, external_ids: { youtube_video: "demo_yt_005", youtube_channel: "UC_artisanwood" } },
    { category: "youtube", media_type: "video", title: "Hand-Carving a Walnut Bowl", parent_title: "Artisan Woodcraft", duration_seconds: 900, external_ids: { youtube_video: "demo_yt_006", youtube_channel: "UC_artisanwood" } },
    { category: "youtube", media_type: "video", title: "Japanese Joinery Without Nails", parent_title: "Artisan Woodcraft", duration_seconds: 1200, external_ids: { youtube_video: "demo_yt_007", youtube_channel: "UC_artisanwood" } },
    { category: "youtube", media_type: "video", title: "Can You Browse the Modern Web on a 486?", parent_title: "Retro Hardware Lab", duration_seconds: 1140, external_ids: { youtube_video: "demo_yt_008", youtube_channel: "UC_retrohwlab" } },
    { category: "youtube", media_type: "video", title: "Building the Ultimate 90s Sound Card", parent_title: "Retro Hardware Lab", duration_seconds: 720, external_ids: { youtube_video: "demo_yt_009", youtube_channel: "UC_retrohwlab" } },
    { category: "youtube", media_type: "video", title: "Overclocking Vintage Silicon", parent_title: "Retro Hardware Lab", duration_seconds: 600, external_ids: { youtube_video: "demo_yt_010", youtube_channel: "UC_retrohwlab" } },
    { category: "youtube", media_type: "video", title: "The Science of Sourdough Hydration", parent_title: "Culinary Geometry", duration_seconds: 660, external_ids: { youtube_video: "demo_yt_011", youtube_channel: "UC_culinarygeom" } },
    { category: "youtube", media_type: "video", title: "Perfecting Neapolitan Crust at Home", parent_title: "Culinary Geometry", duration_seconds: 900, external_ids: { youtube_video: "demo_yt_012", youtube_channel: "UC_culinarygeom" } },

    // Music
    { category: "music", media_type: "music", title: "Midnight Neon", parent_title: "Velvet Frequency", duration_seconds: 215 },
    { category: "music", media_type: "music", title: "Analog Sunset", parent_title: "Velvet Frequency", duration_seconds: 240 },
    { category: "music", media_type: "music", title: "Low-Poly Dreams", parent_title: "Velvet Frequency", duration_seconds: 195 },
    { category: "music", media_type: "music", title: "Stellar Drift", parent_title: "Cosmic Cascade", duration_seconds: 260 },
    { category: "music", media_type: "music", title: "Solar Wind", parent_title: "Cosmic Cascade", duration_seconds: 230 },
    { category: "music", media_type: "music", title: "Aurora Borealis", parent_title: "Cosmic Cascade", duration_seconds: 280 },
    { category: "music", media_type: "music", title: "Rainy Café Reverie", parent_title: "The Paper Orchids", duration_seconds: 190 },
    { category: "music", media_type: "music", title: "Cobblestone Waltzes", parent_title: "The Paper Orchids", duration_seconds: 210 },
    { category: "music", media_type: "music", title: "Autumn in Prague", parent_title: "The Paper Orchids", duration_seconds: 225 },

    // Podcast
    { category: "podcast", media_type: "podcast_episode", title: "Ep 41: Attention Economy and Solitude", parent_title: "Modern Mindscape", duration_seconds: 2520 },
    { category: "podcast", media_type: "podcast_episode", title: "Ep 42: The Architecture of Sleep", parent_title: "Modern Mindscape", duration_seconds: 3000 },
    { category: "podcast", media_type: "podcast_episode", title: "Ep 43: How Language Shapes Perception", parent_title: "Modern Mindscape", duration_seconds: 2700 },
    { category: "podcast", media_type: "podcast_episode", title: "Ep 44: The Future of Neurotechnology", parent_title: "Modern Mindscape", duration_seconds: 2880 },
    { category: "podcast", media_type: "podcast_episode", title: "Ep 12: Crafting Pixel Art Aesthetics", parent_title: "Indie Game Odyssey", duration_seconds: 2100 },
    { category: "podcast", media_type: "podcast_episode", title: "Ep 13: Roguelike Mechanics and Replayability", parent_title: "Indie Game Odyssey", duration_seconds: 2280 },
    { category: "podcast", media_type: "podcast_episode", title: "Ep 14: Solo Dev Survival Guide", parent_title: "Indie Game Odyssey", duration_seconds: 2640 },

    // Shortform
    { category: "shortform", media_type: "shortform", title: "Daily Shorts Feed", parent_title: null, duration_seconds: 1500 },
    { category: "shortform", media_type: "shortform", title: "Micro-Video Stream", parent_title: null, duration_seconds: 1200 },

    // Other
    { category: "other", media_type: "other", title: "Interactive Nebula Exhibit", parent_title: null, duration_seconds: 2700 },
    { category: "other", media_type: "other", title: "Live Coding Jam Session", parent_title: null, duration_seconds: 3600 },
    { category: "other", media_type: "other", title: "Virtual Museum Tour: Antiquities", parent_title: null, duration_seconds: 2100 },
  ];

  const eventsToInsert: NewEvent[] = [];
  let daysSeeded = 0;

  for (let dayOffset = 120; dayOffset >= 0; dayOffset--) {
    const scheduled = scheduledArc.get(dayOffset) ?? [];
    // If no scheduled items, some days are empty (~13% probability)
    const isEmpty = scheduled.length === 0 && rng() < 0.13;
    if (isEmpty) {
      continue;
    }

    daysSeeded++;
    const dateStr = getDateMinusDays(today, dayOffset);
    const targetCount = Math.max(scheduled.length, 3 + Math.floor(rng() * 6)); // 3..8

    const dayItems: RawPoolItem[] = [...scheduled];
    while (dayItems.length < targetCount) {
      const idx = Math.floor(rng() * recurrentPool.length);
      dayItems.push(recurrentPool[idx]!);
    }

    // Generate sorted start minutes across the day (between 08:00 and 22:00)
    const times: number[] = [];
    for (let i = 0; i < dayItems.length; i++) {
      times.push(480 + Math.floor(rng() * (1320 - 480)));
    }
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      if (times[i]! <= times[i - 1]!) {
        times[i] = Math.min(1435, times[i - 1]! + 5 + Math.floor(rng() * 10));
      }
    }

    for (let slot = 0; slot < dayItems.length; slot++) {
      const item = dayItems[slot]!;
      const tMin = times[slot]!;
      const hh = String(Math.floor(tMin / 60) % 24).padStart(2, "0");
      const mm = String(tMin % 60).padStart(2, "0");
      const startedAt = localToUtcIso(`${dateStr} ${hh}:${mm}:00`, "Europe/Bratislava");
      const endedAt = new Date(Date.parse(startedAt) + item.duration_seconds * 1000).toISOString();
      const sourceId = `demo:${dateStr}:s${slot + 1}`;

      eventsToInsert.push({
        source: "manual",
        source_kind: "history_item",
        source_id: sourceId,
        external_ids: item.external_ids ?? null,
        media_type: item.media_type,
        title: item.title,
        parent_title: item.parent_title,
        season: item.season ?? null,
        episode: item.episode ?? null,
        started_at: startedAt,
        ended_at: endedAt,
        duration_seconds: item.duration_seconds,
        progress: item.progress ?? null,
        device: "demo",
        raw: null,
      });
    }
  }

  // 1. Bulk insert events
  const runId = startRun(db, "manual");
  const { inserted } = insertEvents(db, runId, eventsToInsert);
  finishRun(db, runId, {
    status: "ok",
    rowsSeen: eventsToInsert.length,
    rowsInserted: inserted,
  });

  // 2. Planned works saved via saveArchiveEntry
  const plannedWorks = [
    {
      entry_id: "00000000-0000-4000-8000-000000000001",
      category: "anime" as const,
      title: "Chrono Compass",
      creators: ["Studio Aurora"],
      seasons: [{ number: 1, episodes: 12, episode_minutes: 24, total_minutes: 288 }],
      external_ids: { mal: 70010, anilist: 80010 },
      offset: 10,
    },
    {
      entry_id: "00000000-0000-4000-8000-000000000002",
      category: "series" as const,
      title: "Station Horizon",
      creators: ["Apex Media"],
      seasons: [{ number: 1, episodes: 8, episode_minutes: 45, total_minutes: 360 }],
      external_ids: { tvmaze: 30010 },
      offset: 12,
    },
    {
      entry_id: "00000000-0000-4000-8000-000000000003",
      category: "film" as const,
      title: "The Clockwork Forest",
      creators: ["Lydia Vance"],
      runtime_minutes: 110,
      external_ids: { imdb: "tt9900010" },
      offset: 15,
    },
    {
      entry_id: "00000000-0000-4000-8000-000000000004",
      category: "book" as const,
      title: "Quantum Garden",
      creators: ["Dr. Evelyn Stone"],
      pages: 350,
      external_ids: { openlibrary: "OL99010M" },
      offset: 18,
    },
    {
      entry_id: "00000000-0000-4000-8000-000000000005",
      category: "audiobook" as const,
      title: "The Last Cartographer",
      creators: ["Mira Thorne"],
      external_ids: { abs_item: "abs-demo-010" },
      offset: 20,
    },
  ];

  for (const pw of plannedWorks) {
    saveArchiveEntry(
      db,
      {
        entry_id: pw.entry_id,
        status: "planned",
        work: {
          provider: "manual",
          category: pw.category,
          title: pw.title,
          year: 2026,
          creators: pw.creators,
          seasons: "seasons" in pw ? pw.seasons : [],
          runtime_minutes: "runtime_minutes" in pw ? pw.runtime_minutes : null,
          pages: "pages" in pw ? pw.pages : null,
          external_ids: pw.external_ids,
        },
        consumed: {},
        when: { precision: "day", date: getDateMinusDays(today, pw.offset) },
      },
      "Europe/Bratislava",
      { nowIso: `${today}T12:00:00.000Z` }
    );
  }

  // 3. Mark finished seasonal series/anime in work_overrides.
  // Note: We use direct SQL INSERT OR IGNORE with pinned deterministic rev_ids
  // rather than saveWorkOverride() because saveWorkOverride() internally calls
  // parseRevId(undefined) which generates a random UUID, breaking deterministic re-seeding.
  const latestEvents = db
    .query<any, []>("SELECT * FROM events_latest ORDER BY id ASC;")
    .all();
  const comps = groupEventsIntoWorkComponents(latestEvents, db);
  for (const comp of comps) {
    if (
      comp.sourceCanonicalTitle === "Starfall Academy" ||
      comp.sourceCanonicalTitle === "Silicon Horizons"
    ) {
      const revId =
        comp.sourceCanonicalTitle === "Starfall Academy"
          ? "00000000-0000-4000-8000-000000000091"
          : "00000000-0000-4000-8000-000000000092";
      const hash = workOverrideRecordHash({
        work_key: comp.key,
        rev_id: revId,
        title: null,
        category: null,
        status: "finished",
        rating_tenths: null,
        note: null,
        hidden: 0,
        meta_provider: null,
        meta_id: null,
        topic: null,
      });
      db.run(
        `INSERT OR IGNORE INTO work_overrides (
          record_hash, work_key, rev_id, title, category, status,
          rating_tenths, note, hidden, meta_provider, meta_id, meta_json, topic, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          hash,
          comp.key,
          revId,
          null,
          null,
          "finished",
          null,
          null,
          0,
          null,
          null,
          null,
          null,
          `${today}T12:00:00.000Z`,
        ]
      );
    }
  }

  // 4. Annotations (ratings and notes)
  const ratings = [
    { title: "Starfall Academy", rating: 9.0, note: "Outstanding worldbuilding and animation.", rev: "00000000-0000-4000-8000-000000000101" },
    { title: "The Glass Orchard", rating: 9.0, note: "Masterpiece cinematography.", rev: "00000000-0000-4000-8000-000000000102" },
    { title: "Chronicles of Rust", rating: 9.0, note: "Compelling post-apocalyptic saga.", rev: "00000000-0000-4000-8000-000000000103" },
    { title: "Silicon Horizons", rating: 8.5, note: "Sharp writing and tech drama.", rev: "00000000-0000-4000-8000-000000000104" },
    { title: "Echoes of the Deep", rating: 8.5, note: "Captivating narrator and maritime mystery.", rev: "00000000-0000-4000-8000-000000000105" },
    { title: "Skyward Whispers", rating: 8.5, note: "Beautiful standalone anime film.", rev: "00000000-0000-4000-8000-000000000106" },
    { title: "Modern Mindscape", rating: 8.5, note: "Incisive long-form interviews.", rev: "00000000-0000-4000-8000-000000000107" },
    { title: "Neon Ronin: 2099", rating: 8.0, note: "Great soundtrack and neon aesthetics.", rev: "00000000-0000-4000-8000-000000000108" },
    { title: "Echoes of Jupiter", rating: 8.0, note: "Engrossing sci-fi journey.", rev: "00000000-0000-4000-8000-000000000109" },
    { title: "Interactive Nebula Exhibit", rating: 8.0, note: "Immersive science museum installation.", rev: "00000000-0000-4000-8000-000000000110" },
    { title: "Deep Trench Outpost", rating: 7.5, note: "Claustrophobic mystery.", rev: "00000000-0000-4000-8000-000000000111" },
    { title: "The Architecture of Silence", rating: 8.0, note: "Thought-provoking architectural essays.", rev: "00000000-0000-4000-8000-000000000112" },
  ];

  for (const r of ratings) {
    saveAnnotation(
      db,
      {
        source: "manual",
        title: r.title,
        rating: r.rating,
        note: r.note,
        rev_id: r.rev,
      },
      `${today}T12:00:00.000Z`
    );
  }

  const finalCount =
    db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM events;").get()
      ?.count ?? 0;

  return {
    inserted: finalCount - initialCount,
    daysSeeded,
    totalEvents: finalCount,
  };
}

export async function startDemoServer(
  options: DemoServerOptions = {}
): Promise<DemoServerInstance> {
  const port = options.port ?? 8790;
  const dir = resolveDemoDir(options.dir);
  const today =
    options.today ??
    formatLocalParts(new Date().toISOString(), "Europe/Bratislava").date;

  const { configPath, dbPath } = createDemoConfig(dir, port);
  const prevConfigEnv = process.env.INPUTTRACKER_CONFIG;
  process.env.INPUTTRACKER_CONFIG = configPath;

  const db = openDb(dbPath);
  seedDemoData(db, { today, seed: options.seed });
  db.close();

  // Suppress startup logging to print only the requested ready line
  const origLog = console.log;
  console.log = () => {};
  let serverInstance: ReturnType<typeof main>;
  try {
    serverInstance = main({
      loadConfig: () => loadConfig({ path: configPath }),
      openDb: () => openDb(dbPath),
    });
  } finally {
    console.log = origLog;
  }

  const actualPort = serverInstance.server.port ?? port;
  const healthUrl = `http://127.0.0.1:${actualPort}/api/health`;

  // Poll /api/health until responsive
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // Waiting for socket
    }
    await Bun.sleep(20);
  }

  if (!ready) {
    serverInstance.server.stop();
    serverInstance.db.close();
    if (prevConfigEnv !== undefined) {
      process.env.INPUTTRACKER_CONFIG = prevConfigEnv;
    } else {
      delete process.env.INPUTTRACKER_CONFIG;
    }
    throw new Error(`Demo server failed to respond on ${healthUrl}`);
  }

  return {
    server: serverInstance.server,
    db: serverInstance.db,
    dir,
    port: actualPort,
    configPath,
    stop: () => {
      serverInstance.server.stop();
      serverInstance.db.close();
      if (prevConfigEnv !== undefined) {
        process.env.INPUTTRACKER_CONFIG = prevConfigEnv;
      } else {
        delete process.env.INPUTTRACKER_CONFIG;
      }
    },
  };
}

function parseCliArgs(args: string[]): { port?: number; dir?: string; today?: string } {
  let port: number | undefined;
  let dir: string | undefined;
  let today: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--port=")) {
      const raw = a.slice("--port=".length);
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 65535) {
        port = parsed;
      } else {
        console.error(`Invalid --port: ${raw}`);
        process.exit(1);
      }
    } else if (a === "--port" && i + 1 < args.length) {
      const raw = args[++i]!;
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 65535) {
        port = parsed;
      } else {
        console.error(`Invalid --port: ${raw}`);
        process.exit(1);
      }
    } else if (a.startsWith("--dir=")) {
      dir = a.slice("--dir=".length);
    } else if (a === "--dir" && i + 1 < args.length) {
      dir = args[++i];
    } else if (a.startsWith("--today=")) {
      const raw = a.slice("--today=".length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        console.error(`Invalid --today format: ${raw} (expected YYYY-MM-DD)`);
        process.exit(1);
      }
      today = raw;
    } else if (a === "--today" && i + 1 < args.length) {
      const t = args[++i]!;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) {
        console.error(`Invalid --today format: ${t} (expected YYYY-MM-DD)`);
        process.exit(1);
      }
      today = t;
    }
  }

  return { port, dir, today };
}

if (import.meta.main) {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  const instance = await startDemoServer(cliArgs);

  console.log(`demo server ready on http://127.0.0.1:${instance.port}`);

  process.on("SIGINT", () => {
    instance.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    instance.stop();
    process.exit(0);
  });
}
