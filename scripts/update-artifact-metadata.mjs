import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appsDir = path.join(root, "apps");
const tmpDir = path.join(root, ".tmp", "artifact-metadata");
const force = process.argv.includes("--force");

fs.mkdirSync(tmpDir, { recursive: true });

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
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

async function download(url, output) {
  const response = await fetch(url, {
    headers: { "User-Agent": "RokidBrew-Registry-Metadata" },
  });
  if (!response.ok) throw new Error(`download failed ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(output, bytes);
  return bytes;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function parseBadging(aapt, apkPath) {
  const badging = run(aapt, ["dump", "badging", apkPath]);
  const match = badging.match(/^package:\s+name='([^']+)'(?:\s+versionCode='([^']+)')?(?:\s+versionName='([^']*)')?/m);
  if (!match) return {};
  return {
    packageName: match[1],
    versionCode: match[2] ? Number(match[2]) : undefined,
    apkVersionName: match[3] || undefined,
  };
}

function needsMetadata(artifact) {
  return force ||
    !artifact.sha256 ||
    !artifact.sizeBytes ||
    !artifact.packageName ||
    !artifact.versionCode;
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

let updated = 0;
let skipped = 0;
let errors = 0;

for (const file of appFiles) {
  const app = readJson(file);
  let changed = false;

  for (const artifact of app.artifacts || []) {
    if (!needsMetadata(artifact)) {
      skipped += 1;
      continue;
    }

    const suffix = `${app.id}-${artifact.target}.apk`;
    const apkPath = path.join(tmpDir, suffix);
    try {
      const bytes = await download(artifact.url, apkPath);
      const badging = parseBadging(aapt, apkPath);
      artifact.sha256 = sha256(bytes);
      artifact.sizeBytes = bytes.length;
      if (badging.packageName) artifact.packageName = badging.packageName;
      if (badging.versionCode) artifact.versionCode = badging.versionCode;
      if (badging.apkVersionName && !artifact.versionName) artifact.versionName = badging.apkVersionName;
      changed = true;
      updated += 1;
      console.log(`ok     ${app.id}:${artifact.target} ${artifact.packageName || "no-package"} ${artifact.sizeBytes} bytes`);
    } catch (error) {
      errors += 1;
      console.log(`error  ${app.id}:${artifact.target} (${error.message})`);
    }
  }

  if (changed) writeJson(file, app);
}

console.log(`Updated ${updated} artifacts, skipped ${skipped}, errors ${errors}`);

if (errors > 0 && process.env.CI) {
  process.exitCode = 1;
}
