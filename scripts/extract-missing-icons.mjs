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

function findApktool() {
  if (process.env.APKTOOL_JAR && fs.existsSync(process.env.APKTOOL_JAR)) {
    return { command: "java", prefix: ["-jar", process.env.APKTOOL_JAR] };
  }
  if (commandExists("apktool")) return { command: "apktool", prefix: [] };
  return null;
}

function runApktool(apktool, args) {
  return run(apktool.command, [...apktool.prefix, ...args]);
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

function xmlAttr(text, name) {
  const match = text.match(new RegExp(`(?:android:)?${name}="([^"]+)"`));
  return match?.[1] || null;
}

function numberAttr(text, name, fallback) {
  const value = xmlAttr(text, name);
  if (!value) return fallback;
  const match = value.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : fallback;
}

function colorParts(color) {
  if (!color) return null;
  if (/^#[0-9a-f]{8}$/i.test(color)) {
    const a = parseInt(color.slice(1, 3), 16) / 255;
    return { color: `#${color.slice(3)}`, opacity: Number(a.toFixed(3)) };
  }
  if (/^#[0-9a-f]{6}$/i.test(color) || /^#[0-9a-f]{3}$/i.test(color)) {
    return { color, opacity: 1 };
  }
  return null;
}

function resolveColor(decodedDir, value) {
  if (!value) return null;
  if (value.startsWith("#")) return value;
  const match = value.match(/^@color\/(.+)$/);
  if (!match) return null;

  const valuesDir = path.join(decodedDir, "res", "values");
  if (!fs.existsSync(valuesDir)) return null;
  for (const file of fs.readdirSync(valuesDir).filter((name) => name.endsWith(".xml"))) {
    const xml = fs.readFileSync(path.join(valuesDir, file), "utf8");
    const color = xml.match(new RegExp(`<color\\s+name="${match[1]}"[^>]*>(#[^<]+)</color>`));
    if (color) return color[1].trim();
  }
  return null;
}

function colorStyle(decodedDir, value, property) {
  const parsed = colorParts(resolveColor(decodedDir, value));
  if (!parsed) return `${property}="none"`;
  const opacity = parsed.opacity < 1 ? ` ${property}-opacity="${parsed.opacity}"` : "";
  return `${property}="${parsed.color}"${opacity}`;
}

function resourceRef(ref) {
  const match = ref?.match(/^@([^/]+)\/(.+)$/);
  return match ? { type: match[1], name: match[2] } : null;
}

function densityScore(directory) {
  if (/anydpi/.test(directory)) return 70;
  if (/xxxhdpi|640/.test(directory)) return 60;
  if (/xxhdpi|480/.test(directory)) return 50;
  if (/xhdpi|320/.test(directory)) return 40;
  if (/hdpi|240/.test(directory)) return 30;
  if (/mdpi|160/.test(directory)) return 20;
  return 10;
}

function resolveResourceFile(decodedDir, ref) {
  const parsed = resourceRef(ref);
  if (!parsed) return null;

  const resDir = path.join(decodedDir, "res");
  if (!fs.existsSync(resDir)) return null;

  const candidates = [];
  for (const directory of fs.readdirSync(resDir)) {
    if (directory !== parsed.type && !directory.startsWith(`${parsed.type}-`)) continue;
    const dirPath = path.join(resDir, directory);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    for (const file of fs.readdirSync(dirPath)) {
      const extension = path.extname(file);
      if (path.basename(file, extension) === parsed.name) {
        candidates.push({
          file: path.join(dirPath, file),
          score: densityScore(directory) + (extension === ".xml" ? 5 : 0),
        });
      }
    }
  }

  return candidates.sort((a, b) => b.score - a.score)[0]?.file || null;
}

function svgEscape(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function drawableToSvgElements(decodedDir, ref, box) {
  const file = resolveResourceFile(decodedDir, ref);
  if (!file || !fs.existsSync(file)) return "";

  if (/\.(png|jpe?g)$/i.test(file)) {
    const mime = /\.jpe?g$/i.test(file) ? "image/jpeg" : "image/png";
    const bytes = fs.readFileSync(file).toString("base64");
    return `<image x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" href="data:${mime};base64,${bytes}" preserveAspectRatio="xMidYMid meet" />`;
  }

  if (!file.endsWith(".xml")) return "";

  const xml = fs.readFileSync(file, "utf8");
  if (/<shape\b/.test(xml)) {
    const solid = xml.match(/<solid\b([^>]*)\/?>/);
    const color = colorStyle(decodedDir, xmlAttr(solid?.[1] || "", "color") || "#00000000", "fill");
    return `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" ${color} />`;
  }

  if (/<vector\b/.test(xml)) {
    const vectorTag = xml.match(/<vector\b([^>]*)>/)?.[1] || "";
    const viewportWidth = numberAttr(vectorTag, "viewportWidth", 108);
    const viewportHeight = numberAttr(vectorTag, "viewportHeight", 108);
    const scale = Math.min(box.width / viewportWidth, box.height / viewportHeight);
    const x = box.x + (box.width - viewportWidth * scale) / 2;
    const y = box.y + (box.height - viewportHeight * scale) / 2;

    const paths = [...xml.matchAll(/<path\b([^>]*)\/?>/g)].map((match) => {
      const attrs = match[1];
      const pathData = xmlAttr(attrs, "pathData");
      if (!pathData) return "";
      const fill = xmlAttr(attrs, "fillColor");
      const stroke = xmlAttr(attrs, "strokeColor");
      const strokeWidth = numberAttr(attrs, "strokeWidth", 0);
      const fillStyle = fill ? colorStyle(decodedDir, fill, "fill") : 'fill="none"';
      const strokeStyle = stroke ? `${colorStyle(decodedDir, stroke, "stroke")} stroke-width="${strokeWidth}"` : 'stroke="none"';
      return `<path d="${svgEscape(pathData)}" ${fillStyle} ${strokeStyle} />`;
    }).join("");

    return `<g transform="translate(${x} ${y}) scale(${scale})">${paths}</g>`;
  }

  return "";
}

function convertSvgToPng(svgPath, output) {
  if (commandExists("rsvg-convert")) {
    run("rsvg-convert", ["-w", "192", "-h", "192", svgPath, "-o", output]);
    return true;
  }
  if (commandExists("magick")) {
    run("magick", [svgPath, output]);
    return true;
  }
  if (process.platform !== "win32" && commandExists("convert")) {
    run("convert", [svgPath, output]);
    return true;
  }
  return false;
}

function renderDecodedIcon(app, decodedDir, iconPath) {
  const manifestPath = path.join(decodedDir, "AndroidManifest.xml");
  if (!fs.existsSync(manifestPath)) return null;

  const manifest = fs.readFileSync(manifestPath, "utf8");
  const iconRef = xmlAttr(manifest.match(/<application\b([^>]*)>/)?.[1] || "", "icon");
  if (!iconRef) return null;

  const iconFile = resolveResourceFile(decodedDir, iconRef);
  if (!iconFile || !iconFile.endsWith(".xml")) return null;

  const xml = fs.readFileSync(iconFile, "utf8");
  const size = 192;
  let svgBody = "";

  if (/<adaptive-icon\b/.test(xml)) {
    const background = xmlAttr(xml.match(/<background\b([^>]*)\/?>/)?.[1] || "", "drawable");
    const foreground = xmlAttr(xml.match(/<foreground\b([^>]*)\/?>/)?.[1] || "", "drawable");
    svgBody += background ? drawableToSvgElements(decodedDir, background, { x: 0, y: 0, width: size, height: size }) : "";
    svgBody += foreground ? drawableToSvgElements(decodedDir, foreground, { x: 0, y: 0, width: size, height: size }) : "";
  } else {
    svgBody += drawableToSvgElements(decodedDir, iconRef, { x: 0, y: 0, width: size, height: size });
  }

  if (!svgBody) return null;

  const svgPath = path.join(tmpDir, `${app.id}.svg`);
  fs.writeFileSync(svgPath, `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${svgBody}</svg>\n`);
  if (!convertSvgToPng(svgPath, iconPath)) return { status: "skip", reason: "no SVG renderer available" };
  return { status: "ok", entry: path.relative(decodedDir, iconFile).split(path.sep).join("/") };
}

function extractDecodedIcon(app, apkPath, iconPath, apktool) {
  if (!apktool) return { status: "skip", reason: "no raster icon found and apktool unavailable" };
  const decodedDir = path.join(tmpDir, "apktool", app.id);
  fs.rmSync(decodedDir, { recursive: true, force: true });
  runApktool(apktool, ["d", "-f", "-s", "-o", decodedDir, apkPath]);
  return renderDecodedIcon(app, decodedDir, iconPath) || { status: "skip", reason: "no renderable launcher icon found" };
}

async function extractIcon(app, aapt, apktool) {
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
    const rendered = extractDecodedIcon(app, apkPath, iconPath, apktool);
    const validationError = rendered.status === "ok" ? validateGeneratedIcon(iconPath) : null;
    if (validationError) return { id: app.id, status: "skip", reason: validationError };
    return { id: app.id, ...rendered };
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
const apktool = findApktool();
if (!apktool) {
  console.warn("apktool not found; adaptive/vector icons will be skipped.");
}

const apps = fs.readdirSync(appsDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => readJson(path.join(appsDir, name)));

const results = [];
for (const app of apps) {
  try {
    const result = await extractIcon(app, aapt, apktool);
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
