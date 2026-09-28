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
