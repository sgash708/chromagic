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
