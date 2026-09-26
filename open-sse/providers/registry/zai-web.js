export default {
  id: "zai-web",
  priority: 142,
  alias: "zai-web",
  aliases: [
    "zai",
    "zai-cookie",
    "chatglm-web",
  ],
  uiAlias: "zai",
  display: {
    name: "Z.AI / ChatGLM Web (Cookie)",
    icon: "sparkles",
    color: "#2F6BFF",
    textIcon: "ZAI",
    website: "https://chat.z.ai",
    notice: {
      apiKeyUrl: "https://chat.z.ai",
    },
  },
  category: "webCookie",
  authType: "cookie",
  authHint:
    "Paste the `token` value from chat.z.ai localStorage " +
    "(DevTools -> Application -> Local Storage -> chat.z.ai -> token). " +
    "Then refill the captcha device-token pool: python3 scripts/zai-harvest-device-tokens.py",
  transport: {
    baseUrl: "https://chat.z.ai/api/v2",
    format: "zai-web",
    authType: "cookie",
  },
  models: [
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "glm-5.3-flash", name: "GLM-5.3 Flash" },
    { id: "glm-5.2", name: "GLM-5.2" },
  ],
  passthroughModels: true,
};
