/**
 * Regression tests for the Z.AI device-token pool concurrency fixes.
 *
 * The pool file is shared by every server instance (two ports in dev) AND by
 * the harvester, so three bugs were possible:
 *
 *   1. takeDeviceToken() was read-modify-write with no lock -> two concurrent
 *      requests could read the same head token, share it, and lose entries.
 *   2. The harvester snapshotted the pool BEFORE the ~40s browser harvest and
 *      wrote that stale snapshot back -> tokens spent during the window were
 *      resurrected and handed out twice.
 *   3. The refill lock was check-then-write -> two processes could both decide
 *      they held it.
 *
 * These tests pin the fixed behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";

let tmpDir;
let poolFile;
let savedPool;

const mod = () => import("open-sse/lib/zaiDeviceToken.js");

function writePool(tokens) {
  fs.writeFileSync(poolFile, JSON.stringify({ tokens, updatedAt: Date.now() }));
}

function readPool() {
  return JSON.parse(fs.readFileSync(poolFile, "utf8")).tokens;
}

beforeEach(() => {
  savedPool = process.env.ZAI_DEVICE_TOKEN_POOL;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zai-pool-lock-"));
  poolFile = path.join(tmpDir, "pool.json");
  process.env.ZAI_DEVICE_TOKEN_POOL = poolFile;
});

afterEach(() => {
  if (savedPool === undefined) delete process.env.ZAI_DEVICE_TOKEN_POOL;
  else process.env.ZAI_DEVICE_TOKEN_POOL = savedPool;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("takeDeviceToken concurrency", () => {
  it("never hands the same token to two callers in one process", async () => {
    const { takeDeviceToken } = await mod();
    writePool(["a", "b", "c", "d"]);

    const got = [takeDeviceToken(), takeDeviceToken(), takeDeviceToken(), takeDeviceToken()];
    expect(new Set(got).size).toBe(4);
    expect(readPool()).toHaveLength(0);
  });

  it("does not duplicate or lose tokens across processes", async () => {
    writePool(Array.from({ length: 20 }, (_, i) => `t${i}`));

    // Four workers each take 5 tokens from the shared pool.
    const worker = path.join(tmpDir, "w.mjs");
    fs.writeFileSync(
      worker,
      `
      const { takeDeviceToken } = await import("${process.cwd()}/open-sse/lib/zaiDeviceToken.js");
      const out = [];
      for (let i = 0; i < 5; i++) out.push(takeDeviceToken());
      process.stdout.write(JSON.stringify(out));
      `
    );

    const results = await Promise.all(
      [0, 1, 2, 3].map(
        () =>
          new Promise((resolve) => {
            const child = fork(worker, [], {
              cwd: process.cwd(),
              stdio: ["ignore", "pipe", "inherit", "ipc"],
            });
            let buf = "";
            child.stdout.on("data", (d) => (buf += d));
            child.on("close", () => resolve(JSON.parse(buf || "[]")));
          })
      )
    );

    const got = results.flat().filter(Boolean);
    expect(got).toHaveLength(20);
    expect(new Set(got).size).toBe(20); // no duplicates
    expect(readPool()).toHaveLength(0); // nothing lost
  }, 30_000);

  it("returns null on an empty pool and leaves no temp files behind", async () => {
    const { takeDeviceToken } = await mod();
    writePool([]);
    expect(takeDeviceToken()).toBeNull();

    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toHaveLength(0);
  });

  it("reclaims a lock left by a dead process", async () => {
    const { takeDeviceToken } = await mod();
    writePool(["only"]);
    // Stale lock owned by a pid that cannot exist.
    fs.writeFileSync(`${poolFile}.lock`, JSON.stringify({ pid: 999999, at: Date.now() }));

    expect(takeDeviceToken()).toBe("only");
    expect(fs.existsSync(`${poolFile}.lock`)).toBe(false);
  });

  it("treats a zombie pid as dead (a SIGKILLed server leaves one behind)", async () => {
    const { isPidAlive } = await mod();
    if (process.platform !== "linux") return; // /proc-based check

    // A real zombie: this helper forks a grandchild that exits at once and then
    // sleeps without reaping it, so the grandchild stays <defunct> — exactly the
    // state a SIGKILLed server leaves behind.
    const { spawn } = await import("node:child_process");
    const helper = spawn("python3", [
      "-c",
      "import os,sys,time; p=os.fork();\n" +
        "if p==0: os._exit(0)\n" +
        "print(p, flush=True); time.sleep(15)",
    ]);

    const zombiePid = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("no pid from helper")), 8000);
      helper.stdout.on("data", (d) => {
        buf += d;
        const n = parseInt(buf.trim(), 10);
        if (Number.isFinite(n)) {
          clearTimeout(timer);
          resolve(n);
        }
      });
    });

    try {
      const readState = () => {
        try {
          const stat = fs.readFileSync(`/proc/${zombiePid}/stat`, "utf8");
          return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
        } catch {
          return "";
        }
      };
      const { execFileSync } = await import("node:child_process");
      for (let i = 0; i < 40 && readState() !== "Z"; i++) execFileSync("sleep", ["0.05"]);
      expect(readState()).toBe("Z");

      // Signal 0 still succeeds for a zombie — the regression guard.
      expect(() => process.kill(zombiePid, 0)).not.toThrow();
      expect(isPidAlive(zombiePid)).toBe(false);

      // And its lock must not block the pool.
      writePool(["only"]);
      fs.writeFileSync(`${poolFile}.lock`, JSON.stringify({ pid: zombiePid, at: Date.now() }));
      const { takeDeviceToken } = await mod();
      expect(takeDeviceToken()).toBe("only");
    } finally {
      try {
        helper.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 25_000);

  it("addDeviceTokens dedupes against the current pool", async () => {
    const { addDeviceTokens } = await mod();
    writePool(["a", "b"]);
    const total = addDeviceTokens(["b", "c"]);
    expect(total).toBe(3);
    expect(readPool()).toEqual(["a", "b", "c"]);
  });
});
