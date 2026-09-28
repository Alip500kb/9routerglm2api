/**
 * Unit tests for the Z.AI device-token auto-refill scheduler.
 *
 * Covers the pure helpers (threshold/target/gap, JWT resolution, lock
 * lifecycle) and a fake tick that exercises the decision tree without ever
 * spawning a real harvester.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ZAI_REFILL_DEFAULT_THRESHOLD,
  ZAI_REFILL_DEFAULT_TARGET,
  refillThreshold,
  refillTarget,
  tokensToHarvest,
  resolveJwt,
  acquireRefillLock,
  releaseRefillLock,
  runZaiRefillTick,
  startZaiDeviceTokenRefill,
  stopZaiDeviceTokenRefill,
  _resetZaiRefillState,
} from "@/sse/services/zaiDeviceTokenRefill.js";

const ENV_KEYS = [
  "ZAI_TOKEN",
  "ZAI_TOKEN_FILE",
  "ZAI_REFILL_THRESHOLD",
  "ZAI_REFILL_TARGET",
  "ZAI_REFILL_COOLDOWN_MS",
  "ZAI_REFILL_LOCK",
  "DISABLE_ZAI_AUTO_REFILL",
];

let savedEnv;
let tmpDir;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zai-refill-"));
  _resetZaiRefillState();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  stopZaiDeviceTokenRefill();
  _resetZaiRefillState();
  vi.restoreAllMocks();
});

describe("threshold / target / gap", () => {
  it("defaults to sensible values", () => {
    expect(refillThreshold()).toBe(ZAI_REFILL_DEFAULT_THRESHOLD);
    expect(refillTarget()).toBe(ZAI_REFILL_DEFAULT_TARGET);
  });

  it("honours env overrides", () => {
    process.env.ZAI_REFILL_THRESHOLD = "3";
    process.env.ZAI_REFILL_TARGET = "25";
    expect(refillThreshold()).toBe(3);
    expect(refillTarget()).toBe(25);
  });

  it("ignores junk env values", () => {
    process.env.ZAI_REFILL_THRESHOLD = "abc";
    process.env.ZAI_REFILL_TARGET = "-5";
    expect(refillThreshold()).toBe(ZAI_REFILL_DEFAULT_THRESHOLD);
    expect(refillTarget()).toBe(ZAI_REFILL_DEFAULT_TARGET);
  });

  it("never sets target below threshold", () => {
    process.env.ZAI_REFILL_THRESHOLD = "40";
    process.env.ZAI_REFILL_TARGET = "5";
    expect(refillTarget()).toBe(40);
  });

  it("computes the gap to fill", () => {
    expect(tokensToHarvest(0, 50)).toBe(50);
    expect(tokensToHarvest(45, 50)).toBe(5);
    expect(tokensToHarvest(50, 50)).toBe(0);
    expect(tokensToHarvest(99, 50)).toBe(0);
  });
});

describe("resolveJwt", () => {
  it("prefers the env var over the file", () => {
    const file = path.join(tmpDir, "zai-jwt");
    fs.writeFileSync(file, "from-file");
    expect(resolveJwt({ env: { ZAI_TOKEN: "from-env", ZAI_TOKEN_FILE: file } })).toBe("from-env");
  });

  it("falls back to ZAI_TOKEN_FILE", () => {
    const file = path.join(tmpDir, "zai-jwt");
    fs.writeFileSync(file, "  from-file  \n");
    expect(resolveJwt({ env: { ZAI_TOKEN_FILE: file } })).toBe("from-file");
  });

  it("falls back to ~/.hermes/zai-jwt", () => {
    const file = path.join(tmpDir, ".hermes", "zai-jwt");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "home-file");
    expect(resolveJwt({ env: {}, homedir: tmpDir })).toBe("home-file");
  });

  it("returns null when nothing is configured", () => {
    expect(resolveJwt({ env: {}, homedir: tmpDir })).toBeNull();
  });

  it("returns null for an empty file", () => {
    const file = path.join(tmpDir, "zai-jwt");
    fs.writeFileSync(file, "   \n");
    expect(resolveJwt({ env: { ZAI_TOKEN_FILE: file } })).toBeNull();
  });
});

describe("refill lock", () => {
  it("acquires then releases", () => {
    const lockFile = path.join(tmpDir, "pool.lock");
    const first = acquireRefillLock({ lockFile, nowMs: 1000 });
    expect(first.ok).toBe(true);
    expect(fs.existsSync(lockFile)).toBe(true);

    releaseRefillLock({ lockFile });
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("refuses a second holder while the owner is alive", () => {
    const lockFile = path.join(tmpDir, "pool.lock");
    expect(acquireRefillLock({ lockFile, nowMs: 1000 }).ok).toBe(true);
    const second = acquireRefillLock({ lockFile, nowMs: 2000 });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("held");
  });

  it("reclaims a stale lock whose owner is gone", () => {
    const lockFile = path.join(tmpDir, "pool.lock");
    // pid 0 / dead pid, old timestamp
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, at: 1 }));
    const got = acquireRefillLock({ lockFile, nowMs: Date.now() });
    expect(got.ok).toBe(true);
  });

  it("treats a corrupt lock as free", () => {
    const lockFile = path.join(tmpDir, "pool.lock");
    fs.writeFileSync(lockFile, "not json");
    expect(acquireRefillLock({ lockFile, nowMs: Date.now() }).ok).toBe(true);
  });
});

describe("runZaiRefillTick", () => {
  function poolWith(remaining) {
    return () => ({ remaining, updatedAt: Date.now(), path: "/tmp/pool.json" });
  }

  it("skips when the pool is healthy", async () => {
    const res = await runZaiRefillTick({
      poolStatus: poolWith(40),
      threshold: 10,
      target: 50,
      resolveJwt: () => "jwt",
      scriptPath: "/fake/harvest.py",
    });
    expect(res.action).toBe("skip");
    expect(res.reason).toBe("above-threshold");
  });

  it("skips when no JWT is configured", async () => {
    const res = await runZaiRefillTick({
      poolStatus: poolWith(2),
      threshold: 10,
      resolveJwt: () => null,
      scriptPath: "/fake/harvest.py",
    });
    expect(res.action).toBe("skip");
    expect(res.reason).toBe("no-jwt");
  });

  it("skips when the harvester script is missing", async () => {
    const res = await runZaiRefillTick({
      poolStatus: poolWith(2),
      threshold: 10,
      resolveJwt: () => "jwt",
      scriptPath: null,
    });
    expect(res.action).toBe("skip");
    expect(res.reason).toBe("no-script");
  });

  it("skips when another process holds the lock", async () => {
    const res = await runZaiRefillTick({
      poolStatus: poolWith(2),
      threshold: 10,
      resolveJwt: () => "jwt",
      scriptPath: "/fake/harvest.py",
      acquireLock: () => ({ ok: false, reason: "held" }),
    });
    expect(res.action).toBe("skip");
    expect(res.reason).toBe("locked");
  });

  it("refills and reports before/after", async () => {
    let remaining = 2;
    const harvest = vi.fn(async ({ count }) => {
      remaining += count;
      return { ok: true, code: 0 };
    });
    const res = await runZaiRefillTick({
      poolStatus: () => ({ remaining }),
      threshold: 10,
      target: 50,
      resolveJwt: () => "jwt",
      scriptPath: "/fake/harvest.py",
      acquireLock: () => ({ ok: true }),
      releaseLock: () => {},
      harvest,
    });
    expect(res.action).toBe("refilled");
    expect(res.before).toBe(2);
    expect(res.after).toBe(50);
    expect(harvest).toHaveBeenCalledWith(expect.objectContaining({ count: 48 }));
  });

  it("backs off after a failed harvest", async () => {
    const harvest = vi.fn(async () => ({ ok: false, code: 1, stderr: "boom" }));
    const deps = {
      poolStatus: poolWith(2),
      threshold: 10,
      target: 50,
      resolveJwt: () => "jwt",
      scriptPath: "/fake/harvest.py",
      acquireLock: () => ({ ok: true }),
      releaseLock: () => {},
      cooldownMs: 60_000,
      harvest,
    };

    const first = await runZaiRefillTick(deps);
    expect(first.action).toBe("failed");

    // Second tick inside the cooldown must not spawn another harvest.
    const second = await runZaiRefillTick(deps);
    expect(second.action).toBe("skip");
    expect(second.reason).toBe("cooldown");
    expect(harvest).toHaveBeenCalledTimes(1);
  });

  it("releases the lock even when the harvest throws", async () => {
    const releaseLock = vi.fn();
    const res = await runZaiRefillTick({
      poolStatus: poolWith(2),
      threshold: 10,
      resolveJwt: () => "jwt",
      scriptPath: "/fake/harvest.py",
      acquireLock: () => ({ ok: true }),
      releaseLock,
      harvest: async () => {
        throw new Error("kaboom");
      },
    });
    expect(res.action).toBe("failed");
    expect(releaseLock).toHaveBeenCalled();
  });
});

describe("startZaiDeviceTokenRefill", () => {
  it("is idempotent and respects the disable flag", () => {
    expect(startZaiDeviceTokenRefill({ intervalMs: 60_000 })).toBe(true);
    expect(startZaiDeviceTokenRefill({ intervalMs: 60_000 })).toBe(false);
    stopZaiDeviceTokenRefill();

    process.env.DISABLE_ZAI_AUTO_REFILL = "1";
    expect(startZaiDeviceTokenRefill({ intervalMs: 60_000 })).toBe(false);
  });
});
