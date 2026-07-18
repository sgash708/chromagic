// chromagic — Storybook VRT 本体。
// 役割: storycap が撮った現行スクショ(VRT_CURRENT_DIR)を baseline ブランチの画像と
// pixelmatch で比較し、変化を「赤=消えた / 緑=増えた」の2色 diff で可視化。
// PR では actual/expected/diff を report ブランチへ push し、PR コメントにインライン表示する。
// デフォルトブランチへの push 時は現行スクショを baseline ブランチへ保存(=次回比較の基準)。
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fg from "fast-glob";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

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

const MATCH = Number.parseFloat(VRT_MATCHING_THRESHOLD || "0.05");
const THRESH_PX = Number.parseInt(VRT_THRESHOLD_PIXEL || "50", 10);
const AUTH_URL = `https://x-access-token:${TOKEN}@github.com/${REPO}.git`;
const event = EVENT_PATH && fs.existsSync(EVENT_PATH)
  ? JSON.parse(fs.readFileSync(EVENT_PATH, "utf8"))
  : {};
const DEFAULT_BRANCH = event.repository?.default_branch || "main";

const sh = (cmd, opts = {}) =>
  execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts });
const log = (m) => process.stdout.write(`${m}\n`);
const COMMENT_MARKER = "<!-- chromagic-vrt -->";

function listPngs(dir) {
  return fg.sync("**/*.png", { cwd: dir, dot: false }).sort();
}
function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** GitHub Actions の outputs を書き出す（consumer が件数で gate できるように）。 */
function setOutputs(o) {
  if (!process.env.GITHUB_OUTPUT) return;
  const body = Object.entries(o)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${body}\n`);
}

/** baseline ブランチを浅く clone。無ければ null。 */
function cloneBranch(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-"));
  try {
    sh(`git clone -q --depth 1 --branch ${branch} ${AUTH_URL} ${dir}`);
    return dir;
  } catch {
    return null;
  }
}

/** staging ディレクトリを branch として push。force=true で履歴を捨てて置換。 */
function pushBranch(stageDir, branch, { force, baseDir } = {}) {
  let work = stageDir;
  if (!force && baseDir) {
    // 既存 report ブランチに追記
    for (const f of fg.sync("**/*", { cwd: stageDir, dot: false, onlyFiles: true })) {
      copyFile(path.join(stageDir, f), path.join(baseDir, f));
    }
    work = baseDir;
    sh(`git -C ${work} add -A`);
    sh(`git -C ${work} -c user.email=vrt@chromagic -c user.name=chromagic commit -q -m "chromagic: report ${RUN_ID} [skip ci]" || true`);
    sh(`git -C ${work} push -q ${AUTH_URL} HEAD:${branch}`);
    return;
  }
  sh(`git -C ${work} init -q`);
  sh(`git -C ${work} checkout -q -b ${branch}`);
  sh(`git -C ${work} add -A`);
  sh(`git -C ${work} -c user.email=vrt@chromagic -c user.name=chromagic commit -q -m "chromagic: ${branch} @ ${RUN_ID} [skip ci]"`);
  sh(`git -C ${work} push -q --force ${AUTH_URL} HEAD:${branch}`);
}

async function apiFetch(method, urlPath, body) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/** diff を生成。changed なら true。緑=追加 / 赤=削除 の2色。 */
function diffImage(basePath, curPath, diffOut) {
  const a = PNG.sync.read(fs.readFileSync(basePath));
  const b = PNG.sync.read(fs.readFileSync(curPath));
  if (a.width !== b.width || a.height !== b.height) {
    return { changed: true, pixels: -1, sizeMismatch: true };
  }
  const { width, height } = a;
  const out = new PNG({ width, height });
  const px = pixelmatch(a.data, b.data, out.data, width, height, {
    threshold: MATCH,
    includeAA: false,
    alpha: 0.35,
    aaColor: [255, 255, 0],
    diffColor: [255, 0, 0], // 赤 = baseline 側(消えた)
    diffColorAlt: [0, 200, 0], // 緑 = 現行側(増えた)
  });
  if (px > THRESH_PX) {
    fs.mkdirSync(path.dirname(diffOut), { recursive: true });
    fs.writeFileSync(diffOut, PNG.sync.write(out));
    return { changed: true, pixels: px };
  }
  return { changed: false, pixels: px };
}

function rawUrl(kind, rel) {
  const enc = rel.split("/").map(encodeURIComponent).join("/");
  return `${SERVER}/${REPO}/blob/${REPORT_BRANCH}/${RUN_ID}/${kind}/${enc}?raw=true`;
}

function buildComment({ changed, added, removed, total }) {
  const lines = [COMMENT_MARKER];
  const ok = changed.length === 0 && added.length === 0 && removed.length === 0;
  lines.push("## 🎨 chromagic — Visual Regression");
  lines.push("");
  lines.push(ok ? "✅ 視覚的差分なし。" : "🟠 差分を検出しました（🟢=増えた / 🔴=消えたピクセル）。");
  lines.push("");
  lines.push("| pass | changed | new | deleted |");
  lines.push("|:--:|:--:|:--:|:--:|");
  lines.push(`| ${total - changed.length - added.length} | ${changed.length} | ${added.length} | ${removed.length} |`);
  lines.push("");
  for (const c of changed) {
    lines.push(`### \`${c.rel}\`${c.sizeMismatch ? " (サイズ変更)" : ""}`);
    lines.push("| expected | actual | difference |");
    lines.push("|--|--|--|");
    const diffCell = c.sizeMismatch ? "—" : `![diff](${rawUrl("diff", c.rel)})`;
    lines.push(`| ![expected](${rawUrl("expected", c.rel)}) | ![actual](${rawUrl("actual", c.rel)}) | ${diffCell} |`);
    lines.push("");
  }
  if (added.length) {
    lines.push("<details><summary>🆕 new stories</summary>\n");
    for (const rel of added) lines.push(`- \`${rel}\` ![new](${rawUrl("actual", rel)})`);
    lines.push("\n</details>");
  }
  lines.push("");
  lines.push(`<sub>baseline: \`${BASELINE_BRANCH}\` ／ images: \`${REPORT_BRANCH}/${RUN_ID}\` ／ run ${RUN_ID}</sub>`);
  return lines.join("\n");
}

async function upsertComment(prNumber, body) {
  const comments = await apiFetch("GET", `/repos/${REPO}/issues/${prNumber}/comments?per_page=100`);
  const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));
  if (existing) {
    await apiFetch("PATCH", `/repos/${REPO}/issues/comments/${existing.id}`, { body });
  } else {
    await apiFetch("POST", `/repos/${REPO}/issues/${prNumber}/comments`, { body });
  }
}

async function main() {
  const currentPngs = listPngs(CURRENT);
  log(`chromagic: ${currentPngs.length} screenshots captured.`);

  // --- デフォルトブランチへの push: baseline を更新して終了 ---
  const isDefaultPush =
    EVENT === "push" && (event.ref === `refs/heads/${DEFAULT_BRANCH}` || process.env.GITHUB_REF === `refs/heads/${DEFAULT_BRANCH}`);
  if (isDefaultPush) {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-base-"));
    for (const rel of currentPngs) copyFile(path.join(CURRENT, rel), path.join(stage, rel));
    pushBranch(stage, BASELINE_BRANCH, { force: true });
    log(`chromagic: baseline '${BASELINE_BRANCH}' updated (${currentPngs.length} images).`);
    setOutputs({ changed: 0, new: 0, deleted: 0, pass: currentPngs.length, total: currentPngs.length, baseline: "updated" });
    return;
  }

  // --- PR: baseline と比較 ---
  const prNumber = event.pull_request?.number || event.number;
  if (!prNumber) {
    log("chromagic: PR でも default push でもないためスキップ。");
    return;
  }

  const baseDir = cloneBranch(BASELINE_BRANCH);
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
    const r = diffImage(base, cur, diffOut);
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

  // 変化があれば画像を report ブランチへ push
  if (changed.length || added.length) {
    const reportBase = cloneBranch(REPORT_BRANCH);
    pushBranch(stage, REPORT_BRANCH, { force: !reportBase, baseDir: reportBase || undefined });
    log(`chromagic: report images pushed to '${REPORT_BRANCH}/${RUN_ID}'.`);
  }

  const body = buildComment({ changed, added, removed, total: currentPngs.length });
  await upsertComment(prNumber, body);
  log(`chromagic: PR #${prNumber} にコメントしました。`);
}

main().catch((e) => {
  process.stderr.write(`chromagic failed: ${e.stack || e}\n`);
  process.exit(1);
});
