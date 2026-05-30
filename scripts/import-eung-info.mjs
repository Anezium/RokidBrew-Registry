import path from "node:path";
import { fileURLToPath } from "node:url";
import { appFile, parseArgs, writeJson } from "./lib-github-content.mjs";
import {
  buildEungApp,
  eungDownloadUrls,
  findExistingEungApp,
  langValue,
  readEungInfo,
} from "./lib-eung-import.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const usage = `Usage:
  node scripts/import-eung-info.mjs <info-json-url-or-path> [options]

Options:
  --id <id>                 Override app id.
  --name <text>             Override app display name.
  --category <category>     Override category.
  --summary <text>          Override summary.
  --description <text>      Override plain description.
  --type <glasses|phone|combo>
  --target <glasses|phone>  Target for new single-target entries.
  --phone-required <bool>   Override phoneRequired.
  --preserve-artifacts      Keep existing artifacts and update rules.
  --max-screenshots <n>     Limit imported screenshots.
  --no-screenshots          Keep existing screenshots and do not import images.
  --dry-run                 Print generated JSON without writing files.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2), usage);
  const source = args._[0];
  if (!source) throw new Error(usage);

  const loaded = await readEungInfo(source);
  const title = args.name || langValue(loaded.info.title || loaded.info.name) || "EUNG App";
  const downloads = eungDownloadUrls(loaded.info, loaded.source);
  if (downloads.length === 0) throw new Error("EUNG info.json has no download URLs");

  const existingEntry = findExistingEungApp(root, {
    id: args.id || null,
    downloads,
    name: title,
  });
  const result = await buildEungApp({
    root,
    loaded,
    args,
    existing: existingEntry?.app || null,
    defaultMaxScreenshots: null,
  });
  const targetFile = existingEntry?.file || appFile(root, result.app.id);

  if (args.dryRun) {
    console.log(JSON.stringify(result.app, null, 2));
    return;
  }

  writeJson(targetFile, result.app);
  console.log(`Imported ${result.app.name} into ${path.relative(root, targetFile)}`);
  if (result.app.screenshotAssets?.length > 0) {
    console.log(`Screenshots: ${result.app.screenshotAssets.join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
