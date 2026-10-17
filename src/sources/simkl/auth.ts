/**
 * Simkl device-flow authentication and status check.
 *
 * Implements `it auth simkl` and `it auth simkl --status`.
 * Secrets (tokens, device_code) are never logged or printed.
 */

import type { Config } from "../../core/config.ts";
import { localParts } from "../../core/time.ts";
import {
  createSimklClient,
  type SimklClient,
  type SimklClientDeps,
} from "./client.ts";
import {
  createStoredToken,
  readSimklToken,
  simklTokenPath,
  writeSimklToken,
  type SimklToken,
} from "./token.ts";

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_FAILURE = 2;

export interface AuthSimklOptions {
  status?: boolean;
}

export interface AuthSimklDeps {
  config: Config;
  client?: SimklClient;
  createClient?: (cfg: Config["simkl"], deps: SimklClientDeps) => SimklClient;
  readToken?: (path: string) => SimklToken | null;
  writeToken?: (path: string, token: SimklToken) => void;
  tokenPath?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export async function runSimklAuth(
  options: AuthSimklOptions,
  deps: AuthSimklDeps
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const sleepFn =
    deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const nowFn = deps.now ?? (() => Date.now());
  const doReadToken = deps.readToken ?? readSimklToken;
  const doWriteToken = deps.writeToken ?? writeSimklToken;

  const config = deps.config;
  const clientId = config.simkl.client_id.trim();
  const tokenPath = deps.tokenPath ?? simklTokenPath(config);

  // Status check: no network, exits 0
  if (options.status) {
    const token = doReadToken(tokenPath);
    if (token) {
      out("Simkl: connected");
      out(`Client ID: ${clientId ? "configured" : "not configured"}`);
      out(`Scope: ${token.scope}`);
      const [y, m, d] = localParts(token.expires_at, config.timezone).date.split("-");
      out(`Access token valid until: ${d}.${m}.${y}`);
    } else {
      out("Simkl: not connected");
      out(`Client ID: ${clientId ? "configured" : "not configured"}`);
    }
    return EXIT_OK;
  }

  // 1. client_id empty: print hint and exit 1
  if (!clientId) {
    err(
      "simkl.client_id is not set. Set client_id in inputtracker.config.toml (register a V2 app, type 'TV, devices & command line' at https://simkl.com/settings/developer/)."
    );
    return EXIT_USAGE;
  }

  const makeClient =
    deps.createClient ?? ((cfg, clientDeps) => createSimklClient(cfg, clientDeps));
  const client =
    deps.client ??
    makeClient(config.simkl, {
      sleep: sleepFn,
      now: nowFn,
      tokenPath,
      readToken: () => doReadToken(tokenPath),
      writeToken: (t) => doWriteToken(tokenPath, t),
    });

  // 2. Request device code
  let device;
  try {
    device = await client.requestDeviceCode();
  } catch (caught) {
    const msg = caught instanceof Error ? caught.message : String(caught);
    err(`Failed to request Simkl device code: ${msg}`);
    return EXIT_FAILURE;
  }

  // Print verification_uri_complete on its own line, and fallback verification_uri and user_code
  out(device.verification_uri_complete);
  out(`Or visit ${device.verification_uri} and enter code: ${device.user_code}`);

  // 3. Poll for token
  let intervalSeconds = device.interval || 5;
  const startTime = nowFn();
  const maxWaitSeconds = Math.min(600, device.expires_in || 600);
  const deadlineMs = startTime + maxWaitSeconds * 1000;

  while (true) {
    if (nowFn() >= deadlineMs) {
      err("Simkl auth timed out: code expired, run 'it auth simkl' again");
      return EXIT_FAILURE;
    }

    await sleepFn(intervalSeconds * 1000);

    if (nowFn() >= deadlineMs) {
      err("Simkl auth timed out: code expired, run 'it auth simkl' again");
      return EXIT_FAILURE;
    }

    let pollRes;
    try {
      pollRes = await client.pollToken(device.device_code);
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : String(caught);
      err(`Simkl poll error: ${msg}`);
      return EXIT_FAILURE;
    }

    if (pollRes.kind === "success") {
      const storedToken = createStoredToken(pollRes.token, { now: nowFn() });
      doWriteToken(tokenPath, storedToken);
      const [y, m, d] = localParts(storedToken.expires_at, config.timezone).date.split("-");
      out(
        `Simkl connected (scope ${storedToken.scope}, access token valid until ${d}.${m}.${y})`
      );
      return EXIT_OK;
    }

    if (pollRes.kind === "pending") {
      continue;
    }

    if (pollRes.kind === "slow_down") {
      intervalSeconds += 5;
      continue;
    }

    if (pollRes.kind === "expired") {
      err("code expired, run 'it auth simkl' again");
      return EXIT_FAILURE;
    }

    if (pollRes.kind === "invalid_client") {
      err("wrong client_id or a V1 app: register a V2 app");
      return EXIT_FAILURE;
    }
  }
}
