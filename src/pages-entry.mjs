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
    urlCtx: { server: SERVER, repo: REPO, reportBranch: PAGES_REPORT_BRANCH, runId: RUN_ID, baselineBranch: PAGES_BASELINE_BRANCH },
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
