import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitForServer, capturePages } from "./pages-capture.mjs";

test("waitForServer resolves once the fetch succeeds", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) throw new Error("ECONNREFUSED");
    return { ok: true, status: 200 };
  };
  await waitForServer("http://localhost:9999", 5, { fetchImpl, sleepMs: 1 });
  assert.equal(calls, 3);
});

test("waitForServer throws once the timeout elapses without a successful response", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  await assert.rejects(
    () => waitForServer("http://localhost:9999", 0.05, { fetchImpl, sleepMs: 10 }),
    /did not become ready/
  );
});

test("capturePages visits every configured page and writes a screenshot file per page", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-pages-capture-"));
  const visited = [];
  const fakeTab = {
    goto: async (url) => visited.push(url),
    screenshot: async ({ path: p }) => fs.writeFileSync(p, "fake-png"),
    close: async () => {},
  };
  const fakeContext = {
    newPage: async () => fakeTab,
    close: async () => {},
  };
  const fakeBrowser = { newContext: async () => fakeContext };

  const names = await capturePages({
    browser: fakeBrowser,
    baseUrl: "http://localhost:3000",
    pages: [{ path: "/login", name: "login" }, { path: "/dashboard", name: "dashboard" }],
    storageState: undefined,
    viewport: { width: 390, height: 844 },
    outDir: dir,
  });

  assert.deepEqual(names, ["login", "dashboard"]);
  assert.deepEqual(visited, ["http://localhost:3000/login", "http://localhost:3000/dashboard"]);
  assert.equal(fs.existsSync(path.join(dir, "login.png")), true);
  assert.equal(fs.existsSync(path.join(dir, "dashboard.png")), true);
});
