import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseApksignerCertificateSha256 } from "./lib-apk-signing.mjs";
import {
  compareArtifactMetadata,
  measuredArtifact,
  parseAaptBadging,
  validateManifestContract,
} from "./lib-nexus-apk-verifier.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const usage = "Usage: node scripts/verify-nexus-plugin-apks.mjs --base <git-sha> --head <git-sha>";

function valueFor(flag) {
  const index = process.argv.lastIndexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    shell: process.platform === "win32" && /\.(?:bat|cmd)$/i.test(command),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function commandExists(command) {
  return spawnSync(process.platform === "win32" ? "where" : "which", [command], {
    encoding: "utf8",
  }).status === 0;
}

function findBuildTool({ envName, command, alternatives = [] }) {
  const configured = process.env[envName];
  if (configured && fs.existsSync(configured)) return configured;
  if (commandExists(command)) return command;
  for (const alternative of alternatives) {
    if (commandExists(alternative)) return alternative;
  }

  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const buildTools = androidHome && path.join(androidHome, "build-tools");
  if (!buildTools || !fs.existsSync(buildTools)) return null;
  const extension = process.platform === "win32" && command === "apksigner" ? ".bat" :
    process.platform === "win32" ? ".exe" : "";
  const names = [command, ...alternatives].map((name) => `${name}${extension}`);

  for (const version of fs.readdirSync(buildTools)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
    for (const name of names) {
      const candidate = path.join(buildTools, version, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function changedPluginFiles(base, head) {
  const output = run("git", [
    "diff", "--no-renames", "--diff-filter=AM", "--name-only", "-z", base, head, "--",
    "plugins-nexus/*.json",
  ]);
  return output.split("\0")
    .filter(Boolean)
    .map((name) => name.replace(/\\/g, "/"))
    .filter((name) => /^plugins-nexus\/[^/]+\.json$/.test(name))
    .filter((name) => !name.endsWith(".template.json"));
}

async function download(url, output) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("artifact.url is not HTTPS");
  const response = await fetch(parsed, {
    headers: { "User-Agent": "RokidBrew-Nexus-PR-Verification" },
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`download returned HTTP ${response.status} ${response.statusText}`);
  }
  if (new URL(response.url).protocol !== "https:") {
    throw new Error("artifact.url redirected to a non-HTTPS URL");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(output, bytes);
  return bytes;
}

function aaptXmltreeArgs(aapt, apkPath) {
  return path.basename(aapt).toLowerCase().startsWith("aapt2")
    ? ["dump", "xmltree", "--file", "AndroidManifest.xml", apkPath]
    : ["dump", "xmltree", apkPath, "AndroidManifest.xml"];
}

function reportError(errors, file, field, failure) {
  errors.push({ file, field, message: failure instanceof Error ? failure.message : String(failure) });
}

async function verifyPlugin(file, tools, tempDir) {
  const errors = [];
  let plugin;
  try {
    plugin = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  } catch (failure) {
    reportError(errors, file, "manifest JSON", failure);
    return errors;
  }

  const apkPath = path.join(tempDir, `${path.basename(file, ".json")}.apk`);
  let bytes;
  try {
    bytes = await download(plugin.artifact.url, apkPath);
  } catch (failure) {
    reportError(errors, file, "artifact.url", failure);
    return errors;
  }

  let badging;
  try {
    badging = parseAaptBadging(run(tools.aapt, ["dump", "badging", apkPath]));
  } catch (failure) {
    reportError(errors, file, "artifact.packageName/versionCode/versionName", failure);
  }

  let signerSha256;
  try {
    signerSha256 = parseApksignerCertificateSha256(
      run(tools.apksigner, ["verify", "--print-certs", apkPath]),
    );
  } catch (failure) {
    reportError(errors, file, "artifact.signerSha256", failure);
  }

  const measured = measuredArtifact(bytes, badging || {}, signerSha256);
  const measuredFields = ["sha256", "sizeBytes"];
  if (badging) measuredFields.push("packageName", "versionCode", "versionName");
  if (signerSha256) measuredFields.push("signerSha256");
  for (const issue of compareArtifactMetadata(plugin.artifact, measured, measuredFields)) {
    reportError(errors, file, issue.field, issue.message);
  }

  try {
    const xmltree = run(tools.aapt, aaptXmltreeArgs(tools.aapt, apkPath));
    for (const issue of validateManifestContract(xmltree, plugin)) {
      reportError(errors, file, issue.field, issue.message);
    }
  } catch (failure) {
    reportError(errors, file, "manifest.AndroidManifest.xml", failure);
  }

  return errors;
}

async function main() {
  const base = valueFor("--base");
  const head = valueFor("--head");
  if (!base || !head) throw new Error(usage);

  const files = changedPluginFiles(base, head);
  if (files.length === 0) {
    console.log("No added or changed Nexus plugin manifests to verify.");
    return;
  }

  const tools = {
    aapt: findBuildTool({ envName: "AAPT_PATH", command: "aapt", alternatives: ["aapt2"] }),
    apksigner: findBuildTool({ envName: "APKSIGNER_PATH", command: "apksigner" }),
  };
  if (!tools.aapt) throw new Error("Could not find aapt or aapt2; install Android build-tools or set AAPT_PATH");
  if (!tools.apksigner) {
    throw new Error("Could not find apksigner; install Android build-tools or set APKSIGNER_PATH");
  }

  console.log(`Verifying ${files.length} Nexus plugin APK manifest(s).`);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rokidbrew-nexus-verify-"));
  const errors = [];
  try {
    for (const file of files) {
      console.log(`verify ${file}`);
      errors.push(...await verifyPlugin(file, tools, tempDir));
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  if (errors.length > 0) {
    for (const issue of errors) {
      console.error(`ERROR ${issue.file}: ${issue.field}: ${issue.message}`);
    }
    throw new Error(`Nexus plugin APK verification failed with ${errors.length} error(s)`);
  }
  console.log(`Verified ${files.length} Nexus plugin APK manifest(s).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((failure) => {
    console.error(failure.message);
    process.exit(1);
  });
}
