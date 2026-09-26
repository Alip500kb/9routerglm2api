import { describe, it, expect } from "vitest";
import {
  buildBridgePrompt,
  parseToolCall,
  emitToolCallChunks,
  stripToolCallJson,
  generateToolCallId,
} from "open-sse/lib/zaiToolBridge.js";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get current weather for a city",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  },
];

describe("zaiToolBridge: buildBridgePrompt", () => {
  it("returns the system prompt unchanged when there are no tools", () => {
    expect(buildBridgePrompt([], "You are helpful.")).toBe("You are helpful.");
    expect(buildBridgePrompt(null, "x")).toBe("x");
  });

  it("declares every tool name and the required JSON contract", () => {
    const prompt = buildBridgePrompt(TOOLS, "You are helpful.");
    expect(prompt).toContain("You are helpful.");
    expect(prompt).toContain("get_weather");
    expect(prompt).toContain('{"tool":"<tool_name>","args":{...}}');
    expect(prompt).toContain("Get current weather for a city");
  });

  it("accepts bare function objects (no {type,function} wrapper)", () => {
    const prompt = buildBridgePrompt([{ name: "ping", description: "p" }]);
    expect(prompt).toContain("ping");
  });
});

describe("zaiToolBridge: parseToolCall", () => {
  it("parses a bare JSON object reply", () => {
    expect(parseToolCall('{"tool":"get_weather","args":{"city":"Tokyo"}}')).toEqual({
      tool: "get_weather",
      args: { city: "Tokyo" },
    });
  });

  it("parses a fenced JSON block", () => {
    const text = 'Sure!\n```json\n{"tool":"get_weather","args":{"city":"Paris"}}\n```';
    expect(parseToolCall(text)).toEqual({ tool: "get_weather", args: { city: "Paris" } });
  });

  it("parses an inline JSON object embedded in prose", () => {
    const text = 'Let me check. {"tool":"get_weather","args":{"city":"Oslo"}} done.';
    expect(parseToolCall(text)).toEqual({ tool: "get_weather", args: { city: "Oslo" } });
  });

  it("accepts the OpenAI function/arguments shape", () => {
    expect(parseToolCall('{"function":{"name":"get_weather","arguments":"{\\"city\\":\\"Rome\\"}"}}')).toEqual({
      tool: "get_weather",
      args: { city: "Rome" },
    });
  });

  it("returns null for a plain-text answer", () => {
    expect(parseToolCall("The weather in Tokyo is sunny.")).toBeNull();
    expect(parseToolCall("")).toBeNull();
    expect(parseToolCall(null)).toBeNull();
  });
});

describe("zaiToolBridge: stripToolCallJson", () => {
  it("removes the JSON block and keeps surrounding prose", () => {
    const text = 'Checking now. {"tool":"get_weather","args":{"city":"Tokyo"}}';
    expect(stripToolCallJson(text)).toBe("Checking now.");
  });

  it("removes fenced JSON blocks", () => {
    const text = 'Here you go:\n```json\n{"tool":"x","args":{}}\n```';
    expect(stripToolCallJson(text)).toBe("Here you go:");
  });

  it("returns empty string for non-string input", () => {
    expect(stripToolCallJson(null)).toBe("");
    expect(stripToolCallJson(undefined)).toBe("");
  });
});

describe("zaiToolBridge: emitToolCallChunks", () => {
  it("emits one tool_calls delta per call then a finish_reason chunk", () => {
    const deltas = [];
    const chunkFn = (delta, finish) => deltas.push({ delta, finish });
    let roleCount = 0;
    const emitted = emitToolCallChunks(chunkFn, () => { roleCount++; }, [
      { tool: "get_weather", args: { city: "Tokyo" } },
    ]);

    expect(emitted).toBe(true);
    expect(roleCount).toBe(1);
    expect(deltas).toHaveLength(2);
    const call = deltas[0].delta.tool_calls[0];
    expect(call.index).toBe(0);
    expect(call.type).toBe("function");
    expect(call.function.name).toBe("get_weather");
    expect(JSON.parse(call.function.arguments)).toEqual({ city: "Tokyo" });
    expect(deltas[1].finish).toBe("tool_calls");
  });

  it("returns false and emits nothing when there are no calls", () => {
    const deltas = [];
    const emitted = emitToolCallChunks((d, f) => deltas.push({ d, f }), () => {}, []);
    expect(emitted).toBe(false);
    expect(deltas).toHaveLength(0);
  });
});

describe("zaiToolBridge: generateToolCallId", () => {
  it("produces a unique call_ id", () => {
    const a = generateToolCallId();
    const b = generateToolCallId();
    expect(a).toMatch(/^call_zai_/);
    expect(a).not.toBe(b);
  });
});
