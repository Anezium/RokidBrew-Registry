import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactsFor,
  fetchBytes,
  fetchJson,
  githubReleases,
  githubRepoUrl,
  normalizeRegistryKind,
  parseArgs,
  registryFile,
  releasesForRegistryKind,
  releaseToRegistry,
  repoFromUrl,
  repoInfo,
  slugify,
  writeJson,
} from "./lib-github-content.mjs";
import {
  appTypeFromTargets,
  buildEungApp,
  eungInfoRawUrl,
  escapeRegex,
  inferCategory,
  inferTarget,
  isRejectedScreenshot,
  screenshotExt,
  screenshotName,
  versionFromAsset,
  versionMatchRegex,
} from "./lib-eung-import.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDir = path.join(root, "assets", "screenshots");
const reportDefault = path.join(root, ".tmp", "add-app-report.md");
const outputDefault = path.join(root, ".tmp", "add-app-output.json");

const usage = `Usage:
  node scripts/add-app-from-url.mjs <github-url-or-eung-info-json> [options]

Options:
  --kind <app|nexus-plugin>  Registry kind, default app.
  --id <id>                 Override app id.
  --name <name>             Override display name.
  --category <category>     Override category, default inferred or Utility.
  --type <glasses|phone|combo>
  --target <glasses|phone>  Target for a single APK when inference is ambiguous.
  --phone-required <bool>   Override phoneRequired.
  --asset-match <regex>     Only import APK assets matching this regex.
  --release <tag|latest>    Release selector, default from URL or latest.
  --readme-path <path>      README path used later by the AI listing workflow.
  --readme-ref <ref>        README branch/tag/SHA used later by the AI listing workflow.
  --plugin-id <id>          Nexus manifest plugin ID (required for nexus-plugin).
  --package-name <name>     Optional package name; APK metadata extraction verifies/fills it.
  --settings-activity <cls> Nexus settings activity (required for nexus-plugin).
  --api-version <n>         Nexus API version, default 3.
  --capabilities <csv>      Nexus capabilities, default surfaces.
  --launchable <bool>       Nexus launchable flag, default true.
  --min-host-version-code <n>  Minimum Nexus host version code, default 6.
  --release-limit <n>       Number of GitHub releases to copy into releases[], default 5.
  --max-screenshots <n>     Best-effort screenshot import limit, default 4.
  --no-screenshots          Do not import screenshots.
  --report <path>           Markdown report path.
  --output <path>           JSON output summary path.
  --dry-run                 Print generated JSON without writing files.
`;

const screenshotRoots = [
  "screenshots",
  "docs/screenshots",
  "docs/images",
  "assets/screenshots",
  "images",
];

function parseGithubInput(input) {
  const url = new URL(input);
  if (url.hostname !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const repo = `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`;
  const tagIndex = parts.findIndex((part, index) => part === "tag" && parts[index - 1] === "releases");
  const downloadIndex = parts.findIndex((part, index) => part === "download" && parts[index - 1] === "releases");
  const treeIndex = parts.findIndex((part) => part === "tree");
  return {
    repo,
    release: tagIndex >= 0 ? decodeURIComponent(parts[tagIndex + 1] || "") : null,
    downloadTag: downloadIndex >= 0 ? decodeURIComponent(parts[downloadIndex + 1] || "") : null,
    downloadAsset: downloadIndex >= 0 ? decodeURIComponent(parts.slice(downloadIndex + 2).join("/")) : null,
    treeRef: treeIndex >= 0 ? decodeURIComponent(parts[treeIndex + 1] || "") : null,
    treePath: treeIndex >= 0 ? decodeURIComponent(parts.slice(treeIndex + 2).join("/")) : null,
  };
}

function titleFromRepoName(name) {
  return String(name || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function versionFromTag(tag) {
  return String(tag || "").replace(/^v/i, "") || "0.0.0";
}

function isVersionLikeTag(tag) {
  return /^v?\d+(?:[._-]\d+)*/i.test(tag || "");
}

function isPrereleaseLikeTag(tag) {
  return /(?:alpha|beta|rc|dev|preview)/i.test(tag || "");
}

function updateReleaseSelector(tag, requestedSelector) {
  if (requestedSelector === "latest") return "latest";
  return isVersionLikeTag(tag) && !isPrereleaseLikeTag(tag) ? "latest" : tag;
}

async function discoverRepoScreenshots({ repo, ref, id, maxScreenshots, report }) {
  if (maxScreenshots <= 0) return [];
  const imported = [];
  fs.mkdirSync(screenshotDir, { recursive: true });

  for (const rootPath of screenshotRoots) {
    if (imported.length >= maxScreenshots) break;
    let entries = [];
    try {
      entries = await fetchJson(`https://api.github.com/repos/${repo}/contents/${rootPath}?ref=${encodeURIComponent(ref)}`, `${repo}/${rootPath}`);
    } catch {
      continue;
    }
    if (!Array.isArray(entries)) continue;
    const images = entries
      .filter((entry) => entry.type === "file" && screenshotExt(entry.name) && !isRejectedScreenshot(entry.name))
      .slice(0, maxScreenshots - imported.length);
    for (const entry of images) {
      try {
        const targetName = screenshotName(id, imported.length, entry.name);
        const target = path.join(screenshotDir, targetName);
        fs.writeFileSync(target, await fetchBytes(entry.download_url, entry.path));
        imported.push(targetName);
        report.push(`Imported screenshot \`${targetName}\` from \`${entry.path}\`.`);
      } catch (error) {
        report.push(`Skipped screenshot \`${entry.path}\`: ${error.message}`);
      }
    }
  }
  if (imported.length === 0) report.push("No screenshots imported; discovery is best-effort and non-blocking.");
  return imported;
}

async function selectedRelease(repo, selector) {
  if (selector && selector !== "latest") {
    return fetchJson(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(selector)}`, `${repo}@${selector}`);
  }
  return fetchJson(`https://api.github.com/repos/${repo}/releases/latest`, `${repo}@latest`);
}

async function importGeneric(input, args, report) {
  const parsed = parseGithubInput(input);
  const repo = args.repo || parsed?.repo || repoFromUrl(input);
  if (!repo) throw new Error("Expected a GitHub repository, release, or EUNG info.json URL");
  const info = await repoInfo(repo);
  const releaseSelector = args.release || parsed?.release || parsed?.downloadTag || "latest";
  const release = await selectedRelease(repo, releaseSelector);
  const assetRegex = args.assetMatch
    ? new RegExp(args.assetMatch, "i")
    : parsed?.downloadAsset
      ? new RegExp(`^${escapeRegex(parsed.downloadAsset)}$`, "i")
      : /\.apk$/i;
  const apkAssets = (release.assets || []).filter((asset) => assetRegex.test(asset.name || ""));
  if (apkAssets.length === 0) throw new Error(`No APK assets matched in ${repo}@${release.tag_name}`);
  if (args.kind === "nexus-plugin" && apkAssets.length !== 1) {
    throw new Error(`Nexus plugins require exactly one phone APK; ${apkAssets.length} assets matched. Narrow the release with --asset-match.`);
  }

  const repoName = repo.split("/")[1];
  const name = args.name || titleFromRepoName(info.name || repoName);
  const id = args.id || slugify(name || repoName);
  const artifacts = apkAssets.map((asset) => ({
    target: args.kind === "nexus-plugin" ? "phone" : args.target || inferTarget(asset.name),
    url: asset.browser_download_url,
  }));
  const dedupedArtifacts = [];
  const seenTargets = new Set();
  for (const artifact of artifacts) {
    if (seenTargets.has(artifact.target)) {
      report.push(`Multiple APKs inferred as \`${artifact.target}\`; keeping \`${path.basename(new URL(artifact.url).pathname)}\` and marking PR for review.`);
      continue;
    }
    seenTargets.add(artifact.target);
    dedupedArtifacts.push(artifact);
  }
  const type = args.kind === "nexus-plugin"
    ? "phone"
    : appTypeFromTargets(dedupedArtifacts.map((artifact) => artifact.target), args.type);
  const version = versionFromTag(release.tag_name) || versionFromAsset(apkAssets[0].name) || "0.0.0";
  const summary = info.description || `${name} for Rokid AR glasses`;
  const readmePath = args.readmePath || "README.md";
  const app = {
    id,
    name,
    category: args.category || inferCategory([name, summary, repoName]),
    type,
    version,
    summary: summary.slice(0, 180),
    description: summary.slice(0, 700),
    author: repo.split("/")[0],
    sourceUrl: githubRepoUrl(repo),
    phoneRequired: args.phoneRequired ? args.phoneRequired === "true" : type === "combo",
    artifacts: dedupedArtifacts,
    releases: (await githubReleases(repo, args.releaseLimit || 5)).map(releaseToRegistry),
    listingSource: {
      type: "githubReadme",
      repo,
      ...(args.readmeRef ? { branch: args.readmeRef } : {}),
      path: readmePath,
    },
    update: {
      source: "githubReleaseAssets",
      repo,
      release: updateReleaseSelector(release.tag_name, releaseSelector),
      assets: dedupedArtifacts.map((artifact) => {
        const asset = apkAssets.find((candidate) => candidate.browser_download_url === artifact.url);
        return {
          target: artifact.target,
          match: versionMatchRegex(asset?.name || path.basename(new URL(artifact.url).pathname), version),
        };
      }),
    },
  };

  if (!args.noScreenshots && !args.dryRun) {
    const maxScreenshots = Number.parseInt(args.maxScreenshots || "4", 10);
    const screenshots = await discoverRepoScreenshots({
      repo,
      ref: args.readmeRef || info.default_branch || "main",
      id,
      maxScreenshots,
      report,
    });
    if (screenshots.length > 0) app.screenshotAssets = screenshots;
  }

  report.push(`Detected generic GitHub Releases flow for \`${repo}\`.`);
  report.push(`Imported ${dedupedArtifacts.length} APK artifact(s) from release \`${release.tag_name}\`.`);
  return { app, repo, release };
}

function nexusPluginFromApp(app, release, args) {
  const artifact = app.artifacts[0];
  const capabilities = String(args.capabilities || "surfaces")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    id: app.id,
    kind: "nexus-plugin",
    name: app.name,
    category: app.category,
    summary: app.summary,
    description: app.description,
    author: app.author,
    sourceUrl: app.sourceUrl,
    publishedAt: release.published_at || release.created_at,
    iconAsset: `${app.id}.png`,
    screenshotAssets: app.screenshotAssets || [],
    listing: {
      descriptionMarkdown: app.listing?.descriptionMarkdown || app.description,
    },
    releases: releasesForRegistryKind(app.releases, "nexus-plugin"),
    nexus: {
      pluginId: args.pluginId,
      apiVersion: Number.parseInt(args.apiVersion || "3", 10),
      capabilities,
      launchable: args.launchable == null ? true : args.launchable === "true",
      settingsActivity: args.settingsActivity,
      minHostVersionCode: Number.parseInt(args.minHostVersionCode || "6", 10),
    },
    artifact: {
      ...artifact,
      ...(args.packageName ? { packageName: args.packageName } : {}),
    },
  };
}

function writeReport(file, { entry, kind, repo, report }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    `# Add ${entry.name} to RokidBrew Registry`,
    "",
    `- Kind: \`${kind}\``,
    `- Entry id: \`${entry.id}\``,
    `- Repo: \`${repo}\``,
    `- Category: \`${entry.category}\``,
    `- Artifacts: ${artifactsFor(entry).map((artifact) => `\`${artifact.target}\``).join(", ")}`,
    "",
    "## Notes",
    "",
    ...report.map((line) => `- ${line}`),
    "",
    "## Review checklist",
    "",
    "- Confirm target inference is correct (`phone` vs `glasses`).",
    "- Confirm screenshots, if any, are actual app UI and not logos/banners.",
    "- Confirm generated description is accurate before merge.",
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), usage);
  const kind = normalizeRegistryKind(args.kind);
  args.kind = kind;
  const input = args._[0];
  if (!input) throw new Error(usage);
  if (kind === "nexus-plugin" && (!args.pluginId || !args.settingsActivity)) {
    throw new Error("Nexus plugin ingestion requires --plugin-id and --settings-activity values copied from the APK manifest");
  }
  const report = [];
  const eungUrl = eungInfoRawUrl(input);
  if (kind === "nexus-plugin" && eungUrl) {
    throw new Error("Nexus plugin ingestion requires a GitHub repository or release URL, not EUNG info.json");
  }
  const result = eungUrl
    ? await buildEungApp({ root, source: eungUrl, args, report, defaultMaxScreenshots: 4 })
    : await importGeneric(input, args, report);
  const entry = kind === "nexus-plugin"
    ? nexusPluginFromApp(result.app, result.release, args)
    : result.app;

  const file = registryFile(root, entry.id, kind);
  if (!args.dryRun && fs.existsSync(file)) {
    throw new Error(`${path.relative(root, file)} already exists; use the update workflows or choose a new id.`);
  }
  if (!args.dryRun) writeJson(file, entry);

  const reportFile = args.report || reportDefault;
  const outputFile = args.output || outputDefault;
  writeReport(reportFile, { entry, kind, repo: result.repo, report });
  writeJson(outputFile, {
    id: entry.id,
    kind,
    repo: result.repo,
    appFile: path.relative(root, file).replace(/\\/g, "/"),
    entryFile: path.relative(root, file).replace(/\\/g, "/"),
    reportFile: path.relative(root, reportFile).replace(/\\/g, "/"),
  });

  if (args.dryRun) {
    console.log(JSON.stringify(entry, null, 2));
    return;
  }
  console.log(`Wrote ${path.relative(root, file).replace(/\\/g, "/")}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
