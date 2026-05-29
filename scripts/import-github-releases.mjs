import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appFile,
  githubReleases,
  inferRepo,
  parseArgs,
  pickStoreFields,
  readJson,
  releaseToRegistry,
  writeJson,
} from "./lib-github-content.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const usage = `Usage:
  node scripts/import-github-releases.mjs <app-id> [options]

Options:
  --repo <owner/repo>     Override GitHub repository.
  --limit <n>            Number of releases to import, default 5.
  --dry-run              Print generated releases without writing.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2), usage);
  const appId = args._[0];
  if (!appId) throw new Error(usage);

  const file = appFile(root, appId);
  const app = readJson(file);
  const repo = args.repo || inferRepo(app);
  if (!repo) throw new Error(`${appId}: cannot infer GitHub repo; pass --repo owner/repo`);

  const releases = (await githubReleases(repo, args.limit || 5))
    .map(releaseToRegistry)
    .filter((release) => release.version || release.notes || release.changes.length > 0);

  if (args.dryRun) {
    console.log(JSON.stringify({ id: appId, repo, releases }, null, 2));
    return;
  }

  writeJson(file, pickStoreFields(app, { releases }));
  console.log(`Imported ${releases.length} releases for ${appId} from ${repo}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
