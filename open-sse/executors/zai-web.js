import { createHmac, randomUUID } from "node:crypto";
import { BaseExecutor } from "./base.js";
import { computeCaptchaVerifyParam } from "../lib/zaiCaptcha.js";
import { takeDeviceToken, returnDeviceToken, poolStatus } from "../lib/zaiDeviceToken.js";
import { buildBridgePrompt, parseToolCall, emitToolCallChunks, stripToolCallJson } from "../lib/zaiToolBridge.js";

/**
 * Z.AI (chat.z.ai) web-cookie executor.
 *
 * Mirrors the DeepSeek Web cookie provider: the user pastes the `token` value
 * from chat.z.ai localStorage and this executor speaks the site's private
 * completion API on their behalf.
 *
 * Two gates sit in front of POST /api/v2/chat/completions:
 *
 *   1. X-Signature — a two-stage HMAC-SHA256 over (requestId,timestamp,user_id)
 *      plus the base64 prompt. Derived from the frontend bundle; see
 *      buildSignature().
 *   2. captcha_verify_param — an Aliyun CaptchaVerifyParam, REQUIRED on every
 *      request (per-request, not per-session). Minted by lib/zaiCaptcha.js from
 *      a single-use device token supplied by lib/zaiDeviceToken.js.
 *
 * Because both the device token and the param are single-use, each completion
 * consumes exactly one pooled token. An empty pool is a hard, actionable error.
 */

const ZAI_BASE = "https://chat.z.ai";
const COMPLETION_URL = `${ZAI_BASE}/api/v2/chat/completions`;

const DEFAULT_FE_VERSION = "prod-fe-1.1.96";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

// Fixed stage-1 HMAC key. Public constant from the frontend bundle; independently
// corroborated by the open-source GLM-Free-API project.
const SALT_KEY = "key-@@@@)))()((9))-xxxx&&&%%%%%";

// Client-facing id -> upstream id. glm-5.3-flash is served upstream as
// "x-preview-l" (its display name is literally "GLM-5.3-Flash").
const MODEL_ALIASES = {
  "glm-5.3-flash": "x-preview-l",
  "glm-5.3": "glm-5.3",
  "glm-5.2": "glm-5.2",
};

const feVersionCache = { value: null, expiresAt: 0 };

export function resolveUpstreamModel(model) {
  const id = String(model || "").trim().toLowerCase();
  return MODEL_ALIASES[id] || id || "glm-5.3";
}

/**
 * Remove the "<details type=reasoning>" wrapper the site embeds in its output.
 * Handles the unclosed case too: while streaming, the block is still open, so
 * anything from the opening tag onwards is reasoning.
 */
function stripReasoningBlock(text) {
  return String(text || "")
    .replace(/<details\s+type="reasoning"[^>]*>[\s\S]*?<\/details>\s*/gi, "")
    .replace(/<details\s+type="reasoning"[^>]*>[\s\S]*$/i, "");
}

/** Strip the reasoning wrapper's own markup from a reasoning delta. */
function cleanReasoningDelta(text) {
  return String(text || "")
    .replace(/<details\s+type="reasoning"[^>]*>/gi, "")
    .replace(/<\/details>/gi, "");
}

export function extractZaiToken(raw) {
  if (!raw) return null;
  let str = String(raw).trim();
  try {
    const parsed = JSON.parse(str);
    if (typeof parsed?.value === "string") str = parsed.value.trim();
    else if (typeof parsed?.token === "string") str = parsed.token.trim();
  } catch {}
  if (str.includes("token=")) {
    const m = str.match(/(?:^|;\s*)token=([^;]+)/);
    if (m) str = m[1].trim();
  }
  if (str.startsWith("Bearer ")) str = str.slice(7).trim();
  str = str.replace(/^["']|["']$/g, "").trim();
  return str || null;
}

function decodeUserId(token) {
  try {
    const payload = token.split(".")[1];
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return json?.id || "";
  } catch {
    return "";
  }
}

function errorResponse(status, message, code) {
  return new Response(
    JSON.stringify({
      error: { message, type: "upstream_error", code: code ?? `HTTP_${status}` },
    }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

/** Latest live frontend version, so X-FE-Version never goes stale. */
async function resolveFeVersion(log) {
  const now = Date.now();
  if (feVersionCache.value && feVersionCache.expiresAt > now) return feVersionCache.value;
  try {
    // The version lives in the HTML shell (script src), not in /api/config.
    const resp = await fetch(`${ZAI_BASE}/`, { headers: { "User-Agent": DEFAULT_UA } });
    if (resp.ok) {
      const html = await resp.text();
      const m = html.match(/prod-fe-\d+\.\d+\.\d+/);
      if (m) {
        feVersionCache.value = m[0];
        feVersionCache.expiresAt = now + 30 * 60 * 1000;
        return m[0];
      }
    }
  } catch (err) {
    log?.debug?.("ZAI-WEB", `fe version scrape failed: ${err?.message ?? err}`);
  }
  return DEFAULT_FE_VERSION;
}

/**
 * X-Signature:
 *   sortedPayload = "requestId,<id>,timestamp,<ts>,user_id,<uid>" (keys sorted)
 *   bucket        = round(ts / 300000)
 *   stage2        = HMAC-SHA256(SALT_KEY, bucket)          -> hex
 *   signature     = HMAC-SHA256(stage2, sortedPayload|b64(prompt)|ts) -> hex
 */
export function buildSignature({ requestId, timestamp, userId, prompt }) {
  const sortedPayload = [["requestId", requestId], ["timestamp", timestamp], ["user_id", userId]]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k},${v}`)
    .join(",");

  const promptB64 = Buffer.from(String(prompt ?? "").trim(), "utf8").toString("base64");
  const bucket = Math.round(Number(timestamp) / (5 * 60 * 1000));
  const stage2 = createHmac("sha256", SALT_KEY).update(String(bucket)).digest("hex");
  return createHmac("sha256", stage2).update(`${sortedPayload}|${promptB64}|${timestamp}`).digest("hex");
}

function buildQueryString({ requestId, timestamp, userId, token }) {
  const params = {
    timestamp,
    requestId,
    user_id: userId,
    version: "0.0.1",
    platform: "web",
    token,
    user_agent: DEFAULT_UA,
    language: "en-US",
    languages: "en-US,en",
    timezone: "Asia/Jakarta",
    timezone_offset: String(new Date().getTimezoneOffset()),
    cookie_enabled: "true",
    screen_width: "1680",
    screen_height: "1050",
    screen_resolution: "1680x1050",
    viewport_width: "1680",
    viewport_height: "951",
    viewport_size: "1680x951",
    color_depth: "24",
    pixel_ratio: "1",
    current_url: `${ZAI_BASE}/`,
    pathname: "/",
    search: "",
    hash: "",
    host: "chat.z.ai",
    hostname: "chat.z.ai",
    protocol: "https:",
    referrer: "",
    title: "Z.ai - Advanced AI Chatbot",
    local_time: new Date().toISOString(),
    utc_time: new Date().toUTCString(),
    is_mobile: "false",
    is_touch: "false",
    max_touch_points: "0",
    browser_name: "Chrome",
    os_name: "Windows",
    signature_timestamp: timestamp,
  };
  return new URLSearchParams(params).toString();
}

function extractMessageText(content) {
  if (Array.isArray(content)) {
    return content
      .filter((c) => c?.type === "text" || typeof c === "string")
      .map((c) => (typeof c === "string" ? c : String(c?.text ?? "")))
      .join("\n");
  }
  return String(content ?? "");
}

function lastUserPrompt(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i]?.role === "user") return extractMessageText(arr[i].content).trim();
  }
  return "";
}

/** Build the upstream message list; system turns are folded into the first user turn. */
function buildUpstreamMessages(messages, tools) {
  const arr = Array.isArray(messages) ? messages : [];
  const out = [];
  const systemParts = [];

  for (const m of arr) {
    const text = extractMessageText(m?.content).trim();
    if (!text) continue;
    if (m.role === "system" || m.role === "developer") {
      systemParts.push(text);
      continue;
    }
    if (m.role === "user" || m.role === "assistant") {
      out.push({ role: m.role, content: text });
    } else if (m.role === "tool") {
      out.push({ role: "user", content: `Tool result${m.name ? ` (${m.name})` : ""}: ${text}` });
    }
  }

  // When tools are present, append the bridge instruction to the system block.
  // This instructs the model to answer with a plain JSON object
  // {"tool":"<name>","args":{...}} instead of using a native tool-calling API
  // (which the zai completion endpoint does not support for arbitrary tools).
  if (tools && tools.length > 0) {
    const bridge = buildBridgePrompt(tools, "");
    systemParts.push(bridge);
  }

  if (systemParts.length > 0) {
    const joined = systemParts.join("\n\n");
    const firstUser = out.findIndex((m) => m.role === "user");
    if (firstUser >= 0) out[firstUser] = { role: "user", content: `${joined}\n\n${out[firstUser].content}` };
    else out.unshift({ role: "user", content: joined });
  }
  return out;
}

/**
 * Parse one upstream SSE frame.
 * Returns { kind, text } where kind is "reasoning" | "content" | "usage" | "done".
 *
 * Upstream frames carry either:
 *   { delta_content, phase: "thinking" }            -> reasoning delta
 *   { edit_index, edit_content, phase: "answer" }   -> answer is an EDIT: the
 *                                                     buffer is truncated to
 *                                                     edit_index then extended
 *   { phase: "done", done: true }                   -> terminal
 */
function parseFrame(payload, state) {
  const events = [];
  const phase = payload?.phase;

  if (phase === "done" || payload?.done === true) {
    return { events: [{ kind: "done" }], state };
  }

  if (typeof payload?.usage === "object" && payload.usage) {
    events.push({ kind: "usage", usage: payload.usage });
  }

  if (typeof payload?.delta_content === "string" && payload.delta_content.length > 0) {
    // Deltas build the raw buffer; the answer phase later patches it via
    // edit_index/edit_content (which is how the site flips done="false" to
    // done="true" and appends the real answer after </details>).
    state.raw += payload.delta_content;
    if (phase === "thinking") events.push({ kind: "reasoning", text: cleanReasoningDelta(payload.delta_content) });
    else events.push({ kind: "content", text: payload.delta_content });
  }

  if (typeof payload?.edit_content === "string") {
    const idx = typeof payload.edit_index === "number" ? payload.edit_index : state.raw.length;
    state.raw = state.raw.slice(0, idx) + payload.edit_content;
    // Project the edit onto user-visible content (reasoning block removed) and
    // emit only the newly-appended tail.
    const projected = stripReasoningBlock(state.raw);
    if (projected.length > state.emitted.length && projected.startsWith(state.emitted)) {
      const delta = projected.slice(state.emitted.length);
      state.emitted = projected;
      if (delta) events.push({ kind: "content", text: delta });
    } else if (projected !== state.emitted) {
      // Rewrite (e.g. the reasoning block was closed): emit the corrected tail.
      state.emitted = projected;
      events.push({ kind: "content", text: projected });
    }
  }

  return { events, state };
}

function makeSseCollector(model) {
  const state = { raw: "", emitted: "" };
  let reasoning = "";
  let usage = null;
  let done = false;
  return {
    push(payload) {
      const { events, state: next } = parseFrame(payload, state);
      state.raw = next.raw;
      state.emitted = next.emitted;
      for (const ev of events) {
        if (ev.kind === "reasoning") reasoning += ev.text;
        else if (ev.kind === "usage") usage = ev.usage;
        else if (ev.kind === "done") done = true;
      }
      return events;
    },
    result() {
      return { content: state.emitted, reasoningContent: reasoning, usage, done, model };
    },
  };
}

function toOpenAIChunk({ id, created, model, delta, finish }) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  };
}

/**
 * Re-wrap a partially-consumed upstream body. `prelude` holds bytes already
 * read from `reader` while probing for a captcha rejection; re-emitting them
 * first lets a downstream collector see the complete stream.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {string} prelude
 * @returns {ReadableStream<Uint8Array>}
 */
function replayBody(reader, prelude) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      if (prelude) controller.enqueue(encoder.encode(prelude));
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch {
        /* upstream aborted — close with what we have */
      }
      try { controller.close(); } catch {}
    },
    cancel() {
      try { reader.cancel(); } catch {}
    },
  });
}

/** Stream upstream SSE -> OpenAI SSE. `reader` may already have `prelude` consumed. */
function transformSSE(reader, prelude, clientModel, onFirstChunk) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const id = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  const collector = makeSseCollector(clientModel);
  let roleSent = false;

  return new ReadableStream(
    {
      async start(controller) {
        let buffer = prelude || "";
        let closed = false;

        const emit = (obj) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        };
        const ensureRole = () => {
          if (roleSent) return;
          roleSent = true;
          emit(toOpenAIChunk({ id, created, model: clientModel, delta: { role: "assistant", content: "" } }));
        };
        const finish = (reason = "stop") => {
          if (closed) return;
          closed = true;
          ensureRole();
          emit(toOpenAIChunk({ id, created, model: clientModel, delta: {}, finish: reason }));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          try { controller.close(); } catch {}
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const raw = line.replace(/^data:\s*/, "").trim();
              if (!raw || raw === "[DONE]") continue;

              let frame;
              try {
                frame = JSON.parse(raw);
              } catch {
                continue;
              }

              // Upstream may wrap the payload one or two levels deep.
              const payload = frame?.data?.data ?? frame?.data ?? frame;

              if (payload?.error) {
                const err = payload.error;
                if (err?.error_code === "FRONTEND_CAPTCHA_REQUIRED" || err?.code === "FRONTEND_CAPTCHA_REQUIRED") {
                  onFirstChunk?.("captcha");
                }
                ensureRole();
                emit(toOpenAIChunk({ id, created, model: clientModel, delta: { content: `\n[upstream error: ${err?.detail || err?.code || "unknown"}]` } }));
                finish("stop");
                return;
              }

              const events = collector.push(payload);
              for (const ev of events) {
                if (ev.kind === "reasoning") {
                  ensureRole();
                  emit(toOpenAIChunk({ id, created, model: clientModel, delta: { reasoning_content: ev.text } }));
                } else if (ev.kind === "content") {
                  ensureRole();
                  emit(toOpenAIChunk({ id, created, model: clientModel, delta: { content: ev.text } }));
                } else if (ev.kind === "done") {
                  finish("stop");
                  return;
                }
              }
            }
          }
        } catch (err) {
          if (!closed) {
            closed = true;
            try { controller.error(err); } catch {}
          }
          return;
        }
        finish("stop");
      },
      cancel() {},
    },
    { highWaterMark: 16384 }
  );
}

/** Consume the upstream SSE fully and return the aggregate answer. */
async function collectSSE(upstream, clientModel) {
  const decoder = new TextDecoder();
  const reader = upstream.getReader();
  const collector = makeSseCollector(clientModel);
  let buffer = "";
  let upstreamError = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.replace(/^data:\s*/, "").trim();
      if (!raw || raw === "[DONE]") continue;
      let frame;
      try {
        frame = JSON.parse(raw);
      } catch {
        continue;
      }
      const payload = frame?.data?.data ?? frame?.data ?? frame;
      if (payload?.error) {
        upstreamError = payload.error;
        continue;
      }
      collector.push(payload);
    }
  }
  return { ...collector.result(), upstreamError };
}

function isCaptchaError(err) {
  return err?.error_code === "FRONTEND_CAPTCHA_REQUIRED" || err?.code === "FRONTEND_CAPTCHA_REQUIRED";
}

// Upstream capacity/interference errors. chat.z.ai is a free web tier shared by
// browser sessions, so it regularly answers with a well-formed SSE frame whose
// payload carries an error instead of content. These are transient: retrying
// (with a fresh device token) usually succeeds, so they must never surface as an
// empty 200 — that is what makes an agent see a truncated reply and "stream
// interrupted" churn.
const TRANSIENT_UPSTREAM_CODES = new Set([
  "MODEL_CONCURRENCY_LIMIT",
  "INTERNAL_ERROR",
  "RATE_LIMIT",
  "SERVER_BUSY",
  "TEMPORARY_UNAVAILABLE",
  "UPSTREAM_TIMEOUT",
]);

export function isTransientUpstreamError(err) {
  if (!err) return false;
  const code = err?.code || err?.error_code;
  return TRANSIENT_UPSTREAM_CODES.has(code);
}

function upstreamErrorText(err) {
  if (!err) return "unknown upstream error";
  return err.detail || err.message || err.code || err.error_code || JSON.stringify(err).slice(0, 200);
}

/**
 * True when the answer is an attempted-but-cut JSON object. chat.z.ai's free
 * tier sometimes drops the final edit_content frame, leaving a fragment like
 * `{"` or `{"tool":"get` — non-empty text that would otherwise pass through as
 * a legitimate reply and stall the caller.
 *
 * In tool mode a well-formed answer is either prose or a complete JSON object,
 * so anything that opens a brace but does not parse as complete JSON is a cut
 * generation.
 * @param {string} content
 */
export function looksLikeTruncatedToolCall(content) {
  const text = String(content || "").trim();
  if (!text.startsWith("{")) return false;
  try {
    JSON.parse(text);
    return false; // valid, complete JSON — not truncated
  } catch {
    return true; // opens a brace but never closes as valid JSON
  }
}

export class ZaiWebExecutor extends BaseExecutor {
  constructor() {
    super("zai-web", { baseUrl: ZAI_BASE });
  }

  /**
   * One upstream attempt. Consumes one pooled device token.
   * `captchaFailed` is set when upstream rejects the param, so the caller can
   * retry with a fresh token.
   */
  async #attempt({ model, body, stream, token, userId, feVersion, signal, log, clientModel }) {
    const deviceToken = takeDeviceToken();
    if (!deviceToken) {
      const st = poolStatus();
      return {
        ok: false,
        fatal: true,
        response: errorResponse(
          503,
          `Z.AI device-token pool is empty (${st.path}). The captcha gate needs one single-use token per request. ` +
            `Refill it by running: python3 scripts/zai-harvest-device-tokens.py`,
          "ZAI_DEVICE_TOKEN_POOL_EMPTY"
        ),
      };
    }

    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const tools = Array.isArray(body?.tools) && body.tools.length > 0 ? body.tools : null;
    const prompt = lastUserPrompt(messages);
    if (!prompt) {
      returnDeviceToken(deviceToken);
      return {
        ok: false,
        fatal: true,
        response: errorResponse(400, "No user message found in request", "ZAI_NO_PROMPT"),
      };
    }

    let captchaParam;
    try {
      captchaParam = await computeCaptchaVerifyParam(deviceToken);
    } catch (err) {
      returnDeviceToken(deviceToken);
      // A network blip against the Aliyun captcha host is transient — retry
      // rather than failing the whole request.
      log?.debug?.("ZAI-WEB", `captcha solve failed (${err?.message ?? err}), will retry`);
      return { ok: false, retryUpstream: true };
    }
    if (!captchaParam) {
      // Device token rejected — it was already consumed. Try the next one.
      return { ok: false, retryToken: true };
    }

    const timestamp = String(Date.now());
    const requestId = randomUUID();
    const signature = buildSignature({ requestId, timestamp, userId, prompt });
    const query = buildQueryString({ requestId, timestamp, userId, token });
    const upstreamModel = resolveUpstreamModel(model);

    const requestBody = {
      model: upstreamModel,
      messages: buildUpstreamMessages(messages, tools),
      signature_prompt: prompt,
      stream: true,
      captcha_verify_param: captchaParam,
      features: {
        flags: [],
        image_generation: false,
        web_search: body?.web_search === true || body?.features?.web_search === true,
      },
    };
    if (typeof body?.temperature === "number") requestBody.temperature = body.temperature;
    if (typeof body?.top_p === "number") requestBody.top_p = body.top_p;
    if (typeof body?.max_tokens === "number") requestBody.max_tokens = body.max_tokens;
    else requestBody.max_tokens = 8192; // default when client omits — avoids zai's small free-tier cap hitting finish_reason=length

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      "X-FE-Version": feVersion,
      "X-Signature": signature,
      "x-region": "overseas",
      Origin: ZAI_BASE,
      Referer: `${ZAI_BASE}/`,
      "User-Agent": DEFAULT_UA,
    };

    log?.info?.("ZAI-WEB", `POST ${COMPLETION_URL} (model=${upstreamModel})`);

    let resp;
    try {
      resp = await fetch(`${COMPLETION_URL}?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: signal ?? undefined,
      });
    } catch (err) {
      returnDeviceToken(deviceToken);
      return {
        ok: false,
        fatal: true,
        response: errorResponse(502, `Z.AI connection error: ${err?.message ?? err}`, "ZAI_NETWORK"),
      };
    }

    if (resp.status === 401 || resp.status === 403) {
      return {
        ok: false,
        fatal: true,
        response: errorResponse(401, "Z.AI token invalid or expired. Re-copy `token` from chat.z.ai localStorage.", "ZAI_UNAUTHORIZED"),
      };
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return {
        ok: false,
        fatal: true,
        response: errorResponse(resp.status, `Z.AI HTTP ${resp.status}: ${text.slice(0, 300)}`, `HTTP_${resp.status}`),
      };
    }

    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const json = await resp.json().catch(() => null);
      const err = json?.error || json?.detail;
      if (isCaptchaError(err)) return { ok: false, retryToken: true };
      return {
        ok: false,
        fatal: true,
        response: errorResponse(502, `Z.AI error: ${JSON.stringify(err ?? json).slice(0, 300)}`, "ZAI_UPSTREAM"),
      };
    }

    if (stream === false) {
      const { content, reasoningContent, usage, upstreamError } = await collectSSE(resp.body, clientModel);
      if (isCaptchaError(upstreamError)) return { ok: false, retryToken: true };
      if (isTransientUpstreamError(upstreamError)) {
        log?.debug?.("ZAI-WEB", `transient upstream error (${upstreamError.code}), will retry`);
        return { ok: false, retryUpstream: true };
      }
      const message = { role: "assistant", content };
      if (reasoningContent) message.reasoning_content = reasoningContent;

      // Tool-bridge: when the client sent `tools`, the bridge prompt injected
      // into the system section instructs the model to reply with a JSON object
      // {"tool":"<name>","args":{...}}. Parse it back into OpenAI tool_calls.
      let finishReason = "stop";
      if (tools?.length > 0) {
        const parsed = parseToolCall(content);
        if (parsed) {
          message.content = "";
          message.tool_calls = [
            {
              id: `call_zai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              type: "function",
              function: {
                name: parsed.tool,
                arguments: JSON.stringify(parsed.args ?? {}),
              },
            },
          ];
          finishReason = "tool_calls";
        } else if (!String(content || "").trim() || looksLikeTruncatedToolCall(content)) {
          // Hollow or cut generation (capacity interference truncated the
          // answer) — retry rather than return a truncated 200.
          log?.debug?.("ZAI-WEB", "hollow/truncated tool-mode answer, will retry");
          return { ok: false, retryUpstream: true };
        }
      }

      return {
        ok: true,
        response: new Response(
          JSON.stringify({
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: clientModel,
            choices: [{ index: 0, message, finish_reason: finishReason }],
            usage: usage
              ? {
                  prompt_tokens: usage.prompt_tokens ?? 0,
                  completion_tokens: usage.completion_tokens ?? 0,
                  total_tokens: usage.total_tokens ?? 0,
                }
              : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
        url: COMPLETION_URL,
        headers,
        transformedBody: requestBody,
      };
    }

    // Streaming: peek the first frames so a captcha rejection can be retried
    // with a fresh token instead of surfacing mid-stream. A single reader is
    // used and the already-read bytes are replayed into the client stream —
    // tee() is avoided because cancelling one branch can stall the other.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let prelude = "";
    let captchaRejected = false;
    let transientError = null;
    let sawPayload = false;

    while (!sawPayload) {
      const { done, value } = await reader.read();
      if (done) break;
      prelude += decoder.decode(value, { stream: true });
      const lines = prelude.split("\n");
      for (const line of lines.slice(0, -1)) {
        if (!line.startsWith("data:")) continue;
        const raw = line.replace(/^data:\s*/, "").trim();
        if (!raw || raw === "[DONE]") continue;
        let frame;
        try {
          frame = JSON.parse(raw);
        } catch {
          continue;
        }
        const payload = frame?.data?.data ?? frame?.data ?? frame;
        if (payload?.error) {
          if (isCaptchaError(payload.error)) {
            captchaRejected = true;
            sawPayload = true;
            break;
          }
          if (isTransientUpstreamError(payload.error)) {
            transientError = payload.error;
            sawPayload = true;
            break;
          }
        }
        if (payload && (payload.phase || payload.delta_content || payload.edit_content)) {
          sawPayload = true;
          break;
        }
      }
    }

    if (captchaRejected) {
      try { await reader.cancel(); } catch {}
      return { ok: false, retryToken: true };
    }
    if (transientError) {
      try { await reader.cancel(); } catch {}
      log?.debug?.("ZAI-WEB", `transient upstream error (${transientError.code}), will retry`);
      return { ok: false, retryUpstream: true };
    }

    // Tool mode: the web backend only speaks text, so the bridge call can only
    // be classified once the answer completes. Buffer the full upstream reply,
    // then emit a synthetic OpenAI SSE stream (prose + tool_calls deltas) —
    // exactly the shape deepseek-web produces, so agents behave identically.
    if (tools && tools.length > 0) {
      const { content, reasoningContent, upstreamError } = await collectSSE(
        replayBody(reader, prelude),
        clientModel,
      );
      if (isCaptchaError(upstreamError)) return { ok: false, retryToken: true };
      if (isTransientUpstreamError(upstreamError)) {
        log?.debug?.("ZAI-WEB", `transient upstream error in tool mode (${upstreamError.code}), will retry`);
        return { ok: false, retryUpstream: true };
      }

      const parsed = parseToolCall(content);
      // A hollow or brace-unbalanced answer in tool mode is a cut generation,
      // not a real reply — retry rather than hand the client a truncated 200
      // (the source of agent "empty/partial reply" loops).
      if (!parsed && (!String(content || "").trim() || looksLikeTruncatedToolCall(content))) {
        log?.debug?.("ZAI-WEB", "hollow/truncated tool-mode answer, will retry");
        return { ok: false, retryUpstream: true };
      }

      const visible = parsed ? stripToolCallJson(content) : content;
      const encoder = new TextEncoder();
      const id = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const created = Math.floor(Date.now() / 1000);
      let roleEmitted = false;

      const outStream = new ReadableStream({
        start(controller) {
          const chunk = (delta, finish) =>
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: clientModel,
                  choices: [{ index: 0, delta, finish_reason: finish ?? null }],
                })}\n\n`,
              ),
            );
          const ensureRole = () => {
            if (!roleEmitted) {
              roleEmitted = true;
              chunk({ role: "assistant", content: "" });
            }
          };

          if (parsed) {
            ensureRole();
            if (visible) chunk({ content: visible });
            if (reasoningContent) chunk({ reasoning_content: reasoningContent });
            emitToolCallChunks(chunk, ensureRole, [parsed]);
          } else {
            ensureRole();
            if (content) chunk({ content });
            if (reasoningContent) chunk({ reasoning_content: reasoningContent });
            chunk({}, "stop");
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      return {
        ok: true,
        response: new Response(outStream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        }),
        url: COMPLETION_URL,
        headers,
        transformedBody: requestBody,
      };
    }

    const clientStream = transformSSE(reader, prelude, clientModel, undefined, tools);
    return {
      ok: true,
      response: new Response(clientStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      }),
      url: COMPLETION_URL,
      headers,
      transformedBody: requestBody,
    };
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const rawCreds = credentials || {};
    const token = extractZaiToken(rawCreds.apiKey || rawCreds.token);

    if (!token) {
      return {
        response: errorResponse(
          400,
          "Invalid credentials: paste the `token` value from chat.z.ai localStorage " +
            "(DevTools -> Application -> Local Storage -> chat.z.ai -> token)",
          "ZAI_NO_TOKEN"
        ),
        url: COMPLETION_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const userId = decodeUserId(token);
    if (!userId) {
      return {
        response: errorResponse(400, "Malformed Z.AI token: could not decode JWT payload", "ZAI_BAD_TOKEN"),
        url: COMPLETION_URL,
        headers: {},
        transformedBody: body,
      };
    }

    // Fail fast when the pool is empty: a completion cannot succeed without a
    // device token, so don't burn a version-scrape round trip first.
    if (poolStatus().remaining === 0) {
      const st = poolStatus();
      return {
        response: errorResponse(
          503,
          `Z.AI device-token pool is empty (${st.path}). The captcha gate needs one single-use token per request. ` +
            `Refill it by running: python3 scripts/zai-harvest-device-tokens.py`,
          "ZAI_DEVICE_TOKEN_POOL_EMPTY"
        ),
        url: COMPLETION_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const feVersion = await resolveFeVersion(log);
    const clientModel = typeof model === "string" && model.trim() ? model.trim() : "glm-5.3";

    // Each attempt burns one single-use device token. The pool exists to absorb
    // the occasional already-consumed token, so a few retries are expected.
    // Transient upstream capacity errors get their own retry with a short
    // backoff — the web tier is shared with browser sessions, so a second
    // attempt after a pause usually succeeds.
    const maxAttempts = 4;
    let lastResult = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.#attempt({
        model: clientModel,
        body,
        stream,
        token,
        userId,
        feVersion,
        signal,
        log,
        clientModel,
      });
      if (result.ok || result.fatal) return result;
      lastResult = result;
      if (result.retryToken) {
        log?.debug?.("ZAI-WEB", `captcha/device token rejected, retrying (${attempt}/${maxAttempts})`);
        continue;
      }
      if (result.retryUpstream) {
        log?.debug?.("ZAI-WEB", `transient upstream error, retrying (${attempt}/${maxAttempts})`);
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 800 * attempt));
          continue;
        }
      }
      break;
    }

    const st = poolStatus();
    // Distinguish the two exhaustion modes: a genuine captcha/device-token
    // failure (pool needs refilling) versus upstream capacity interference
    // (model busy — nothing the operator can fix locally).
    if (lastResult?.retryUpstream) {
      return {
        response: errorResponse(
          503,
          `Z.AI upstream is temporarily unavailable after ${maxAttempts} attempts ` +
            `(model at capacity / internal error). Retry shortly or pick another model.`,
          "ZAI_UPSTREAM_BUSY"
        ),
        url: COMPLETION_URL,
        headers: {},
        transformedBody: body,
      };
    }
    return {
      response: errorResponse(
        503,
        `Z.AI captcha could not be satisfied after ${maxAttempts} attempts ` +
          `(${st.remaining} device tokens left at ${st.path}). ` +
          `Refill the pool: python3 scripts/zai-harvest-device-tokens.py`,
        "ZAI_CAPTCHA_EXHAUSTED"
      ),
      url: COMPLETION_URL,
      headers: {},
      transformedBody: body,
    };
  }
}
