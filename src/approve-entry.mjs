// chromagic — 実ページVRTの承認コメント処理。
// issue_comment イベントで "/chromagic approve" を検知し、PR作成者本人でないこと・
// write権限を持つこと・対象commitに未解決の差分検出check(failure)が存在することを確認した上で
// PAGES_CHECK_NAME の check run を success に更新する。
import fs from "node:fs";
import { isApproveCommand, isSelfApprove, hasWritePermission } from "./lib/approve.mjs";
import { apiFetch, createOrUpdateCheckRun, getCheckRun } from "./lib/github-api.mjs";

const {
  GITHUB_TOKEN: TOKEN,
  GITHUB_REPOSITORY: REPO,
  GITHUB_EVENT_PATH: EVENT_PATH,
  GITHUB_API_URL: API = "https://api.github.com",
  PAGES_CHECK_NAME,
} = process.env;

const log = (m) => process.stdout.write(`${m}\n`);

async function postRejectionComment(prNumber, body) {
  await apiFetch("POST", `/repos/${REPO}/issues/${prNumber}/comments`, { body }, { token: TOKEN, apiBase: API });
}

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
    await postRejectionComment(
      prNumber,
      `@${commentAuthor} セルフApproveはできません。PR作成者以外がApproveする必要があります。`
    );
    process.exitCode = 1;
    return;
  }

  const canApprove = await hasWritePermission({ repo: REPO, username: commentAuthor, token: TOKEN, apiBase: API });
  if (!canApprove) {
    log(`chromagic: @${commentAuthor} には承認権限がありません(write権限が必要)。`);
    await postRejectionComment(
      prNumber,
      `@${commentAuthor} には承認権限がありません(リポジトリへのwrite権限が必要です)。`
    );
    process.exitCode = 1;
    return;
  }

  const pr = await apiFetch("GET", `/repos/${REPO}/pulls/${prNumber}`, undefined, { token: TOKEN, apiBase: API });

  const checkRun = await getCheckRun({ repo: REPO, sha: pr.head.sha, name: PAGES_CHECK_NAME, token: TOKEN, apiBase: API });
  const isFreshFailure =
    checkRun &&
    checkRun.conclusion === "failure" &&
    new Date(checkRun.completed_at) <= new Date(event.comment.created_at);
  if (!isFreshFailure) {
    log(
      "chromagic: 対象commitに未解決の差分検出checkが見つからないため承認できません" +
        "(VRT未実行、または既に承認済み、またはcheck実行後に新しいcommitがpushされた可能性があります)。"
    );
    await postRejectionComment(
      prNumber,
      `@${commentAuthor} 承認できませんでした。対象commitに未解決の差分検出checkが見つかりません` +
        "(VRT未実行、既に承認済み、またはcheck実行後に新しいcommitがpushされた可能性があります)。"
    );
    process.exitCode = 1;
    return;
  }

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
