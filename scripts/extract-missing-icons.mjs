import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appsDir = path.join(root, "apps");
const iconDir = path.join(root, "assets", "icons");
const tmpDir = path.join(root, ".tmp", "icon-extract");

fs.mkdirSync(iconDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

const force = process.argv.includes("--force");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
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

function firstArtifactUrl(app) {
  const preferred = app.artifacts?.find((artifact) => artifact.target === "glasses") ||
    app.artifacts?.find((artifact) => artifact.target === "phone") ||
    app.artifacts?.[0];
  return preferred?.url;
}

async function download(url, output) {
  const response = await fetch(url, {
    headers: { "User-Agent": "RokidBrew-Registry-IconExtractor" },
  });
  if (!response.ok) throw new Error(`download failed ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(output, bytes);
}

function iconCandidatesFromBadging(badging) {
  const candidates = [];
  for (const line of badging.split(/\r?\n/)) {
    const match = line.match(/^application-icon(?:-\d+)?:'([^']+)'/);
    if (match) candidates.push(match[1]);
  }
  const fallback = badging.match(/application:.* icon='([^']+)'/);
  if (fallback) candidates.push(fallback[1]);
  return [...new Set(candidates)].filter(Boolean).reverse();
}

function listZip(apk) {
  if (commandExists("unzip")) return run("unzip", ["-Z1", apk]).split(/\r?\n/).filter(Boolean);
  if (commandExists("jar")) return run("jar", ["tf", apk]).split(/\r?\n/).filter(Boolean);
  throw new Error("Neither unzip nor jar is available");
}

function extractZipEntry(apk, entry, output) {
  if (commandExists("unzip")) {
    const bytes = spawnSync("unzip", ["-p", apk, entry], { encoding: "buffer" });
    if (bytes.status !== 0 || !bytes.stdout?.length) {
      throw new Error(`could not extract ${entry}`);
    }
    fs.writeFileSync(output, bytes.stdout);
    return;
  }
  if (commandExists("jar")) {
    const extractDir = path.join(tmpDir, "extract", path.basename(output, path.extname(output)));
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    run("jar", ["xf", apk, entry], { cwd: extractDir });
    const extracted = path.join(extractDir, entry);
    if (!fs.existsSync(extracted)) throw new Error(`could not extract ${entry}`);
    fs.copyFileSync(extracted, output);
    return;
  }
  throw new Error("Neither unzip nor jar is available");
}

function looksRaster(entry) {
  return /\.(png|webp|jpg|jpeg)$/i.test(entry);
}

function isRejectedIconEntry(entry) {
  return /notification|notify|status|panel|badge|banner|splash|background|bg|shadow|small_icon|ic_stat|monochrome/i.test(entry);
}

function looksLauncherLike(entry) {
  return /(^|\/)(ic_launcher|launcher|app_icon|appicon|logo|icon)[^/]*\.(png|webp|jpe?g)$/i.test(entry);
}

function bestFallbackEntry(entries) {
  const ranked = entries
    .filter((entry) => looksRaster(entry))
    .filter((entry) => /res\/(mipmap|drawable)/.test(entry))
    .filter((entry) => !isRejectedIconEntry(entry))
    .filter((entry) => looksLauncherLike(entry))
    .sort((a, b) => {
      const score = (entry) => {
        let value = 0;
        if (/xxxhdpi|640|432/.test(entry)) value += 50;
        if (/xxhdpi|480/.test(entry)) value += 40;
        if (/xhdpi|320/.test(entry)) value += 30;
        if (/ic_launcher/i.test(entry)) value += 20;
        if (/foreground/i.test(entry)) value += 8;
        if (/round/i.test(entry)) value -= 10;
        return value;
      };
      return score(b) - score(a);
    });
  return ranked[0];
}

function pngDimensions(file) {
  const bytes = fs.readFileSync(file);
  const pngSignature = "89504e470d0a1a0a";
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== pngSignature) return null;
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function validateGeneratedIcon(iconPath) {
  const dimensions = pngDimensions(iconPath);
  if (!dimensions) return null;
  if (dimensions.width < 48 || dimensions.height < 48) {
    fs.rmSync(iconPath, { force: true });
    return `icon too small (${dimensions.width}x${dimensions.height})`;
  }
  return null;
}

async function extractIcon(app, aapt) {
  const iconPath = path.join(iconDir, `${app.id}.png`);
  if (!force && fs.existsSync(iconPath)) return { id: app.id, status: "exists" };

  const url = firstArtifactUrl(app);
  if (!url) return { id: app.id, status: "skip", reason: "no artifact url" };

  const apkPath = path.join(tmpDir, `${app.id}.apk`);
  await download(url, apkPath);

  const badging = run(aapt, ["dump", "badging", apkPath]);
  const entries = listZip(apkPath);
  const candidates = iconCandidatesFromBadging(badging);

  let selected = candidates.find((entry) => looksRaster(entry) && entries.includes(entry) && !isRejectedIconEntry(entry));
  if (!selected) selected = bestFallbackEntry(entries);

  if (!selected) {
    return { id: app.id, status: "skip", reason: "no raster icon found" };
  }

  const extracted = path.join(tmpDir, `${app.id}${path.extname(selected)}`);
  extractZipEntry(apkPath, selected, extracted);

  if (/\.png$/i.test(extracted)) {
    fs.copyFileSync(extracted, iconPath);
  } else if (commandExists("magick")) {
    run("magick", [extracted, iconPath]);
  } else if (commandExists("convert")) {
    run("convert", [extracted, iconPath]);
  } else {
    return { id: app.id, status: "skip", reason: `${selected} needs ImageMagick conversion` };
  }

  const validationError = validateGeneratedIcon(iconPath);
  if (validationError) return { id: app.id, status: "skip", reason: validationError };

  return { id: app.id, status: "ok", entry: selected };
}

const aapt = findAapt();
if (!aapt) {
  console.error("Could not find aapt. Install Android build-tools or set AAPT_PATH.");
  process.exit(1);
}

const apps = fs.readdirSync(appsDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => readJson(path.join(appsDir, name)));

const results = [];
for (const app of apps) {
  try {
    const result = await extractIcon(app, aapt);
    results.push(result);
    console.log(`${result.status.padEnd(6)} ${app.id}${result.entry ? ` <- ${result.entry}` : result.reason ? ` (${result.reason})` : ""}`);
  } catch (error) {
    results.push({ id: app.id, status: "error", reason: error.message });
    console.log(`error  ${app.id} (${error.message})`);
  }
}

const ok = results.filter((result) => result.status === "ok").length;
const skipped = results.filter((result) => result.status === "skip").length;
const errors = results.filter((result) => result.status === "error").length;

console.log(`Extracted ${ok} icons, skipped ${skipped}, errors ${errors}`);

if (errors > 0 && process.env.CI) {
  process.exitCode = 1;
}
