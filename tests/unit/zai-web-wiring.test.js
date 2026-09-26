import { describe, it, expect } from "vitest";
import fs from "node:fs";

import REGISTRY from "open-sse/providers/registry/index.js";
import { PROVIDER_MODELS } from "open-sse/providers/index.js";
import { PROVIDER_CAPABILITIES } from "open-sse/providers/capabilities.js";
import { AI_PROVIDERS, WEB_COOKIE_PROVIDERS } from "@/shared/constants/providers.js";
import { resolveProviderIconId } from "@/shared/utils/providerIcon.js";

const ROOT = "/home/alip/ai_bucket/9router";

describe("zai-web is wired into the 9router provider list", () => {
  it("has a registry entry with the right shape", () => {
    const r = REGISTRY.find((p) => p.id === "zai-web");
    expect(r).toBeTruthy();
    expect(r.category).toBe("webCookie");
    expect(r.authType).toBe("cookie");
    expect(r.uiAlias).toBe("zai");
    expect(r.models.map((m) => m.id)).toEqual(["glm-5.3", "glm-5.3-flash", "glm-5.2"]);
  });

  it("shows up in AI_PROVIDERS (the dashboard list source)", () => {
    const p = AI_PROVIDERS["zai-web"];
    expect(p).toBeTruthy();
    expect(p.name).toBe("Z.AI / ChatGLM Web (Cookie)");
    expect(p.authType).toBe("cookie");
    expect(p.authHint).toContain("chat.z.ai");
  });

  it("lands in the Web Cookie dashboard section", () => {
    expect(WEB_COOKIE_PROVIDERS["zai-web"]).toBeTruthy();
    // sanity: siblings are there too
    expect(WEB_COOKIE_PROVIDERS["deepseek-web"]).toBeTruthy();
  });

  it("resolves its models", () => {
    const models = PROVIDER_MODELS["zai-web"];
    expect(models).toBeTruthy();
    expect(models.map((m) => m.id).sort()).toEqual(["glm-5.2", "glm-5.3", "glm-5.3-flash"]);
  });

  it("has capabilities", () => {
    expect(PROVIDER_CAPABILITIES["zai-web"]["glm-5.3"]).toBeTruthy();
    expect(PROVIDER_CAPABILITIES["zai-web"]["glm-5.3-flash"]).toBeTruthy();
    expect(PROVIDER_CAPABILITIES["zai-web"]["glm-5.2"]).toBeTruthy();
  });

  it("resolves an icon that actually exists on disk", () => {
    const iconId = resolveProviderIconId("zai-web");
    expect(iconId).toBe("glm");
    expect(fs.existsSync(`${ROOT}/public/providers/${iconId}.png`)).toBe(true);
  });

  it("keeps provider ids unique", () => {
    const ids = REGISTRY.map((p) => p.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it("registers the executor under every alias", () => {
    const src = fs.readFileSync(`${ROOT}/open-sse/executors/index.js`, "utf8");
    expect(src).toContain('"zai-web": new ZaiWebExecutor()');
    expect(src).toContain("zai: new ZaiWebExecutor()");
    expect(src).toContain('"zai-cookie": new ZaiWebExecutor()');
  });

  it("validates the credential in the providers API", () => {
    const src = fs.readFileSync(`${ROOT}/src/app/api/providers/validate/route.js`, "utf8");
    expect(src).toContain('case "zai-web":');
    expect(src).toContain("chat.z.ai/api/models");
  });

  it("shows a cookie-value placeholder in the add-key modal", () => {
    const src = fs.readFileSync(
      `${ROOT}/src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js`,
      "utf8"
    );
    expect(src).toContain('provider === "zai-web" ? "token value (JWT)"');
  });
});
