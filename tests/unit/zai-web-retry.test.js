import { describe, it, expect } from "vitest";
import { isTransientUpstreamError, looksLikeTruncatedToolCall } from "open-sse/executors/zai-web.js";
import { findJsonObjects } from "open-sse/lib/zaiToolBridge.js";

describe("zai-web: isTransientUpstreamError", () => {
  it("flags capacity/interference codes as retryable", () => {
    for (const code of ["MODEL_CONCURRENCY_LIMIT", "INTERNAL_ERROR", "RATE_LIMIT", "SERVER_BUSY"]) {
      expect(isTransientUpstreamError({ code })).toBe(true);
    }
  });

  it("accepts error_code as well as code", () => {
    expect(isTransientUpstreamError({ error_code: "INTERNAL_ERROR" })).toBe(true);
  });

  it("does not flag captcha or unknown errors", () => {
    expect(isTransientUpstreamError({ code: "FRONTEND_CAPTCHA_REQUIRED" })).toBe(false);
    expect(isTransientUpstreamError({ code: "SOME_OTHER" })).toBe(false);
    expect(isTransientUpstreamError(null)).toBe(false);
    expect(isTransientUpstreamError(undefined)).toBe(false);
  });
});

describe("zai-web: looksLikeTruncatedToolCall", () => {
  it("detects a bare cut fragment", () => {
    expect(looksLikeTruncatedToolCall('{"')).toBe(true);
    expect(looksLikeTruncatedToolCall('{"tool":"get')).toBe(true);
    expect(looksLikeTruncatedToolCall('{"tool":"get_weather","args":{"city":"Tok')).toBe(true);
  });

  it("detects an unterminated string", () => {
    expect(looksLikeTruncatedToolCall('{"tool":"get_weather')).toBe(true);
  });

  it("returns false for complete, balanced JSON", () => {
    expect(looksLikeTruncatedToolCall('{"tool":"get_weather","args":{"city":"Tokyo"}}')).toBe(false);
    expect(looksLikeTruncatedToolCall('{"foo":"bar"}')).toBe(false);
  });

  it("returns false for plain prose and empty strings", () => {
    expect(looksLikeTruncatedToolCall("The weather is sunny.")).toBe(false);
    expect(looksLikeTruncatedToolCall("")).toBe(false);
    expect(looksLikeTruncatedToolCall(null)).toBe(false);
  });

  it("flags any brace-opening fragment that is not valid JSON", () => {
    expect(looksLikeTruncatedToolCall('{"foo":"bar"')).toBe(true);
  });
});

describe("zaiToolBridge: findJsonObjects", () => {
  it("extracts nested objects as a single balanced unit", () => {
    const text = 'x {"tool":"t","args":{"a":{"b":1}}} y {"other":2}';
    const found = findJsonObjects(text);
    expect(found).toContain('{"tool":"t","args":{"a":{"b":1}}}');
    expect(found).toContain('{"other":2}');
  });

  it("ignores braces inside string literals", () => {
    const found = findJsonObjects('{"tool":"a{b}c","args":{}}');
    expect(found).toEqual(['{"tool":"a{b}c","args":{}}']);
  });

  it("handles escaped quotes inside strings", () => {
    const found = findJsonObjects('{"tool":"say \\"hi\\"","args":{}}');
    expect(found).toHaveLength(1);
    expect(JSON.parse(found[0]).tool).toBe('say "hi"');
  });

  it("returns an empty array when there is no object", () => {
    expect(findJsonObjects("no json here")).toEqual([]);
    expect(findJsonObjects("")).toEqual([]);
  });
});
