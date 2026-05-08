import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appsDir = path.join(root, "apps");
const distDir = path.join(root, "dist");
const iconDir = path.join(root, "assets", "icons");
const screenshotDir = path.join(root, "assets", "screenshots");
const publicBaseUrl = (process.env.ROKIDBREW_PUBLIC_BASE_URL ||
  "https://raw.githubusercontent.com/Anezium/RokidBrew-Registry/main").replace(/\/$/, "");
const newWindowDays = Number.parseInt(process.env.ROKIDBREW_NEW_WINDOW_DAYS || "2", 10);
const generatedAt = new Date();

const required = ["id", "name", "category", "type", "version", "summary", "author", "sourceUrl", "artifacts"];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertApp(app, file) {
  for (const key of required) {
    if (app[key] === undefined || app[key] === null || app[key] === "") {
      throw new Error(`${path.relative(root, file)} is missing "${key}"`);
    }
  }
  if (!["combo", "phone", "glasses"].includes(app.type)) {
    throw new Error(`${app.id}: type must be combo, phone, or glasses`);
  }
  if (!/^https?:\/\//.test(app.sourceUrl)) {
    throw new Error(`${app.id}: sourceUrl must be http(s)`);
  }
  if (!Array.isArray(app.artifacts) || app.artifacts.length === 0) {
    throw new Error(`${app.id}: artifacts must be a non-empty array`);
  }
  const targets = new Set();
  for (const artifact of app.artifacts) {
    if (!["phone", "glasses"].includes(artifact.target)) {
      throw new Error(`${app.id}: artifact target must be phone or glasses`);
    }
    if (!artifact.url || !/^https?:\/\//.test(artifact.url)) {
      throw new Error(`${app.id}: artifact url must be http(s)`);
    }
    if (targets.has(artifact.target)) {
      throw new Error(`${app.id}: duplicate artifact target ${artifact.target}`);
    }
    targets.add(artifact.target);
  }
}

function assetUrl(relativePath) {
  return `${publicBaseUrl}/${relativePath.split(path.sep).join("/")}`;
}

function attachAssetUrls(app) {
  const iconPath = path.join(iconDir, `${app.id}.png`);
  if (fs.existsSync(iconPath)) {
    app.iconAsset = `${app.id}.png`;
    app.iconUrl = assetUrl(path.relative(root, iconPath));
  }

  const screenshots = Array.isArray(app.screenshotAssets)
    ? app.screenshotAssets
    : app.screenshotAsset
      ? [app.screenshotAsset]
      : [];

  app.screenshotAssets = screenshots;
  delete app.screenshotAsset;

  const screenshotUrls = screenshots
    .map((name) => {
      const screenshotPath = path.join(screenshotDir, name);
      return fs.existsSync(screenshotPath) ? assetUrl(path.relative(root, screenshotPath)) : null;
    })
    .filter(Boolean);

  if (screenshotUrls.length > 0) app.screenshotUrls = screenshotUrls;
}

function normalizeDate(value) {
  if (!value || typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function attachCuration(app) {
  const publishedAt = normalizeDate(app.publishedAt);

  const newUntil = normalizeDate(app.newUntil);
  if (!newUntil && publishedAt && newWindowDays > 0) {
    app.newUntil = new Date(Date.parse(publishedAt) + newWindowDays * 24 * 60 * 60 * 1000).toISOString();
  }
}

function featuredRank(app) {
  if (Number.isFinite(app.featuredRank)) return app.featuredRank;
  if (app.featured === true) return Number.MAX_SAFE_INTEGER - 1;
  return Number.MAX_SAFE_INTEGER;
}

function isNewApp(app, now = generatedAt.getTime()) {
  const newUntil = Date.parse(app.newUntil || "");
  if (!Number.isNaN(newUntil)) return now <= newUntil;

  const publishedAt = Date.parse(app.publishedAt || "");
  if (Number.isNaN(publishedAt) || now < publishedAt || newWindowDays <= 0) return false;
  return now - publishedAt <= newWindowDays * 24 * 60 * 60 * 1000;
}

function publishedRank(app) {
  const publishedAt = Date.parse(app.publishedAt || "");
  return Number.isNaN(publishedAt) ? 0 : publishedAt;
}

function nameCompare(a, b) {
  return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
}

function registryOrder(a, b) {
  const aNew = isNewApp(a);
  const bNew = isNewApp(b);
  if (aNew !== bNew) return aNew ? -1 : 1;
  if (aNew && bNew) {
    return publishedRank(b) - publishedRank(a) ||
      featuredRank(a) - featuredRank(b) ||
      nameCompare(a, b);
  }

  const aFeatured = featuredRank(a) < Number.MAX_SAFE_INTEGER;
  const bFeatured = featuredRank(b) < Number.MAX_SAFE_INTEGER;
  if (aFeatured !== bFeatured) return aFeatured ? -1 : 1;
  if (aFeatured && bFeatured) {
    return featuredRank(a) - featuredRank(b) || nameCompare(a, b);
  }

  return nameCompare(a, b);
}

if (!fs.existsSync(appsDir)) {
  throw new Error("Missing apps/ directory");
}

const apps = fs.readdirSync(appsDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => {
    const file = path.join(appsDir, name);
    const app = readJson(file);
    assertApp(app, file);
    attachCuration(app);
    attachAssetUrls(app);
    return app;
  })
  .sort(registryOrder);

const duplicate = apps.map((app) => app.id).find((id, index, ids) => ids.indexOf(id) !== index);
if (duplicate) throw new Error(`Duplicate app id: ${duplicate}`);

fs.mkdirSync(distDir, { recursive: true });
const brewFile = path.join(root, "brew.json");
let brewVersion, brewVersionCode, brewApkUrl;
if (fs.existsSync(brewFile)) {
  const brew = readJson(brewFile);
  brewVersion = brew.version;
  brewVersionCode = brew.versionCode;
  brewApkUrl = brew.apkUrl;
}

const output = {
  schemaVersion: 1,
  generatedAt: generatedAt.toISOString(),
  ...(brewVersion != null && { brewVersion, brewVersionCode, brewApkUrl }),
  apps,
};

fs.writeFileSync(path.join(distDir, "apps.v1.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(`Built dist/apps.v1.json with ${apps.length} apps`);
