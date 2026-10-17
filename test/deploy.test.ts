/**
 * Deploy checks (synthetic, no systemd required).
 *
 * These tests are pure file inspections plus two sandboxed runs of
 * `scripts/install.sh` against a temp HOME/XDG dir. Nothing here reads the app
 * config, touches the real user units, or contacts the network.
 */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = dirname(import.meta.dir);
const DEPLOY = join(REPO, "deploy");
const INSTALL_SH = join(REPO, "scripts", "install.sh");
const BASH = Bun.which("bash") ?? "/bin/bash";

const UNIT_FILES = [
  "inputtracker.service",
  "inputtracker-sync@.service",
  "inputtracker-sync@audiobookshelf.timer",
  "inputtracker-sync@simkl.timer",
  "inputtracker-sync@activitywatch.timer",
  "inputtracker-backup.service",
  "inputtracker-backup.timer",
  "inputtracker-weekly.service",
  "inputtracker-weekly.timer",
] as const;

const SERVICE_FILES = [
  "inputtracker.service",
  "inputtracker-sync@.service",
  "inputtracker-backup.service",
  "inputtracker-weekly.service",
] as const;

const TIMER_FILES = [
  "inputtracker-sync@audiobookshelf.timer",
  "inputtracker-sync@simkl.timer",
  "inputtracker-sync@activitywatch.timer",
  "inputtracker-backup.timer",
  "inputtracker-weekly.timer",
] as const;

function readDeploy(name: string): string {
  return readFileSync(join(DEPLOY, name), "utf8");
}

function readInstall(): string {
  return readFileSync(INSTALL_SH, "utf8");
}

/** Environment for a spawned install run, with the real process env as base. */
function cleanEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return { ...env, ...overrides };
}

async function runInstall(
  args: string[],
  env: Record<string, string>
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([BASH, INSTALL_SH, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

/** `foo@bar.service` -> `foo@.service`; other names map to themselves. */
function templateName(unit: string): string {
  const at = unit.indexOf("@");
  if (at === -1) {
    return unit;
  }
  const dot = unit.indexOf(".", at);
  return unit.slice(0, at + 1) + unit.slice(dot);
}

/** First-match value of a `Key=value` line. */
function directive(text: string, key: string): string | null {
  const match = new RegExp(`^${key}=(.*)$`, "m").exec(text);
  return match ? (match[1] as string) : null;
}

/** Any unresolved template placeholder such as `@APP_DIR@` or `@BUN@`. */
const PLACEHOLDER = /@[A-Z_]+@/;

// A secret-ish assignment: a token/api-key/bearer value that is not a
// placeholder. Deploy files must contain none of these.
const SECRET_PATTERNS = [
  /token\s*[=:]\s*["']?[A-Za-z0-9_\-]{8,}/i,
  /bearer\s+[A-Za-z0-9._\-]{8,}/i,
  /api[_-]?key\s*[=:]\s*["']?[A-Za-z0-9_\-]{8,}/i,
];

describe("deploy files: presence and content", () => {
  test("all unit files exist", () => {
    for (const name of UNIT_FILES) {
      expect(existsSync(join(DEPLOY, name))).toBe(true);
    }
    expect(existsSync(INSTALL_SH)).toBe(true);
  });

  test("no PC-specific paths or secrets anywhere in deploy or install.sh", () => {
    const sources: Array<{ name: string; text: string }> = [
      ...UNIT_FILES.map((name) => ({ name, text: readDeploy(name) })),
      { name: "scripts/install.sh", text: readInstall() },
    ];

    for (const { name, text } of sources) {
      expect(text, `${name} must not contain /home/pinacule`).not.toContain(
        "/home/pinacule"
      );
      expect(text, `${name} must not contain localhost:13378`).not.toContain(
        "localhost:13378"
      );
      for (const pattern of SECRET_PATTERNS) {
        expect(text, `${name} must not contain a literal token`).not.toMatch(pattern);
      }
    }
  });

  test("service units use the @APP_DIR@ and @BUN@ placeholders and no absolute /home path", () => {
    for (const name of SERVICE_FILES) {
      const text = readDeploy(name);
      expect(text).toContain("@APP_DIR@");
      expect(text).toContain("@BUN@");
    }
    for (const name of UNIT_FILES) {
      expect(readDeploy(name)).not.toMatch(/\/home\//);
    }
  });

  test("timers reference existing service units and want timers.target", () => {
    for (const name of TIMER_FILES) {
      const text = readDeploy(name);
      expect(text).toContain("[Timer]");
      expect(directive(text, "WantedBy")).toBe("timers.target");

      const target = directive(text, "Unit");
      expect(target).not.toBeNull();
      const unit = target as string;
      const exists =
        existsSync(join(DEPLOY, unit)) ||
        existsSync(join(DEPLOY, templateName(unit)));
      expect(exists, `${name} -> ${unit} must resolve to a unit file`).toBe(true);
    }
  });
});

describe("deploy files: required directives", () => {
  test("inputtracker.service runs the server and restarts on failure", () => {
    const text = readDeploy("inputtracker.service");
    expect(directive(text, "Type")).toBe("simple");
    expect(directive(text, "WorkingDirectory")).toBe("@APP_DIR@");
    expect(directive(text, "ExecStart")).toBe(
      "@BUN@ run src/server/main.ts"
    );
    expect(directive(text, "Restart")).toBe("on-failure");
    expect(directive(text, "WantedBy")).toBe("default.target");
  });

  test("inputtracker-sync@.service is a oneshot sync template", () => {
    const text = readDeploy("inputtracker-sync@.service");
    expect(directive(text, "Type")).toBe("oneshot");
    expect(directive(text, "WorkingDirectory")).toBe("@APP_DIR@");
    expect(directive(text, "ExecStart")).toBe(
      "@BUN@ run src/cli/index.ts sync %i"
    );
  });

  test("audiobookshelf timer is hourly and points at its service", () => {
    const text = readDeploy("inputtracker-sync@audiobookshelf.timer");
    expect(directive(text, "OnCalendar")).toBe("hourly");
    expect(directive(text, "Persistent")).toBe("true");
    expect(directive(text, "RandomizedDelaySec")).toBe("120");
    expect(directive(text, "Unit")).toBe(
      "inputtracker-sync@audiobookshelf.service"
    );
  });

  test("simkl timer is hourly at :30 and points at its service", () => {
    const text = readDeploy("inputtracker-sync@simkl.timer");
    expect(directive(text, "OnCalendar")).toBe("*-*-* *:30:00");
    expect(directive(text, "Persistent")).toBe("true");
    expect(directive(text, "RandomizedDelaySec")).toBe("120");
    expect(directive(text, "Unit")).toBe(
      "inputtracker-sync@simkl.service"
    );
  });

  test("activitywatch timer runs every 10 minutes and points at its service", () => {
    const text = readDeploy("inputtracker-sync@activitywatch.timer");
    expect(directive(text, "OnCalendar")).toBe("*:0/10");
    expect(directive(text, "Persistent")).toBe("true");
    expect(directive(text, "RandomizedDelaySec")).toBe("30");
    expect(directive(text, "Unit")).toBe(
      "inputtracker-sync@activitywatch.service"
    );
  });

  test("backup service and timer", () => {
    const service = readDeploy("inputtracker-backup.service");
    expect(directive(service, "Type")).toBe("oneshot");
    expect(directive(service, "WorkingDirectory")).toBe("@APP_DIR@");
    expect(directive(service, "ExecStart")).toBe(
      "@BUN@ run src/cli/index.ts backup"
    );

    const timer = readDeploy("inputtracker-backup.timer");
    expect(directive(timer, "OnCalendar")).toBe("*-*-* 03:30:00");
    expect(directive(timer, "Persistent")).toBe("true");
    expect(directive(timer, "Unit")).toBe("inputtracker-backup.service");
  });

  test("weekly summary service is a oneshot `it notify weekly`", () => {
    const service = readDeploy("inputtracker-weekly.service");
    expect(directive(service, "Type")).toBe("oneshot");
    expect(directive(service, "WorkingDirectory")).toBe("@APP_DIR@");
    expect(directive(service, "ExecStart")).toBe(
      "@BUN@ run src/cli/index.ts notify weekly"
    );

    const timer = readDeploy("inputtracker-weekly.timer");
    expect(directive(timer, "OnCalendar")).toBe("Sun *-*-* 19:00:00");
    expect(directive(timer, "Persistent")).toBe("true");
    expect(directive(timer, "Unit")).toBe("inputtracker-weekly.service");
  });

  test("units do not hard-code the config path", () => {
    for (const name of SERVICE_FILES) {
      expect(readDeploy(name)).not.toMatch(/INPUTTRACKER_CONFIG\s*=/);
    }
  });
});

describe("scripts/install.sh", () => {
  test("--dry-run exits 0, prints the plan and resolved bun, and touches nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "it-deploy-dry-"));
    try {
      const home = join(root, "home");
      mkdirSync(home);
      const bin = join(root, "bin");
      mkdirSync(bin);
      const fakeBun = join(bin, "bun");
      writeFileSync(fakeBun, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeBun, 0o755);

      const { code, out } = await runInstall(
        ["--dry-run"],
        cleanEnv({
          HOME: home,
          XDG_CONFIG_HOME: home,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        })
      );

      expect(code).toBe(0);
      expect(out).toContain("Dry run");
      expect(out).toContain(home);
      // The resolved Bun path is shown, not just the template placeholder.
      expect(out).toContain(fakeBun);
      expect(out).not.toContain("@BUN@");
      expect(out).toContain("loginctl enable-linger");
      // Nothing was created: not even the unit directory.
      expect(readdirSync(home)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing bun (absent from PATH and ~/.bun/bin) exits non-zero with a message", async () => {
    const root = mkdtempSync(join(tmpdir(), "it-deploy-nobun-"));
    try {
      const home = join(root, "home");
      mkdirSync(home); // Deliberately no ~/.bun/bin/bun here.
      const bin = join(root, "bin");
      mkdirSync(bin); // No bun on PATH, but the shell utilities the script needs.
      const dirnameBin = Bun.which("dirname");
      if (dirnameBin) {
        symlinkSync(dirnameBin, join(bin, "dirname"));
      }

      const { code, out, err } = await runInstall(
        ["--dry-run"],
        cleanEnv({ HOME: home, XDG_CONFIG_HOME: home, PATH: bin })
      );

      expect(code).not.toBe(0);
      expect(err.toLowerCase()).toContain("bun");
      expect(out).not.toContain("Dry run");
      // A failing run writes nothing.
      expect(readdirSync(home)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--no-start renders absolute bun paths, no placeholders, and is idempotent", async () => {
    const root = mkdtempSync(join(tmpdir(), "it-deploy-install-"));
    try {
      const home = join(root, "home");
      mkdirSync(home);
      const bin = join(root, "bin");
      mkdirSync(bin);
      const fakeBun = join(bin, "bun");
      writeFileSync(fakeBun, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeBun, 0o755);

      const logPath = join(root, "systemctl.log");
      const shim = join(bin, "systemctl");
      writeFileSync(
        shim,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "\${SYSTEMCTL_LOG}"\n`
      );
      chmodSync(shim, 0o755);

      const env = cleanEnv({
        HOME: home,
        XDG_CONFIG_HOME: home,
        SYSTEMCTL_LOG: logPath,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      });

      const first = await runInstall(["--no-start"], env);
      expect(first.code).toBe(0);
      expect(first.out).toContain("loginctl enable-linger");

      const unitDir = join(home, "systemd", "user");
      for (const name of UNIT_FILES) {
        expect(existsSync(join(unitDir, name))).toBe(true);
        const text = readFileSync(join(unitDir, name), "utf8");
        expect(text, `${name} still has an unresolved placeholder`).not.toMatch(
          PLACEHOLDER
        );
      }
      for (const name of SERVICE_FILES) {
        const text = readFileSync(join(unitDir, name), "utf8");
        expect(text).toContain(REPO);
        const exec = directive(text, "ExecStart");
        expect(exec).not.toBeNull();
        // Absolute path to the resolved bun, with the command unchanged.
        expect((exec as string).startsWith(`${fakeBun} run `)).toBe(true);
        expect((exec as string).startsWith("/")).toBe(true);
      }

      // systemctl was only asked to reload, never to enable (-now).
      const log = readFileSync(logPath, "utf8");
      expect(log).toContain("--user daemon-reload");
      expect(log).not.toContain("enable");

      // A second run must not change any rendered unit.
      const snapshot = new Map(
        UNIT_FILES.map((name) => [name, readFileSync(join(unitDir, name), "utf8")])
      );
      const second = await runInstall(["--no-start"], env);
      expect(second.code).toBe(0);
      for (const name of UNIT_FILES) {
        expect(readFileSync(join(unitDir, name), "utf8")).toBe(
          snapshot.get(name) as string
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips systemctl gracefully when it is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "it-deploy-nosysctl-"));
    try {
      const home = join(root, "home");
      mkdirSync(home);
      // A PATH with the shell utilities the script needs, but no systemctl.
      const bin = join(root, "bin");
      mkdirSync(bin);
      for (const tool of ["dirname", "mkdir", "cmp", "mv", "rm", "id", "sed"]) {
        const found = Bun.which(tool);
        if (found) {
          symlinkSync(found, join(bin, tool));
        }
      }
      // bun must resolve so install.sh gets past the bun check; systemctl stays absent.
      const fakeBun = join(bin, "bun");
      writeFileSync(fakeBun, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeBun, 0o755);

      const { code, err } = await runInstall(
        ["--no-start"],
        cleanEnv({ HOME: home, XDG_CONFIG_HOME: home, PATH: bin })
      );
      expect(code).toBe(0);
      expect(err).toContain("systemctl not found");
      // Units still rendered.
      expect(
        existsSync(join(home, "systemd", "user", "inputtracker.service"))
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("works from any checkout path (portable APP_DIR)", async () => {
    const root = mkdtempSync(join(tmpdir(), "it-deploy-portable-"));
    try {
      // A checkout at an unrelated, nested path: not the repository location.
      const checkout = join(root, "opt", "somewhere-else", "inputtracker");
      mkdirSync(join(checkout, "scripts"), { recursive: true });
      cpSync(INSTALL_SH, join(checkout, "scripts", "install.sh"));
      cpSync(DEPLOY, join(checkout, "deploy"), { recursive: true });

      const home = join(root, "home");
      mkdirSync(home);
      const bin = join(root, "bin");
      mkdirSync(bin);
      const fakeBun = join(bin, "bun");
      writeFileSync(fakeBun, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeBun, 0o755);
      const shim = join(bin, "systemctl");
      writeFileSync(shim, "#!/bin/sh\nexit 0\n");
      chmodSync(shim, 0o755);

      const proc = Bun.spawn(
        [BASH, join(checkout, "scripts", "install.sh"), "--no-start"],
        {
          env: cleanEnv({
            HOME: home,
            XDG_CONFIG_HOME: home,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
          }),
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code, `install.sh failed:\n${out}\n${err}`).toBe(0);

      const unitDir = join(home, "systemd", "user");
      for (const name of UNIT_FILES) {
        const text = readFileSync(join(unitDir, name), "utf8");
        expect(text, `${name} still has an unresolved placeholder`).not.toMatch(
          PLACEHOLDER
        );
      }
      // The units point at the temp checkout, not the repository being tested.
      for (const name of SERVICE_FILES) {
        const text = readFileSync(join(unitDir, name), "utf8");
        expect(directive(text, "WorkingDirectory")).toBe(checkout);
        expect(text).toContain(checkout);
        expect(text).not.toContain(REPO);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("systemd-analyze verification", () => {
  test("rendered units verify when systemd-analyze is available", async () => {
    const analyze = Bun.which("systemd-analyze");
    if (!analyze) {
      return; // Not a systemd host: nothing to verify.
    }

    const tmp = mkdtempSync(join(tmpdir(), "it-deploy-verify-"));
    try {
      const bin = join(tmp, "bin");
      mkdirSync(bin);
      const shim = join(bin, "systemctl");
      writeFileSync(shim, "#!/bin/sh\nexit 0\n");
      chmodSync(shim, 0o755);

      const { code } = await runInstall(
        ["--no-start"],
        cleanEnv({
          HOME: tmp,
          XDG_CONFIG_HOME: tmp,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        })
      );
      expect(code).toBe(0);

      const unitDir = join(tmp, "systemd", "user");
      const proc = Bun.spawn(
        [analyze, "--user", "verify", ...UNIT_FILES.map((n) => join(unitDir, n))],
        { stdout: "pipe", stderr: "pipe" }
      );
      const [out, err, verifyCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      // Warnings (about bun/WorkingDirectory) do not change the exit code;
      // only real parse errors do.
      expect(verifyCode, `systemd-analyze verify failed:\n${out}\n${err}`).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a full run builds the web app, enables the units and restarts the server", async () => {
    const root = mkdtempSync(join(tmpdir(), "it-deploy-full-"));
    try {
      const home = join(root, "home");
      mkdirSync(home);
      const bin = join(root, "bin");
      mkdirSync(bin);
      const logPath = join(root, "calls.log");
      // Shims log their calls instead of installing, building or touching systemd.
      for (const name of ["bun", "systemctl"]) {
        const shim = join(bin, name);
        writeFileSync(shim, `#!/bin/sh\nprintf '${name} %s\\n' "$*" >> "\${CALLS_LOG}"\n`);
        chmodSync(shim, 0o755);
      }
      const env = cleanEnv({
        HOME: home,
        XDG_CONFIG_HOME: home,
        CALLS_LOG: logPath,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      });

      const { code } = await runInstall([], env);
      expect(code).toBe(0);
      const calls = readFileSync(logPath, "utf8").trim().split("\n");
      expect(calls).toEqual([
        "systemctl --user daemon-reload",
        "bun install --frozen-lockfile",
        "bun run build:web",
        "systemctl --user enable --now inputtracker.service inputtracker-sync@audiobookshelf.timer inputtracker-sync@simkl.timer inputtracker-sync@activitywatch.timer inputtracker-backup.timer inputtracker-weekly.timer",
        "systemctl --user restart inputtracker.service",
      ]);

      // --no-build skips the build but still restarts.
      rmSync(logPath);
      const noBuild = await runInstall(["--no-build"], env);
      expect(noBuild.code).toBe(0);
      const noBuildCalls = readFileSync(logPath, "utf8");
      expect(noBuildCalls).not.toContain("bun ");
      expect(noBuildCalls).toContain("systemctl --user restart inputtracker.service");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
