import fs from "node:fs";

export function slugify(pagePath) {
  const stripped = pagePath.replace(/^\/+/, "").replace(/\/+$/, "");
  const slug = stripped.replace(/[^a-zA-Z0-9]+/g, "-");
  return slug || "root";
}

export function loadPagesConfig(configPath) {
  if (!fs.existsSync(configPath)) return null;
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!Array.isArray(raw.pages)) {
    throw new Error(`chromagic: invalid pages config at ${configPath} — "pages" must be an array`);
  }
  return {
    pages: raw.pages.map((p) => ({
      path: p.path,
      name: p.name || slugify(p.path),
    })),
  };
}
