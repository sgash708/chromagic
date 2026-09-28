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
