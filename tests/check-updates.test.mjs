import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const allowMissingAsset of [undefined, false, true]) {
  test(`glasses-only release with phone allowMissingAsset=${allowMissingAsset}`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rokidbrew-updates-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "scripts"));
    fs.mkdirSync(path.join(root, "apps"));
    for (const filename of ["check-updates.mjs", "lib-github-content.mjs"]) {
      fs.copyFileSync(path.join(repo, "scripts", filename), path.join(root, "scripts", filename));
    }
    const app = JSON.parse(fs.readFileSync(path.join(repo, "apps/rokid-nexus.json"), "utf8"));
    app.artifacts = app.artifacts.filter((artifact) => artifact.target === "phone");
    const rule = app.update.assets.find((entry) => entry.target === "phone");
    delete rule.allowMissingAsset;
    if (allowMissingAsset !== undefined) rule.allowMissingAsset = allowMissingAsset;
    const appPath = path.join(root, "apps/rokid-nexus.json");
    const before = JSON.stringify(app);
    fs.writeFileSync(appPath, before);
    const release = {
      tag_name: "v1.8.2",
      assets: [{ name: "nexus-glasses-1.8.2.apk" }],
    };
    const mockPath = path.join(root, "mock-fetch.mjs");
    fs.writeFileSync(mockPath, `globalThis.fetch = async (url) => {
      if (url !== "https://api.github.com/repos/Anezium/Rokid-Nexus/releases/latest") {
        throw new Error("Unexpected request: " + url);
      }
      return new Response(JSON.stringify(${JSON.stringify(release)}));
    };`);
    const result = spawnSync(process.execPath, [
      "--import", pathToFileURL(mockPath).href, path.join(root, "scripts/check-updates.mjs"), "--app", app.id, "--strict",
    ], {
      encoding: "utf8",
      env: { ...process.env, AAPT_PATH: process.execPath },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = fs.readFileSync(path.join(root, ".tmp/update-report.md"), "utf8");
    assert.match(report, new RegExp(`Warnings: ${allowMissingAsset === true ? 0 : 1}`));
    assert.match(report, /Errors: 0/);
    assert.match(report, /Updates: 0/);
    assert.match(report, /skip\s+rokid-nexus:phone no matching APK/);
    assert.equal(fs.readFileSync(appPath, "utf8"), before, "keep the phone on its existing release");
  });
}
