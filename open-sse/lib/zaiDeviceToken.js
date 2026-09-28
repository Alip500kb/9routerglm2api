/**
 * Z.AI device-token pool.
 *
 * The Aliyun captcha chain needs a "deviceToken" that only Aliyun FeiLin — an
 * anti-bot script requiring a real browser engine (99 `document` refs, 147
 * `navigator` refs) — can mint. It cannot run in Node.
 *
 * So tokens are harvested once by a browser and stored in a pool file; the
 * executor consumes one per completion. Both the device token AND the
 * resulting captcha_verify_param are SINGLE USE, so the pool must always hold
 * at least as many tokens as pending requests.
 *
 * Pool file (default ~/.hermes/zai-device-tokens.json, override with
 * ZAI_DEVICE_TOKEN_POOL):
 *   { "tokens": ["<base64 device token>", ...], "updatedAt": 1699999999999 }
 *
 * Refresh with:  python3 scripts/zai-harvest-device-tokens.py
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_POOL_PATH = path.join(os.homedir(), ".hermes", "zai-device-tokens.json");

export function getPoolPath() {
  return process.env.ZAI_DEVICE_TOKEN_POOL || DEFAULT_POOL_PATH;
}

function readPool() {
  const file = getPoolPath();
  try {
    const raw = fs.readFileSync(file, "utf8");
    const json = JSON.parse(raw);
    const tokens = Array.isArray(json?.tokens) ? json.tokens.filter((t) => typeof t === "string" && t) : [];
    return { tokens, updatedAt: json?.updatedAt ?? 0 };
  } catch {
    return { tokens: [], updatedAt: 0 };
  }
}

function writePool(pool) {
  const file = getPoolPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write to a temp file then rename: rename is atomic on POSIX, so a reader
  // never observes a half-written pool (which would parse as empty and make
  // every concurrent request see "pool exhausted").
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...pool, updatedAt: Date.now() }, null, 2));
  fs.renameSync(tmp, file);
}

function lockPath() {
  return `${getPoolPath()}.lock`;
}

const LOCK_STALE_MS = 30 * 1000;
// The critical section is two file ops, so contention windows are microseconds.
// Keep the wait short: takeDeviceToken() is synchronous and runs on the request
// path, so every millisecond here is a blocked event loop.
const LOCK_WAIT_MS = 1 * 1000;

/**
 * Is a pid still running?
 *
 * `process.kill(pid, 0)` also succeeds for a zombie — a process that exited but
 * whose parent has not reaped it yet. A server killed with SIGKILL leaves one
 * behind, and treating it as alive kept its pool lock "held" until the stale
 * timeout, stalling every refill in the meantime. Rule zombies out.
 */
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
  } catch (err) {
    return err?.code === "EPERM"; // exists, just owned by someone else
  }
  try {
    // comm may contain spaces and parens, so read the state after the last ')'.
    const stat = fs.readFileSync(`/proc/${n}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    if (stat.slice(end + 2, end + 3) === "Z") return false;
  } catch {
    /* no /proc (macOS/Windows) — trust signal 0 */
  }
  return true;
}

/**
 * Serialise pool mutations across processes.
 *
 * takeDeviceToken() and the harvester both do read-modify-write on one shared
 * file, and the pool is shared by every server instance (e.g. two ports). Two
 * concurrent takes used to both read the same head token, hand it to two
 * requests, and lose entries on write-back. O_CREAT|O_EXCL makes exactly one
 * winner per instant; losers spin briefly, then give up and proceed unlocked
 * rather than deadlocking a request.
 */
function withPoolLock(fn) {
  const lock = lockPath();
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;

  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
  } catch {
    /* already there */
  }

  while (Date.now() < deadline) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), {
        flag: "wx",
        mode: 0o600,
      });
      held = true;
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") break;
      // Reclaim a lock left behind by a crashed process.
      try {
        const info = JSON.parse(fs.readFileSync(lock, "utf8"));
        const ageMs = Date.now() - Number(info?.at || 0);
        if (!isPidAlive(info?.pid) || ageMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        /* corrupt lock — let the retry loop handle it */
      }
      // True synchronous sleep (busy-spinning would burn a core on the server).
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      } catch {
        const end = Date.now() + 2;
        while (Date.now() < end) {
          /* fallback spin */
        }
      }
    }
  }

  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.rmSync(lock, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Atomically take the next device token. Single-use: the token is removed from
 * the pool so two concurrent requests can never share one.
 * Returns null when the pool is empty.
 */
export function takeDeviceToken() {
  return withPoolLock(() => {
    const pool = readPool();
    if (pool.tokens.length === 0) return null;
    const [token, ...rest] = pool.tokens;
    writePool({ ...pool, tokens: rest });
    return token;
  });
}

/** Put a token back (e.g. the captcha step failed for a reason other than the token). */
export function returnDeviceToken(token) {
  if (!token) return;
  withPoolLock(() => {
    const pool = readPool();
    pool.tokens.unshift(token);
    writePool(pool);
  });
}

/** Pool depth, for status reporting and pre-flight checks. */
export function poolStatus() {
  const pool = readPool();
  return { remaining: pool.tokens.length, updatedAt: pool.updatedAt, path: getPoolPath() };
}

/** Bulk-add tokens (used by the harvester). */
export function addDeviceTokens(tokens) {
  const clean = (tokens || []).filter((t) => typeof t === "string" && t);
  if (clean.length === 0) return 0;
  return withPoolLock(() => {
    const pool = readPool();
    const merged = [...pool.tokens, ...clean.filter((t) => !pool.tokens.includes(t))];
    writePool({ ...pool, tokens: merged });
    return merged.length;
  });
}

/** Lock path used by takeDeviceToken/returnDeviceToken/addDeviceTokens. */
export { lockPath as getPoolLockPath };
