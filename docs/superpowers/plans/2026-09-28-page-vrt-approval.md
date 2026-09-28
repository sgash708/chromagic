# 実ページVRT + 承認フロー Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** chromagicにStorybookとは独立した「実ページVRT」を追加し、差分検出時は`/chromagic approve`コメント（セルフApprove不可）で明示承認しないとマージできないゲートを設ける。

**Architecture:** 既存`src/main.mjs`のpixelmatch比較・git操作・GitHub API呼び出しを`src/lib/`配下の3モジュール（`image-diff.mjs` / `git-ops.mjs` / `github-api.mjs`）に抽出して共通化する。その上に実ページ専用の`pages-config.mjs`（設定読み込み）・`pages-capture.mjs`（Playwrightでのログイン＋撮影）・`approve.mjs`（承認判定）を新設し、`src/pages-entry.mjs` と `src/approve-entry.mjs` の2つのエントリポイントから呼び出す。`action.yml`はこれらを実行する新ステップを追加し、`pages-start-command`未指定なら実ページVRTを丸ごとスキップする。

**Tech Stack:** Node.js 24 (`node:test`標準テストランナー), playwright-core（既存のChrome for Testingバイナリを再利用しChromium再ダウンロードを避ける）, pixelmatch, pngjs, fast-glob

**Spec:** `docs/superpowers/specs/2026-09-28-page-vrt-approval-design.md`

## Global Constraints

- 実ページVRTはStorybook側の既存フロー（merge=承認）を一切変更しない
- `pages-config`ファイルが存在しない、または`pages-start-command`が未指定の場合は実ページVRT全体をスキップし、既存consumerの挙動に影響を与えない
- 認証情報（ID/PW等）はconsumerのログインスクリプト内で完結させ、chromagic本体のコードには渡さない
- セルフApprove（PR作成者自身による承認）は必ず拒否する
- 承認者はリポジトリへの`write`以上の権限を持つ必要がある
- baseline/reportブランチはStorybookと別（`vrt-baseline-pages` / `vrt-reports-pages`）
- 本PRはmainにマージしない（動作確認用ブランチとして作業する）
- トークンをコマンドライン引数・URL・エラーメッセージに含めない（既存`main.mjs`のGIT_ASKPASS方式・マスク処理を踏襲する）

## Review Focus

- 不正な`chromagic.pages.json`（`pages`が配列でない、JSON壊れ）を渡されたときにクラッシュせず明確なエラーで落ちるか（Task 5）
- ヘルスチェックがタイムアウトしたとき「差分なし」と誤判定せずジョブを失敗させるか（Task 6）
- PR作成者自身が`/chromagic approve`とコメントしても承認されないか（Task 7）
- write権限のない第三者が`/chromagic approve`とコメントしても承認されないか（Task 7）
- `/chromagic approve`の表記ゆれ（前後空白・大文字小文字・微妙に違う文言）で誤って承認扱いにならないか（Task 7）
- 新しいcommitでhead shaが変わったとき、古いshaへの承認が新しいshaに引き継がれず未承認状態に戻るか（Task 3のcheck run関数が「同名・別shaなら新規作成」になっているか）

---

## Task 1: `src/lib/image-diff.mjs` 抽出

**Files:**
- Create: `src/lib/image-diff.mjs`
- Test: `src/lib/image-diff.test.mjs`

**Interfaces:**
- Produces: `listPngs(dir): string[]`, `copyFile(src, dest): void`, `diffImage(basePath, curPath, diffOut, { matchThreshold, thresholdPixel }): { changed, pixels, sizeMismatch? }`, `rawUrl({ server, repo, reportBranch, runId, kind, rel }): string`, `buildComment({ marker, title, changed, added, removed, total, urlCtx }): string`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/image-diff.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { listPngs, diffImage, rawUrl, buildComment } from "./image-diff.mjs";

function writeSolidPng(filePath, { width, height, color }) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = color[0];
    png.data[i * 4 + 1] = color[1];
    png.data[i * 4 + 2] = color[2];
    png.data[i * 4 + 3] = 255;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

test("listPngs finds png files recursively and sorts them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-test-"));
  writeSolidPng(path.join(dir, "b.png"), { width: 2, height: 2, color: [0, 0, 0] });
  writeSolidPng(path.join(dir, "a", "c.png"), { width: 2, height: 2, color: [0, 0, 0] });
  assert.deepEqual(listPngs(dir), ["a/c.png", "b.png"]);
});

test("diffImage returns changed=false when images are identical", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-test-"));
  const base = path.join(dir, "base.png");
  const cur = path.join(dir, "cur.png");
  writeSolidPng(base, { width: 4, height: 4, color: [10, 20, 30] });
  writeSolidPng(cur, { width: 4, height: 4, color: [10, 20, 30] });
  const r = diffImage(base, cur, path.join(dir, "diff.png"), { matchThreshold: 0.05, thresholdPixel: 50 });
  assert.equal(r.changed, false);
  assert.equal(fs.existsSync(path.join(dir, "diff.png")), false);
});

test("diffImage returns changed=true and writes diff when pixels differ beyond threshold", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-test-"));
  const base = path.join(dir, "base.png");
  const cur = path.join(dir, "cur.png");
  writeSolidPng(base, { width: 10, height: 10, color: [0, 0, 0] });
  writeSolidPng(cur, { width: 10, height: 10, color: [255, 255, 255] });
  const diffOut = path.join(dir, "diff.png");
  const r = diffImage(base, cur, diffOut, { matchThreshold: 0.05, thresholdPixel: 50 });
  assert.equal(r.changed, true);
  assert.ok(r.pixels > 50);
  assert.equal(fs.existsSync(diffOut), true);
});

test("diffImage detects size mismatch without throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-test-"));
  const base = path.join(dir, "base.png");
  const cur = path.join(dir, "cur.png");
  writeSolidPng(base, { width: 4, height: 4, color: [0, 0, 0] });
  writeSolidPng(cur, { width: 8, height: 8, color: [0, 0, 0] });
  const r = diffImage(base, cur, path.join(dir, "diff.png"), { matchThreshold: 0.05, thresholdPixel: 50 });
  assert.equal(r.changed, true);
  assert.equal(r.sizeMismatch, true);
});

test("rawUrl encodes path segments", () => {
  const url = rawUrl({ server: "https://github.com", repo: "o/r", reportBranch: "vrt-reports", runId: "123", kind: "diff", rel: "a b/c.png" });
  assert.equal(url, "https://github.com/o/r/blob/vrt-reports/123/diff/a%20b/c.png?raw=true");
});

test("buildComment reports no-diff message when nothing changed", () => {
  const body = buildComment({
    marker: "<!-- chromagic-vrt -->",
    title: "🎨 chromagic — Visual Regression",
    changed: [], added: [], removed: [], total: 3,
    urlCtx: { server: "https://github.com", repo: "o/r", reportBranch: "vrt-reports", runId: "1" },
  });
  assert.match(body, /視覚的差分なし/);
  assert.match(body, /<!-- chromagic-vrt -->/);
});

test("buildComment lists changed stories with expected/actual/diff links", () => {
  const body = buildComment({
    marker: "<!-- chromagic-vrt -->",
    title: "🎨 chromagic — Visual Regression",
    changed: [{ rel: "Button.png", pixels: 120 }], added: [], removed: [], total: 3,
    urlCtx: { server: "https://github.com", repo: "o/r", reportBranch: "vrt-reports", runId: "1" },
  });
  assert.match(body, /Button\.png/);
  assert.match(body, /expected/);
  assert.match(body, /actual/);
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test src/lib/image-diff.test.mjs`
Expected: FAIL（`./image-diff.mjs`が存在しないためimportエラー）

- [ ] **Step 3: `src/lib/image-diff.mjs`を実装する**

`src/main.mjs`の`listPngs` / `copyFile` / `diffImage` / `rawUrl` / `buildComment`を移植し、モジュールスコープの定数（`MATCH`, `THRESH_PX`, `SERVER`, `REPO`, `REPORT_BRANCH`, `RUN_ID`, `COMMENT_MARKER`）への依存を引数に置き換える:

```js
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export function listPngs(dir) {
  return fg.sync("**/*.png", { cwd: dir, dot: false }).sort();
}

export function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

export function diffImage(basePath, curPath, diffOut, { matchThreshold, thresholdPixel }) {
  const a = PNG.sync.read(fs.readFileSync(basePath));
  const b = PNG.sync.read(fs.readFileSync(curPath));
  if (a.width !== b.width || a.height !== b.height) {
    return { changed: true, pixels: -1, sizeMismatch: true };
  }
  const { width, height } = a;
  const out = new PNG({ width, height });
  const px = pixelmatch(a.data, b.data, out.data, width, height, {
    threshold: matchThreshold,
    includeAA: false,
    alpha: 0.35,
    aaColor: [255, 255, 0],
    diffColor: [255, 0, 0],
    diffColorAlt: [0, 200, 0],
  });
  if (px > thresholdPixel) {
    fs.mkdirSync(path.dirname(diffOut), { recursive: true });
    fs.writeFileSync(diffOut, PNG.sync.write(out));
    return { changed: true, pixels: px };
  }
  return { changed: false, pixels: px };
}

export function rawUrl({ server, repo, reportBranch, runId, kind, rel }) {
  const enc = rel.split("/").map(encodeURIComponent).join("/");
  return `${server}/${repo}/blob/${reportBranch}/${runId}/${kind}/${enc}?raw=true`;
}

export function buildComment({ marker, title, changed, added, removed, total, urlCtx }) {
  const lines = [marker];
  const ok = changed.length === 0 && added.length === 0 && removed.length === 0;
  lines.push(`## ${title}`);
  lines.push("");
  lines.push(ok ? "✅ 視覚的差分なし。" : "🟠 差分を検出しました(🟢=増えた / 🔴=消えたピクセル)。");
  lines.push("");
  lines.push("| pass | changed | new | deleted |");
  lines.push("|:--:|:--:|:--:|:--:|");
  lines.push(`| ${total - changed.length - added.length} | ${changed.length} | ${added.length} | ${removed.length} |`);
  lines.push("");
  for (const c of changed) {
    lines.push(`### \`${c.rel}\`${c.sizeMismatch ? " (サイズ変更)" : ""}`);
    lines.push("| expected | actual | difference |");
    lines.push("|--|--|--|");
    const diffCell = c.sizeMismatch ? "—" : `![diff](${rawUrl({ ...urlCtx, kind: "diff", rel: c.rel })})`;
    lines.push(`| ![expected](${rawUrl({ ...urlCtx, kind: "expected", rel: c.rel })}) | ![actual](${rawUrl({ ...urlCtx, kind: "actual", rel: c.rel })}) | ${diffCell} |`);
    lines.push("");
  }
  if (added.length) {
    lines.push("<details><summary>🆕 new</summary>\n");
    for (const rel of added) lines.push(`- \`${rel}\` ![new](${rawUrl({ ...urlCtx, kind: "actual", rel })})`);
    lines.push("\n</details>");
  }
  lines.push("");
  lines.push(`<sub>images: \`${urlCtx.reportBranch}/${urlCtx.runId}\` ／ run ${urlCtx.runId}</sub>`);
  return lines.join("\n");
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `node --test src/lib/image-diff.test.mjs`
Expected: PASS（全テストgreen）

- [ ] **Step 5: コミット**

```bash
git add src/lib/image-diff.mjs src/lib/image-diff.test.mjs
git commit -m "feat: pixelmatch比較・コメント生成ロジックをsrc/lib/image-diff.mjsに抽出"
```

## Task 2: `src/lib/git-ops.mjs` 抽出

**Files:**
- Create: `src/lib/git-ops.mjs`
- Test: `src/lib/git-ops.test.mjs`

**Interfaces:**
- Produces: `makeGitEnv(token): NodeJS.ProcessEnv`, `makeGit(gitEnv): (...args: string[]) => string`, `cloneBranch(remoteUrl, branch, git): string | null`, `pushBranch(stageDir, branch, { force, baseDir, remoteUrl, git, commitMessage }): void`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/git-ops.test.mjs`（実際のGitHubには接続せず、ローカルのbare repoに対してclone/pushの往復を検証する）:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeGitEnv, makeGit, cloneBranch, pushBranch } from "./git-ops.mjs";

function initBareRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-bare-"));
  execFileSync("git", ["init", "-q", "--bare", dir]);
  return dir;
}

test("pushBranch(force) creates a new branch and cloneBranch reads it back", () => {
  const bareDir = initBareRepo();
  const remoteUrl = bareDir;
  const gitEnv = makeGitEnv("dummy-token");
  const git = makeGit(gitEnv);

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-stage-"));
  fs.writeFileSync(path.join(stage, "a.png"), "fake-png-bytes");
  pushBranch(stage, "vrt-baseline-pages", { force: true, remoteUrl, git, commitMessage: "test: baseline" });

  const cloned = cloneBranch(remoteUrl, "vrt-baseline-pages", git);
  assert.ok(cloned, "clone should succeed");
  assert.equal(fs.readFileSync(path.join(cloned, "a.png"), "utf8"), "fake-png-bytes");
});

test("cloneBranch returns null for a branch that does not exist", () => {
  const bareDir = initBareRepo();
  const gitEnv = makeGitEnv("dummy-token");
  const git = makeGit(gitEnv);
  assert.equal(cloneBranch(bareDir, "no-such-branch", git), null);
});

test("pushBranch(force=false) appends files to an existing report branch", () => {
  const bareDir = initBareRepo();
  const gitEnv = makeGitEnv("dummy-token");
  const git = makeGit(gitEnv);

  const stage1 = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-stage-"));
  fs.writeFileSync(path.join(stage1, "run1.png"), "run1");
  pushBranch(stage1, "vrt-reports-pages", { force: true, remoteUrl: bareDir, git, commitMessage: "test: report run1" });

  const baseDir = cloneBranch(bareDir, "vrt-reports-pages", git);
  const stage2 = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-stage-"));
  fs.writeFileSync(path.join(stage2, "run2.png"), "run2");
  pushBranch(stage2, "vrt-reports-pages", { force: false, baseDir, remoteUrl: bareDir, git, commitMessage: "test: report run2" });

  const cloned = cloneBranch(bareDir, "vrt-reports-pages", git);
  assert.equal(fs.readFileSync(path.join(cloned, "run1.png"), "utf8"), "run1");
  assert.equal(fs.readFileSync(path.join(cloned, "run2.png"), "utf8"), "run2");
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test src/lib/git-ops.test.mjs`
Expected: FAIL（`./git-ops.mjs`が存在しない）

- [ ] **Step 3: `src/lib/git-ops.mjs`を実装する**

```js
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fg from "fast-glob";

export function makeGitEnv(token) {
  const askpassDir = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-auth-"));
  const askpassPath = path.join(askpassDir, "askpass.sh");
  fs.writeFileSync(askpassPath, `#!/bin/sh\nprintf '%s' "$CHROMAGIC_GIT_TOKEN"\n`);
  fs.chmodSync(askpassPath, 0o700);
  return {
    ...process.env,
    GIT_ASKPASS: askpassPath,
    CHROMAGIC_GIT_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
  };
}

export function makeGit(gitEnv) {
  const sh = (file, args, opts = {}) =>
    execFileSync(file, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: gitEnv, ...opts });
  return (...args) => sh("git", args);
}

export function cloneBranch(remoteUrl, branch, git) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-"));
  try {
    git("clone", "-q", "--depth", "1", "--branch", branch, remoteUrl, dir);
    return dir;
  } catch {
    return null;
  }
}

export function pushBranch(stageDir, branch, { force, baseDir, remoteUrl, git, commitMessage }) {
  let work = stageDir;
  if (!force && baseDir) {
    for (const f of fg.sync("**/*", { cwd: stageDir, dot: false, onlyFiles: true })) {
      const dest = path.join(baseDir, f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(stageDir, f), dest);
    }
    work = baseDir;
    git("-C", work, "add", "-A");
    try {
      git("-C", work, "-c", "user.email=vrt@chromagic", "-c", "user.name=chromagic", "commit", "-q", "-m", commitMessage);
    } catch {
      // 変更なしで commit するものが無いケースは無視
    }
    git("-C", work, "push", "-q", remoteUrl, `HEAD:${branch}`);
    return;
  }
  git("-C", work, "init", "-q");
  git("-C", work, "checkout", "-q", "-b", branch);
  git("-C", work, "add", "-A");
  git("-C", work, "-c", "user.email=vrt@chromagic", "-c", "user.name=chromagic", "commit", "-q", "-m", commitMessage);
  git("-C", work, "push", "-q", "--force", remoteUrl, `HEAD:${branch}`);
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `node --test src/lib/git-ops.test.mjs`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/git-ops.mjs src/lib/git-ops.test.mjs
git commit -m "feat: git clone/push操作をsrc/lib/git-ops.mjsに抽出"
```

## Task 3: `src/lib/github-api.mjs` 抽出 + check run関数追加

**Files:**
- Create: `src/lib/github-api.mjs`
- Test: `src/lib/github-api.test.mjs`

**Interfaces:**
- Consumes: なし（fetchのみ）
- Produces: `apiFetch(method, urlPath, body, { token, apiBase }): Promise<any>`, `upsertComment({ prNumber, body, marker, token, apiBase, repo }): Promise<void>`, `createOrUpdateCheckRun({ repo, sha, name, conclusion, summary, token, apiBase }): Promise<any>`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/github-api.test.mjs`（`global.fetch`をモックする）:

```js
import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { apiFetch, upsertComment, createOrUpdateCheckRun } from "./github-api.mjs";

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
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test src/lib/github-api.test.mjs`
Expected: FAIL（`./github-api.mjs`が存在しない）

- [ ] **Step 3: `src/lib/github-api.mjs`を実装する**

```js
export async function apiFetch(method, urlPath, body, { token, apiBase }) {
  const res = await fetch(`${apiBase}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status} ${await res.text()}`);
  return res.json();
}

export async function upsertComment({ prNumber, body, marker, token, apiBase, repo }) {
  const comments = await apiFetch("GET", `/repos/${repo}/issues/${prNumber}/comments?per_page=100`, undefined, { token, apiBase });
  const existing = comments.find((c) => c.body?.includes(marker));
  if (existing) {
    await apiFetch("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body }, { token, apiBase });
  } else {
    await apiFetch("POST", `/repos/${repo}/issues/${prNumber}/comments`, { body }, { token, apiBase });
  }
}

export async function createOrUpdateCheckRun({ repo, sha, name, conclusion, summary, token, apiBase }) {
  const existing = await apiFetch(
    "GET",
    `/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}`,
    undefined,
    { token, apiBase }
  );
  const run = existing.check_runs?.find((r) => r.name === name);
  const payload = {
    name,
    head_sha: sha,
    status: "completed",
    conclusion,
    output: { title: name, summary },
  };
  if (run) {
    return apiFetch("PATCH", `/repos/${repo}/check-runs/${run.id}`, payload, { token, apiBase });
  }
  return apiFetch("POST", `/repos/${repo}/check-runs`, payload, { token, apiBase });
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `node --test src/lib/github-api.test.mjs`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/github-api.mjs src/lib/github-api.test.mjs
git commit -m "feat: GitHub APIコメント/check run操作をsrc/lib/github-api.mjsに抽出"
```

## Task 4: `src/main.mjs` をlib経由にリファクタ

**Files:**
- Modify: `src/main.mjs`（全体、Task1-3で抽出した関数の呼び出しに置き換え。ロジック・出力は変更しない）

**Interfaces:**
- Consumes: `listPngs, copyFile, diffImage, rawUrl, buildComment` from `./lib/image-diff.mjs`; `makeGitEnv, makeGit, cloneBranch, pushBranch` from `./lib/git-ops.mjs`; `upsertComment` from `./lib/github-api.mjs`

- [ ] **Step 1: `src/main.mjs`を書き換える**

```js
// chromagic — Storybook VRT 本体。
// 役割: storycap が撮った現行スクショ(VRT_CURRENT_DIR)を baseline ブランチの画像と
// pixelmatch で比較し、変化を「赤=消えた / 緑=増えた」の2色 diff で可視化。
// PR では actual/expected/diff を report ブランチへ push し、PR コメントにインライン表示する。
// デフォルトブランチへの push 時は現行スクショを baseline ブランチへ保存(=次回比較の基準)。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listPngs, copyFile, diffImage, buildComment } from "./lib/image-diff.mjs";
import { makeGitEnv, makeGit, cloneBranch, pushBranch } from "./lib/git-ops.mjs";
import { upsertComment } from "./lib/github-api.mjs";

const {
  GITHUB_TOKEN: TOKEN,
  GITHUB_REPOSITORY: REPO,
  GITHUB_RUN_ID: RUN_ID,
  GITHUB_EVENT_NAME: EVENT,
  GITHUB_EVENT_PATH: EVENT_PATH,
  GITHUB_SERVER_URL: SERVER = "https://github.com",
  GITHUB_API_URL: API = "https://api.github.com",
  VRT_CURRENT_DIR: CURRENT,
  VRT_BASELINE_BRANCH: BASELINE_BRANCH,
  VRT_REPORT_BRANCH: REPORT_BRANCH,
  VRT_MATCHING_THRESHOLD,
  VRT_THRESHOLD_PIXEL,
} = process.env;

const THRESHOLD_OPTS = {
  matchThreshold: Number.parseFloat(VRT_MATCHING_THRESHOLD || "0.05"),
  thresholdPixel: Number.parseInt(VRT_THRESHOLD_PIXEL || "50", 10),
};

const REMOTE_URL = `https://x-access-token@github.com/${REPO}.git`;
const GIT_ENV = makeGitEnv(TOKEN);
const git = makeGit(GIT_ENV);
const log = (m) => process.stdout.write(`${m}\n`);
const COMMENT_MARKER = "<!-- chromagic-vrt -->";

const event = EVENT_PATH && fs.existsSync(EVENT_PATH)
  ? JSON.parse(fs.readFileSync(EVENT_PATH, "utf8"))
  : {};
const DEFAULT_BRANCH = event.repository?.default_branch || "main";

function setOutputs(o) {
  if (!process.env.GITHUB_OUTPUT) return;
  const body = Object.entries(o).map(([k, v]) => `${k}=${v}`).join("\n");
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${body}\n`);
}

async function main() {
  const currentPngs = listPngs(CURRENT);
  log(`chromagic: ${currentPngs.length} screenshots captured.`);

  const isDefaultPush =
    EVENT === "push" && (event.ref === `refs/heads/${DEFAULT_BRANCH}` || process.env.GITHUB_REF === `refs/heads/${DEFAULT_BRANCH}`);
  if (isDefaultPush) {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-base-"));
    for (const rel of currentPngs) copyFile(path.join(CURRENT, rel), path.join(stage, rel));
    pushBranch(stage, BASELINE_BRANCH, { force: true, remoteUrl: REMOTE_URL, git, commitMessage: `chromagic: ${BASELINE_BRANCH} @ ${RUN_ID} [skip ci]` });
    log(`chromagic: baseline '${BASELINE_BRANCH}' updated (${currentPngs.length} images).`);
    setOutputs({ changed: 0, new: 0, deleted: 0, pass: currentPngs.length, total: currentPngs.length, baseline: "updated" });
    return;
  }

  const prNumber = event.pull_request?.number || event.number;
  if (!prNumber) {
    log("chromagic: PR でも default push でもないためスキップ。");
    return;
  }

  const baseDir = cloneBranch(REMOTE_URL, BASELINE_BRANCH, git);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-report-"));
  const changed = [];
  const added = [];

  for (const rel of currentPngs) {
    const cur = path.join(CURRENT, rel);
    const base = baseDir ? path.join(baseDir, rel) : null;
    if (!base || !fs.existsSync(base)) {
      added.push(rel);
      copyFile(cur, path.join(stage, RUN_ID, "actual", rel));
      continue;
    }
    const diffOut = path.join(stage, RUN_ID, "diff", rel);
    const r = diffImage(base, cur, diffOut, THRESHOLD_OPTS);
    if (r.changed) {
      changed.push({ rel, ...r });
      copyFile(cur, path.join(stage, RUN_ID, "actual", rel));
      copyFile(base, path.join(stage, RUN_ID, "expected", rel));
    }
  }

  const baseSet = new Set(baseDir ? listPngs(baseDir) : []);
  const removed = [...baseSet].filter((rel) => !currentPngs.includes(rel));

  log(`chromagic: changed=${changed.length} new=${added.length} deleted=${removed.length} pass=${currentPngs.length - changed.length - added.length}`);
  setOutputs({
    changed: changed.length,
    new: added.length,
    deleted: removed.length,
    pass: currentPngs.length - changed.length - added.length,
    total: currentPngs.length,
  });

  if (changed.length || added.length) {
    const reportBase = cloneBranch(REMOTE_URL, REPORT_BRANCH, git);
    pushBranch(stage, REPORT_BRANCH, {
      force: !reportBase, baseDir: reportBase || undefined, remoteUrl: REMOTE_URL, git,
      commitMessage: `chromagic: report ${RUN_ID} [skip ci]`,
    });
    log(`chromagic: report images pushed to '${REPORT_BRANCH}/${RUN_ID}'.`);
  }

  const body = buildComment({
    marker: COMMENT_MARKER,
    title: "🎨 chromagic — Visual Regression",
    changed, added, removed, total: currentPngs.length,
    urlCtx: { server: SERVER, repo: REPO, reportBranch: REPORT_BRANCH, runId: RUN_ID },
  });
  await upsertComment({ prNumber, body, marker: COMMENT_MARKER, token: TOKEN, apiBase: API, repo: REPO });
  log(`chromagic: PR #${prNumber} にコメントしました。`);
}

main().catch((e) => {
  let msg = e.stack || String(e);
  if (TOKEN) msg = msg.split(TOKEN).join("***");
  process.stderr.write(`chromagic failed: ${msg}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: 構文チェック**

Run: `node --check src/main.mjs`
Expected: 出力なし（正常終了）

- [ ] **Step 3: 既存libテストを再実行し壊れていないことを確認**

Run: `node --test src/lib/`
Expected: PASS（Task1-3で書いたテストが全てgreenのまま）

- [ ] **Step 4: コミット**

```bash
git add src/main.mjs
git commit -m "refactor: main.mjsをsrc/lib配下の共通モジュール経由に書き換え"
```

## Task 5: `src/lib/pages-config.mjs`

**Files:**
- Create: `src/lib/pages-config.mjs`
- Test: `src/lib/pages-config.test.mjs`

**Interfaces:**
- Produces: `loadPagesConfig(configPath): { pages: { path: string, name: string }[] } | null`, `slugify(pagePath): string`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/pages-config.test.mjs`:

```js
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
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test src/lib/pages-config.test.mjs`
Expected: FAIL

- [ ] **Step 3: `src/lib/pages-config.mjs`を実装する**

```js
import fs from "node:fs";

export function slugify(pagePath) {
  const stripped = pagePath.replace(/^\/+/, "").replace(/\/+$/, "");
  const slug = stripped.replace(/[^a-zA-Z0-9]+/g, "-");
  return slug || "root";
}

export function loadPagesConfig(configPath) {
  if (!fs.existsSync(configPath)) return null;
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!Array.isArray(raw.pages)) {
    throw new Error(`chromagic: invalid pages config at ${configPath} — "pages" must be an array`);
  }
  return {
    pages: raw.pages.map((p) => ({
      path: p.path,
      name: p.name || slugify(p.path),
    })),
  };
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `node --test src/lib/pages-config.test.mjs`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/pages-config.mjs src/lib/pages-config.test.mjs
git commit -m "feat: chromagic.pages.json 読み込みロジックを追加"
```

## Task 6: `src/lib/pages-capture.mjs`

**Files:**
- Create: `src/lib/pages-capture.mjs`
- Test: `src/lib/pages-capture.test.mjs`

**Interfaces:**
- Consumes: `playwright-core`の`Browser`インターフェース（`newContext`, `newPage`など。テストではモックオブジェクトを渡す）
- Produces: `waitForServer(url, timeoutSec, { fetchImpl, sleepMs }): Promise<void>`（タイムアウト時はthrow）, `runLoginScript({ browser, baseUrl, loginScriptPath, viewport }): Promise<object>`（storage stateを返す）, `capturePages({ browser, baseUrl, pages, storageState, viewport, outDir }): Promise<string[]>`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/pages-capture.test.mjs`:

```js
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
```

実ブラウザ・実ログインフローを使うテストはここでは行わない（Playwrightの`chromium.launch`や実際のログインスクリプト実行は、consumerリポジトリでの結合確認に委ねる。この境界は計画のReview Focusにも記載済み）。

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test src/lib/pages-capture.test.mjs`
Expected: FAIL

- [ ] **Step 3: `src/lib/pages-capture.mjs`を実装する**

```js
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function waitForServer(url, timeoutSec, { fetchImpl = fetch, sleepMs = 500 } = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    try {
      const res = await fetchImpl(url);
      if (res.status < 500) return;
    } catch {
      // 未起動、リトライ
    }
    if (Date.now() >= deadline) {
      throw new Error(`chromagic: server at ${url} did not become ready within ${timeoutSec}s`);
    }
    await new Promise((r) => setTimeout(r, sleepMs));
  }
}

export async function runLoginScript({ browser, baseUrl, loginScriptPath, viewport }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  process.env.CHROMAGIC_BASE_URL = baseUrl;
  const mod = await import(pathToFileURL(path.resolve(loginScriptPath)).href);
  await mod.default(page);
  const storageState = await context.storageState();
  await context.close();
  return storageState;
}

export async function capturePages({ browser, baseUrl, pages, storageState, viewport, outDir }) {
  const context = await browser.newContext({ storageState, viewport });
  const names = [];
  for (const p of pages) {
    const tab = await context.newPage();
    await tab.goto(new URL(p.path, baseUrl).toString());
    const outPath = path.join(outDir, `${p.name}.png`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await tab.screenshot({ path: outPath, fullPage: true });
    await tab.close();
    names.push(p.name);
  }
  await context.close();
  return names;
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `node --test src/lib/pages-capture.test.mjs`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/pages-capture.mjs src/lib/pages-capture.test.mjs
git commit -m "feat: 実ページのヘルスチェック・ログイン・撮影ロジックを追加"
```

## Task 7: `src/lib/approve.mjs`

**Files:**
- Create: `src/lib/approve.mjs`
- Test: `src/lib/approve.test.mjs`

**Interfaces:**
- Consumes: `apiFetch` from `./github-api.mjs`
- Produces: `isApproveCommand(body): boolean`, `isSelfApprove(commentAuthor, prAuthor): boolean`, `hasWritePermission({ repo, username, token, apiBase }): Promise<boolean>`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/approve.test.mjs`:

```js
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
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test src/lib/approve.test.mjs`
Expected: FAIL

- [ ] **Step 3: `src/lib/approve.mjs`を実装する**

```js
import { apiFetch } from "./github-api.mjs";

export const APPROVE_COMMAND = "/chromagic approve";

export function isApproveCommand(body) {
  return body.trim() === APPROVE_COMMAND;
}

export function isSelfApprove(commentAuthor, prAuthor) {
  return commentAuthor.toLowerCase() === prAuthor.toLowerCase();
}

export async function hasWritePermission({ repo, username, token, apiBase }) {
  const res = await apiFetch("GET", `/repos/${repo}/collaborators/${username}/permission`, undefined, { token, apiBase });
  return res.permission === "write" || res.permission === "admin";
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `node --test src/lib/approve.test.mjs`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/approve.mjs src/lib/approve.test.mjs
git commit -m "feat: /chromagic approve の承認判定ロジックを追加"
```

## Task 8: `src/pages-entry.mjs`（実ページVRT エントリポイント）

**Files:**
- Create: `src/pages-entry.mjs`

**Interfaces:**
- Consumes: `loadPagesConfig` from `./lib/pages-config.mjs`; `waitForServer, runLoginScript, capturePages` from `./lib/pages-capture.mjs`; `listPngs, copyFile, diffImage, buildComment` from `./lib/image-diff.mjs`; `makeGitEnv, makeGit, cloneBranch, pushBranch` from `./lib/git-ops.mjs`; `upsertComment, createOrUpdateCheckRun` from `./lib/github-api.mjs`; `playwright-core`の`chromium`

このタスクはprocess.env駆動のオーケストレーションであり、Task1-7のユニットテストで構成要素の正しさは担保済みのため、自動テストは追加しない（構文チェックのみ）。

- [ ] **Step 1: `package.json`に`playwright-core`を追加する**

`package.json`の`dependencies`に追記:

```json
"playwright-core": "^1.49.0"
```

Run: `npm install`（`package-lock.json`とローカル`node_modules`の両方を更新する）

- [ ] **Step 2: `src/pages-entry.mjs`を実装する**

```js
// chromagic — 実ページVRT本体。
// consumer が起動したアプリ(PAGES_BASE_URL)に対し、chromagic.pages.json に列挙されたパスを
// Playwright(playwright-core, Chrome for Testing を流用)で撮影し、既存のpixelmatch比較・
// PRコメント・baseline更新ロジックを再利用しつつ、実ページ専用のブランチとPRコメントに出力する。
// 差分があれば check run(PAGES_CHECK_NAME)を failure にし、approve-entry.mjs による
// `/chromagic approve` コメント承認があるまでマージをブロックする。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { loadPagesConfig } from "./lib/pages-config.mjs";
import { waitForServer, runLoginScript, capturePages } from "./lib/pages-capture.mjs";
import { listPngs, copyFile, diffImage, buildComment } from "./lib/image-diff.mjs";
import { makeGitEnv, makeGit, cloneBranch, pushBranch } from "./lib/git-ops.mjs";
import { upsertComment, createOrUpdateCheckRun } from "./lib/github-api.mjs";

const {
  GITHUB_TOKEN: TOKEN,
  GITHUB_REPOSITORY: REPO,
  GITHUB_RUN_ID: RUN_ID,
  GITHUB_EVENT_NAME: EVENT,
  GITHUB_EVENT_PATH: EVENT_PATH,
  GITHUB_SERVER_URL: SERVER = "https://github.com",
  GITHUB_API_URL: API = "https://api.github.com",
  PAGES_CONFIG_PATH,
  PAGES_START_COMMAND,
  PAGES_BASE_URL,
  PAGES_LOGIN_SCRIPT,
  PAGES_HEALTH_CHECK_TIMEOUT,
  PAGES_BASELINE_BRANCH,
  PAGES_REPORT_BRANCH,
  PAGES_VIEWPORT,
  PAGES_CHECK_NAME,
  VRT_MATCHING_THRESHOLD,
  VRT_THRESHOLD_PIXEL,
  CHROME_PATH,
} = process.env;

const log = (m) => process.stdout.write(`${m}\n`);
const MARKER = "<!-- chromagic-vrt-pages -->";
const REMOTE_URL = `https://x-access-token@github.com/${REPO}.git`;
const THRESHOLD_OPTS = {
  matchThreshold: Number.parseFloat(VRT_MATCHING_THRESHOLD || "0.05"),
  thresholdPixel: Number.parseInt(VRT_THRESHOLD_PIXEL || "50", 10),
};

async function main() {
  if (!PAGES_START_COMMAND || !PAGES_CONFIG_PATH || !fs.existsSync(PAGES_CONFIG_PATH)) {
    log("chromagic: pages-start-command 未指定 または pages-config が無いため実ページVRTをスキップ。");
    return;
  }
  const config = loadPagesConfig(PAGES_CONFIG_PATH);
  if (!config || config.pages.length === 0) {
    log("chromagic: pages-config にページが定義されていないためスキップ。");
    return;
  }

  await waitForServer(PAGES_BASE_URL, Number.parseInt(PAGES_HEALTH_CHECK_TIMEOUT || "30", 10));

  const [w, h] = (PAGES_VIEWPORT || "1280x800").split("x").map(Number);
  const viewport = { width: w, height: h };
  const browser = await chromium.launch({ executablePath: CHROME_PATH });

  let storageState;
  if (PAGES_LOGIN_SCRIPT) {
    storageState = await runLoginScript({ browser, baseUrl: PAGES_BASE_URL, loginScriptPath: PAGES_LOGIN_SCRIPT, viewport });
  }

  const currentDir = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-pages-current-"));
  await capturePages({ browser, baseUrl: PAGES_BASE_URL, pages: config.pages, storageState, viewport, outDir: currentDir });
  await browser.close();

  const event = EVENT_PATH && fs.existsSync(EVENT_PATH) ? JSON.parse(fs.readFileSync(EVENT_PATH, "utf8")) : {};
  const DEFAULT_BRANCH = event.repository?.default_branch || "main";
  const GIT_ENV = makeGitEnv(TOKEN);
  const git = makeGit(GIT_ENV);
  const currentPngs = listPngs(currentDir);

  const isDefaultPush =
    EVENT === "push" && (event.ref === `refs/heads/${DEFAULT_BRANCH}` || process.env.GITHUB_REF === `refs/heads/${DEFAULT_BRANCH}`);
  if (isDefaultPush) {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-pages-base-"));
    for (const rel of currentPngs) copyFile(path.join(currentDir, rel), path.join(stage, rel));
    pushBranch(stage, PAGES_BASELINE_BRANCH, { force: true, remoteUrl: REMOTE_URL, git, commitMessage: `chromagic: ${PAGES_BASELINE_BRANCH} @ ${RUN_ID} [skip ci]` });
    log(`chromagic: pages baseline '${PAGES_BASELINE_BRANCH}' updated (${currentPngs.length} images).`);
    return;
  }

  const prNumber = event.pull_request?.number || event.number;
  const headSha = event.pull_request?.head?.sha;
  if (!prNumber) {
    log("chromagic: PR でも default push でもないため実ページVRTをスキップ。");
    return;
  }

  const baseDir = cloneBranch(REMOTE_URL, PAGES_BASELINE_BRANCH, git);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-pages-report-"));
  const changed = [];
  const added = [];

  for (const rel of currentPngs) {
    const cur = path.join(currentDir, rel);
    const base = baseDir ? path.join(baseDir, rel) : null;
    if (!base || !fs.existsSync(base)) {
      added.push(rel);
      copyFile(cur, path.join(stage, RUN_ID, "actual", rel));
      continue;
    }
    const diffOut = path.join(stage, RUN_ID, "diff", rel);
    const r = diffImage(base, cur, diffOut, THRESHOLD_OPTS);
    if (r.changed) {
      changed.push({ rel, ...r });
      copyFile(cur, path.join(stage, RUN_ID, "actual", rel));
      copyFile(base, path.join(stage, RUN_ID, "expected", rel));
    }
  }

  const baseSet = new Set(baseDir ? listPngs(baseDir) : []);
  const removed = [...baseSet].filter((rel) => !currentPngs.includes(rel));
  const hasDiff = changed.length > 0 || added.length > 0 || removed.length > 0;

  if (changed.length || added.length) {
    const reportBase = cloneBranch(REMOTE_URL, PAGES_REPORT_BRANCH, git);
    pushBranch(stage, PAGES_REPORT_BRANCH, {
      force: !reportBase, baseDir: reportBase || undefined, remoteUrl: REMOTE_URL, git,
      commitMessage: `chromagic: pages report ${RUN_ID} [skip ci]`,
    });
  }

  const body = buildComment({
    marker: MARKER,
    title: "🖼️ chromagic — Page VRT",
    changed, added, removed, total: currentPngs.length,
    urlCtx: { server: SERVER, repo: REPO, reportBranch: PAGES_REPORT_BRANCH, runId: RUN_ID },
  });
  await upsertComment({ prNumber, body, marker: MARKER, token: TOKEN, apiBase: API, repo: REPO });

  if (headSha) {
    await createOrUpdateCheckRun({
      repo: REPO,
      sha: headSha,
      name: PAGES_CHECK_NAME,
      conclusion: hasDiff ? "failure" : "success",
      summary: hasDiff ? "差分が検出されました。`/chromagic approve` で承認してください。" : "差分なし。",
      token: TOKEN,
      apiBase: API,
    });
  }

  log(`chromagic: pages changed=${changed.length} new=${added.length} deleted=${removed.length}`);
}

main().catch((e) => {
  let msg = e.stack || String(e);
  if (TOKEN) msg = msg.split(TOKEN).join("***");
  process.stderr.write(`chromagic pages failed: ${msg}\n`);
  process.exit(1);
});
```

- [ ] **Step 3: 構文チェック**

Run: `node --check src/pages-entry.mjs`
Expected: 出力なし

- [ ] **Step 4: コミット**

```bash
git add package.json package-lock.json src/pages-entry.mjs
git commit -m "feat: 実ページVRTのエントリポイントsrc/pages-entry.mjsを追加"
```

## Task 9: `src/approve-entry.mjs`（承認処理 エントリポイント）

**Files:**
- Create: `src/approve-entry.mjs`

**Interfaces:**
- Consumes: `isApproveCommand, isSelfApprove, hasWritePermission` from `./lib/approve.mjs`; `apiFetch, createOrUpdateCheckRun` from `./lib/github-api.mjs`

- [ ] **Step 1: `src/approve-entry.mjs`を実装する**

```js
// chromagic — 実ページVRTの承認コメント処理。
// issue_comment イベントで "/chromagic approve" を検知し、PR作成者本人でないこと・
// write権限を持つことを確認した上で PAGES_CHECK_NAME の check run を success に更新する。
import fs from "node:fs";
import { isApproveCommand, isSelfApprove, hasWritePermission } from "./lib/approve.mjs";
import { apiFetch, createOrUpdateCheckRun } from "./lib/github-api.mjs";

const {
  GITHUB_TOKEN: TOKEN,
  GITHUB_REPOSITORY: REPO,
  GITHUB_EVENT_PATH: EVENT_PATH,
  GITHUB_API_URL: API = "https://api.github.com",
  PAGES_CHECK_NAME,
} = process.env;

const log = (m) => process.stdout.write(`${m}\n`);

async function main() {
  const event = JSON.parse(fs.readFileSync(EVENT_PATH, "utf8"));
  const commentBody = event.comment?.body || "";
  if (!isApproveCommand(commentBody)) {
    log("chromagic: 承認コマンドではないためスキップ。");
    return;
  }
  if (!event.issue?.pull_request) {
    log("chromagic: PRへのコメントではないためスキップ。");
    return;
  }

  const commentAuthor = event.comment.user.login;
  const prAuthor = event.issue.user.login;
  const prNumber = event.issue.number;

  if (isSelfApprove(commentAuthor, prAuthor)) {
    log(`chromagic: @${commentAuthor} はPR作成者本人のため承認できません。`);
    process.exitCode = 1;
    return;
  }

  const canApprove = await hasWritePermission({ repo: REPO, username: commentAuthor, token: TOKEN, apiBase: API });
  if (!canApprove) {
    log(`chromagic: @${commentAuthor} には承認権限がありません(write権限が必要)。`);
    process.exitCode = 1;
    return;
  }

  const pr = await apiFetch("GET", `/repos/${REPO}/pulls/${prNumber}`, undefined, { token: TOKEN, apiBase: API });
  await createOrUpdateCheckRun({
    repo: REPO,
    sha: pr.head.sha,
    name: PAGES_CHECK_NAME,
    conclusion: "success",
    summary: `@${commentAuthor} により承認されました。`,
    token: TOKEN,
    apiBase: API,
  });
  log(`chromagic: @${commentAuthor} が PR #${prNumber} の実ページVRTを承認しました。`);
}

main().catch((e) => {
  let msg = e.stack || String(e);
  if (TOKEN) msg = msg.split(TOKEN).join("***");
  process.stderr.write(`chromagic approve failed: ${msg}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: 構文チェック**

Run: `node --check src/approve-entry.mjs`
Expected: 出力なし

- [ ] **Step 3: コミット**

```bash
git add src/approve-entry.mjs
git commit -m "feat: /chromagic approve コメント処理のエントリポイントを追加"
```

## Task 10: `action.yml` 拡張

**Files:**
- Modify: `action.yml`

- [ ] **Step 1: inputsセクションに実ページVRT用の項目を追加する**

`action.yml`の`inputs:`ブロック末尾（`install-fonts`の後）に追記:

```yaml
  pages-config:
    description: "実ページVRT対象URL一覧の設定ファイル。存在しなければ実ページVRTはスキップされる。"
    required: false
    default: "chromagic.pages.json"
  pages-start-command:
    description: "実ページVRT用にアプリを起動するコマンド。未指定なら実ページVRTはスキップされる。"
    required: false
    default: ""
  pages-base-url:
    description: "起動したアプリへアクセスするベースURL。"
    required: false
    default: "http://localhost:3000"
  pages-login-script:
    description: "ログイン用Playwrightスクリプトのパス。省略時は未ログイン状態でキャプチャする。"
    required: false
    default: ""
  pages-health-check-timeout:
    description: "アプリ起動待ちのタイムアウト秒数。"
    required: false
    default: "30"
  pages-baseline-branch:
    description: "実ページ用ベースライン画像ブランチ。"
    required: false
    default: "vrt-baseline-pages"
  pages-report-branch:
    description: "実ページ用PRコメント画像のホストブランチ。"
    required: false
    default: "vrt-reports-pages"
  pages-viewport:
    description: "実ページVRTのビューポート WxH。省略時は viewport の1つ目の値を使う。"
    required: false
    default: ""
  pages-check-name:
    description: "実ページVRTの承認ゲートに使う check run 名。branch protection の required check にはこの名前を指定する。"
    required: false
    default: "chromagic/pages-approval"
```

- [ ] **Step 2: composite stepsに実ページVRT実行ステップを追加する**

`playwright-core`はTask8で`package.json`の`dependencies`に加えるため、既存の`Restore action dependencies cache` / `Install action dependencies` / `Save action dependencies cache`ステップ（package-lock.jsonハッシュキー）がそのままキャッシュ・インストールする。専用のキャッシュステップは追加不要。

既存の`Compare & report (pixelmatch 緑/赤)`ステップの直後に追記:

```yaml
    - name: Start app for page VRT
      if: ${{ inputs.pages-start-command != '' }}
      shell: bash
      env:
        PAGES_START_COMMAND: ${{ inputs.pages-start-command }}
      run: |
        nohup bash -c "$PAGES_START_COMMAND" > "$RUNNER_TEMP/chromagic-pages-app.log" 2>&1 &
        echo $! > "$RUNNER_TEMP/chromagic-pages-app.pid"

    - name: Capture & compare pages (実ページVRT)
      if: ${{ inputs.pages-start-command != '' }}
      shell: bash
      env:
        GITHUB_TOKEN: ${{ inputs.github-token }}
        PAGES_CONFIG_PATH: ${{ inputs.pages-config }}
        PAGES_START_COMMAND: ${{ inputs.pages-start-command }}
        PAGES_BASE_URL: ${{ inputs.pages-base-url }}
        PAGES_LOGIN_SCRIPT: ${{ inputs.pages-login-script }}
        PAGES_HEALTH_CHECK_TIMEOUT: ${{ inputs.pages-health-check-timeout }}
        PAGES_BASELINE_BRANCH: ${{ inputs.pages-baseline-branch }}
        PAGES_REPORT_BRANCH: ${{ inputs.pages-report-branch }}
        PAGES_VIEWPORT: ${{ inputs.pages-viewport }}
        PAGES_CHECK_NAME: ${{ inputs.pages-check-name }}
        VRT_MATCHING_THRESHOLD: ${{ inputs.matching-threshold }}
        VRT_THRESHOLD_PIXEL: ${{ inputs.threshold-pixel }}
        CHROME_PATH: ${{ steps.chrome.outputs.chrome-path }}
      run: node "$GITHUB_ACTION_PATH/src/pages-entry.mjs"

    - name: Stop app for page VRT
      if: ${{ always() && inputs.pages-start-command != '' }}
      shell: bash
      run: |
        if [ -f "$RUNNER_TEMP/chromagic-pages-app.pid" ]; then
          kill "$(cat "$RUNNER_TEMP/chromagic-pages-app.pid")" 2>/dev/null || true
        fi
```

- [ ] **Step 3: actionlintで検証する**

Run: `actionlint action.yml`
Expected: 出力なし（エラーなし）

- [ ] **Step 4: コミット**

```bash
git add action.yml
git commit -m "feat: action.ymlに実ページVRT用のinputsとstepsを追加"
```

## Task 11: 承認コメント用ワークフロー例 + サンプル設定ファイル

**Files:**
- Create: `examples/vrt-pages-approve.yaml`
- Create: `examples/vrt-pages.yaml`
- Create: `examples/chromagic.pages.json.sample`
- Create: `examples/login.sample.mjs`

- [ ] **Step 1: `examples/chromagic.pages.json.sample`を作成する**

```json
{
  "pages": [
    { "path": "/login", "name": "login" },
    { "path": "/dashboard", "name": "dashboard" }
  ]
}
```

- [ ] **Step 2: `examples/login.sample.mjs`を作成する**

```js
// consumer リポジトリに配置し、pages-login-script input で指定するサンプル。
// chromagic は default export を Playwright の page を渡して実行し、
// 完了後のブラウザ context から storage state を取得して以降のキャプチャに使う。
export default async function login(page) {
  await page.goto(`${process.env.CHROMAGIC_BASE_URL}/login`);
  await page.fill("#id", process.env.CHROMAGIC_LOGIN_ID);
  await page.fill("#password", process.env.CHROMAGIC_LOGIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard");
}
```

- [ ] **Step 3: `examples/vrt-pages.yaml`を作成する**

```yaml
# .github/workflows/vrt-pages.yaml
name: Page VRT

on:
  pull_request:
  push: { branches: [main] } # ← ベースライン更新に必須

permissions:
  contents: write
  pull-requests: write
  checks: write

jobs:
  vrt-pages:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - uses: sgash708/chromagic@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          pages-start-command: "bun run start"
          pages-base-url: "http://localhost:3000"
          pages-config: "chromagic.pages.json"
          pages-login-script: ".github/chromagic/login.mjs"
        env:
          CHROMAGIC_LOGIN_ID: ${{ secrets.CHROMAGIC_LOGIN_ID }}
          CHROMAGIC_LOGIN_PASSWORD: ${{ secrets.CHROMAGIC_LOGIN_PASSWORD }}
```

- [ ] **Step 4: `examples/vrt-pages-approve.yaml`を作成する**

```yaml
# .github/workflows/vrt-pages-approve.yaml
# PRコメントで `/chromagic approve` と投稿すると、実ページVRTの承認ゲート
# (chromagic/pages-approval check) を success にしてマージ可能にする。
# 事前に branch protection で "chromagic/pages-approval" を required check に設定しておくこと。
name: Page VRT Approve

on:
  issue_comment:
    types: [created]

permissions:
  checks: write
  pull-requests: read

jobs:
  approve:
    if: ${{ github.event.issue.pull_request }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - uses: sgash708/chromagic@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          mode: approve
```

- [ ] **Step 5: `action.yml`に`mode`入力と分岐ステップを追加する**

Task10で追加した`Capture & compare pages`ステップの`if`条件を、approveモードでは実行されないように調整し、承認処理ステップを追加する。`action.yml`の`inputs:`に追記:

```yaml
  mode:
    description: "capture(既定): VRT撮影・比較を実行。approve: /chromagic approve コメントの承認処理のみ実行。"
    required: false
    default: "capture"
```

既存の`Capture stories (storycap)`以降の全ステップの`if`条件の先頭に`inputs.mode == 'capture' &&`を追加し（例: `if: ${{ inputs.mode == 'capture' && inputs.pages-start-command != '' }}`）、末尾に承認処理ステップを追加する:

```yaml
    - name: Approve page VRT (mode=approve)
      if: ${{ inputs.mode == 'approve' }}
      shell: bash
      env:
        GITHUB_TOKEN: ${{ inputs.github-token }}
        PAGES_CHECK_NAME: ${{ inputs.pages-check-name }}
      run: node "$GITHUB_ACTION_PATH/src/approve-entry.mjs"
```

- [ ] **Step 6: actionlintで再検証する**

Run: `actionlint action.yml examples/vrt-pages.yaml examples/vrt-pages-approve.yaml`
Expected: 出力なし

- [ ] **Step 7: コミット**

```bash
git add examples/vrt-pages.yaml examples/vrt-pages-approve.yaml examples/chromagic.pages.json.sample examples/login.sample.mjs action.yml
git commit -m "feat: 実ページVRT・承認ワークフローのexamplesとaction.ymlのmode切替を追加"
```

## Task 12: README更新

**Files:**
- Modify: `README.md`
- Modify: `README.ja.md`

- [ ] **Step 1: `README.ja.md`に「実ページVRT」セクションを追加する**

`## 仕組み`セクションの前に追記:

```markdown
## 実ページVRT（任意）

Storybookのstoryだけでなく、実際にデプロイされる画面そのものの見た目のデグレも検知できる。

- consumerが指定した起動コマンド(`pages-start-command`)でアプリを起動し、`chromagic.pages.json`に列挙したURLを撮影
- ログインが必要な画面は、consumerが用意したPlaywrightログインスクリプト(`pages-login-script`)でstorage stateを取得してから撮影
- baseline/reportはStorybookとは別ブランチ(`vrt-baseline-pages` / `vrt-reports-pages`)で管理
- 差分が出たPRは `chromagic/pages-approval` checkが失敗した状態になり、**PR作成者以外**が `/chromagic approve` とコメントする(かつリポジトリへのwrite権限を持つ)まで、branch protectionでマージをブロックできる
- 使い方は [`examples/vrt-pages.yaml`](examples/vrt-pages.yaml) と [`examples/vrt-pages-approve.yaml`](examples/vrt-pages-approve.yaml) を参照

`pages-start-command`または`pages-config`を指定しなければ、実ページVRTは実行されず既存のStorybook VRTの挙動のみになる。
```

`## inputs`テーブルに追記:

```markdown
| `pages-config` | `chromagic.pages.json` | 実ページVRT対象URL一覧の設定ファイル。無ければ実ページVRTはスキップ |
| `pages-start-command` | (空) | 実ページVRT用アプリ起動コマンド。未指定ならスキップ |
| `pages-base-url` | `http://localhost:3000` | 起動したアプリへのベースURL |
| `pages-login-script` | (空) | ログイン用Playwrightスクリプトのパス |
| `pages-health-check-timeout` | `30` | アプリ起動待ちのタイムアウト秒数 |
| `pages-baseline-branch` | `vrt-baseline-pages` | 実ページ用ベースラインブランチ |
| `pages-report-branch` | `vrt-reports-pages` | 実ページ用レポートブランチ |
| `pages-viewport` | (空、`viewport`を継承) | 実ページVRTのビューポート |
| `pages-check-name` | `chromagic/pages-approval` | 承認ゲートに使うcheck run名 |
| `mode` | `capture` | `capture`または`approve` |
```

- [ ] **Step 2: `README.md`に英語版の対応セクションを追加する**

`README.ja.md`と同内容を英語で`README.md`の対応箇所に追記する。

- [ ] **Step 3: コミット**

```bash
git add README.md README.ja.md
git commit -m "docs: 実ページVRT・承認フローの使い方をREADMEに追記"
```

## Task 13: `package.json` / CI更新

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: `package.json`に`test`スクリプトを追加する**

`"scripts"`セクションが無いので新設:

```json
"scripts": {
  "test": "node --test src/lib"
}
```

- [ ] **Step 2: `.github/workflows/ci.yml`にテスト実行ステップを追加する**

`Syntax check`ステップの直後に追記:

```yaml
      - name: Unit tests
        run: npm test
```

`actionlint`ステップの対象に新規examplesファイルも含まれることを確認する（`raven-actions/actionlint`はリポジトリ全体を走査するため追加設定不要）。

- [ ] **Step 3: ローカルで一通り検証する**

Run:
```bash
npm test
node --check src/main.mjs src/pages-entry.mjs src/approve-entry.mjs
actionlint
```
Expected: 全てエラーなく完了

- [ ] **Step 4: コミット**

```bash
git add package.json .github/workflows/ci.yml
git commit -m "test: 単体テスト実行をnpm test/CIに追加"
```

## Task 14: ブランチpush + PR作成（mainへのマージはしない）

**Files:** なし（git操作のみ）

- [ ] **Step 1: 使用ブランチ名を確認する**

Run: `git branch --show-current`
Expected: `feature/page-vrt-approval`のような作業ブランチ名（mainではないこと）。mainで作業していた場合はここで`git checkout -b feature/page-vrt-approval`する。

- [ ] **Step 2: リモートへpushする**

```bash
git push -u origin feature/page-vrt-approval
```

- [ ] **Step 3: PRを作成する（draft、mainへの自動マージは行わない）**

```bash
gh pr create --draft --title "feat: 実ページVRT + /chromagic approve 承認フローを追加" --body "$(cat <<'EOF'
## Summary
- Storybookとは独立した実ページVRT（consumer起動アプリのURL一覧をPlaywrightで撮影・比較）を追加
- 差分検出時は `chromagic/pages-approval` checkを失敗させ、PR作成者以外の `/chromagic approve` コメント（write権限必須）で承認するまでマージをブロックできるようにした
- Storybook側の既存フロー（merge=承認）は変更なし

## Test plan
- [x] `npm test`（`src/lib`配下のユニットテスト）
- [x] `node --check` で全エントリポイントの構文確認
- [x] `actionlint` でaction.yml / examplesのワークフロー構文確認
- [ ] 実際のconsumerリポジトリでの実ページVRT・承認フローの結合確認（本PRのスコープ外、別途実施）

このPRはmainにはマージせず、動作確認用として開いています。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: PRのURLを控えて完了報告する**

Run: `gh pr view --web=false --json url -q .url`

この出力をユーザーへの完了報告に含める。
