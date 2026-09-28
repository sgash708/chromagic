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
