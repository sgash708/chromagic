import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isApproveCommand, isSelfApprove, hasWritePermission } from "./approve.mjs";

afterEach(() => {
  mock.reset();
});

test("isApproveCommand matches the exact command, tolerating surrounding whitespace", () => {
  assert.equal(isApproveCommand("/chromagic approve"), true);
  assert.equal(isApproveCommand("  /chromagic approve  \n"), true);
});

test("isApproveCommand rejects near-miss phrasing", () => {
  assert.equal(isApproveCommand("/chromagic approved"), false);
  assert.equal(isApproveCommand("please /chromagic approve this"), false);
  assert.equal(isApproveCommand("/Chromagic Approve"), false);
  assert.equal(isApproveCommand(""), false);
});

test("isSelfApprove is case-insensitive and true when author matches", () => {
  assert.equal(isSelfApprove("Alice", "alice"), true);
  assert.equal(isSelfApprove("alice", "bob"), false);
});

test("hasWritePermission returns true for write/admin and false otherwise", async () => {
  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ permission: "write" }),
    text: async () => "",
  }));
  assert.equal(await hasWritePermission({ repo: "o/r", username: "bob", token: "t", apiBase: "https://api.github.com" }), true);

  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ permission: "read" }),
    text: async () => "",
  }));
  assert.equal(await hasWritePermission({ repo: "o/r", username: "eve", token: "t", apiBase: "https://api.github.com" }), false);
});
