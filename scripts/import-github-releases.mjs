import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  githubReleases,
  inferRepo,
  normalizeRegistryKind,
  parseArgs,
  pickStoreFields,
  readJson,
  registryFile,
  releasesForRegistryKind,
  releaseToRegistry,
  writeJson,
} from "./lib-github-content.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const usage = `Usage:
  node scripts/import-github-releases.mjs <entry-id> [options]

Options:
  --kind <app|nexus-plugin>  Registry kind, default app.
  --repo <owner/repo>     Override GitHub repository.
  --limit <n>            Number of releases to import, default 5.
  --dry-run              Print generated releases without writing.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2), usage);
  const kind = normalizeRegistryKind(args.kind);
  const appId = args._[0];
  if (!appId) throw new Error(usage);

  const file = registryFile(root, appId, kind);
  const app = readJson(file);
  const repo = args.repo || inferRepo(app);
  if (!repo) throw new Error(`${appId}: cannot infer GitHub repo; pass --repo owner/repo`);

  const importedReleases = (await githubReleases(repo, args.limit || 5))
    .map(releaseToRegistry)
    .filter((release) => release.version || release.notes || release.changes.length > 0);
  const releases = releasesForRegistryKind(importedReleases, kind);

  if (args.dryRun) {
    console.log(JSON.stringify({ id: appId, repo, releases }, null, 2));
    return;
  }

  const updated = pickStoreFields(app, { releases });
  if (kind === "nexus-plugin") updated.releases = releases;
  writeJson(file, updated);
  console.log(`Imported ${releases.length} releases for ${appId} from ${repo}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
