import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appsDir = path.join(root, "apps");

function updateConfigs(app) {
  const configs = [];
  if (app.update) configs.push({ where: "app", config: app.update });
  for (const artifact of app.artifacts || []) {
    if (artifact.update) configs.push({ where: `artifact:${artifact.target}`, config: artifact.update });
  }
  return configs;
}

function assetPatterns(app) {
  const found = [];
  const walk = (value, where) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${where}[${index}]`));
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key === "match" && typeof entry === "string") found.push({ where, pattern: entry });
      else walk(entry, where ? `${where}.${key}` : key);
    }
  };
  walk(app, "");
  return found;
}

test("asset match patterns are valid regular expressions", () => {
  const offenders = [];
  for (const name of fs.readdirSync(appsDir).filter((file) => file.endsWith(".json"))) {
    const app = JSON.parse(fs.readFileSync(path.join(appsDir, name), "utf8"));
    for (const { where, pattern } of assetPatterns(app)) {
      try {
        new RegExp(pattern);
      } catch (error) {
        offenders.push(`${name} (${where}): ${error.message}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `A pattern that fails to compile drops its app from every update check, silently pinning it to whatever version is in the registry:\n${offenders.join("\n")}`,
  );
});

test("stable update configs never pin a version-like release tag", () => {
  const offenders = [];
  for (const name of fs.readdirSync(appsDir).filter((file) => file.endsWith(".json"))) {
    const app = JSON.parse(fs.readFileSync(path.join(appsDir, name), "utf8"));
    for (const { where, config } of updateConfigs(app)) {
      if (config.disabled) continue;
      const release = config.release || config.tag;
      if (!release || release === "latest") continue;
      if (/(?:alpha|beta|rc|dev|preview)/i.test(release)) continue;
      if (/^v?\d+(?:[._-]\d+)*/i.test(release)) {
        offenders.push(`${name} (${where}): "${release}"`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Stable version-like release pins stop tracking upstream (and rot if the release is deleted); use "latest" or a rolling tag instead:\n${offenders.join("\n")}`,
  );
});
