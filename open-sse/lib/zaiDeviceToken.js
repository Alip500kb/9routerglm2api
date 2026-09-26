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
  fs.writeFileSync(file, JSON.stringify({ ...pool, updatedAt: Date.now() }, null, 2));
}

/**
 * Atomically take the next device token. Single-use: the token is removed from
 * the pool so two concurrent requests can never share one.
 * Returns null when the pool is empty.
 */
export function takeDeviceToken() {
  const pool = readPool();
  if (pool.tokens.length === 0) return null;
  const [token, ...rest] = pool.tokens;
  writePool({ ...pool, tokens: rest });
  return token;
}

/** Put a token back (e.g. the captcha step failed for a reason other than the token). */
export function returnDeviceToken(token) {
  if (!token) return;
  const pool = readPool();
  pool.tokens.unshift(token);
  writePool(pool);
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
  const pool = readPool();
  const merged = [...pool.tokens, ...clean];
  writePool({ ...pool, tokens: merged });
  return merged.length;
}
