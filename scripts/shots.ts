// Review screenshots for skins (manager tooling, not part of the app).
//
//   bun scripts/shots.ts --base http://localhost:5191 --theme nightcity --out <dir> \
//     [--pages calendar,insights,settings] [--frames 24 --interval 250 --frame-page calendar]
//     [--baseline <dot-shots>/report.json]   (only report blocked controls Dot doesn't have)
// A page is a route (`calendar?date=2026-10-21`) or `work` (first work linked from Library).
//
// For every page × {desktop 1440×900, phone 390×844 @2x} it saves a PNG and checks:
//   - overflow: the page scrolls sideways (scrollWidth > viewport width)
//   - blocked:  a visible button/link/input whose centre hit-test lands on an element outside it
//               (an overlay that steals clicks)
// Frames: a JPEG sequence of one page (desktop and phone) plus an animated WebP of each.
// Results: <out>/report.json and a one-line summary per shot on stdout.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (name: string, def?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1]! : def;
};
const BASE = arg("base", "http://localhost:5183")!;
const THEME = arg("theme", "dot")!;
const OUT = arg("out", "shots")!;
const PAGES = arg("pages", "calendar,library,work,insights,review,settings")!.split(",");
const FRAMES = Number(arg("frames", "0"));
const INTERVAL = Number(arg("interval", "250"));
const FRAME_PAGE = arg("frame-page", "calendar")!;
const SETTLE = Number(arg("settle", "3500"));
const EXTRA_LS = arg("ls", ""); // key=value;key=value extra localStorage entries
const BASELINE = arg("baseline");
const baseline: Record<string, { blocked: { control: string; text: string }[] }> = BASELINE ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
const fileName = (page: string) => page.replace(/[^a-z0-9-]+/gi, "_").replace(/_+$/, "");
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  phone: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
} as const;

const profile = mkdtempSync(join(tmpdir(), "shots-"));
const chrome = spawn("chromium", [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--mute-audio",
  "--disable-gpu-sandbox", "about:blank",
], { stdio: "ignore" });
process.on("exit", () => chrome.kill("SIGKILL"));

async function devtoolsUrl(): Promise<string> {
  const file = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    if (existsSync(file)) {
      const [port, path] = readFileSync(file, "utf8").trim().split("\n");
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    }
    await Bun.sleep(100);
  }
  throw new Error("chromium did not start");
}

const ws = new WebSocket(await devtoolsUrl());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)!;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  }
});
function send(method: string, params: object = {}, sessionId?: string): Promise<any> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId: S } = await send("Target.attachToTarget", { targetId, flatten: true });
const cdp = (m: string, p: object = {}) => send(m, p, S);
await cdp("Page.enable");
await cdp("Runtime.enable");
const ls: Record<string, string> = { "inputtracker.theme": THEME };
for (const pair of EXTRA_LS.split(";").filter(Boolean)) {
  const [k, ...v] = pair.split("=");
  ls[k!] = v.join("=");
}
await cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `try{${Object.entries(ls).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(v)});`).join("")}}catch(e){}`,
});

async function evaluate<T>(expression: string): Promise<T> {
  const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
  return r.result.value as T;
}

async function go(route: string) {
  await cdp("Page.navigate", { url: `${BASE}/#/${route}` });
  await Bun.sleep(SETTLE);
}

let workRoute: string | null = null;
async function resolveRoute(page: string): Promise<string | null> {
  if (page !== "work") return page;
  if (workRoute) return workRoute;
  await go("library");
  const href = await evaluate<string | null>(
    `(() => { const a = [...document.querySelectorAll('a[href*="work="]')][0]; return a ? a.getAttribute('href') : null; })()`
  );
  workRoute = href ? href.replace(/^#\//, "") : null;
  return workRoute;
}

const CHECKS = `(() => {
  const vw = window.innerWidth;
  const overflow = document.documentElement.scrollWidth - vw;
  const blocked = [];
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=radio], label';
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > vw) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) continue;
    if (el.closest('.sr-only')) continue;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit) continue;
    if (el.contains(hit) || hit.contains(el)) continue;
    const forId = el.tagName === 'LABEL' && el.htmlFor && hit.id === el.htmlFor;
    if (forId) continue;
    // Hit on a sibling inside the same label/control wrapper is fine (sr-only radios in tiles).
    if (el.tagName === 'INPUT' && hit.closest('label') && hit.closest('label').contains(el)) continue;
    const describe = (n) => n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).slice(0, 3).join('.') : '');
    blocked.push({ control: describe(el), text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40), by: describe(hit) });
  }
  const fx = [...document.querySelectorAll('[data-skin-layer], .skin-fx, .skin-bg')].map((n) => ({ el: n.className || n.tagName, pe: getComputedStyle(n).pointerEvents }));
  return { overflow, blocked: blocked.slice(0, 60), blockedCount: blocked.length, fx, theme: document.documentElement.dataset.theme, title: document.title };
})()`;

const report: Record<string, unknown> = {};
for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  await cdp("Emulation.setDeviceMetricsOverride", vp);
  await cdp("Emulation.setTouchEmulationEnabled", { enabled: vp.mobile });
  for (const page of PAGES) {
    const route = await resolveRoute(page);
    if (!route) { console.log(`${vpName} ${page}: no route (no work link in library)`); continue; }
    await go(route);
    const checks = await evaluate<any>(CHECKS);
    const key = `${fileName(page)}-${vpName}`;
    const base = new Set((baseline[key]?.blocked ?? []).map((b) => b.control + "|" + b.text));
    if (BASELINE) {
      checks.blocked = checks.blocked.filter((b: any) => !base.has(b.control + "|" + b.text));
      checks.blockedCount = checks.blocked.length;
    }
    const shot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const file = join(OUT, `${key}.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    // Full-length capture too, so the lower part of long pages gets reviewed.
    const metrics = await cdp("Page.getLayoutMetrics");
    const h = Math.min(Math.ceil(metrics.cssContentSize.height), 6000);
    const full = await cdp("Page.captureScreenshot", { format: "jpeg", quality: 80, captureBeyondViewport: true, clip: { x: 0, y: 0, width: vp.width, height: h, scale: 1 } });
    writeFileSync(join(OUT, `${key}-full.jpg`), Buffer.from(full.data, "base64"));
    report[key] = checks;
    console.log(`${vpName} ${page}: theme=${checks.theme} overflow=${checks.overflow}px blocked=${checks.blockedCount}${checks.blockedCount ? " e.g. " + JSON.stringify(checks.blocked.slice(0, 3)) : ""}`);
  }
  if (FRAMES > 0) {
    const route = await resolveRoute(FRAME_PAGE);
    await go(route ?? FRAME_PAGE);
    const dir = join(OUT, `frames-${fileName(FRAME_PAGE)}-${vpName}`);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < FRAMES; i++) {
      const f = await cdp("Page.captureScreenshot", { format: "jpeg", quality: 70 });
      writeFileSync(join(dir, `f${String(i).padStart(3, "0")}.jpg`), Buffer.from(f.data, "base64"));
      await Bun.sleep(INTERVAL);
    }
    const anim = join(OUT, `anim-${fileName(FRAME_PAGE)}-${vpName}.webp`);
    Bun.spawnSync(["magick", "-delay", String(Math.round(INTERVAL / 10)), "-loop", "0", join(dir, "f*.jpg"), "-resize", vp.mobile ? "390x" : "960x", "-quality", "60", anim]);
    console.log(`${vpName} frames: ${dir} (${FRAMES} × ${INTERVAL} ms) -> ${anim}`);
  }
}
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
ws.close();
chrome.kill("SIGKILL");
process.exit(0);
