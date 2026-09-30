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

test("diffImage pads the smaller image and still writes a diff on size mismatch", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-test-"));
  const base = path.join(dir, "base.png");
  const cur = path.join(dir, "cur.png");
  writeSolidPng(base, { width: 4, height: 4, color: [0, 0, 0] });
  writeSolidPng(cur, { width: 8, height: 8, color: [0, 0, 0] });
  const diffOut = path.join(dir, "diff.png");
  const r = diffImage(base, cur, diffOut, { matchThreshold: 0.05, thresholdPixel: 50 });
  assert.equal(r.changed, true);
  assert.equal(r.sizeMismatch, true);
  assert.equal(fs.existsSync(diffOut), true);
  const out = PNG.sync.read(fs.readFileSync(diffOut));
  assert.equal(out.width, 8);
  assert.equal(out.height, 8);
});

test("diffImage highlights newly added content in the grown region, not just blank padding", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromagic-test-"));
  const base = path.join(dir, "base.png");
  const cur = path.join(dir, "cur.png");
  writeSolidPng(base, { width: 4, height: 4, color: [255, 255, 255] });
  // cur is taller and its added rows are non-white (simulating new content), not blank padding.
  writeSolidPng(cur, { width: 4, height: 8, color: [0, 128, 0] });
  const diffOut = path.join(dir, "diff.png");
  const r = diffImage(base, cur, diffOut, { matchThreshold: 0.05, thresholdPixel: 0 });
  assert.equal(r.changed, true);
  assert.equal(r.sizeMismatch, true);
  assert.ok(r.pixels > 0);
  assert.equal(fs.existsSync(diffOut), true);
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
    urlCtx: { server: "https://github.com", repo: "o/r", reportBranch: "vrt-reports", runId: "1", baselineBranch: "vrt-baseline" },
  });
  assert.match(body, /視覚的差分なし/);
  assert.match(body, /<!-- chromagic-vrt -->/);
  assert.match(body, /baseline: `vrt-baseline`/);
});

test("buildComment lists changed stories with expected/actual/diff links", () => {
  const body = buildComment({
    marker: "<!-- chromagic-vrt -->",
    title: "🎨 chromagic — Visual Regression",
    changed: [{ rel: "Button.png", pixels: 120 }], added: [], removed: [], total: 3,
    urlCtx: { server: "https://github.com", repo: "o/r", reportBranch: "vrt-reports", runId: "1", baselineBranch: "vrt-baseline" },
  });
  assert.match(body, /Button\.png/);
  assert.match(body, /expected/);
  assert.match(body, /actual/);
  assert.match(body, /差分を検出しました（/);
  assert.match(body, /baseline: `vrt-baseline`/);
});

test("buildComment uses fullwidth parens and includes 'new stories' header for added items", () => {
  const body = buildComment({
    marker: "<!-- chromagic-vrt -->",
    title: "🎨 chromagic — Visual Regression",
    changed: [], added: ["NewComponent.png"], removed: [], total: 3,
    urlCtx: { server: "https://github.com", repo: "o/r", reportBranch: "vrt-reports", runId: "1", baselineBranch: "vrt-baseline" },
  });
  assert.match(body, /🆕 new stories/);
  assert.match(body, /差分を検出しました（🟢=増えた \/ 🔴=消えたピクセル）/);
  assert.match(body, /baseline: `vrt-baseline`/);
});
