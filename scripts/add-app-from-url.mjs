import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appFile,
  fetchBytes,
  fetchJson,
  fetchText,
  githubReleases,
  githubRepoUrl,
  parseArgs,
  rawGithubUrl,
  releaseToRegistry,
  repoFromUrl,
  repoInfo,
  slugify,
  stripMarkdown,
  writeJson,
} from "./lib-github-content.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDir = path.join(root, "assets", "screenshots");
const reportDefault = path.join(root, ".tmp", "add-app-report.md");
const outputDefault = path.join(root, ".tmp", "add-app-output.json");

const usage = `Usage:
  node scripts/add-app-from-url.mjs <github-url-or-eung-info-json> [options]

Options:
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

function normalizeGithubBlob(url) {
  const blob = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i.exec(url);
  if (blob) return rawGithubUrl(`${blob[1]}/${blob[2]}`, blob[3], blob[4]);
  return url;
}

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

function eungInfoRawUrl(input) {
  const normalized = normalizeGithubBlob(input);
  if (/^https:\/\/raw\.githubusercontent\.com\/eung3392\/eungsoft\/.+\/download\/RokidGlasses\/.+\/info\.json$/i.test(normalized)) {
    return normalized;
  }
  const parsed = parseGithubInput(input);
  if (parsed?.repo?.toLowerCase() !== "eung3392/eungsoft") return null;
  if (parsed.treeRef && /^download\/RokidGlasses\/[^/]+\/?$/i.test(parsed.treePath || "")) {
    return rawGithubUrl(parsed.repo, parsed.treeRef, `${parsed.treePath.replace(/\/$/, "")}/info.json`);
  }
  return null;
}

function langValue(value, lang = "en") {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => langValue(item, lang)).filter(Boolean).join("\n");
  if (typeof value === "object") return value[lang] || value.en || Object.values(value).map((item) => langValue(item, lang)).find(Boolean) || "";
  return String(value);
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&rarr;/gi, "->")
    .replace(/&mdash;|&ndash;/gi, "-");
}

function htmlToMarkdown(html) {
  return decodeHtml(String(html || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/<a\b[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => `[${stripHtml(label).trim() || href}](${href})`)
    .replace(/<\s*h[1-6][^>]*>([\s\S]*?)<\s*\/\s*h[1-6]\s*>/gi, (_, title) => `\n\n### ${stripHtml(title).trim()}\n\n`)
    .replace(/<\s*\/\s*p\s*>/gi, "\n\n")
    .replace(/<\s*p\b[^>]*>/gi, "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*li\s*>/gi, "\n")
    .replace(/<\s*li\b[^>]*>/gi, "- ")
    .replace(/<\s*\/?\s*(ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<\s*(b|strong)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, "**$2**")
    .replace(/<[^>]+>/g, ""))
    .replace(/^\s*[\u2022\u25e6]\s*/gm, "- ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripHtml(html) {
  return decodeHtml(String(html || "").replace(/<[^>]+>/g, ""));
}

function plainText(value) {
  return stripMarkdown(htmlToMarkdown(value)).trim();
}

function firstSentence(text, fallback = "") {
  const cleaned = String(text || "").trim();
  if (!cleaned) return fallback;
  const match = /^(.{20,180}?[.!?])\s/.exec(`${cleaned} `);
  return (match?.[1] || cleaned).slice(0, 180).trim();
}

function titleFromRepoName(name) {
  return String(name || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function inferCategory(values) {
  const text = values.join(" ").toLowerCase();
  const rules = [
    ["AI", ["ai", "assistant", "llm", "gpt", "chatbot"]],
    ["Accessibility", ["accessibility", "subtitle", "voice recognition", "stt", "hearing"]],
    ["Browser", ["browser", "web"]],
    ["Camera", ["camera", "photo", "live cam", "dcim"]],
    ["Launcher", ["launcher", "home"]],
    ["Media", ["player", "video", "media", "music", "stream"]],
    ["Reader", ["reader", "ebook", "epub", "txt", "book"]],
    ["Translation", ["translation", "translate", "transcribe"]],
    ["Games", ["game", "archery", "scouter"]],
    ["Navigation", ["map", "gmaps", "navigation", "gps"]],
    ["Developer", ["terminal", "ssh", "shell", "developer"]],
  ];
  return rules.find(([, needles]) => needles.some((needle) => text.includes(needle)))?.[0] || "Utility";
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

function versionFromAsset(name) {
  const match = String(name || "").match(/(?:^|[_\-.])v?(\d+(?:\.\d+){0,4}(?:[-+][0-9A-Za-z.-]+)?)(?=[_\-.]|$)/i);
  return match?.[1] || null;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function versionMatchRegex(assetName, version) {
  const escaped = escapeRegex(assetName);
  const normalized = String(version || "").replace(/^v/i, "");
  if (!normalized) return `^${escaped}$`;

  const normalizedVariants = new Set([normalized]);
  const parts = normalized.split(".");
  while (parts.length > 1 && parts.at(-1) === "0") {
    parts.pop();
    normalizedVariants.add(parts.join("."));
  }

  const variants = [...normalizedVariants, ...[...normalizedVariants].map((value) => `v${value}`)]
    .filter(Boolean)
    .map(escapeRegex)
    .sort((a, b) => b.length - a.length);
  const versionPattern = "v?(?<version>\\d+(?:[._-]\\d+){0,4}(?:[-+][0-9A-Za-z.-]+)?)";
  for (const variant of variants) {
    if (escaped.includes(variant)) return `^${escaped.replace(variant, versionPattern)}$`;
  }

  const versionToken = String(assetName).match(/v\d+(?:[._-]\d+){0,4}(?:[-+][0-9A-Za-z.-]+)?|\d+(?:[._-]\d+){1,4}(?:[-+][0-9A-Za-z.-]+)?/i)?.[0];
  if (versionToken) {
    return `^${escaped.replace(escapeRegex(versionToken), versionPattern)}$`;
  }

  return `^${escaped}$`;
}

function inferTarget(assetName, fallback) {
  const name = String(assetName || "").toLowerCase();
  if (/core|phone|mobile|cxrm|cxr-m|client-m/.test(name)) return "phone";
  if (/hud|glasses|glass|cxrs|cxr-s|client-s/.test(name)) return "glasses";
  return fallback || "glasses";
}

function appTypeFromTargets(targets, override) {
  if (override) return override;
  const unique = new Set(targets);
  if (unique.has("phone") && unique.has("glasses")) return "combo";
  return unique.has("phone") ? "phone" : "glasses";
}

function isRejectedScreenshot(name) {
  return /logo|icon|badge|banner|social|splash|background|avatar|cover|hero/i.test(name);
}

function screenshotExt(name) {
  const ext = path.extname(name).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp"].includes(ext) ? ext : null;
}

function screenshotName(id, index, sourceName) {
  const ext = screenshotExt(sourceName) || ".png";
  return index === 0 ? `${id}${ext}` : `${id}-${index + 1}${ext}`;
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

function rawSiblingUrl(rawInfoUrl, fileName) {
  return new URL(fileName, rawInfoUrl).toString();
}

function sourceFolderUrl(rawInfoUrl) {
  const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)\/info\.json$/i.exec(rawInfoUrl);
  if (!raw) return githubRepoUrl("eung3392/eungsoft");
  return `https://github.com/${raw[1]}/${raw[2]}/tree/${raw[3]}/${raw[4]}`;
}

function firstApkUrl(value) {
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    if (typeof item === "string" && /\.apk(?:$|[?#])/i.test(item)) return item;
    if (item && typeof item === "object") {
      const found = Object.values(item).find((entry) => typeof entry === "string" && /\.apk(?:$|[?#])/i.test(entry));
      if (found) return found;
    }
  }
  return null;
}

async function importEung(rawInfoUrl, args, report) {
  const raw = await fetchText(rawInfoUrl, rawInfoUrl);
  const info = JSON.parse(raw);
  const name = args.name || langValue(info.title || info.name) || "EUNG SOFT App";
  const id = args.id || slugify(name);
  const descriptionMarkdown = htmlToMarkdown(langValue(info.description));
  const control = htmlToMarkdown(langValue(info.control));
  const summary = args.summary || langValue(info.shortDescription) || firstSentence(plainText(descriptionMarkdown), name);
  const releaseNote = langValue(Array.isArray(info.updated) ? info.updated[0] : info.updated);
  const apkUrl = firstApkUrl(info.download || info.downloads || info.apk || info.apks);
  if (!apkUrl) throw new Error("EUNG info.json does not expose an APK download URL");
  const artifactUrl = /^https?:\/\//i.test(apkUrl) ? apkUrl : rawSiblingUrl(rawInfoUrl, apkUrl);
  const assetName = path.basename(new URL(artifactUrl).pathname);
  const version = String(info.version || versionFromAsset(assetName) || "0.0.0").replace(/^v/i, "");
  const target = args.target || inferTarget(assetName, "glasses");
  const type = appTypeFromTargets([target], args.type);
  const listingBlocks = [
    descriptionMarkdown,
    control ? `### Controls\n\n${control}` : "",
  ].filter(Boolean);
  const app = {
    id,
    name,
    category: args.category || inferCategory([name, summary, descriptionMarkdown]),
    type,
    version,
    summary: String(summary).trim().slice(0, 180),
    description: firstSentence(plainText(descriptionMarkdown), summary).slice(0, 700),
    author: "EUNG SOFT",
    sourceUrl: sourceFolderUrl(rawInfoUrl),
    phoneRequired: args.phoneRequired ? args.phoneRequired === "true" : type === "combo",
    artifacts: [{ target, url: artifactUrl }],
    listing: listingBlocks.length ? { descriptionMarkdown: listingBlocks.join("\n\n") } : undefined,
    releases: releaseNote ? [{
      version,
      date: info.releaseDate || null,
      sourceReleaseUrl: sourceFolderUrl(rawInfoUrl),
      notes: htmlToMarkdown(releaseNote),
      changes: [],
    }] : [],
    update: {
      source: "githubReleaseAssets",
      repo: "eung3392/eungsoft",
      release: "RokidGlassesApp",
      assets: [{ target, match: versionMatchRegex(assetName, version) }],
    },
  };

  if (!args.noScreenshots && !args.dryRun) {
    const images = Array.isArray(info.images) ? info.images : [];
    const max = Number.parseInt(args.maxScreenshots || "4", 10);
    const imported = [];
    fs.mkdirSync(screenshotDir, { recursive: true });
    for (const image of images.slice(0, max)) {
      const imageName = typeof image === "string" ? image : image?.url || image?.src || image?.name;
      if (!imageName || !screenshotExt(imageName) || isRejectedScreenshot(imageName)) continue;
      const imageUrl = /^https?:\/\//i.test(imageName) ? imageName : rawSiblingUrl(rawInfoUrl, imageName);
      const targetName = screenshotName(id, imported.length, imageName);
      fs.writeFileSync(path.join(screenshotDir, targetName), await fetchBytes(imageUrl, imageName));
      imported.push(targetName);
      report.push(`Imported EUNG screenshot \`${targetName}\`.`);
    }
    if (imported.length > 0) app.screenshotAssets = imported;
  }

  report.push(`Detected EUNG info.json flow for \`${name}\`.`);
  return { app, repo: "eung3392/eungsoft" };
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

  const repoName = repo.split("/")[1];
  const name = args.name || titleFromRepoName(info.name || repoName);
  const id = args.id || slugify(name || repoName);
  const artifacts = apkAssets.map((asset) => ({
    target: args.target || inferTarget(asset.name),
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
  const type = appTypeFromTargets(dedupedArtifacts.map((artifact) => artifact.target), args.type);
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
  return { app, repo };
}

function writeReport(file, { app, repo, report }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    `# Add ${app.name} to RokidBrew Registry`,
    "",
    `- App id: \`${app.id}\``,
    `- Repo: \`${repo}\``,
    `- Type: \`${app.type}\``,
    `- Category: \`${app.category}\``,
    `- Artifacts: ${(app.artifacts || []).map((artifact) => `\`${artifact.target}\``).join(", ")}`,
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
  const input = args._[0];
  if (!input) throw new Error(usage);
  const report = [];
  const eungUrl = eungInfoRawUrl(input);
  const result = eungUrl
    ? await importEung(eungUrl, args, report)
    : await importGeneric(input, args, report);

  const file = appFile(root, result.app.id);
  if (!args.dryRun && fs.existsSync(file)) {
    throw new Error(`${path.relative(root, file)} already exists; use the update workflows or choose a new id.`);
  }
  if (!args.dryRun) writeJson(file, result.app);

  const reportFile = args.report || reportDefault;
  const outputFile = args.output || outputDefault;
  writeReport(reportFile, { app: result.app, repo: result.repo, report });
  writeJson(outputFile, {
    id: result.app.id,
    repo: result.repo,
    appFile: path.relative(root, file).replace(/\\/g, "/"),
    reportFile: path.relative(root, reportFile).replace(/\\/g, "/"),
  });

  if (args.dryRun) {
    console.log(JSON.stringify(result.app, null, 2));
    return;
  }
  console.log(`Wrote apps/${result.app.id}.json`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
