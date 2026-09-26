import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { resolvePortArg } = require("../../custom-server.js");

// Regression: `.next/standalone/server.js` reads the port from `process.env.PORT`
// only and ignores `--port`/`-p`. Before custom-server.js translated the flag,
// a bare `node custom-server.js` (and `npm start`, which passes `--port 20127`)
// silently fell back to Next's 3000 default.
describe("custom-server port resolution", () => {
  it("reads --port <n>", () => {
    expect(resolvePortArg(["--port", "20127"])).toBe("20127");
  });

  it("reads -p <n>", () => {
    expect(resolvePortArg(["-p", "8080"])).toBe("8080");
  });

  it("reads the inline --port=<n> form", () => {
    expect(resolvePortArg(["--port=9000"])).toBe("9000");
  });

  it("ignores unrelated flags and finds the port among them", () => {
    expect(resolvePortArg(["--skip-update", "--port", "20128", "--tray"])).toBe("20128");
  });

  it("returns null when no port flag is present", () => {
    expect(resolvePortArg([])).toBeNull();
    expect(resolvePortArg(["--tray", "--skip-update"])).toBeNull();
  });

  it("ignores a non-numeric or missing port value", () => {
    expect(resolvePortArg(["--port"])).toBeNull();
    expect(resolvePortArg(["--port", "abc"])).toBeNull();
    expect(resolvePortArg(["--port", "--tray"])).toBeNull();
  });
});
