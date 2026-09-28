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
