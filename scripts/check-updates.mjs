import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { bulletChanges, cleanMarkdown } from "./lib-github-content.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appsDir = path.join(root, "apps");
const brewFile = path.join(root, "brew.json");
const tmpDir = path.join(root, ".tmp", "check-updates");
const reportFile = path.join(root, ".tmp", "update-report.md");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const strict = args.includes("--strict");
const releaseMetadataOnly = args.includes("--release-metadata-only");
const appFilters = new Set(valuesFor("--app"));
const shouldCheckBrew = appFilters.size === 0 || [...appFilters].some((id) => id.toLowerCase() === "rokidbrew");

fs.mkdirSync(tmpDir, { recursive: true });
fs.mkdirSync(path.dirname(reportFile), { recursive: true });

function valuesFor(flag) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && args[i + 1]) values.push(args[i + 1]);
  }
  return values;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function commandExists(command) {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [command], {
    encoding: "utf8",
  });
  return probe.status === 0;
}

function findAapt() {
  if (process.env.AAPT_PATH && fs.existsSync(process.env.AAPT_PATH)) return process.env.AAPT_PATH;
  if (commandExists("aapt")) return "aapt";

  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!androidHome) return null;
  const buildTools = path.join(androidHome, "build-tools");
  if (!fs.existsSync(buildTools)) return null;

  const candidates = fs.readdirSync(buildTools)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .flatMap((version) => [
      path.join(buildTools, version, process.platform === "win32" ? "aapt.exe" : "aapt"),
      path.join(buildTools, version, process.platform === "win32" ? "aapt2.exe" : "aapt2"),
    ]);

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function parseBadging(aapt, apkPath) {
  const badging = run(aapt, ["dump", "badging", apkPath]);
  const match = badging.match(/^package:\s+name='([^']+)'(?:\s+versionCode='([^']+)')?(?:\s+versionName='([^']*)')?/m);
  if (!match) return {};
  return {
    packageName: match[1],
    versionCode: match[2] ? Number(match[2]) : undefined,
    versionName: match[3] || undefined,
  };
}

async function fetchBytes(url, label) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "RokidBrew-Registry-Update-Checker",
    },
  });
  if (!response.ok) throw new Error(`${label} download failed: ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchJson(url, label) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "RokidBrew-Registry-Update-Checker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${label} failed: ${response.status} ${response.statusText}`);
  return response.json();
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function safeFileName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
}

function parseGithubReleaseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 6 || parts[2] !== "releases" || parts[3] !== "download") return null;
  return {
    repo: `${parts[0]}/${parts[1]}`,
    tag: decodeURIComponent(parts[4]),
    assetName: decodeURIComponent(parts.slice(5).join("/")),
  };
}

function parseRawGithubUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "raw.githubusercontent.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 4) return null;
  return {
    repo: `${parts[0]}/${parts[1]}`,
    ref: decodeURIComponent(parts[2]),
    filePath: decodeURIComponent(parts.slice(3).join("/")),
  };
}

function isVersionLikeTag(tag) {
  return /^v?\d+(?:[._-]\d+)*/i.test(tag);
}

function isPrereleaseLikeTag(tag) {
  return /(?:alpha|beta|rc|dev|preview)/i.test(tag);
}

function tagVersion(tag) {
  return tag.replace(/^v/i, "");
}

function versionFromName(value) {
  if (!value) return null;
  const match = value.match(/(?:^|[_\-.])v?(\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?)(?=[_\-.]|$)/i);
  return match?.[1] || null;
}

function normalizeVersion(value) {
  if (!value || typeof value !== "string") return null;
  const cleaned = value.trim().replace(/^v/i, "");
  const match = cleaned.match(/^(\d+(?:\.\d+){0,4})(?:[-+.]?([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    raw: cleaned,
    numbers: match[1].split(".").map((part) => Number.parseInt(part, 10)),
    suffix: match[2] || "",
  };
}

function compareVersions(a, b) {
  const va = normalizeVersion(a);
  const vb = normalizeVersion(b);
  if (!va || !vb) return null;
  const length = Math.max(va.numbers.length, vb.numbers.length);
  for (let i = 0; i < length; i += 1) {
    const left = va.numbers[i] || 0;
    const right = vb.numbers[i] || 0;
    if (left !== right) return left - right;
  }
  if (va.suffix === vb.suffix) return 0;
  if (!va.suffix) return 1;
  if (!vb.suffix) return -1;
  return va.suffix.localeCompare(vb.suffix, "en", { numeric: true, sensitivity: "base" });
}

function bestVersion(values) {
  return values
    .filter(Boolean)
    .reduce((best, value) => {
      if (!best) return value;
      const compared = compareVersions(value, best);
      return compared != null && compared > 0 ? value : best;
    }, null);
}

function semverSortKey(candidate) {
  return candidate.versionForCompare || candidate.versionName || candidate.assetVersion || "";
}

function compareCandidates(a, b) {
  const aCode = Number(a.versionCode || 0);
  const bCode = Number(b.versionCode || 0);
  if (aCode !== bCode) return aCode - bCode;

  const versionCompare = compareVersions(semverSortKey(a), semverSortKey(b));
  if (versionCompare != null && versionCompare !== 0) return versionCompare;

  return Date.parse(a.updatedAt || 0) - Date.parse(b.updatedAt || 0);
}

function publicReleaseUrl(repo, release) {
  return `https://api.github.com/repos/${repo}/releases/${release === "latest" ? "latest" : `tags/${encodeURIComponent(release)}`}`;
}

function currentBrewVersionCode(brew) {
  return Number(brew?.versionCode || 0);
}

function shouldUpdateBrew(brew, candidate) {
  const currentCode = currentBrewVersionCode(brew);
  const candidateCode = Number(candidate.versionCode || 0);
  if (candidateCode && candidateCode > currentCode) {
    return `versionCode ${currentCode} -> ${candidateCode}`;
  }

  const currentVersion = brew?.version || "";
  const candidateVersion = candidate.versionName || candidate.assetVersion || "";
  const versionCompare = compareVersions(candidateVersion, currentVersion);
  if (versionCompare != null && versionCompare > 0) {
    return `version ${currentVersion || "unknown"} -> ${candidateVersion}`;
  }

  if (candidate.url === brew?.apkUrl && candidateCode === currentCode) {
    if (!releaseMetadataOnly) return null;

    if (candidate.releaseUrl && candidate.releaseUrl !== brew?.releaseUrl) {
      return "release metadata";
    }
    if ("releaseNotes" in candidate && candidate.releaseNotes !== (brew?.notes || "")) {
      return "release notes";
    }
    const currentChanges = JSON.stringify(Array.isArray(brew?.changes) ? brew.changes : []);
    const candidateChanges = JSON.stringify(candidate.releaseChanges || []);
    if (Array.isArray(candidate.releaseChanges) && candidateChanges !== currentChanges) {
      return "release changes";
    }
    return null;
  }

  return null;
}

function applyBrewCandidate(brew, candidate) {
  brew.version = bestVersion([
    candidate.versionName,
    candidate.assetVersion,
    tagVersion(candidate.releaseTag || ""),
  ]) || brew.version;
  if (candidate.versionCode) brew.versionCode = candidate.versionCode;
  brew.apkUrl = candidate.url;
  if (candidate.releaseUrl) brew.releaseUrl = candidate.releaseUrl;
  if ("releaseNotes" in candidate) brew.notes = candidate.releaseNotes || null;
  if (Array.isArray(candidate.releaseChanges)) brew.changes = candidate.releaseChanges;
}

const releaseCache = new Map();
async function getRelease(repo, release) {
  const key = `${repo}@${release}`;
  if (!releaseCache.has(key)) {
    releaseCache.set(key, fetchJson(publicReleaseUrl(repo, release), `${repo} ${release}`));
  }
  return releaseCache.get(key);
}

const artifactCache = new Map();
async function inspectApk(aapt, url, label, assetName) {
  if (!artifactCache.has(url)) {
    artifactCache.set(url, (async () => {
      const bytes = await fetchBytes(url, label);
      const apkPath = path.join(tmpDir, `${safeFileName(label)}.apk`);
      fs.writeFileSync(apkPath, bytes);
      const badging = parseBadging(aapt, apkPath);
      const assetVersion = versionFromName(assetName || url);
      return {
        sha256: sha256(bytes),
        sizeBytes: bytes.length,
        packageName: badging.packageName,
        versionCode: badging.versionCode,
        versionName: badging.versionName,
        assetVersion,
        versionForCompare: bestVersion([assetVersion, badging.versionName]),
      };
    })());
  }
  return artifactCache.get(url);
}

function ruleForTarget(updateConfig, target) {
  if (!updateConfig) return null;
  const assetRules = Array.isArray(updateConfig.assets) ? updateConfig.assets : [];
  return assetRules.find((rule) => rule.target === target) || null;
}

function inferredGithubConfig(artifact) {
  const info = parseGithubReleaseUrl(artifact.url);
  if (!info) return null;
  const release = isVersionLikeTag(info.tag) && !isPrereleaseLikeTag(info.tag) ? "latest" : info.tag;
  return {
    source: "githubRelease",
    repo: info.repo,
    release,
    inferred: true,
    assets: [
      {
        target: artifact.target,
        currentAsset: info.assetName,
      },
    ],
  };
}

function mergedUpdateConfig(app, artifact) {
  if (app.update?.disabled || artifact.update?.disabled) return null;
  const explicit = artifact.update || app.update;
  if (explicit) return explicit;
  return inferredGithubConfig(artifact);
}

function regexFromRule(rule) {
  if (!rule?.match) return null;
  return new RegExp(rule.match, "i");
}

function assetCandidates(release, rule) {
  const match = regexFromRule(rule);
  return (release.assets || [])
    .filter((asset) => asset.name?.toLowerCase().endsWith(".apk"))
    .filter((asset) => !match || match.test(asset.name));
}

function expectedPackage(rule, artifact) {
  return rule?.packageName || artifact.packageName || null;
}

function currentComparableVersions(app, artifact, candidate) {
  const currentRelease = parseGithubReleaseUrl(artifact.url);
  const currentAssetVersion = versionFromName(currentRelease?.assetName || artifact.url);
  if (candidate?.aggregateRelease && candidate.assetVersion) {
    return [currentAssetVersion || app.version].filter(Boolean);
  }

  return [
    app.version,
    artifact.versionName,
    currentAssetVersion,
  ].filter(Boolean);
}

function shouldUpdate(app, artifact, candidate) {
  const currentCode = Number(artifact.versionCode || 0);
  const candidateCode = Number(candidate.versionCode || 0);
  if (candidateCode && currentCode && candidateCode > currentCode) {
    return `versionCode ${currentCode} -> ${candidateCode}`;
  }

  const currentVersion = bestVersion(currentComparableVersions(app, artifact, candidate));
  const candidateVersion = candidate.versionForCompare;
  const versionCompare = compareVersions(candidateVersion, currentVersion);
  if (versionCompare != null && versionCompare > 0) {
    return `version ${currentVersion || "unknown"} -> ${candidateVersion}`;
  }

  if (candidate.url === artifact.url) {
    const changed = candidate.sha256 && artifact.sha256 && candidate.sha256 !== artifact.sha256;
    const missing = !artifact.sha256 || !artifact.sizeBytes || !artifact.packageName || !artifact.versionCode;
    if (changed) return "same URL changed checksum";
    if (missing) return "fill missing metadata";
    if (!candidate.allowReleaseMetadataOnly) return null;

    const releaseReason = shouldUpdateRelease(app, candidate);
    if (releaseReason) return releaseReason;
  }

  if (candidate.url !== artifact.url && candidate.sha256 && candidate.sha256 !== artifact.sha256) {
    if (!currentCode || !candidateCode || candidateCode >= currentCode) {
      if (versionCompare == null || versionCompare >= 0) return "asset changed";
    }
  }

  return null;
}

function candidateReleaseVersion(candidate) {
  if (candidate.aggregateRelease && candidate.assetVersion) return candidate.assetVersion;

  return bestVersion([
    candidate.versionName,
    candidate.assetVersion,
    tagVersion(candidate.releaseTag || ""),
  ]);
}

function versionsEqual(left, right) {
  if (!left || !right) return false;
  const compared = compareVersions(left, right);
  return compared == null ? left === right : compared === 0;
}

function matchingRelease(app, candidate) {
  const releases = Array.isArray(app.releases) ? app.releases : [];
  if (candidate.releaseUrl && !candidate.aggregateRelease) {
    const byUrl = releases.find((release) => release.sourceReleaseUrl === candidate.releaseUrl);
    if (byUrl) return byUrl;
  }

  const version = candidateReleaseVersion(candidate);
  if (version) {
    const byVersion = releases.find((release) => versionsEqual(release.version, version));
    if (byVersion) return byVersion;
  }

  return null;
}

function releaseChangesEqual(left, right) {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}

function shouldUpdateRelease(app, candidate) {
  if (!("releaseNotes" in candidate) && !Array.isArray(candidate.releaseChanges)) return null;
  const release = matchingRelease(app, candidate);
  if (!release) return "release metadata";
  if ("releaseNotes" in candidate && candidate.releaseNotes !== (release.notes || "")) return "release notes";
  if (Array.isArray(candidate.releaseChanges) && !releaseChangesEqual(candidate.releaseChanges, release.changes)) {
    return "release changes";
  }
  return null;
}

function upsertAppRelease(app, candidate) {
  if (candidate.upsertRelease === false) return;
  if (!candidate.releaseUrl && !("releaseNotes" in candidate) && !Array.isArray(candidate.releaseChanges)) return;

  const version = candidateReleaseVersion(candidate);
  const existing = matchingRelease(app, candidate);
  const hasReleaseNotes = "releaseNotes" in candidate;
  const entry = {
    version: version || null,
    date: candidate.releasePublishedAt || candidate.updatedAt || existing?.date || null,
    sourceReleaseUrl: candidate.releaseUrl || null,
    notes: hasReleaseNotes ? candidate.releaseNotes || null : existing?.notes || null,
    changes: Array.isArray(candidate.releaseChanges) ? candidate.releaseChanges : existing?.changes || [],
  };

  const releases = Array.isArray(app.releases) ? app.releases : [];
  const filtered = releases.filter((release) => {
    if (entry.version && versionsEqual(release.version, entry.version)) return false;
    if (!candidate.aggregateRelease && entry.sourceReleaseUrl && release.sourceReleaseUrl === entry.sourceReleaseUrl) return false;
    return true;
  });
  app.releases = [entry, ...filtered].slice(0, 8);
}

function applyCandidate(app, artifact, candidate) {
  artifact.url = candidate.url;
  artifact.sha256 = candidate.sha256;
  artifact.sizeBytes = candidate.sizeBytes;
  if (candidate.packageName) artifact.packageName = candidate.packageName;
  if (candidate.versionCode) artifact.versionCode = candidate.versionCode;
  if (candidate.versionName) artifact.versionName = candidate.versionName;

  const candidateVersion = candidateReleaseVersion(candidate);
  const nextAppVersion = bestVersion([app.version, candidateVersion]);
  if (nextAppVersion) app.version = nextAppVersion;
  if (candidate.releasePublishedAt) app.publishedAt = candidate.releasePublishedAt;
  upsertAppRelease(app, candidate);
}

async function checkGithubArtifact(aapt, app, artifact, updateConfig, rule, log, warn) {
  const repo = updateConfig.repo;
  const releaseSelector = updateConfig.release || updateConfig.tag || "latest";
  if (!repo) throw new Error(`${app.id}:${artifact.target} update.repo is required`);

  const release = await getRelease(repo, releaseSelector);
  const candidates = assetCandidates(release, rule);
  const packageName = expectedPackage(rule, artifact);
  const aggregateRelease = updateConfig.source === "githubReleaseAssets";
  // Aggregate releases can host many apps, so their body/date may be generic
  // README or changelog text that should not replace per-app curation.
  const useReleaseBody = !aggregateRelease || updateConfig.useReleaseBody === true;
  const allowReleaseMetadataOnly = releaseMetadataOnly || updateConfig.releaseMetadataOnly === true;
  const inspected = [];

  for (const asset of candidates) {
    const metadata = await inspectApk(aapt, asset.browser_download_url, `${app.id}-${artifact.target}-${asset.name}`, asset.name);
    if (packageName && metadata.packageName !== packageName) continue;
    const artifactChanged = asset.browser_download_url !== artifact.url ||
      Boolean(metadata.sha256 && artifact.sha256 && metadata.sha256 !== artifact.sha256);
    const shouldCopyReleaseBody = useReleaseBody && (artifactChanged || allowReleaseMetadataOnly);
    inspected.push({
      ...metadata,
      url: asset.browser_download_url,
      assetName: asset.name,
      updatedAt: asset.updated_at,
      aggregateRelease,
      allowReleaseMetadataOnly,
      upsertRelease: artifactChanged || allowReleaseMetadataOnly,
      versionForCompare: aggregateRelease && metadata.assetVersion ? metadata.assetVersion : metadata.versionForCompare,
      releaseTag: release.tag_name,
      releasePublishedAt: aggregateRelease ? asset.created_at || asset.updated_at || release.published_at : release.published_at,
      releaseUrl: release.html_url,
      ...(shouldCopyReleaseBody && {
        releaseNotes: cleanMarkdown(release.body || ""),
        releaseChanges: bulletChanges(release.body || "", 8),
      }),
    });
  }

  if (inspected.length === 0) {
    const currentTag = parseGithubReleaseUrl(artifact.url)?.tag;
    if (rule?.match && currentTag && currentTag !== release.tag_name) {
      const apkNames = (release.assets || [])
        .filter((asset) => asset.name?.toLowerCase().endsWith(".apk"))
        .map((asset) => asset.name);
      warn(`${app.id}:${artifact.target} ${repo}@${release.tag_name} differs from the current artifact tag ${currentTag} but no asset matches the configured pattern (release APKs: ${apkNames.join(", ") || "none"}) — renamed upstream?`);
    }
    log(`skip   ${app.id}:${artifact.target} no matching APK in ${repo}@${release.tag_name}`);
    return null;
  }

  const best = inspected.sort(compareCandidates).at(-1);
  const reason = shouldUpdate(app, artifact, best);
  if (!reason) {
    log(`ok     ${app.id}:${artifact.target} ${best.assetName}`);
    return null;
  }

  log(`update ${app.id}:${artifact.target} ${reason} (${best.assetName})`);
  return best;
}

async function checkRawArtifact(aapt, app, artifact, log) {
  const raw = parseRawGithubUrl(artifact.url);
  if (!raw) return null;
  const assetName = path.basename(raw.filePath);
  const metadata = await inspectApk(aapt, artifact.url, `${app.id}-${artifact.target}-${assetName}`, assetName);
  const candidate = {
    ...metadata,
    url: artifact.url,
    assetName,
  };
  const reason = shouldUpdate(app, artifact, candidate);
  if (!reason) {
    log(`ok     ${app.id}:${artifact.target} raw ${raw.repo}/${raw.filePath}`);
    return null;
  }
  log(`update ${app.id}:${artifact.target} ${reason} (raw ${raw.repo}/${raw.filePath})`);
  return candidate;
}

async function checkBrewUpdate(aapt, log) {
  const brew = fs.existsSync(brewFile) ? readJson(brewFile) : {};
  const release = await getRelease("Anezium/RokidBrew", "latest");
  const assets = (release.assets || [])
    .filter((asset) => /^RokidBrew-phone-.*\.apk$/i.test(asset.name || ""))
    .sort((a, b) => Date.parse(a.updated_at || 0) - Date.parse(b.updated_at || 0));

  if (assets.length === 0) {
    log(`skip   rokidbrew:phone no matching phone APK in Anezium/RokidBrew@${release.tag_name}`);
    return null;
  }

  const asset = assets.at(-1);
  const metadata = await inspectApk(aapt, asset.browser_download_url, `rokidbrew-phone-${asset.name}`, asset.name);
  if (metadata.packageName && metadata.packageName !== "com.rokidbrew.phone") {
    throw new Error(`rokidbrew:phone package mismatch: ${metadata.packageName}`);
  }

  const candidate = {
    ...metadata,
    url: asset.browser_download_url,
    assetName: asset.name,
    updatedAt: asset.updated_at,
    releaseTag: release.tag_name,
    releasePublishedAt: release.published_at,
    releaseUrl: release.html_url,
    releaseNotes: cleanMarkdown(release.body || ""),
    releaseChanges: bulletChanges(release.body || "", 8),
  };
  const reason = shouldUpdateBrew(brew, candidate);
  if (!reason) {
    log(`ok     rokidbrew:phone ${asset.name}`);
    return null;
  }

  log(`update rokidbrew:phone ${reason} (${asset.name})`);
  return { brew, candidate, reason };
}

function summarizeChange(app, artifact, candidate, reason) {
  return {
    id: app.id,
    target: artifact.target,
    name: app.name,
    reason,
    url: candidate.url,
    assetName: candidate.assetName,
    versionCode: candidate.versionCode,
    versionName: candidate.versionName,
    assetVersion: candidate.assetVersion,
  };
}

function summarizeBrewChange(candidate, reason) {
  return {
    id: "rokidbrew",
    target: "phone",
    name: "RokidBrew",
    reason,
    url: candidate.url,
    assetName: candidate.assetName,
    versionCode: candidate.versionCode,
    versionName: candidate.versionName,
    assetVersion: candidate.assetVersion,
  };
}

function buildReport({ updates, skipped, errors, warnings, logs }) {
  const lines = [
    "# RokidBrew app update check",
    "",
    `Mode: ${dryRun ? "dry run" : "write changes"}`,
    `Checked at: ${new Date().toISOString()}`,
    "",
    `Updates: ${updates.length}`,
    `Skipped/no change: ${skipped}`,
    `Warnings: ${warnings.length}`,
    `Errors: ${errors.length}`,
  ];

  if (updates.length > 0) {
    lines.push("", "## Updates", "");
    for (const update of updates) {
      const version = bestVersion([update.assetVersion, update.versionName]) || "unknown";
      lines.push(`- ${update.name} (${update.id}:${update.target}) -> ${version} / versionCode ${update.versionCode || "unknown"} (${update.reason})`);
      lines.push(`  - ${update.assetName || update.url}`);
    }
  }

  if (warnings.length > 0) {
    lines.push("", "## Warnings", "");
    for (const warning of warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (errors.length > 0) {
    lines.push("", "## Errors", "");
    for (const error of errors) {
      lines.push(`- ${error}`);
    }
  }

  lines.push("", "## Log", "", "```text", ...logs, "```", "");
  return lines.join("\n");
}

const aapt = findAapt();
if (!aapt) {
  console.error("Could not find aapt. Install Android build-tools or set AAPT_PATH.");
  process.exit(1);
}

const appFiles = fs.readdirSync(appsDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => path.join(appsDir, name));

const logs = [];
const updates = [];
const errors = [];
const warnings = [];
let skipped = 0;

function log(message) {
  logs.push(message);
  console.log(message);
}

function warn(message) {
  warnings.push(message);
  log(`warn   ${message}`);
}

for (const file of appFiles) {
  const app = readJson(file);
  if (appFilters.size > 0 && !appFilters.has(app.id)) continue;

  let changed = false;
  for (const artifact of app.artifacts || []) {
    try {
      const updateConfig = mergedUpdateConfig(app, artifact);
      const rule = ruleForTarget(updateConfig, artifact.target);
      const before = JSON.stringify(app);
      let candidate = null;
      let reason = null;

      if (updateConfig?.source === "githubRelease" || updateConfig?.source === "githubReleaseAssets") {
        candidate = await checkGithubArtifact(aapt, app, artifact, updateConfig, rule, log, warn);
      } else {
        candidate = await checkRawArtifact(aapt, app, artifact, log);
      }

      if (candidate) {
        reason = shouldUpdate(app, artifact, candidate);
        updates.push(summarizeChange(app, artifact, candidate, reason));
        if (!dryRun) {
          applyCandidate(app, artifact, candidate);
          changed = changed || JSON.stringify(app) !== before;
        }
      } else {
        skipped += 1;
      }
    } catch (error) {
      const message = `${app.id}:${artifact.target} ${error.message}`;
      errors.push(message);
      log(`error  ${message}`);
    }
  }

  if (changed) writeJson(file, app);
}

if (shouldCheckBrew) {
  try {
    const result = await checkBrewUpdate(aapt, log);
    if (result) {
      updates.push(summarizeBrewChange(result.candidate, result.reason));
      if (!dryRun) {
        applyBrewCandidate(result.brew, result.candidate);
        writeJson(brewFile, result.brew);
      }
    } else {
      skipped += 1;
    }
  } catch (error) {
    const message = `rokidbrew:phone ${error.message}`;
    errors.push(message);
    log(`error  ${message}`);
  }
}

const report = buildReport({ updates, skipped, errors, warnings, logs });
fs.writeFileSync(reportFile, report);
console.log(`Wrote ${path.relative(root, reportFile)}`);
console.log(`Updates ${updates.length}, skipped ${skipped}, warnings ${warnings.length}, errors ${errors.length}`);

if (strict && errors.length > 0) {
  process.exitCode = 1;
}
