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

test("update configs never pin a version-like release tag", () => {
  const offenders = [];
  for (const name of fs.readdirSync(appsDir).filter((file) => file.endsWith(".json"))) {
    const app = JSON.parse(fs.readFileSync(path.join(appsDir, name), "utf8"));
    for (const { where, config } of updateConfigs(app)) {
      if (config.disabled) continue;
      const release = config.release || config.tag;
      if (!release || release === "latest") continue;
      if (/^v?\d+(?:[._-]\d+)*/i.test(release)) {
        offenders.push(`${name} (${where}): "${release}"`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Version-like release pins stop tracking upstream (and rot if the release is deleted); use "latest" or a rolling tag instead:\n${offenders.join("\n")}`,
  );
});
