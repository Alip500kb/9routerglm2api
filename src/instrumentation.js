export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Background schedulers live here rather than in custom-server.js: that file
    // loads src/*.js through plain Node, where the "open-sse" and "@/" specifiers
    // cannot resolve (no package.json, not in node_modules — webpack supplies
    // them). Importing them from the Next runtime keeps the aliases working.
    const { startBackgroundTokenRefresh } = await import("@/sse/services/backgroundTokenRefresh.js");
    startBackgroundTokenRefresh();

    const { startZaiDeviceTokenRefill } = await import("@/sse/services/zaiDeviceTokenRefill.js");
    startZaiDeviceTokenRefill();
  }
}
