import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";

import { buildSignature, extractZaiToken, resolveUpstreamModel, ZaiWebExecutor } from "open-sse/executors/zai-web.js";
import { aliHash, urlEncode, signAliyunParams, CAPTCHA_SCENE_ID, computeCaptchaVerifyParam } from "open-sse/lib/zaiCaptcha.js";
import { takeDeviceToken, returnDeviceToken, poolStatus, addDeviceTokens, getPoolPath } from "open-sse/lib/zaiDeviceToken.js";

// A real chat.z.ai JWT shape (payload only needs `id` for the executor).
const TOKEN =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9." +
  Buffer.from(JSON.stringify({ id: "4e9f00e1-5e8b-492a-889c-28ec91a031b9", email: "a@b.c" })).toString("base64url") +
  ".sig";

describe("zai-web: extractZaiToken", () => {
  it("accepts a bare JWT", () => {
    expect(extractZaiToken(TOKEN)).toBe(TOKEN);
  });

  it("unwraps a JSON credential envelope", () => {
    expect(extractZaiToken(JSON.stringify({ value: TOKEN }))).toBe(TOKEN);
    expect(extractZaiToken(JSON.stringify({ token: TOKEN }))).toBe(TOKEN);
  });

  it("strips a Bearer prefix and surrounding quotes", () => {
    expect(extractZaiToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(extractZaiToken(`"${TOKEN}"`)).toBe(TOKEN);
  });

  it("extracts token= from a cookie string", () => {
    expect(extractZaiToken(`acw_tc=abc; token=${TOKEN}; _ga=1`)).toBe(TOKEN);
  });

  it("returns null for empty input", () => {
    expect(extractZaiToken("")).toBeNull();
    expect(extractZaiToken(null)).toBeNull();
    expect(extractZaiToken(undefined)).toBeNull();
  });
});

describe("zai-web: buildSignature", () => {
  // Independent re-derivation of the documented algorithm. If the executor's
  // implementation drifts, this test fails.
  function reference({ requestId, timestamp, userId, prompt }) {
    const SALT = "key-@@@@)))()((9))-xxxx&&&%%%%%";
    const sortedPayload = [["requestId", requestId], ["timestamp", timestamp], ["user_id", userId]]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k},${v}`)
      .join(",");
    const b64 = Buffer.from(String(prompt).trim(), "utf8").toString("base64");
    const bucket = Math.round(Number(timestamp) / (5 * 60 * 1000));
    const stage2 = createHmac("sha256", SALT).update(String(bucket)).digest("hex");
    return createHmac("sha256", stage2).update(`${sortedPayload}|${b64}|${timestamp}`).digest("hex");
  }

  it("matches the reference implementation", () => {
    const cases = [
      { requestId: "abc-123", timestamp: "1790300000000", userId: "u-1", prompt: "hello world" },
      { requestId: "x", timestamp: "1790999999999", userId: "u", prompt: "  padded  " },
      { requestId: "z", timestamp: "1", userId: "y", prompt: "unicode ✓ 日本語" },
    ];
    for (const c of cases) {
      expect(buildSignature(c)).toBe(reference(c));
    }
  });

  it("produces 64 hex chars", () => {
    const sig = buildSignature({ requestId: "r", timestamp: "1790300000000", userId: "u", prompt: "p" });
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the prompt changes", () => {
    const base = { requestId: "r", timestamp: "1790300000000", userId: "u" };
    expect(buildSignature({ ...base, prompt: "a" })).not.toBe(buildSignature({ ...base, prompt: "b" }));
  });

  it("uses round() for the 5-minute bucket, not floor()", () => {
    // 1790300250000 is exactly 1.5 buckets after the epoch-aligned origin, so
    // floor and round disagree — this pins the correct variant.
    const ts = "1790300250000";
    const SALT = "key-@@@@)))()((9))-xxxx&&&%%%%%";
    const bucket = Math.round(Number(ts) / 300000);
    const stage2 = createHmac("sha256", SALT).update(String(bucket)).digest("hex");
    const sortedPayload = "requestId,r,timestamp," + ts + ",user_id,u";
    const b64 = Buffer.from("p", "utf8").toString("base64");
    const expected = createHmac("sha256", stage2).update(`${sortedPayload}|${b64}|${ts}`).digest("hex");
    expect(buildSignature({ requestId: "r", timestamp: ts, userId: "u", prompt: "p" })).toBe(expected);
  });
});

describe("zaiCaptcha: primitives", () => {
  it("urlEncode matches RFC3986 unreserved rules", () => {
    expect(urlEncode("a b")).toBe("a%20b");
    expect(urlEncode("a+b")).toBe("a%2Bb");
    expect(urlEncode("a=b")).toBe("a%3Db");
    expect(urlEncode("a~b-c_d.e")).toBe("a~b-c_d.e");
    expect(urlEncode("x%y")).toBe("x%25y");
  });

  it("aliHash is deterministic and 32 hex chars", () => {
    const a = aliHash('{"a":1}', "0000");
    const b = aliHash('{"a":1}', "0000");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("aliHash is sensitive to both input and salt", () => {
    expect(aliHash("x", "0000")).not.toBe(aliHash("y", "0000"));
    expect(aliHash("x", "0000")).not.toBe(aliHash("x", "1111"));
  });

  it("signAliyunParams produces a base64 HMAC-SHA1 over sorted params", () => {
    const params = { AccessKeyId: "AK", Action: "InitCaptchaV3", Timestamp: "2026-01-01T00:00:00Z" };
    const sig = signAliyunParams(params, "SECRET");
    expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // stable across key insertion order
    const reordered = { Timestamp: params.Timestamp, Action: params.Action, AccessKeyId: params.AccessKeyId };
    expect(signAliyunParams(reordered, "SECRET")).toBe(sig);
    expect(signAliyunParams(params, "OTHER")).not.toBe(sig);
  });

  it("uses the chat.z.ai scene id", () => {
    expect(CAPTCHA_SCENE_ID).toBe("didk33e0");
  });

  it("computeCaptchaVerifyParam returns null without a device token", async () => {
    await expect(computeCaptchaVerifyParam("")).resolves.toBeNull();
    await expect(computeCaptchaVerifyParam(null)).resolves.toBeNull();
  });
});

describe("zaiDeviceToken: pool", () => {
  let tmpPool;
  const savedEnv = process.env.ZAI_DEVICE_TOKEN_POOL;

  beforeEach(() => {
    tmpPool = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zai-pool-")), "pool.json");
    process.env.ZAI_DEVICE_TOKEN_POOL = tmpPool;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ZAI_DEVICE_TOKEN_POOL;
    else process.env.ZAI_DEVICE_TOKEN_POOL = savedEnv;
  });

  it("honours the env override", () => {
    expect(getPoolPath()).toBe(tmpPool);
  });

  it("starts empty", () => {
    expect(poolStatus().remaining).toBe(0);
    expect(takeDeviceToken()).toBeNull();
  });

  it("adds and drains tokens FIFO", () => {
    addDeviceTokens(["t1", "t2", "t3"]);
    expect(poolStatus().remaining).toBe(3);
    expect(takeDeviceToken()).toBe("t1");
    expect(takeDeviceToken()).toBe("t2");
    expect(poolStatus().remaining).toBe(1);
    expect(takeDeviceToken()).toBe("t3");
    expect(takeDeviceToken()).toBeNull();
  });

  it("is single-use: a taken token is gone", () => {
    addDeviceTokens(["only"]);
    expect(takeDeviceToken()).toBe("only");
    expect(takeDeviceToken()).toBeNull();
    expect(poolStatus().remaining).toBe(0);
  });

  it("returns a token to the front of the queue", () => {
    addDeviceTokens(["a", "b"]);
    const t = takeDeviceToken();
    expect(t).toBe("a");
    returnDeviceToken(t);
    expect(takeDeviceToken()).toBe("a");
  });

  it("ignores empty and non-string entries", () => {
    addDeviceTokens(["", null, undefined, "ok", 0, "ok2"]);
    expect(poolStatus().remaining).toBe(2);
  });

  it("survives a corrupt pool file", () => {
    fs.writeFileSync(tmpPool, "{not json");
    expect(poolStatus().remaining).toBe(0);
    expect(takeDeviceToken()).toBeNull();
  });
});

describe("zai-web: executor guards", () => {
  const ex = new ZaiWebExecutor();
  const log = { info() {}, warn() {}, error() {}, debug() {} };

  it("registers under the zai-web provider id", () => {
    expect(ex.provider).toBe("zai-web");
  });

  it("rejects a missing token with 400", async () => {
    const res = await ex.execute({ model: "glm-5.3", body: { messages: [] }, stream: true, credentials: {}, signal: null, log });
    expect(res.response.status).toBe(400);
    const body = await res.response.json();
    expect(body.error.code).toBe("ZAI_NO_TOKEN");
  });

  it("rejects a malformed token with 400", async () => {
    const res = await ex.execute({
      model: "glm-5.3",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "not-a-jwt" },
      signal: null,
      log,
    });
    expect(res.response.status).toBe(400);
    const body = await res.response.json();
    expect(body.error.code).toBe("ZAI_BAD_TOKEN");
  });
});

describe("zai-web: model aliasing", () => {
  it("maps the client ids to upstream ids", () => {
    expect(resolveUpstreamModel("glm-5.3-flash")).toBe("x-preview-l");
    expect(resolveUpstreamModel("glm-5.3")).toBe("glm-5.3");
    expect(resolveUpstreamModel("glm-5.2")).toBe("glm-5.2");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(resolveUpstreamModel("  GLM-5.3-Flash  ")).toBe("x-preview-l");
  });

  it("passes unknown ids through and defaults when empty", () => {
    expect(resolveUpstreamModel("glm-9.9")).toBe("glm-9.9");
    expect(resolveUpstreamModel("")).toBe("glm-5.3");
    expect(resolveUpstreamModel(null)).toBe("glm-5.3");
  });
});

describe("zai-web: empty pool fails fast", () => {
  let tmpPool;
  const savedEnv = process.env.ZAI_DEVICE_TOKEN_POOL;

  beforeEach(() => {
    tmpPool = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zai-pool-")), "pool.json");
    process.env.ZAI_DEVICE_TOKEN_POOL = tmpPool;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ZAI_DEVICE_TOKEN_POOL;
    else process.env.ZAI_DEVICE_TOKEN_POOL = savedEnv;
  });

  it("returns an actionable 503 without touching the network", async () => {
    const ex = new ZaiWebExecutor();
    const t0 = Date.now();
    const res = await ex.execute({
      model: "glm-5.3-flash",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: TOKEN },
      signal: null,
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });
    // Must be immediate (no fe-version scrape, no completion attempt).
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(res.response.status).toBe(503);
    const body = await res.response.json();
    expect(body.error.code).toBe("ZAI_DEVICE_TOKEN_POOL_EMPTY");
    expect(body.error.message).toContain("zai-harvest-device-tokens.py");
  });
});
