import assert from "node:assert/strict";
import test from "node:test";
import { browserOpener, openDefaultBrowser } from "../server/mcpjson";

test("a headless Linux host has no browser to open, so nothing is started", () => {
  assert.equal(browserOpener("linux", { PATH: "/usr/bin:/bin" }, () => true), null, "no DISPLAY or WAYLAND_DISPLAY");
  assert.equal(browserOpener("linux", { DISPLAY: ":0", PATH: "/usr/bin:/bin" }, () => false), null, "no xdg-open on PATH");
  assert.equal(browserOpener("linux", { WAYLAND_DISPLAY: "wayland-0", PATH: "/opt/x:/usr/bin" }, (path) => path === "/usr/bin/xdg-open"), "/usr/bin/xdg-open");
  assert.equal(browserOpener("darwin", {}), "/usr/bin/open");
  assert.equal(browserOpener("win32", {}), "cmd");
  assert.equal(openDefaultBrowser("https://example.test/authorize", null), false);
});

test("a browser command that does not exist is reported, not fatal", async () => {
  // Before 0.11.1 this spawn's 'error' event had no listener and ended the plugin process.
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (line: string) => void warnings.push(line);
  try {
    assert.equal(openDefaultBrowser("https://example.test/authorize?state=secret", "/nonexistent/xdg-open"), true);
    await new Promise((settle) => setTimeout(settle, 200));
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /could not open a browser on this host \(ENOENT\)/);
  assert.ok(!warnings[0]!.includes("secret"), "the sign-in URL is never logged");
});
