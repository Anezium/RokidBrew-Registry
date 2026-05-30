import fs from "node:fs";
import path from "node:path";
import {
  fetchBytes,
  fetchText,
  githubRepoUrl,
  rawGithubUrl,
  slugify,
  stripMarkdown,
} from "./lib-github-content.mjs";

export const EUNG_REPO = "eung3392/eungsoft";
export const EUNG_RELEASE_BUCKET = "RokidGlassesApp";

const screenshotExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function parseGithubInput(input) {
  try {
    const url = new URL(input);
    if (url.hostname !== "github.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const repo = `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`;
    const treeIndex = parts.findIndex((part) => part === "tree");
    return {
      repo,
      treeRef: treeIndex >= 0 ? decodeURIComponent(parts[treeIndex + 1] || "") : null,
      treePath: treeIndex >= 0 ? decodeURIComponent(parts.slice(treeIndex + 2).join("/")) : null,
    };
  } catch {
    return null;
  }
}

export function normalizeGithubBlob(input) {
  const blob = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i.exec(input);
  if (blob) return rawGithubUrl(`${blob[1]}/${blob[2]}`, blob[3], blob[4]);
  return input;
}

export function eungInfoRawUrl(input) {
  const normalized = normalizeGithubBlob(input);
  if (/^https:\/\/raw\.githubusercontent\.com\/eung3392\/eungsoft\/.+\/download\/RokidGlasses\/.+\/info\.json$/i.test(normalized)) {
    return normalized;
  }

  const parsed = parseGithubInput(input);
  if (parsed?.repo?.toLowerCase() !== EUNG_REPO) return null;
  if (parsed.treeRef && /^download\/RokidGlasses\/[^/]+\/?$/i.test(parsed.treePath || "")) {
    return rawGithubUrl(parsed.repo, parsed.treeRef, `${parsed.treePath.replace(/\/$/, "")}/info.json`);
  }
  return null;
}

export async function readEungInfo(source) {
  const normalized = normalizeGithubBlob(source);
  if (/^https?:\/\//i.test(normalized)) {
    const raw = await fetchText(normalized, normalized);
    return {
      source: normalized,
      raw,
      info: JSON.parse(raw),
      remote: true,
    };
  }

  const file = path.resolve(normalized);
  const raw = fs.readFileSync(file, "utf8");
  return {
    source: file,
    raw,
    info: JSON.parse(raw),
    remote: false,
  };
}

export function langValue(value, lang = "en") {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => langValue(item, lang)).filter(Boolean).join("\n");
  if (typeof value === "object") {
    return value[lang] ||
      value.en ||
      Object.values(value).map((item) => langValue(item, lang)).find(Boolean) ||
      "";
  }
  return String(value);
}

export function decodeHtml(text) {
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

export function stripHtml(html) {
  return decodeHtml(String(html || "").replace(/<[^>]+>/g, ""));
}

export function htmlToMarkdown(html) {
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

export function plainText(value) {
  return stripMarkdown(htmlToMarkdown(value)).trim();
}

export function firstSentence(text, fallback = "") {
  const cleaned = String(text || "").trim();
  if (!cleaned) return fallback;
  const match = /^(.{20,180}?[.!?])\s/.exec(`${cleaned} `);
  return (match?.[1] || cleaned).slice(0, 180).trim();
}

export function inferCategory(values, name, description) {
  const parts = Array.isArray(values) ? values : [values, name, description];
  const text = parts.filter(Boolean).join(" ").toLowerCase();
  const rules = [
    ["AI", ["ai", "assistant", "llm", "gpt", "chatbot"]],
    ["Accessibility", ["accessibility", "subtitle", "voice recognition", "stt", "hearing"]],
    ["Browser", ["browser", "web"]],
    ["Camera", ["camera", "photo", "live cam", "dcim"]],
    ["Launcher", ["launcher", "home"]],
    ["Media", ["player", "video", "media", "music", "stream"]],
    ["Reader", ["reader", "ebook", "e-book", "epub", "txt", "book"]],
    ["Translation", ["translation", "translate", "transcribe"]],
    ["Games", ["game", "archery", "scouter", "pilot"]],
    ["Navigation", ["map", "gmaps", "navigation", "gps"]],
    ["Developer", ["terminal", "ssh", "shell", "developer"]],
    ["Utility", ["utility", "tool", "timer", "remover", "meta"]],
  ];
  return rules.find(([, needles]) => needles.some((needle) => text.includes(needle)))?.[0] || "Utility";
}

export function versionFromAsset(name) {
  const match = String(name || "").match(/(?:^|[_\-.])v?(\d+(?:\.\d+){0,4}(?:[-+][0-9A-Za-z.-]+)?)(?=[_\-.]|$)/i);
  return match?.[1] || null;
}

export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function versionMatchRegex(assetName, version) {
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

export function inferTarget(assetName, fallback) {
  const name = String(assetName || "").toLowerCase();
  if (/core|phone|mobile|cxrm|cxr-m|client-m/.test(name)) return "phone";
  if (/hud|glasses|glass|cxrs|cxr-s|client-s/.test(name)) return "glasses";
  return fallback || "glasses";
}

export function appTypeFromTargets(targets, override) {
  if (override) return override;
  const unique = new Set(targets);
  if (unique.has("phone") && unique.has("glasses")) return "combo";
  return unique.has("phone") ? "phone" : "glasses";
}

export function isRejectedScreenshot(name) {
  return /logo|icon|badge|banner|social|splash|background|avatar|cover|hero/i.test(name);
}

export function screenshotExt(name) {
  const ext = path.extname(String(name || "")).toLowerCase();
  return screenshotExtensions.has(ext) ? ext : null;
}

export function screenshotName(id, index, sourceName) {
  const ext = screenshotExt(sourceName) || ".png";
  return index === 0 ? `${id}${ext}` : `${id}-${index + 1}${ext}`;
}

export function sourceFolderUrl(source) {
  const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)\/info\.json$/i.exec(source);
  if (!raw) return githubRepoUrl(EUNG_REPO);
  return `https://github.com/${raw[1]}/${raw[2]}/tree/${raw[3]}/${raw[4]}`;
}

function siblingSource(source, fileName) {
  if (/^https?:\/\//i.test(source)) return new URL(fileName, source).toString();
  return path.resolve(path.dirname(source), fileName);
}

function apkUrls(value) {
  const values = Array.isArray(value) ? value : [value];
  const urls = [];
  for (const item of values) {
    if (typeof item === "string" && /\.apk(?:$|[?#])/i.test(item)) urls.push(item);
    if (item && typeof item === "object") {
      for (const entry of Object.values(item)) {
        if (typeof entry === "string" && /\.apk(?:$|[?#])/i.test(entry)) urls.push(entry);
      }
    }
  }
  return urls;
}

export function eungDownloadUrls(info, source) {
  return apkUrls(info.download || info.downloads || info.apk || info.apks)
    .map((url) => /^https?:\/\//i.test(url) ? url : siblingSource(source, url));
}

export function firstApkUrl(info, source) {
  return eungDownloadUrls(info, source)[0] || null;
}

function sourceBasename(value) {
  try {
    return path.basename(new URL(value).pathname);
  } catch {
    return path.basename(value);
  }
}

function readJsonIfExists(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function allExistingApps(root) {
  const appsDir = path.join(root, "apps");
  if (!fs.existsSync(appsDir)) return [];
  return fs.readdirSync(appsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const file = path.join(appsDir, name);
      return { file, app: readJsonIfExists(file) };
    })
    .filter((entry) => entry.app);
}

export function findExistingEungApp(root, { id, downloads, name }) {
  const requestedFile = id ? path.join(root, "apps", `${id}.json`) : null;
  if (requestedFile && fs.existsSync(requestedFile)) return { file: requestedFile, app: readJsonIfExists(requestedFile) };

  const downloadSet = new Set(downloads || []);
  const normalizedName = String(name || "").toLowerCase();
  return allExistingApps(root).find(({ app }) => {
    if (app.id === id) return true;
    if (String(app.name || "").toLowerCase() === normalizedName) return true;
    return (app.artifacts || []).some((artifact) => downloadSet.has(artifact.url));
  }) || null;
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

function boolValue(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

function preserveArtifactMetadata(existing, artifact) {
  const prior = (existing?.artifacts || []).find((item) => item.target === artifact.target && item.url === artifact.url);
  return prior ? { ...prior, ...artifact } : artifact;
}

function targetList(args, existing, inferredTarget) {
  if (args.type === "combo" || existing?.type === "combo") return ["glasses", "phone"];
  return [args.target || existing?.artifacts?.[0]?.target || inferredTarget || "glasses"];
}

function buildListing(descriptionMarkdown, controlMarkdown, existing) {
  const controlBlock = controlMarkdown
    ? /^#{1,6}\s/m.test(controlMarkdown)
      ? controlMarkdown
      : `### Controls\n\n${controlMarkdown}`
    : "";
  const descriptionMarkdownBody = [descriptionMarkdown, controlBlock].filter(Boolean).join("\n\n");
  if (!descriptionMarkdownBody && !existing?.listing) return undefined;
  return {
    ...(existing?.listing || {}),
    ...(descriptionMarkdownBody ? { descriptionMarkdown: descriptionMarkdownBody } : {}),
  };
}

function buildReleases(info, releaseUrl, fallbackVersion) {
  const updated = Array.isArray(info.updated) ? info.updated : info.updated ? [info.updated] : [];
  const releases = updated
    .map((item) => {
      const object = item && typeof item === "object" && !Array.isArray(item) ? item : {};
      const notes = htmlToMarkdown(langValue(object.en ? object.en : object.notes || object.description || item));
      return {
        version: object.version || fallbackVersion || null,
        date: object.releaseDate || info.releaseDate || null,
        sourceReleaseUrl: releaseUrl,
        ...(notes && { notes }),
        changes: [],
      };
    })
    .filter((release) => release.version || release.date || release.notes);
  if (releases.length > 0) return releases;
  if (!fallbackVersion && !info.releaseDate) return [];
  return [{
    version: fallbackVersion || null,
    date: info.releaseDate || null,
    sourceReleaseUrl: releaseUrl,
    notes: "Imported from EUNG SOFT app metadata.",
    changes: [],
  }];
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

async function importScreenshots({ root, id, source, images, args, existing, report, defaultMaxScreenshots }) {
  if (args.noScreenshots) return existing?.screenshotAssets || undefined;

  const parsedMax = args.maxScreenshots ? Number.parseInt(args.maxScreenshots, 10) : defaultMaxScreenshots;
  const max = Number.isFinite(parsedMax) ? parsedMax : images.length;
  const selected = images.slice(0, Math.max(0, max));
  const imported = [];
  const screenshotDir = path.join(root, "assets", "screenshots");
  if (!args.dryRun) fs.mkdirSync(screenshotDir, { recursive: true });

  for (const image of selected) {
    const imageName = typeof image === "string" ? image : image?.url || image?.src || image?.name;
    if (!imageName || !screenshotExt(imageName) || isRejectedScreenshot(imageName)) continue;
    const targetName = screenshotName(id, imported.length, imageName);
    imported.push(targetName);
    if (!args.dryRun) {
      const imageSource = /^https?:\/\//i.test(imageName) ? imageName : siblingSource(source, imageName);
      const target = path.join(screenshotDir, targetName);
      if (/^https?:\/\//i.test(imageSource)) {
        fs.writeFileSync(target, await fetchBytes(imageSource, imageName));
      } else {
        fs.copyFileSync(imageSource, target);
      }
    }
    report?.push(`Imported EUNG screenshot \`${targetName}\`.`);
  }

  if (imported.length > 0) return imported;
  return existing?.screenshotAssets || undefined;
}

export async function buildEungApp({
  root,
  source,
  loaded,
  args = {},
  existing = null,
  report = [],
  defaultMaxScreenshots = 4,
}) {
  const entry = loaded || await readEungInfo(source);
  const info = entry.info;
  const title = args.name || langValue(info.title || info.name) || existing?.name || "EUNG SOFT App";
  const id = args.id || existing?.id || slugify(title, "eung-app");
  const artifactUrl = firstApkUrl(info, entry.source);
  if (!artifactUrl) throw new Error("EUNG info.json does not expose an APK download URL");

  const assetName = sourceBasename(artifactUrl);
  const version = String(info.version || existing?.version || versionFromAsset(assetName) || "0.0.0").replace(/^v/i, "");
  const inferredTarget = inferTarget(assetName, "glasses");
  const targets = targetList(args, existing, inferredTarget);
  const type = args.type || existing?.type || appTypeFromTargets(targets, undefined);
  const descriptionMarkdown = htmlToMarkdown(langValue(info.description));
  const controlMarkdown = htmlToMarkdown(langValue(info.control));
  const descriptionText = stripMarkdown(descriptionMarkdown);
  const tags = Array.isArray(info.tags?.en) ? info.tags.en : [];
  const summary = args.summary ||
    langValue(info.shortDescription) ||
    existing?.summary ||
    firstSentence(descriptionText, title);
  const artifacts = targets.map((target) => preserveArtifactMetadata(existing, {
    target,
    url: artifactUrl,
  }));
  const release = githubReleaseInfo(artifactUrl);
  const releaseUrl = release?.releaseUrl || sourceFolderUrl(entry.source);
  const updateAssets = targets.map((target) => ({
    target,
    match: versionMatchRegex(release?.assetName || assetName, version),
  }));
  const screenshotAssets = await importScreenshots({
    root,
    id,
    source: entry.source,
    images: Array.isArray(info.images) ? info.images : [],
    args,
    existing,
    report,
    defaultMaxScreenshots,
  });
  const releases = buildReleases(info, releaseUrl, version);

  const app = orderedApp({
    ...(existing || {}),
    id,
    name: title,
    category: args.category || existing?.category || inferCategory([tags, title, descriptionText]),
    type,
    version,
    publishedAt: info.releaseDate || existing?.publishedAt,
    summary: String(summary).trim().slice(0, 180),
    description: args.description || descriptionText || existing?.description || String(summary).trim(),
    listing: buildListing(descriptionMarkdown, controlMarkdown, existing),
    releases: releases.length > 0 ? releases : existing?.releases || [],
    screenshotAssets,
    phoneRequired: boolValue(args.phoneRequired, existing?.phoneRequired ?? type === "combo"),
    artifacts: args.preserveArtifacts && existing?.artifacts ? existing.artifacts : artifacts,
    author: existing?.author || "EUNG SOFT",
    sourceUrl: existing?.sourceUrl || sourceFolderUrl(entry.source),
    iconAsset: existing?.iconAsset,
    update: args.preserveArtifacts && existing?.update
      ? existing.update
      : {
          source: "githubReleaseAssets",
          repo: release?.repo || EUNG_REPO,
          release: release?.tag || EUNG_RELEASE_BUCKET,
          assets: updateAssets,
        },
  });

  report?.push(`Detected EUNG info.json flow for \`${title}\`.`);
  return { app, repo: release?.repo || EUNG_REPO, source: entry.source, info };
}
