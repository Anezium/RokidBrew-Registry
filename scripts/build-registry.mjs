import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appsDir = path.join(root, "apps");
const nexusPluginsDir = path.join(root, "plugins-nexus");
const distDir = path.join(root, "dist");
const iconDir = path.join(root, "assets", "icons");
const screenshotDir = path.join(root, "assets", "screenshots");

const publicBranch = process.env.ROKIDBREW_PUBLIC_BRANCH || "main";
const publicBaseUrl = (process.env.ROKIDBREW_PUBLIC_BASE_URL ||
  `https://raw.githubusercontent.com/Anezium/RokidBrew-Registry/${publicBranch}`).replace(/\/$/, "");
const newWindowDays = Number.parseInt(process.env.ROKIDBREW_NEW_WINDOW_DAYS || "2", 10);
const generatedAt = new Date(process.env.ROKIDBREW_GENERATED_AT || Date.now());
if (Number.isNaN(generatedAt.getTime())) {
  throw new Error("ROKIDBREW_GENERATED_AT must be a valid date when set");
}

const appRequired = ["id", "name", "category", "type", "version", "summary", "author", "sourceUrl", "artifacts"];
const nexusPluginRequired = [
  "id", "kind", "name", "category", "summary", "description", "author", "sourceUrl",
  "publishedAt", "iconAsset", "screenshotAssets", "listing", "releases", "nexus", "artifact",
];
const nexusCapabilityAllowlist = new Set(["surfaces", "microphone", "http_proxy", "camera"]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function isHttpsUrl(value) {
  if (typeof value !== "string" || !/^https:\/\//i.test(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function assertApp(app, file) {
  for (const key of appRequired) {
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

function assertNexusPlugin(plugin, file) {
  const relativeFile = path.relative(root, file);
  for (const key of nexusPluginRequired) {
    if (plugin[key] === undefined || plugin[key] === null || plugin[key] === "") {
      throw new Error(`${relativeFile} is missing "${key}"`);
    }
  }
  if (plugin.kind !== "nexus-plugin") {
    throw new Error(`${plugin.id}: kind must be nexus-plugin`);
  }
  if (path.basename(file) !== `${plugin.id}.json`) {
    throw new Error(`${relativeFile}: filename must match plugin id ${plugin.id}`);
  }
  if (!isHttpsUrl(plugin.sourceUrl)) {
    throw new Error(`${plugin.id}: sourceUrl must be an HTTPS URL`);
  }
  if (!normalizeDate(plugin.publishedAt)) {
    throw new Error(`${plugin.id}: publishedAt must be a valid date`);
  }
  if (!Array.isArray(plugin.screenshotAssets)) {
    throw new Error(`${plugin.id}: screenshotAssets must be an array`);
  }
  if (!plugin.listing?.descriptionMarkdown) {
    throw new Error(`${plugin.id}: listing.descriptionMarkdown is required`);
  }
  if (!Array.isArray(plugin.releases)) {
    throw new Error(`${plugin.id}: releases must be an array`);
  }
  for (const release of plugin.releases) {
    if (!release.version || typeof release.version !== "string") {
      throw new Error(`${plugin.id}: each release requires a version`);
    }
    if (!normalizeDate(release.date)) {
      throw new Error(`${plugin.id}: each release requires a valid date`);
    }
    if (typeof release.notes !== "string") {
      throw new Error(`${plugin.id}: each release requires notes (an empty string is allowed)`);
    }
  }

  const nexus = plugin.nexus;
  if (!nexus.pluginId || typeof nexus.pluginId !== "string") {
    throw new Error(`${plugin.id}: nexus.pluginId is required`);
  }
  if (plugin.id !== nexus.pluginId) {
    throw new Error(`${plugin.id}: id must exactly equal nexus.pluginId`);
  }
  if (nexus.apiVersion !== 3) {
    throw new Error(`${plugin.id}: nexus.apiVersion must be exactly 3`);
  }
  if (!Array.isArray(nexus.capabilities) ||
      nexus.capabilities.some((capability) => !nexusCapabilityAllowlist.has(capability))) {
    throw new Error(
      `${plugin.id}: nexus.capabilities may only contain surfaces, microphone, http_proxy, or camera`,
    );
  }
  if (typeof nexus.launchable !== "boolean") {
    throw new Error(`${plugin.id}: nexus.launchable must be boolean`);
  }
  if (nexus.settingsActivity != null &&
      (typeof nexus.settingsActivity !== "string" || !nexus.settingsActivity.trim())) {
    throw new Error(`${plugin.id}: nexus.settingsActivity must be a non-blank string when present`);
  }
  if (!Number.isInteger(nexus.minHostVersionCode) || nexus.minHostVersionCode < 1) {
    throw new Error(`${plugin.id}: nexus.minHostVersionCode must be a positive integer`);
  }

  const artifact = plugin.artifact;
  if (artifact.target !== "phone") {
    throw new Error(`${plugin.id}: artifact target must be phone`);
  }
  if (!isHttpsUrl(artifact.url)) {
    throw new Error(`${plugin.id}: artifact url must be an HTTPS URL`);
  }
  if (!/^[0-9a-f]{64}$/i.test(artifact.sha256 || "")) {
    throw new Error(`${plugin.id}: artifact sha256 must be 64 hexadecimal characters`);
  }
  if (!/^[0-9a-f]{64}$/.test(artifact.signerSha256 || "")) {
    throw new Error(`${plugin.id}: artifact signerSha256 must be 64 lowercase hexadecimal characters`);
  }
  if (!Number.isInteger(artifact.sizeBytes) || artifact.sizeBytes < 1) {
    throw new Error(`${plugin.id}: artifact sizeBytes must be a positive integer`);
  }
  if (!artifact.packageName || typeof artifact.packageName !== "string") {
    throw new Error(`${plugin.id}: artifact.packageName is required`);
  }
  if (!Number.isInteger(artifact.versionCode) || artifact.versionCode < 1) {
    throw new Error(`${plugin.id}: artifact.versionCode must be a positive integer`);
  }
  if (!artifact.versionName || typeof artifact.versionName !== "string") {
    throw new Error(`${plugin.id}: artifact.versionName is required`);
  }
}

function assetUrl(relativePath) {
  return `${publicBaseUrl}/${relativePath.split(path.sep).join("/")}`;
}

function attachAssetUrls(app, declaredIcon = false) {
  const iconAsset = declaredIcon ? app.iconAsset : `${app.id}.png`;
  const iconPath = path.join(iconDir, iconAsset);
  if (fs.existsSync(iconPath)) {
    app.iconAsset = iconAsset;
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

function stripPrivateFields(app) {
  delete app.update;
  delete app.listingSource;
  for (const artifact of app.artifacts || []) {
    delete artifact.update;
  }
  if (app.artifact) delete app.artifact.update;
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
    stripPrivateFields(app);
    return app;
  })
  .sort(registryOrder);

const duplicate = apps.map((app) => app.id).find((id, index, ids) => ids.indexOf(id) !== index);
if (duplicate) throw new Error(`Duplicate app id: ${duplicate}`);

if (!fs.existsSync(nexusPluginsDir)) {
  throw new Error("Missing plugins-nexus/ directory");
}

const nexusPlugins = fs.readdirSync(nexusPluginsDir)
  .filter((name) => name.endsWith(".json") && !name.endsWith(".template.json"))
  .sort()
  .map((name) => {
    const file = path.join(nexusPluginsDir, name);
    const plugin = readJson(file);
    assertNexusPlugin(plugin, file);
    attachAssetUrls(plugin, true);
    stripPrivateFields(plugin);
    return plugin;
  })
  .sort(nameCompare);

for (const key of ["id", "nexus.pluginId", "artifact.packageName"]) {
  const values = nexusPlugins.map((plugin) => key.split(".").reduce((value, part) => value?.[part], plugin));
  const repeated = values.find((value, index) => values.indexOf(value) !== index);
  if (repeated) throw new Error(`Duplicate Nexus plugin ${key}: ${repeated}`);
}

fs.mkdirSync(distDir, { recursive: true });
const brewFile = path.join(root, "brew.json");
let brewVersion, brewVersionCode, brewApkUrl, brewReleaseUrl, brewNotes, brewChanges;
if (fs.existsSync(brewFile)) {
  const brew = readJson(brewFile);
  brewVersion = brew.version;
  brewVersionCode = brew.versionCode;
  brewApkUrl = brew.apkUrl;
  brewReleaseUrl = brew.releaseUrl;
  brewNotes = brew.notes;
  brewChanges = Array.isArray(brew.changes) ? brew.changes.filter(Boolean) : undefined;
}

const output = {
  schemaVersion: 1,
  generatedAt: generatedAt.toISOString(),
  ...(brewVersion != null && {
    brewVersion,
    brewVersionCode,
    brewApkUrl,
    brewReleaseUrl,
    brewNotes,
    brewChanges,
  }),
  apps,
};

fs.writeFileSync(path.join(distDir, "apps.v1.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(`Built dist/apps.v1.json with ${apps.length} apps`);

const nexusOutput = {
  version: 1,
  plugins: nexusPlugins,
};
fs.writeFileSync(path.join(distDir, "nexus-plugins.v1.json"), `${JSON.stringify(nexusOutput, null, 2)}\n`);
console.log(`Built dist/nexus-plugins.v1.json with ${nexusPlugins.length} plugins`);
