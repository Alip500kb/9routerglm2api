/**
 * Z.AI (chat.z.ai) — OpenAI-compatible tool-call bridge.
 *
 * The zai-web completion endpoint does not accept a top-level `tools` array —
 * the site's own agent infrastructure manages its built-in tools (search,
 * retrieve, open_url) server-side via `mcp_servers`.
 *
 * This module provides a structured bridge:
 *
 *   buildBridgePrompt(tools, systemPrompt)
 *     → full system-prompt string that declares the user's tools in JSON,
 *       forces the model to reply with a single JSON object
 *       {"tool":"<name>","args":{...}} when a tool is needed.
 *
 *   parseToolCall(text)
 *     → first valid JSON object with .tool or .function keys, or null.
 *
 * The executor (zai-web.js) uses these to translate OpenAI `tools`/`tool_calls`
 * into a plain-text round-trip that the GLM model can actually produce.
 */

/**
 * Build the system-prompt injection that declares user tools.
 * @param {Array} tools   - OpenAI tools array: [{type:"function", function:{name,description,parameters}}]
 * @param {string} [systemPrompt] - existing system prompt to append to.
 * @returns {string} the full system prompt text.
 */
export function buildBridgePrompt(tools, systemPrompt = "") {
  if (!Array.isArray(tools) || tools.length === 0) return systemPrompt;

  const toolsBlock = tools
    .map((t) => {
      const fn = t?.function ?? t; // accept both {type,function} and bare
      return JSON.stringify(
        {
          name: fn?.name,
          description: fn?.description ?? "",
          parameters: fn?.parameters ?? {},
        },
        null,
        2,
      );
    })
    .join("\n");

  const instruction = `

You have access to the following tools. When you need to call one, respond with ONLY a single JSON object in this exact format — no prose, no markdown, no explanation:

{"tool":"<tool_name>","args":{...}}

Available tools:
${toolsBlock}

Rules:
- If the user's question can be answered directly without a tool, reply normally in plain text.
- If a tool is required, output exactly one JSON object matching the format above and nothing else.
- Do not wrap the JSON in code fences or add any surrounding text when calling a tool.`;

  return systemPrompt ? `${systemPrompt}\n${instruction}` : instruction;
}

/**
 * Try to extract a tool-call JSON object from the assistant's text reply.
 * Looks for the first parseable JSON object with a `tool` or `function` key.
 * @param {string} text - raw assistant content
 * @returns {null | {tool: string, args: object}}
 */
export function parseToolCall(text) {
  if (!text || typeof text !== "string") return null;

  // Try direct parse (whole reply is JSON)
  try {
    const obj = JSON.parse(text.trim());
    if (
      obj &&
      typeof obj === "object" &&
      (obj.tool !== undefined || obj.function !== undefined)
    )
      return normalize(obj);
  } catch {}

  // Look for a fenced JSON block
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fenceMatch) {
    try {
      const obj = JSON.parse(fenceMatch[1].trim());
      if (
        obj &&
        typeof obj === "object" &&
        (obj.tool !== undefined || obj.function !== undefined)
      )
        return normalize(obj);
    } catch {}
  }

  // Scan for a balanced {...} object that carries a tool marker. A naive
  // /{[^{}]*}/ regex fails on the normal nested shape
  // {"tool":"x","args":{"city":"y"}}, so walk the string with brace matching
  // (string- and escape-aware).
  for (const candidate of findJsonObjects(text)) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object" && (obj.tool !== undefined || obj.function !== undefined))
        return normalize(obj);
    } catch {
      /* not valid JSON — keep scanning */
    }
  }

  return null;
}

/**
 * Find every balanced top-level `{...}` substring in `text`, skipping braces
 * that appear inside string literals. Returns the raw substrings.
 * @param {string} text
 * @returns {string[]}
 */
export function findJsonObjects(text) {
  const out = [];
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          out.push(s.slice(i, j + 1));
          i = j; // continue scanning after this object
          break;
        }
      }
    }
  }
  return out;
}

function normalize(obj) {
  const toolName = obj.tool ?? obj.function?.name ?? obj.name;
  const args = obj.args ?? obj.arguments ?? obj.function?.arguments ?? {};
  let parsedArgs = args;
  if (typeof parsedArgs === "string") {
    try {
      parsedArgs = JSON.parse(parsedArgs);
    } catch {
      /* keep as string */
    }
  }
  return { tool: toolName, args: parsedArgs };
}

/**
 * Remove the JSON tool-call block from the assistant's visible text so stream
 * clients see only prose (the call itself travels as tool_calls deltas).
 * @param {string} text
 * @returns {string}
 */
export function stripToolCallJson(text) {
  if (!text || typeof text !== "string") return "";
  let out = text;
  // Drop fenced blocks that carry a tool call.
  out = out.replace(/```(?:json)?\s*([\s\S]*?)```/g, (match, inner) =>
    parseToolCall(inner) ? "" : match,
  );
  // Drop inline balanced objects that parse as a tool call.
  for (const obj of findJsonObjects(out)) {
    if (parseToolCall(obj)) out = out.replace(obj, "");
  }
  return out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** OpenAI-shaped id for a bridged tool call. */
export function generateToolCallId() {
  return `call_zai_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Emit OpenAI streaming tool_calls chunks for a detected call, then a final
 * `finish_reason:"tool_calls"` chunk. Mirrors deepseekWebToolBridge so both
 * web-cookie providers present an identical wire shape to clients.
 *
 * @param {(delta: object, finish?: string|null) => void} chunkFn
 * @param {() => void} ensureRoleFn  emits the initial role delta once
 * @param {Array<{tool: string, args: object}>} calls
 * @returns {boolean} true when at least one call was emitted
 */
export function emitToolCallChunks(chunkFn, ensureRoleFn, calls) {
  if (!calls || calls.length === 0) return false;
  ensureRoleFn();
  calls.forEach((call, index) => {
    chunkFn({
      tool_calls: [
        {
          index,
          id: generateToolCallId(),
          type: "function",
          function: { name: call.tool, arguments: JSON.stringify(call.args ?? {}) },
        },
      ],
    });
  });
  chunkFn({}, "tool_calls");
  return true;
}
