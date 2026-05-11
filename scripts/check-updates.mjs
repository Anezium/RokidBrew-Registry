import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appsDir = path.join(root, "apps");
const tmpDir = path.join(root, ".tmp", "check-updates");
const reportFile = path.join(root, ".tmp", "update-report.md");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const strict = args.includes("--strict");
const appFilters = new Set(valuesFor("--app"));

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

function currentComparableVersions(app, artifact) {
  const currentRelease = parseGithubReleaseUrl(artifact.url);
  return [
    app.version,
    artifact.versionName,
    versionFromName(currentRelease?.assetName || artifact.url),
  ].filter(Boolean);
}

function shouldUpdate(app, artifact, candidate) {
  const currentCode = Number(artifact.versionCode || 0);
  const candidateCode = Number(candidate.versionCode || 0);
  if (candidateCode && currentCode && candidateCode > currentCode) {
    return `versionCode ${currentCode} -> ${candidateCode}`;
  }

  const currentVersion = bestVersion(currentComparableVersions(app, artifact));
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
  }

  if (candidate.url !== artifact.url && candidate.sha256 && candidate.sha256 !== artifact.sha256) {
    if (!currentCode || !candidateCode || candidateCode >= currentCode) {
      if (versionCompare == null || versionCompare >= 0) return "asset changed";
    }
  }

  return null;
}

function applyCandidate(app, artifact, candidate) {
  artifact.url = candidate.url;
  artifact.sha256 = candidate.sha256;
  artifact.sizeBytes = candidate.sizeBytes;
  if (candidate.packageName) artifact.packageName = candidate.packageName;
  if (candidate.versionCode) artifact.versionCode = candidate.versionCode;
  if (candidate.versionName) artifact.versionName = candidate.versionName;

  const nextAppVersion = bestVersion([
    app.version,
    candidate.assetVersion,
    candidate.versionName,
    tagVersion(candidate.releaseTag || ""),
  ]);
  if (nextAppVersion) app.version = nextAppVersion;
  if (candidate.releasePublishedAt) app.publishedAt = candidate.releasePublishedAt;
}

async function checkGithubArtifact(aapt, app, artifact, updateConfig, rule, log) {
  const repo = updateConfig.repo;
  const releaseSelector = updateConfig.release || updateConfig.tag || "latest";
  if (!repo) throw new Error(`${app.id}:${artifact.target} update.repo is required`);

  const release = await getRelease(repo, releaseSelector);
  const candidates = assetCandidates(release, rule);
  const packageName = expectedPackage(rule, artifact);
  const inspected = [];

  for (const asset of candidates) {
    const metadata = await inspectApk(aapt, asset.browser_download_url, `${app.id}-${artifact.target}-${asset.name}`, asset.name);
    if (packageName && metadata.packageName !== packageName) continue;
    inspected.push({
      ...metadata,
      url: asset.browser_download_url,
      assetName: asset.name,
      updatedAt: asset.updated_at,
      releaseTag: release.tag_name,
      releasePublishedAt: release.published_at,
    });
  }

  if (inspected.length === 0) {
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

function buildReport({ updates, skipped, errors, logs }) {
  const lines = [
    "# RokidBrew app update check",
    "",
    `Mode: ${dryRun ? "dry run" : "write changes"}`,
    `Checked at: ${new Date().toISOString()}`,
    "",
    `Updates: ${updates.length}`,
    `Skipped/no change: ${skipped}`,
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
let skipped = 0;

function log(message) {
  logs.push(message);
  console.log(message);
}

for (const file of appFiles) {
  const app = readJson(file);
  if (appFilters.size > 0 && !appFilters.has(app.id)) continue;

  let changed = false;
  for (const artifact of app.artifacts || []) {
    try {
      const updateConfig = mergedUpdateConfig(app, artifact);
      const rule = ruleForTarget(updateConfig, artifact.target);
      const before = JSON.stringify(artifact);
      let candidate = null;
      let reason = null;

      if (updateConfig?.source === "githubRelease" || updateConfig?.source === "githubReleaseAssets") {
        candidate = await checkGithubArtifact(aapt, app, artifact, updateConfig, rule, log);
      } else {
        candidate = await checkRawArtifact(aapt, app, artifact, log);
      }

      if (candidate) {
        reason = shouldUpdate(app, artifact, candidate);
        updates.push(summarizeChange(app, artifact, candidate, reason));
        if (!dryRun) {
          applyCandidate(app, artifact, candidate);
          changed = changed || JSON.stringify(artifact) !== before;
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

const report = buildReport({ updates, skipped, errors, logs });
fs.writeFileSync(reportFile, report);
console.log(`Wrote ${path.relative(root, reportFile)}`);
console.log(`Updates ${updates.length}, skipped ${skipped}, errors ${errors.length}`);

if (strict && errors.length > 0) {
  process.exitCode = 1;
}
