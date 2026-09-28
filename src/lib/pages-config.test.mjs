import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPagesConfig, slugify } from "./pages-config.mjs";

test("loadPagesConfig returns null when the file does not exist", () => {
  assert.equal(loadPagesConfig("/no/such/chromagic.pages.json"), null);
});

test("loadPagesConfig fills missing name via slugify", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-pages-cfg-"));
  const file = path.join(dir, "chromagic.pages.json");
  fs.writeFileSync(file, JSON.stringify({ pages: [{ path: "/login" }, { path: "/a/b", name: "custom" }] }));
  const cfg = loadPagesConfig(file);
  assert.deepEqual(cfg.pages, [
    { path: "/login", name: "login" },
    { path: "/a/b", name: "custom" },
  ]);
});

test("loadPagesConfig throws a clear error when pages is not an array", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-pages-cfg-"));
  const file = path.join(dir, "chromagic.pages.json");
  fs.writeFileSync(file, JSON.stringify({ pages: "not-an-array" }));
  assert.throws(() => loadPagesConfig(file), /pages.*must be an array/);
});

test("loadPagesConfig surfaces a JSON parse error instead of crashing silently", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-pages-cfg-"));
  const file = path.join(dir, "chromagic.pages.json");
  fs.writeFileSync(file, "{ not valid json");
  assert.throws(() => loadPagesConfig(file));
});

test("slugify strips leading/trailing slashes and non-alnum chars", () => {
  assert.equal(slugify("/login"), "login");
  assert.equal(slugify("/a/b/"), "a-b");
  assert.equal(slugify("/"), "root");
});
