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
    const diffCell = c.sizeMismatch ? "—" : `![diff](${rawUrl({ ...urlCtx, kind: "diff", rel: c.rel })})`;
    lines.push(`| ![expected](${rawUrl({ ...urlCtx, kind: "expected", rel: c.rel })}) | ![actual](${rawUrl({ ...urlCtx, kind: "actual", rel: c.rel })}) | ${diffCell} |`);
    lines.push("");
  }
  if (added.length) {
    lines.push("<details><summary>🆕 new stories</summary>\n");
    for (const rel of added) lines.push(`- \`${rel}\` ![new](${rawUrl({ ...urlCtx, kind: "actual", rel })})`);
    lines.push("\n</details>");
  }
  lines.push("");
  lines.push(`<sub>baseline: \`${urlCtx.baselineBranch}\` ／ images: \`${urlCtx.reportBranch}/${urlCtx.runId}\` ／ run ${urlCtx.runId}</sub>`);
  return lines.join("\n");
}
