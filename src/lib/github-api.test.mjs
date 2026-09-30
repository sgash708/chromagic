import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { apiFetch, upsertComment, createOrUpdateCheckRun, getCheckRun } from "./github-api.mjs";

afterEach(() => {
  mock.reset();
});

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test("apiFetch throws with status and body on non-ok response", async () => {
  global.fetch = mock.fn(async () => jsonResponse(500, { message: "boom" }));
  await assert.rejects(
    () => apiFetch("GET", "/repos/o/r/x", undefined, { token: "t", apiBase: "https://api.github.com" }),
    /500/
  );
});

test("upsertComment posts a new comment when no existing marker comment found", async () => {
  const calls = [];
  global.fetch = mock.fn(async (url, opts) => {
    calls.push({ url, method: opts?.method });
    if (opts?.method === "GET" || !opts) return jsonResponse(200, []);
    return jsonResponse(201, { id: 1 });
  });
  await upsertComment({ prNumber: 5, body: "hello", marker: "<!-- m -->", token: "t", apiBase: "https://api.github.com", repo: "o/r" });
  assert.equal(calls.at(-1).method, "POST");
  assert.match(calls.at(-1).url, /\/repos\/o\/r\/issues\/5\/comments$/);
});

test("upsertComment patches the existing marker comment instead of creating a new one", async () => {
  const calls = [];
  global.fetch = mock.fn(async (url, opts) => {
    calls.push({ url, method: opts?.method });
    if (!opts?.method || opts.method === "GET") return jsonResponse(200, [{ id: 42, body: "old <!-- m -->" }]);
    return jsonResponse(200, { id: 42 });
  });
  await upsertComment({ prNumber: 5, body: "new", marker: "<!-- m -->", token: "t", apiBase: "https://api.github.com", repo: "o/r" });
  assert.equal(calls.at(-1).method, "PATCH");
  assert.match(calls.at(-1).url, /\/repos\/o\/r\/issues\/comments\/42$/);
});

test("createOrUpdateCheckRun creates a new run when none exists for the sha", async () => {
  const calls = [];
  global.fetch = mock.fn(async (url, opts) => {
    calls.push({ url, method: opts?.method ?? "GET" });
    if ((opts?.method ?? "GET") === "GET") return jsonResponse(200, { check_runs: [] });
    return jsonResponse(201, { id: 99 });
  });
  await createOrUpdateCheckRun({ repo: "o/r", sha: "abc123", name: "chromagic/pages-approval", conclusion: "failure", summary: "diff found", token: "t", apiBase: "https://api.github.com" });
  assert.equal(calls.at(-1).method, "POST");
  assert.match(calls.at(-1).url, /\/repos\/o\/r\/check-runs$/);
});

test("createOrUpdateCheckRun updates the existing run for the same sha instead of creating a duplicate", async () => {
  const calls = [];
  global.fetch = mock.fn(async (url, opts) => {
    calls.push({ url, method: opts?.method ?? "GET" });
    if ((opts?.method ?? "GET") === "GET") return jsonResponse(200, { check_runs: [{ id: 7, name: "chromagic/pages-approval" }] });
    return jsonResponse(200, { id: 7 });
  });
  await createOrUpdateCheckRun({ repo: "o/r", sha: "abc123", name: "chromagic/pages-approval", conclusion: "success", summary: "approved", token: "t", apiBase: "https://api.github.com" });
  assert.equal(calls.at(-1).method, "PATCH");
  assert.match(calls.at(-1).url, /\/repos\/o\/r\/check-runs\/7$/);
});

test("getCheckRun returns the matching check run when present", async () => {
  global.fetch = mock.fn(async () =>
    jsonResponse(200, { check_runs: [{ id: 7, name: "chromagic/pages-approval", conclusion: "failure" }] })
  );
  const run = await getCheckRun({ repo: "o/r", sha: "abc123", name: "chromagic/pages-approval", token: "t", apiBase: "https://api.github.com" });
  assert.deepEqual(run, { id: 7, name: "chromagic/pages-approval", conclusion: "failure" });
});

test("getCheckRun returns null when no matching check run exists", async () => {
  global.fetch = mock.fn(async () => jsonResponse(200, { check_runs: [] }));
  const run = await getCheckRun({ repo: "o/r", sha: "abc123", name: "chromagic/pages-approval", token: "t", apiBase: "https://api.github.com" });
  assert.equal(run, null);
});
