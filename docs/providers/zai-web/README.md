# Z.AI / ChatGLM Web (Cookie)

Use **GLM-5.3, GLM-5.3-Flash and GLM-5.2** through your own chat.z.ai account — no API key, no billing. The provider logs in with the `token` from your browser session and speaks the site's private completion API on your behalf, exposing it as a normal OpenAI-compatible model on the gateway.

```
provider id : zai-web
aliases     : zai, zai-cookie, chatglm-web
category    : webCookie
auth        : cookie (localStorage `token`)
upstream    : POST https://chat.z.ai/api/v2/chat/completions
```

---

## Why this one is interesting

chat.z.ai does not expose an API. Three separate gates sit in front of every completion, and all three had to be reverse-engineered from the site's own frontend bundle before a single request would go through:

| Gate | What it is | Where it lives |
| --- | --- | --- |
| `X-Signature` | Two-stage HMAC-SHA256 over `(requestId, timestamp, user_id)` plus the base64 prompt | `executors/zai-web.js` → `buildSignature()` |
| `captcha_verify_param` | An Aliyun `CaptchaVerifyParam`, **required on every request** | `lib/zaiCaptcha.js` |
| `deviceToken` | Aliyun FeiLin anti-bot token — **browser-engine only** | `lib/zaiDeviceToken.js` + `scripts/zai-harvest-device-tokens.py` |

The first two can be computed in Node. The third cannot: Aliyun FeiLin touches `document` and `navigator` hundreds of times and refuses to run outside a real browser engine. That constraint is what shapes the whole design — see [The device-token pool](#the-device-token-pool).

---

## Quick start

### 1. Get your chat.z.ai token

Sign in at <https://chat.z.ai>, then open DevTools:

```
Application → Local Storage → https://chat.z.ai → token
```

Copy the value (a JWT). This is the credential the provider stores.

### 2. Fill the device-token pool

```bash
pip install playwright && playwright install chromium

python3 scripts/zai-harvest-device-tokens.py --token <JWT> --count 50
```

The script drives a headless Chromium against the Aliyun captcha, harvests device tokens and appends them to the pool file. Add `--headed` to watch it work.

### 3. Add the provider

Dashboard → **Providers** → **Z.AI / ChatGLM Web (Cookie)** → paste the token. Aliases `zai`, `zai-cookie` and `chatglm-web` all resolve to the same provider.

### 4. Call it

```bash
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer $YOUR_GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "zai/glm-5.3",
    "messages": [{"role": "user", "content": "Say PONG"}]
  }'
```

---

## Models

| Model ID | Upstream ID | Thinking | Context | Max output |
| --- | --- | --- | --- | --- |
| `zai/glm-5.3` | `glm-5.3` | yes, can disable | 1,000,000 | 131,072 |
| `zai/glm-5.3-flash` | `x-preview-l` | yes, can disable | 1,000,000 | 131,072 |
| `zai/glm-5.2` | `glm-5.2` | yes, always on | 1,000,000 | 131,072 |

`glm-5.3-flash` is served upstream under the id `x-preview-l` — its display name there is literally "GLM-5.3-Flash". The executor maps it transparently, so you always use the friendly id.

Reasoning arrives as `reasoning_content`, same shape as the other web-cookie providers.

---

## The device-token pool

Both the device token **and** the resulting `captcha_verify_param` are **single-use**. One completion consumes exactly one token. There is no way around this — it is how the upstream captcha works.

```
~/.hermes/zai-device-tokens.json      (override: ZAI_DEVICE_TOKEN_POOL)
{ "tokens": ["<base64 device token>", ...], "updatedAt": 1699999999999 }
```

`lib/zaiDeviceToken.js` takes a token atomically (removed from the pool, so two concurrent requests can never share one) and returns it if the captcha step fails for an unrelated reason.

**An empty pool is a hard, immediate error** — the executor returns `503 ZAI_DEVICE_TOKEN_POOL_EMPTY` without touching the network, and the message tells you the exact command to refill it. Keep the pool deeper than your peak concurrency.

Check the current depth:

```bash
python3 -c "import json,pathlib; print(len(json.loads((pathlib.Path.home()/'.hermes/zai-device-tokens.json').read_text())['tokens']), 'tokens')"
```

---

## Tool calling

The upstream endpoint **rejects a top-level `tools` array**. The site's own agent layer manages its built-in tools (search, retrieve, open_url) server-side through `mcp_servers`, and that path is not open to third parties.

So `lib/zaiToolBridge.js` bridges OpenAI-style tools over plain text:

1. **Inject** — `buildBridgePrompt()` appends the user's tools, as JSON schemas, to the system prompt and instructs the model to answer with exactly one JSON object when a tool is needed:

   ```json
   {"tool":"<tool_name>","args":{...}}
   ```

2. **Parse** — `parseToolCall()` scans the reply for the first balanced `{...}` carrying a `tool` or `function` key. Brace matching is string- and escape-aware, so the normal nested shape `{"tool":"x","args":{"city":"y"}}` parses correctly (a naive `/{[^{}]*}/` regex does not).

3. **Emit** — the call is converted back into a real `tool_calls` delta with `finish_reason: "tool_calls"`, exactly as a native provider would return.

Accepted input shapes: the standard `{type:"function", function:{...}}` wrapper **and** bare `{name, description, parameters}` objects. Accepted reply shapes: raw JSON, fenced JSON blocks, JSON embedded in prose, and the OpenAI `{function:{name,arguments}}` form.

### Streaming

In tool mode the stream is **buffered and replayed**, not forwarded raw. Without this the model's `{"tool":...}` JSON would leak into `content` and the caller would see garbage before the real `tool_calls` delta. Buffering mirrors the DeepSeek Web provider and guarantees the visible stream is either clean prose or a clean tool call — never a half-parsed fragment.

---

## Reliability

Free-tier z.ai is genuinely flaky, and the executor handles that rather than passing it through:

**Transient-error retry.** These upstream codes are retried with backoff instead of surfaced as an empty answer:

```
MODEL_CONCURRENCY_LIMIT · INTERNAL_ERROR · RATE_LIMIT
SERVER_BUSY · TEMPORARY_UNAVAILABLE · UPSTREAM_TIMEOUT
```

**Truncated-generation detection.** The free tier sometimes drops the final frame, leaving a fragment like `{"` or `{"tool":"get`. In tool mode a well-formed answer is either prose or complete JSON, so `looksLikeTruncatedToolCall()` flags anything that opens a brace but never closes as valid JSON and retries it.

Measured effect on a repeated tool-call loop: **3/6 → 6/6** successes.

**Output ceiling.** `max_tokens` defaults to 8192 when the caller does not set one, which stops the upstream from cutting answers short with `finish_reason: "length"`.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `503 ZAI_DEVICE_TOKEN_POOL_EMPTY` | Pool ran dry | Re-run the harvester |
| Captcha error on every request | Expired chat.z.ai JWT | Paste a fresh `token` |
| Empty reply / `IN 0 OUT 0` | Upstream transient error | Auto-retried; if it persists, the pool or account is rate-limited |
| `finish_reason: "length"` | Caller set a small `max_tokens` | Raise it, or omit it |
| Tools ignored entirely | Client did not send `tools` | Confirm `/v1/models` advertises `tools: true` for the model |
| Everything broke after a z.ai deploy | Site updated its private API | Check `X-FE-Version`; the constant may need bumping |

The `X-FE-Version` header is scraped from the site and cached, so a frontend deploy usually heals itself without a code change.

---

## Files

| Path | Lines | Role |
| --- | --- | --- |
| `open-sse/executors/zai-web.js` | 1005 | Executor: signature, streaming, tool bridge, retry |
| `open-sse/lib/zaiToolBridge.js` | 214 | Prompt-based tool-call bridge |
| `open-sse/lib/zaiCaptcha.js` | 265 | Aliyun captcha chain (init → data blob → verify) |
| `open-sse/lib/zaiDeviceToken.js` | 83 | Single-use device-token pool |
| `open-sse/providers/registry/zai-web.js` | 38 | Provider registration |
| `scripts/zai-harvest-device-tokens.py` | 188 | Browser-side token harvester |

Wired into `open-sse/executors/index.js`, `open-sse/providers/registry/index.js`, `open-sse/providers/capabilities.js`, `src/lib/providerIcon.js`, `src/app/api/validate/route.js` and `AddApiKeyModal.js`.

The Aliyun RPC credentials, the stage-1 HMAC key and the cipher tables are **public constants shipped in chat.z.ai's own frontend bundle** — they are read from there, not invented. See the header comments in `zaiCaptcha.js` and `zai-web.js`.

---

## Tests

```bash
npx vitest run unit/zai-web.test.js unit/zai-web-wiring.test.js \
                unit/zai-tool-bridge.test.js unit/zai-web-retry.test.js
```

**65 tests, 4 files, all passing** — covering the HMAC signature, token extraction, model aliasing, captcha primitives, pool semantics, the empty-pool fast-fail, bridge parsing and emission, transient-error classification and truncation detection.

---

## Limitations

Honest list, so nobody is surprised:

- **Captcha tokens are single-use.** Throughput is bounded by how many you harvest. This is not a bug that can be fixed in code.
- **Tool calling is prompt-based, not native.** It is materially less reliable than real function calling; the model can still emit malformed JSON. Retry and truncation detection mitigate this, they do not eliminate it.
- **The 1M window is what upstream advertises.** The gateway no longer truncates at 128k (that was a capabilities-table bug), but the *effective* ceiling on a free-tier account is z.ai's policy, not ours.
- **This is a private, reverse-engineered API.** It can break without notice when the site ships a change. Treat it as best-effort, not as a supported contract.
- **One account, one session.** The provider acts as you. Heavy automated use may run into account-level limits.

---

## Credits

- Signature derivation corroborated against the open-source **GLM-Free-API** project.
- Design mirrors the existing **DeepSeek Web** and **Gemini Web** cookie providers in this repository.
