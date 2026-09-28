// Auto-refill the Z.AI device-token pool before it runs dry.
//
// The pool in open-sse/lib/zaiDeviceToken.js holds single-use tokens minted by
// Aliyun FeiLin, which only runs inside a real browser engine. When the pool
// empties, the zai-web executor returns 503 ZAI_DEVICE_TOKEN_POOL_EMPTY without
// touching the network. This scheduler tops the pool back up in the background
// so the first request after a dry spell does not fail.
//
// It needs the chat.z.ai localStorage JWT (see scripts/zai-harvest-device-tokens.py).
// Supply it via ZAI_TOKEN, or a file at ZAI_TOKEN_FILE (default ~/.hermes/zai-jwt,
// chmod 600 recommended). With no JWT the scheduler is a no-op — never an error.
//
// Env knobs (all optional):
//   ZAI_REFILL_THRESHOLD   refill when remaining drops below this (default 10)
//   ZAI_REFILL_TARGET      pool depth to aim for                    (default 50)
//   ZAI_REFILL_INTERVAL_MS scheduler period                         (default 5 min)
//   ZAI_REFILL_COOLDOWN_MS wait after a failed harvest               (default 10 min)
//   ZAI_REFILL_TIMEOUT_MS  kill a stuck harvester                    (default 3 min)
//   ZAI_HARVEST_SCRIPT     path to the harvester
//   DISABLE_ZAI_AUTO_REFILL=1 to turn the scheduler off entirely
//
// Fail-open everywhere: tick errors are logged and swallowed, exactly like
// src/sse/services/backgroundTokenRefresh.js.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as log from "../utils/logger.js";
import { poolStatus, getPoolPath } from "open-sse/lib/zaiDeviceToken.js";

export const ZAI_REFILL_DEFAULT_THRESHOLD = 10;
export const ZAI_REFILL_DEFAULT_TARGET = 50;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 30 * 1000;
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_HARVEST_TIMEOUT_MS = 3 * 60 * 1000;
// Must exceed the longest legitimate harvest (ZAI_REFILL_TIMEOUT_MS, default
// 3 min) or a live harvest could have its lock stolen mid-flight.
const LOCK_STALE_MS = 5 * 60 * 1000;

let started = false;
let intervalHandle = null;
let initialTimeoutHandle = null;
let tickRunning = false;
let cooldownUntilMs = 0;

function isTruthyEnv(value) {
  if (value == null || value === "") return false;
  const v = String(value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function readIntEnv(name, fallback, { min = 1 } = {}) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= min ? Math.floor(parsed) : fallback;
}

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  if (phase === "phase-production-build" || phase === "phase-export" || phase === "phase-static") {
    return true;
  }
  if (process.env.NEXT_RUNTIME === "edge") return true;
  return false;
}

/** Pool depth at or below this triggers a refill. */
export function refillThreshold() {
  return readIntEnv("ZAI_REFILL_THRESHOLD", ZAI_REFILL_DEFAULT_THRESHOLD, { min: 1 });
}

/** Pool depth the scheduler aims for after a successful harvest. */
export function refillTarget() {
  const target = readIntEnv("ZAI_REFILL_TARGET", ZAI_REFILL_DEFAULT_TARGET, { min: 1 });
  return Math.max(target, refillThreshold());
}

/** How many tokens to ask for, given the current depth. */
export function tokensToHarvest(remaining, target = refillTarget()) {
  const gap = target - remaining;
  return gap > 0 ? gap : 0;
}

/**
 * Resolve the chat.z.ai JWT. Prefers the env var so the secret can be injected
 * without touching disk. Returns null when unavailable (scheduler then no-ops).
 */
export function resolveJwt({ env = process.env, homedir = os.homedir() } = {}) {
  const fromEnv = String(env.ZAI_TOKEN || "").trim();
  if (fromEnv) return fromEnv;

  const file = env.ZAI_TOKEN_FILE || path.join(homedir, ".hermes", "zai-jwt");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
  if (!raw) return null;

  // Warn (never block) when the secret is group/world readable.
  try {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode & 0o077) {
      log.warn("ZAI_REFILL", "JWT file is readable by other users — chmod 600 recommended", {
        file,
        mode: mode.toString(8).padStart(3, "0"),
      });
    }
  } catch {
    /* stat is best-effort */
  }
  return raw;
}

/** Harvest runs out-of-process; the JWT travels via env, never argv (argv is world-readable in ps). */
export function runHarvest({ scriptPath, jwt, count, timeoutMs = DEFAULT_HARVEST_TIMEOUT_MS, spawnFn = spawn }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn("python3", [scriptPath, "--count", String(count)], {
        env: { ...process.env, ZAI_TOKEN: jwt },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ ok: false, error: err?.message ?? String(err) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ ok: false, error: `harvest timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    if (timer.unref) timer.unref();

    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => finish({ ok: false, error: err?.message ?? String(err) }));
    child.on("close", (code) => {
      finish({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function lockPath() {
  return process.env.ZAI_REFILL_LOCK || `${getPoolPath()}.refill.lock`;
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
  } catch (err) {
    return err?.code === "EPERM";
  }
  try {
    // A zombie still answers signal 0 but is effectively gone — and a SIGKILLed
    // server leaves one behind, which would hold this lock for the full stale
    // window and block every refill in the meantime.
    const stat = fs.readFileSync(`/proc/${n}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    if (stat.slice(end + 2, end + 3) === "Z") return false;
  } catch {
    /* no /proc (macOS/Windows) — trust signal 0 */
  }
  return true;
}

/**
 * Cross-process guard: the pool file is shared (e.g. two servers on different
 * ports), so two processes must not harvest at once.
 *
 * Acquisition is atomic — the lock is created with O_CREAT|O_EXCL, so exactly
 * one process can win even when several race at the same instant. A lock older
 * than LOCK_STALE_MS, or whose owner pid is gone, is reclaimed.
 */
export function acquireRefillLock({ nowMs = Date.now(), lockFile = lockPath() } = {}) {
  const payload = JSON.stringify({ pid: process.pid, at: nowMs });

  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  } catch {
    /* already there */
  }

  const tryCreate = () => {
    try {
      fs.writeFileSync(lockFile, payload, { flag: "wx", mode: 0o600 });
      return { ok: true };
    } catch (err) {
      if (err?.code === "EEXIST") return { ok: false, reason: "exists" };
      return { ok: false, reason: "write-failed", error: err?.message ?? String(err) };
    }
  };

  const first = tryCreate();
  if (first.ok) return first;
  if (first.reason !== "exists") return first;

  // Someone holds it. Reclaim only when the holder is demonstrably gone.
  let held = null;
  try {
    held = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch {
    /* unreadable/corrupt — treat as reclaimable below */
  }
  const ageMs = nowMs - Number(held?.at || 0);
  const stale =
    !held ||
    !Number.isFinite(ageMs) ||
    ageMs >= LOCK_STALE_MS ||
    !isPidAlive(Number(held?.pid));
  if (!stale) return { ok: false, reason: "held", holder: held };

  try {
    fs.rmSync(lockFile, { force: true });
  } catch {
    /* best-effort */
  }
  const second = tryCreate();
  return second.ok ? second : { ok: false, reason: "held", holder: held };
}

export function releaseRefillLock({ lockFile = lockPath() } = {}) {
  try {
    fs.rmSync(lockFile, { force: true });
  } catch {
    /* best-effort */
  }
}

function resolveScriptPath() {
  // Module-relative first: independent of the process cwd, which differs between
  // a repo checkout and the standalone build (<root>/src/sse/services → <root>).
  // fileURLToPath (not .pathname) so percent-encoded paths — e.g. a checkout
  // under a directory with spaces — still resolve.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.ZAI_HARVEST_SCRIPT,
    path.join(moduleDir, "..", "..", "..", "scripts", "zai-harvest-device-tokens.py"),
    path.join(process.cwd(), "scripts", "zai-harvest-device-tokens.py"),
    path.join(process.cwd(), "..", "scripts", "zai-harvest-device-tokens.py"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * One refill tick. Returns a small result object describing what happened.
 * @param {object} [deps] injectable seams for tests
 */
export async function runZaiRefillTick(deps = {}) {
  if (tickRunning) return { action: "skip", reason: "tick-running" };
  tickRunning = true;
  try {
    const status = (deps.poolStatus || poolStatus)();
    const remaining = Number(status?.remaining || 0);
    const threshold = deps.threshold ?? refillThreshold();
    const target = deps.target ?? refillTarget();

    if (remaining >= threshold) return { action: "skip", reason: "above-threshold", remaining };

    const nowMs = (deps.now || Date.now)();
    if (nowMs < cooldownUntilMs) {
      return { action: "skip", reason: "cooldown", remaining, retryInMs: cooldownUntilMs - nowMs };
    }

    const jwt = (deps.resolveJwt || resolveJwt)();
    if (!jwt) return { action: "skip", reason: "no-jwt", remaining };

    // Explicit undefined check (not ??) so tests can force "no script" with null.
    const scriptPath = deps.scriptPath !== undefined ? deps.scriptPath : resolveScriptPath();
    if (!scriptPath) return { action: "skip", reason: "no-script", remaining };

    const lock = (deps.acquireLock || acquireRefillLock)({ nowMs });
    if (!lock.ok) return { action: "skip", reason: "locked", remaining, detail: lock };

    try {
      const count = tokensToHarvest(remaining, target);
      const timeoutMs = deps.timeoutMs ?? readIntEnv("ZAI_REFILL_TIMEOUT_MS", DEFAULT_HARVEST_TIMEOUT_MS);
      const result = await (deps.harvest || runHarvest)({ scriptPath, jwt, count, timeoutMs });

      if (!result?.ok) {
        const cooldownMs = deps.cooldownMs ?? readIntEnv("ZAI_REFILL_COOLDOWN_MS", DEFAULT_COOLDOWN_MS);
        cooldownUntilMs = nowMs + cooldownMs;
        log.warn("ZAI_REFILL", "Harvest failed — backing off", {
          remaining,
          error: result?.error || `exit ${result?.code}`,
          stderr: result?.stderr ? String(result.stderr).slice(-300) : undefined,
          cooldownMs,
        });
        return { action: "failed", reason: "harvest-failed", remaining, detail: result };
      }

      const after = (deps.poolStatus || poolStatus)().remaining;
      log.info("ZAI_REFILL", "Pool topped up", { before: remaining, after, requested: count });
      return { action: "refilled", before: remaining, after, requested: count };
    } finally {
      (deps.releaseLock || releaseRefillLock)({});
    }
  } catch (err) {
    log.warn("ZAI_REFILL", "Tick failed (swallowed)", { error: err?.message ?? String(err) });
    return { action: "failed", reason: "tick-error", error: err?.message ?? String(err) };
  } finally {
    tickRunning = false;
  }
}

/**
 * Start the refill interval. Safe to call multiple times (no-op if already started).
 * @returns {boolean} true if started this call
 */
export function startZaiDeviceTokenRefill({ intervalMs } = {}) {
  if (started) return false;
  if (isTruthyEnv(process.env.DISABLE_ZAI_AUTO_REFILL)) return false;
  if (isNonServerRuntime()) return false;

  started = true;
  const period =
    Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : readIntEnv("ZAI_REFILL_INTERVAL_MS", DEFAULT_INTERVAL_MS);

  const safeTick = () => {
    runZaiRefillTick().catch((err) => {
      log.warn("ZAI_REFILL", "Unhandled tick rejection (swallowed)", {
        error: err?.message ?? String(err),
      });
    });
  };

  initialTimeoutHandle = setTimeout(safeTick, INITIAL_DELAY_MS);
  if (initialTimeoutHandle.unref) initialTimeoutHandle.unref();

  intervalHandle = setInterval(safeTick, period);
  if (intervalHandle.unref) intervalHandle.unref();

  return true;
}

export function stopZaiDeviceTokenRefill() {
  if (initialTimeoutHandle) {
    clearTimeout(initialTimeoutHandle);
    initialTimeoutHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (started) started = false;
}

/** Test seam: clear module-level cooldown state. */
export function _resetZaiRefillState() {
  cooldownUntilMs = 0;
  tickRunning = false;
}
