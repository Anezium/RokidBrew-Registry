import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builderSource = path.join(repoRoot, "scripts", "build-registry.mjs");
const pluginFixture = JSON.parse(fs.readFileSync(
  path.join(repoRoot, "plugins-nexus", "EXAMPLE.template.json"),
  "utf8",
));

const appFixture = {
  id: "example-app",
  name: "Example App",
  category: "Utility",
  type: "phone",
  version: "1.0.0",
  summary: "Builder test app.",
  author: "Example",
  sourceUrl: "https://github.com/example/example-app",
  artifacts: [
    {
      target: "phone",
      url: "https://github.com/example/example-app/releases/download/v1.0.0/example.apk",
    },
  ],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runBuild(plugins) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rokidbrew-registry-test-"));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(builderSource, path.join(root, "scripts", "build-registry.mjs"));
  writeJson(path.join(root, "apps", "example-app.json"), appFixture);
  fs.mkdirSync(path.join(root, "plugins-nexus"), { recursive: true });
  for (const plugin of plugins) {
    writeJson(path.join(root, "plugins-nexus", `${plugin.id || "missing-id"}.json`), plugin);
  }

  const result = spawnSync(process.execPath, [path.join(root, "scripts", "build-registry.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ROKIDBREW_GENERATED_AT: "2026-01-02T03:04:05.000Z",
    },
  });
  return { root, result };
}

function withBuild(plugins, assertion) {
  const build = runBuild(plugins);
  try {
    assertion(build);
  } finally {
    fs.rmSync(build.root, { recursive: true, force: true });
  }
}

test("builds the excluded example into the version 1 Nexus feed shape", () => {
  withBuild([], ({ root: appOnlyRoot, result: appOnlyResult }) => {
    assert.equal(appOnlyResult.status, 0, appOnlyResult.stderr || appOnlyResult.stdout);
    const appOnlyFeed = fs.readFileSync(path.join(appOnlyRoot, "dist", "apps.v1.json"), "utf8");

    withBuild([clone(pluginFixture)], ({ root, result }) => {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const feed = JSON.parse(fs.readFileSync(path.join(root, "dist", "nexus-plugins.v1.json"), "utf8"));
      assert.deepEqual(Object.keys(feed), ["version", "plugins"]);
      assert.equal(feed.version, 1);
      assert.equal(feed.plugins.length, 1);
      assert.equal(feed.plugins[0].nexus.pluginId, pluginFixture.nexus.pluginId);
      assert.equal(feed.plugins[0].artifact.packageName, pluginFixture.artifact.packageName);
      assert.equal(feed.plugins[0].artifact.signerSha256, pluginFixture.artifact.signerSha256);
      assert.equal(
        fs.readFileSync(path.join(root, "dist", "apps.v1.json"), "utf8"),
        appOnlyFeed,
        "adding a Nexus descriptor must not change the app feed bytes",
      );
    });
  });
});

const requiredCases = [
  ["id", (plugin) => delete plugin.id, /missing "id"/],
  ["kind", (plugin) => delete plugin.kind, /missing "kind"/],
  ["nexus.pluginId", (plugin) => delete plugin.nexus.pluginId, /nexus\.pluginId is required/],
  ["artifact.packageName", (plugin) => delete plugin.artifact.packageName, /artifact\.packageName is required/],
  ["artifact.sha256", (plugin) => delete plugin.artifact.sha256, /artifact sha256 must be 64 hexadecimal characters/],
  ["artifact.signerSha256", (plugin) => delete plugin.artifact.signerSha256, /artifact signerSha256 must be 64 lowercase hexadecimal characters/],
];

for (const [field, removeField, expected] of requiredCases) {
  test(`rejects a Nexus plugin missing ${field}`, () => {
    const plugin = clone(pluginFixture);
    removeField(plugin);
    withBuild([plugin], ({ result }) => {
      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}\n${result.stdout}`, expected);
    });
  });
}

test("rejects a non-lowercase artifact.signerSha256", () => {
  const plugin = clone(pluginFixture);
  plugin.artifact.signerSha256 = plugin.artifact.signerSha256.toUpperCase();
  withBuild([plugin], ({ result }) => {
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stderr}\n${result.stdout}`,
      /artifact signerSha256 must be 64 lowercase hexadecimal characters/,
    );
  });
});

test("rejects duplicate nexus.pluginId values", () => {
  const first = clone(pluginFixture);
  const second = clone(pluginFixture);
  second.id = "other-example-plugin";
  second.name = "Other Example Plugin";
  second.artifact.packageName = "com.anezium.rokidbus.plugin.otherexample";

  withBuild([first, second], ({ result }) => {
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /Duplicate Nexus plugin nexus\.pluginId: example-plugin/);
  });
});
