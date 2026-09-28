/**
 * Regression tests for the zai-web tool-call bridge.
 *
 * These pin the two bugs that made an agent see a hollow/one-token reply
 * ("S") instead of a tool call:
 *
 *   1. `buildUpstreamMessages` dropped assistant turns whose `tool_calls`
 *      were present but whose `content` was null — the model then saw a
 *      "Tool result" turn with no originating call, so it could not tell
 *      which tool had run and stalled.
 *   2. The SSE collector accumulated reasoning/usage/done but ignored
 *      `content` events, so an answer that arrived on plain answer deltas
 *      (no closing edit frame) aggregated to "".
 *
 * Both helpers are exported from the executor so these tests exercise the
 * real implementation, not a copy.
 */
import { describe, it, expect } from "vitest";
import {
  buildBridgePrompt,
  parseToolCall,
  stripToolCallJson,
  isToolCallShape,
} from "open-sse/lib/zaiToolBridge.js";
import {
  buildUpstreamMessages,
  makeSseCollector,
  looksLikeTruncatedToolCall,
} from "open-sse/executors/zai-web.js";

// --- 1. The bridge prompt must explain how to continue after a tool result ---

describe("zaiToolBridge: bridge prompt continuation rules", () => {
  const TOOLS = [
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "List a directory",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
  ];

  it("tells the model that a 'Tool result' turn is its own earlier call", () => {
    const prompt = buildBridgePrompt(TOOLS, "");
    expect(prompt).toContain("Tool result");
    expect(prompt.toLowerCase()).toContain("already called");
  });

  it("forbids repeating an identical tool call", () => {
    const prompt = buildBridgePrompt(TOOLS, "");
    expect(prompt.toLowerCase()).toContain("never repeat");
  });
});

// --- 2. An assistant tool_calls turn must survive into the upstream transcript ---

describe("zai-web buildUpstreamMessages: assistant tool_calls are preserved", () => {
  const TOOLS = [
    { type: "function", function: { name: "list_dir", description: "List a directory", parameters: {} } },
  ];

  const messages = [
    { role: "user", content: "adopsi mod ini /home/alip/Documents/hermes-brutal-mod-main/" },
    {
      role: "assistant",
      content: null, // <-- the shape OpenAI agents send for a tool-call turn
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "list_dir", arguments: JSON.stringify({ path: "/home/alip/Documents/hermes-brutal-mod-main" }) },
        },
      ],
    },
    { role: "tool", name: "list_dir", content: "README.md\npackage.json" },
  ];

  it("renders the tool call even though content is null", () => {
    const out = buildUpstreamMessages(messages, TOOLS);
    const joined = out.map((m) => m.content).join("\n");
    expect(joined).toContain("list_dir");
    expect(joined).toContain("hermes-brutal-mod-main");
  });

  it("keeps an assistant turn whose only payload is the tool call", () => {
    const out = buildUpstreamMessages(messages, TOOLS);
    expect(out.some((m) => m.role === "assistant")).toBe(true);
  });

  it("still folds the system prompt into the first user turn", () => {
    const out = buildUpstreamMessages(messages, TOOLS);
    expect(out[0].role).toBe("user");
    expect(out[0].content).toContain("You have access to the following tools");
  });

  it("preserves assistant prose alongside the rendered call", () => {
    const withProse = [
      messages[0],
      { ...messages[1], content: "Baik, saya cek direktorinya." },
      messages[2],
    ];
    const out = buildUpstreamMessages(withProse, TOOLS);
    const asst = out.find((m) => m.role === "assistant");
    expect(asst.content).toContain("saya cek direktorinya");
    expect(asst.content).toContain("list_dir");
  });

  it("drops a genuinely empty assistant turn", () => {
    const out = buildUpstreamMessages([{ role: "user", content: "hi" }, { role: "assistant", content: "" }], null);
    expect(out.filter((m) => m.role === "assistant")).toHaveLength(0);
  });
});

// --- 3. Answer text must survive every delivery path the site uses ---

describe("zai-web collector: answer text survives every delivery path", () => {
  it("keeps prose delivered as answer deltas after the reasoning block closes", () => {
    const c = makeSseCollector("glm-5.3-flash");
    const pre = '<details type="reasoning" done="false">\n> thinking';
    c.push({ phase: "thinking", delta_content: pre });
    // The site rewrites the `false` marker in place to close the block.
    c.push({ phase: "answer", edit_index: pre.indexOf("false"), edit_content: 'true">\n> thinking\n</details>\n' });
    c.push({ phase: "answer", delta_content: "Halo, " });
    c.push({ phase: "answer", delta_content: "saya akan membaca direktori itu." });
    c.push({ phase: "done", done: true });
    expect(c.result().content).toBe("Halo, saya akan membaca direktori itu.");
  });

  it("keeps prose delivered via an edit frame", () => {
    const c = makeSseCollector("glm-5.3-flash");
    c.push({ phase: "answer", edit_index: 0, edit_content: "Jawaban final." });
    c.push({ phase: "done", done: true });
    expect(c.result().content).toBe("Jawaban final.");
  });

  it("strips the reasoning block from the visible answer", () => {
    const c = makeSseCollector("glm-5.3-flash");
    const pre = '<details type="reasoning" done="false">\n> why';
    c.push({ phase: "thinking", delta_content: pre });
    c.push({
      phase: "answer",
      edit_index: pre.indexOf("false"),
      edit_content: 'true">\n> why\n</details>\n{"tool":"x","args":{}}',
    });
    expect(c.result().content).toBe('{"tool":"x","args":{}}');
  });

  it("never returns a hollow string when the answer had content", () => {
    const c = makeSseCollector("glm-5.3-flash");
    c.push({ phase: "answer", delta_content: "S" });
    expect(c.result().content).toBe("S");
  });

  it("reports done and reasoning alongside the answer", () => {
    const c = makeSseCollector("glm-5.3-flash");
    const pre = '<details type="reasoning" done="false">\n> step';
    c.push({ phase: "thinking", delta_content: pre });
    c.push({
      phase: "answer",
      edit_index: pre.indexOf("false"),
      edit_content: 'true">\n> step\n</details>\nDone.',
    });
    c.push({ phase: "done", done: true });
    const r = c.result();
    expect(r.content).toBe("Done.");
    expect(r.done).toBe(true);
    expect(r.reasoningContent).toContain("step");
  });
});

// --- 4. Raw tool-call JSON must never leak into `content` ---
//
// The model often prefixes its JSON with prose or a reasoning block, and the
// stream can be cut anywhere. The executor's leak guard used to require the
// reply to START with "{", so "prose + truncated JSON" was treated as a normal
// reply and the raw `{"tool":…` text was streamed to the client as content.

describe("zai-web: raw tool JSON never leaks into content", () => {
  const CALL = '{"tool":"terminal","args":{"command":"ls -la"}}';
  const TRUNC = '{"tool":"terminal","args":{"command":"ls -la';

  it("flags a bare truncated call", () => {
    expect(looksLikeTruncatedToolCall(TRUNC)).toBe(true);
  });

  it("flags a truncated call preceded by prose", () => {
    expect(looksLikeTruncatedToolCall(`Saya jalankan.\n${TRUNC}`)).toBe(true);
  });

  it("flags a truncated call preceded by a reasoning block", () => {
    const content = `<details type="reasoning" done="true">\n> mikir\n</details>\n${TRUNC}`;
    expect(looksLikeTruncatedToolCall(content)).toBe(true);
  });

  it("does not flag a complete call", () => {
    expect(looksLikeTruncatedToolCall(CALL)).toBe(false);
    expect(looksLikeTruncatedToolCall(`Baik.\n${CALL}`)).toBe(false);
  });

  it("does not flag ordinary prose that merely contains a brace", () => {
    expect(looksLikeTruncatedToolCall("Gunakan format {key: value} ya.")).toBe(false);
    expect(looksLikeTruncatedToolCall("")).toBe(false);
    expect(looksLikeTruncatedToolCall("Jawaban biasa tanpa JSON.")).toBe(false);
  });

  it("leaves no JSON behind once a call is parsed", () => {
    for (const content of [
      CALL,
      `Baik, saya cek.\n${CALL}`,
      `Saya cek.\n${CALL}\nSelesai.`,
      "```json\n" + CALL + "\n```",
      `<details type="reasoning" done="true">\n> mikir\n</details>\n${CALL}`,
    ]) {
      expect(parseToolCall(content)).toBeTruthy();
      const visible = stripToolCallJson(content);
      expect(visible).not.toContain('"tool"');
      expect(visible).not.toContain("command");
      expect(visible).not.toContain("<details");
    }
  });

  it("keeps the surrounding prose when stripping the call", () => {
    expect(stripToolCallJson(`Baik, saya cek.\n${CALL}`)).toBe("Baik, saya cek.");
  });
});

// --- 5. Every accepted call shape must also be recognised by the leak guard ---
//
// `normalize()` accepted `{name,arguments}` but the detection predicates only
// looked for `tool`/`function`, so that shape parsed as null and leaked.

describe("zaiToolBridge: call-shape detection is consistent", () => {
  it("accepts the bare {name, arguments} form", () => {
    const obj = { name: "terminal", arguments: { command: "ls" } };
    expect(isToolCallShape(obj)).toBe(true);
    expect(parseToolCall(JSON.stringify(obj))).toEqual({
      tool: "terminal",
      args: { command: "ls" },
    });
  });

  it("accepts the bare {name, args} form", () => {
    const obj = { name: "terminal", args: { command: "ls" } };
    expect(parseToolCall(JSON.stringify(obj))?.tool).toBe("terminal");
  });

  it("rejects a bare {name} object with no arguments", () => {
    expect(isToolCallShape({ name: "someone" })).toBe(false);
    expect(parseToolCall('{"name":"someone"}')).toBeNull();
  });

  it("still accepts the OpenAI wrapper form", () => {
    const obj = { type: "function", function: { name: "terminal", arguments: '{"command":"ls"}' } };
    expect(parseToolCall(JSON.stringify(obj))).toEqual({
      tool: "terminal",
      args: { command: "ls" },
    });
  });
});
