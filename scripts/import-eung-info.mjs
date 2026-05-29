import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appsDir = path.join(root, "apps");
const screenshotDir = path.join(root, "assets", "screenshots");

const usage = `Usage:
  node scripts/import-eung-info.mjs <info-json-url-or-path> [options]

Options:
  --id <id>                 Override app id.
  --category <category>     Override category.
  --summary <text>          Override summary.
  --description <text>      Override plain description.
  --type <glasses|phone|combo>
  --target <glasses|phone>  Target for new single-target entries.
  --phone-required <bool>   Override phoneRequired.
  --max-screenshots <n>     Limit imported screenshots.
  --no-screenshots          Keep existing screenshots and do not import images.
  --dry-run                 Print generated JSON without writing files.
`;

function parseArgs(argv) {
  const args = { source: null };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--") && !args.source) {
      args.source = value;
      continue;
    }
    if (value === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (value === "--no-screenshots") {
      args.noScreenshots = true;
      continue;
    }
    const key = value.replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for ${value}`);
    args[key] = next;
    i += 1;
  }
  if (!args.source) throw new Error(usage);
  return args;
}

function normalizeSource(source) {
  const githubBlob = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i.exec(source);
  if (githubBlob) {
    return `https://raw.githubusercontent.com/${githubBlob[1]}/${githubBlob[2]}/${githubBlob[3]}/${githubBlob[4]}`;
  }
  return source;
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { Accept: "application/json,text/plain,*/*" } });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

async function readSource(source) {
  const normalized = normalizeSource(source);
  if (/^https?:\/\//i.test(normalized)) {
    return {
      source: normalized,
      raw: await fetchText(normalized),
      remote: true,
    };
  }
  return {
    source: path.resolve(normalized),
    raw: fs.readFileSync(normalized, "utf8"),
    remote: false,
  };
}

function langValue(value, lang = "en") {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return value[lang] || value.en || Object.values(value).find(Boolean) || "";
  return String(value);
}

function decodeHtml(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&rarr;/gi, "->")
    .replace(/&mdash;/gi, "-")
    .replace(/&ndash;/gi, "-");
}

function htmlToMarkdown(html) {
  if (!html) return "";
  let text = String(html);
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(/<a\b[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
    return `[${stripHtml(label).trim() || href}](${href})`;
  });
  text = text.replace(/<\s*h[1-6][^>]*>([\s\S]*?)<\s*\/\s*h[1-6]\s*>/gi, (_, title) => {
    return `\n\n### ${stripHtml(title).trim()}\n\n`;
  });
  text = text.replace(/<\s*\/\s*p\s*>/gi, "\n\n");
  text = text.replace(/<\s*p\b[^>]*>/gi, "");
  text = text.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  text = text.replace(/<\s*\/\s*li\s*>/gi, "\n");
  text = text.replace(/<\s*li\b[^>]*>/gi, "- ");
  text = text.replace(/<\s*\/?\s*ul\b[^>]*>/gi, "\n");
  text = text.replace(/<\s*\/?\s*ol\b[^>]*>/gi, "\n");
  text = text.replace(/<\s*b\b[^>]*>([\s\S]*?)<\s*\/\s*b\s*>/gi, "**$1**");
  text = text.replace(/<\s*strong\b[^>]*>([\s\S]*?)<\s*\/\s*strong\s*>/gi, "**$1**");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeHtml(text);
  text = text.replace(/^\s*[\u2022\u25e6]\s*/gm, "- ");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function stripHtml(html) {
  return decodeHtml(String(html || "").replace(/<[^>]+>/g, ""));
}

function plainText(html) {
  return htmlToMarkdown(html)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(text, fallback = "") {
  const cleaned = String(text || "").trim();
  if (!cleaned) return fallback;
  const match = /^(.{20,180}?[.!?])\s/.exec(`${cleaned} `);
  return (match?.[1] || cleaned).slice(0, 180).trim();
}

function slugifyName(name) {
  return String(name || "eung-app")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function readJsonIfExists(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function allExistingApps() {
  if (!fs.existsSync(appsDir)) return [];
  return fs.readdirSync(appsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const file = path.join(appsDir, name);
      return { file, app: readJsonIfExists(file) };
    })
    .filter((entry) => entry.app);
}

function findExistingApp(id, downloads, name) {
  const requestedFile = id ? path.join(appsDir, `${id}.json`) : null;
  if (requestedFile && fs.existsSync(requestedFile)) return { file: requestedFile, app: readJsonIfExists(requestedFile) };
  const downloadSet = new Set(downloads);
  const normalizedName = String(name || "").toLowerCase();
  return allExistingApps().find(({ app }) => {
    if (app.id === id) return true;
    if (String(app.name || "").toLowerCase() === normalizedName) return true;
    return (app.artifacts || []).some((artifact) => downloadSet.has(artifact.url));
  }) || null;
}

function inferCategory(tags, name, description) {
  const values = [...(Array.isArray(tags) ? tags : []), name, description].join(" ").toLowerCase();
  const rules = [
    ["Accessibility", ["accessibility", "subtitle", "voice recognition", "stt", "hearing"]],
    ["Browser", ["browser", "web"]],
    ["Camera", ["camera", "photo", "live cam", "dcim"]],
    ["Launcher", ["launcher", "home"]],
    ["Utility", ["utility", "tool", "timer", "remover", "meta"]],
    ["Media", ["player", "video", "media"]],
    ["Reader", ["reader", "ebook", "e-book", "epub", "txt"]],
    ["Translation", ["translation", "translate"]],
    ["Games", ["game", "archery", "pilot"]],
  ];
  return rules.find(([, needles]) => needles.some((needle) => values.includes(needle)))?.[0] || "Utility";
}

function githubReleaseInfo(url) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^?#]+)(?:[?#].*)?$/i.exec(url);
  if (!match) return null;
  return {
    repo: `${match[1]}/${match[2]}`,
    tag: decodeURIComponent(match[3]),
    assetName: decodeURIComponent(match[4]),
    releaseUrl: `https://github.com/${match[1]}/${match[2]}/releases/tag/${decodeURIComponent(match[3])}`,
  };
}

function versionRegexFromAsset(assetName, version) {
  const escaped = assetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!version) return `^${escaped}$`;
  const versionPattern = String(version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const replaced = escaped.replace(versionPattern, "(?<version>\\d+(?:\\.\\d+)*)");
  return `^${replaced}$`;
}

function sourceFolderUrl(source) {
  const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)\/info\.json$/i.exec(source);
  if (raw) return `https://github.com/${raw[1]}/${raw[2]}/tree/${raw[3]}/${raw[4]}`;
  return "https://github.com/eung3392/eungsoft";
}

function imageUrl(source, imageName) {
  if (/^https?:\/\//i.test(source)) return new URL(imageName, source).toString();
  return path.resolve(path.dirname(source), imageName);
}

function screenshotName(id, index, imageName) {
  const ext = path.extname(imageName).toLowerCase() || ".jpg";
  return index === 0 ? `${id}${ext}` : `${id}-${index + 1}${ext}`;
}

async function importScreenshots(id, source, images, args, existing) {
  if (args.noScreenshots) return existing?.screenshotAssets || [];
  const max = args.maxScreenshots ? Number.parseInt(args.maxScreenshots, 10) : images.length;
  const selected = images.slice(0, Number.isFinite(max) ? max : images.length);
  fs.mkdirSync(screenshotDir, { recursive: true });
  const assets = [];
  for (const [index, image] of selected.entries()) {
    const fileName = screenshotName(id, index, image);
    const destination = path.join(screenshotDir, fileName);
    const sourceImage = imageUrl(source, image);
    assets.push(fileName);
    if (args.dryRun) continue;
    if (/^https?:\/\//i.test(sourceImage)) {
      fs.writeFileSync(destination, await fetchBytes(sourceImage));
    } else {
      fs.copyFileSync(sourceImage, destination);
    }
  }
  return assets.length > 0 ? assets : existing?.screenshotAssets || [];
}

function preserveArtifactMetadata(existing, artifact) {
  const prior = (existing?.artifacts || []).find((item) => item.target === artifact.target && item.url === artifact.url);
  return prior ? { ...prior, ...artifact } : artifact;
}

function targetList(args, existing) {
  if (args.type === "combo" || existing?.type === "combo") return ["glasses", "phone"];
  return [args.target || existing?.artifacts?.[0]?.target || "glasses"];
}

function buildListing(descriptionHtml, controlHtml) {
  const description = htmlToMarkdown(descriptionHtml);
  const control = htmlToMarkdown(controlHtml);
  if (!control) return description;
  const controlBlock = /^#{1,6}\s/m.test(control) ? control : `### Usage / Controls\n\n${control}`;
  return [description, controlBlock].filter(Boolean).join("\n\n");
}

function buildReleases(info, releaseUrl) {
  const updated = Array.isArray(info.updated) ? info.updated : [];
  const releases = updated
    .map((item) => {
      const notes = plainText(langValue(item.en ? item.en : item));
      return {
        version: item.version || null,
        date: item.releaseDate || null,
        sourceReleaseUrl: releaseUrl,
        ...(notes && { notes }),
        changes: [],
      };
    })
    .filter((release) => release.version || release.date || release.notes);
  if (releases.length > 0) return releases;
  return [{
    version: info.version || null,
    date: info.releaseDate || null,
    sourceReleaseUrl: releaseUrl,
    notes: "Imported from EUNG SOFT app metadata.",
    changes: [],
  }];
}

function boolValue(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

function orderedApp(app) {
  const order = [
    "id", "name", "category", "type", "version", "publishedAt", "summary", "description",
    "listing", "releases", "featured", "featuredRank", "screenshotAssets", "phoneRequired",
    "artifacts", "author", "sourceUrl", "iconAsset", "update",
  ];
  const out = {};
  for (const key of order) {
    if (app[key] !== undefined && app[key] !== null) out[key] = app[key];
  }
  for (const [key, value] of Object.entries(app)) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loaded = await readSource(args.source);
  const info = JSON.parse(loaded.raw);
  const downloads = Array.isArray(info.download) ? info.download.filter(Boolean) : [];
  if (downloads.length === 0) throw new Error("EUNG info.json has no download URLs");

  const title = langValue(info.title) || "EUNG App";
  const requestedId = args.id || null;
  const existingEntry = findExistingApp(requestedId, downloads, title);
  const id = requestedId || existingEntry?.app?.id || slugifyName(title);
  const existing = existingEntry?.app || null;
  const appFile = existingEntry?.file || path.join(appsDir, `${id}.json`);
  const latestDownload = downloads[0];
  const release = githubReleaseInfo(latestDownload);
  const tags = Array.isArray(info.tags?.en) ? info.tags.en : [];
  const descriptionHtml = langValue(info.description);
  const controlHtml = langValue(info.control);
  const descriptionText = plainText(descriptionHtml);
  const type = args.type || existing?.type || "glasses";
  const targets = targetList({ ...args, type }, existing);
  const artifacts = targets.map((target) => preserveArtifactMetadata(existing, {
    target,
    url: latestDownload,
  }));
  const screenshotAssets = await importScreenshots(
    id,
    loaded.source,
    Array.isArray(info.images) ? info.images : [],
    args,
    existing,
  );
  const updateAssets = targets.map((target) => ({
    target,
    match: release ? versionRegexFromAsset(release.assetName, info.version) : undefined,
  })).filter((asset) => asset.match);

  const app = orderedApp({
    ...(existing || {}),
    id,
    name: title,
    category: args.category || existing?.category || inferCategory(tags, title, descriptionText),
    type,
    version: info.version || existing?.version || "1.0.0",
    publishedAt: info.releaseDate || existing?.publishedAt,
    summary: args.summary || langValue(info.shortDescription) || firstSentence(descriptionText, existing?.summary || title),
    description: args.description || descriptionText || existing?.description || langValue(info.shortDescription),
    listing: {
      ...(existing?.listing || {}),
      descriptionMarkdown: buildListing(descriptionHtml, controlHtml),
    },
    releases: buildReleases(info, release?.releaseUrl),
    screenshotAssets,
    phoneRequired: boolValue(args.phoneRequired, existing?.phoneRequired ?? type === "combo"),
    artifacts,
    author: existing?.author || "EUNG SOFT",
    sourceUrl: existing?.sourceUrl || sourceFolderUrl(loaded.source),
    iconAsset: existing?.iconAsset,
    update: release ? {
      source: "githubReleaseAssets",
      repo: release.repo,
      release: release.tag,
      assets: updateAssets,
    } : existing?.update,
  });

  if (args.dryRun) {
    console.log(JSON.stringify(app, null, 2));
    return;
  }

  fs.mkdirSync(appsDir, { recursive: true });
  fs.writeFileSync(appFile, `${JSON.stringify(app, null, 2)}\n`);
  console.log(`Imported ${app.name} into ${path.relative(root, appFile)}`);
  if (screenshotAssets.length > 0) {
    console.log(`Screenshots: ${screenshotAssets.join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
