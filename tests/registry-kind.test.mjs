import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  normalizeRegistryKind,
  registryFile,
  releasesForRegistryKind,
} from "../scripts/lib-github-content.mjs";

test("registry kind defaults to the existing app namespace", () => {
  assert.equal(normalizeRegistryKind(), "app");
  assert.equal(registryFile("/registry", "example"), path.join("/registry", "apps", "example.json"));
});

test("nexus-plugin maps to its namespace and fixed release shape", () => {
  assert.equal(
    registryFile("/registry", "feeds", "nexus-plugin"),
    path.join("/registry", "plugins-nexus", "feeds.json"),
  );
  assert.deepEqual(
    releasesForRegistryKind([
      {
        version: "feeds-v0.1.0",
        date: "2026-01-02T03:04:05.000Z",
        sourceReleaseUrl: "https://github.com/Anezium/feeds/releases/tag/feeds-v0.1.0",
        notes: "Initial release.",
        changes: ["Ignored app-only field"],
      },
    ], "nexus-plugin"),
    [
      {
        version: "0.1.0",
        date: "2026-01-02T03:04:05.000Z",
        notes: "Initial release.",
      },
    ],
  );
});

test("unsupported registry kinds fail clearly", () => {
  assert.throws(() => normalizeRegistryKind("plugin"), /expected app or nexus-plugin/);
});
