import assert from "node:assert/strict";
import test from "node:test";
import { nexusPluginFromApp } from "../scripts/add-app-from-url.mjs";

const app = {
  id: "example-plugin",
  name: "Example Plugin",
  category: "Utility",
  summary: "Example summary.",
  description: "Example description.",
  author: "Example",
  sourceUrl: "https://github.com/example/plugin",
  screenshotAssets: [],
  releases: [],
  artifacts: [{ target: "phone", url: "https://github.com/example/plugin/releases/plugin.apk" }],
};
const release = { published_at: "2026-01-02T03:04:05.000Z" };

test("Nexus ingestion omits settingsActivity when the option is absent", () => {
  const plugin = nexusPluginFromApp(app, release, { pluginId: app.id });
  assert.equal(Object.hasOwn(plugin.nexus, "settingsActivity"), false);
});

test("Nexus ingestion retains settingsActivity when supplied", () => {
  const plugin = nexusPluginFromApp(app, release, {
    pluginId: app.id,
    settingsActivity: ".ExampleSettingsActivity",
  });
  assert.equal(plugin.nexus.settingsActivity, ".ExampleSettingsActivity");
});
