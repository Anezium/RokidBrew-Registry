import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const registryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceFile = process.argv[2];

if (!sourceFile) {
  console.error("Usage: node scripts/import-from-store.mjs <path-to-apps.json>");
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
const apps = raw.apps || [];
const appsDir = path.join(registryRoot, "apps");

fs.mkdirSync(appsDir, { recursive: true });

for (const app of apps) {
  const out = { ...app };
  if (out.screenshotAsset && !out.screenshotAssets) {
    out.screenshotAssets = [out.screenshotAsset];
  }
  delete out.screenshotAsset;
  delete out.iconUrl;
  delete out.iconAsset;
  delete out.screenshotUrls;

  const file = path.join(appsDir, `${out.id}.json`);
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
}

console.log(`Imported ${apps.length} apps into apps/`);
