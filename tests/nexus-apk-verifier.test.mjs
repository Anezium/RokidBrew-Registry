import assert from "node:assert/strict";
import test from "node:test";
import {
  compareArtifactMetadata,
  measuredArtifact,
  parseAaptBadging,
  validateManifestContract,
} from "../scripts/lib-nexus-apk-verifier.mjs";

const plugin = {
  nexus: {
    pluginId: "example-plugin",
    apiVersion: 3,
    capabilities: ["surfaces", "camera"],
  },
};

const validXmltree = `N: android=http://schemas.android.com/apk/res/android
E: manifest (line=2)
  A: package="com.example.plugin" (Raw: "com.example.plugin")
  E: application (line=5)
    E: service (line=6)
      A: android:name(0x01010003)=".ExamplePluginService" (Raw: ".ExamplePluginService")
      A: android:exported(0x01010010)=(type 0x12)0xffffffff
      E: intent-filter (line=9)
        E: action (line=10)
          A: android:name(0x01010003)="com.anezium.rokidbus.action.PLUGIN" (Raw: "com.anezium.rokidbus.action.PLUGIN")
      E: meta-data (line=12)
        A: android:name(0x01010003)="com.anezium.rokidbus.plugin.ID" (Raw: "com.anezium.rokidbus.plugin.ID")
        A: android:value(0x01010024)="example-plugin" (Raw: "example-plugin")
      E: meta-data (line=15)
        A: android:name(0x01010003)="com.anezium.rokidbus.plugin.API_VERSION" (Raw: "com.anezium.rokidbus.plugin.API_VERSION")
        A: android:value(0x01010024)=(type 0x10)0x3
      E: meta-data (line=18)
        A: android:name(0x01010003)="com.anezium.rokidbus.plugin.CAPABILITIES" (Raw: "com.anezium.rokidbus.plugin.CAPABILITIES")
        A: android:value(0x01010024)="surfaces microphone camera" (Raw: "surfaces microphone camera")
`;

test("accepts the Nexus plugin service and headless manifest contract", () => {
  assert.deepEqual(validateManifestContract(validXmltree, plugin), []);
});

const manifestFailureCases = [
  [
    "exported plugin service count",
    validXmltree.replace("0xffffffff", "0x0"),
    "manifest.pluginService",
  ],
  [
    "duplicate exported plugin services",
    `${validXmltree}    E: service (line=21)
      A: android:name(0x01010003)=".OtherPluginService" (Raw: ".OtherPluginService")
      A: android:exported(0x01010010)=(type 0x12)0xffffffff
      E: intent-filter (line=24)
        E: action (line=25)
          A: android:name(0x01010003)="com.anezium.rokidbus.action.PLUGIN" (Raw: "com.anezium.rokidbus.action.PLUGIN")
`,
    "manifest.pluginService",
  ],
  [
    "plugin id metadata",
    validXmltree.replaceAll("example-plugin", "other-plugin"),
    "nexus.pluginId",
  ],
  [
    "API version metadata",
    validXmltree.replace("(type 0x10)0x3", "(type 0x10)0x2"),
    "nexus.apiVersion",
  ],
  [
    "requested capability subset",
    validXmltree.replaceAll("surfaces microphone camera", "surfaces microphone"),
    "nexus.capabilities",
  ],
  [
    "headless activity rule",
    `${validXmltree}    E: activity (line=21)
      A: android:name(0x01010003)=".MainActivity" (Raw: ".MainActivity")
      E: intent-filter (line=23)
        E: action (line=24)
          A: android:name(0x01010003)="android.intent.action.MAIN" (Raw: "android.intent.action.MAIN")
        E: category (line=26)
          A: android:name(0x01010003)="android.intent.category.LAUNCHER" (Raw: "android.intent.category.LAUNCHER")
`,
    "manifest.activities",
  ],
];

for (const [description, xmltree, field] of manifestFailureCases) {
  test(`rejects a manifest with an invalid ${description}`, () => {
    assert.equal(validateManifestContract(xmltree, plugin).some((issue) => issue.field === field), true);
  });
}

test("parses aapt package and version metadata", () => {
  assert.deepEqual(
    parseAaptBadging(
      "package: name='com.example.plugin' versionCode='42' versionName='1.2.3' platformBuildVersionName=''\n",
    ),
    { packageName: "com.example.plugin", versionCode: 42, versionName: "1.2.3" },
  );
});

test("compares every pinned artifact field with measured APK values", () => {
  const bytes = Buffer.from("example APK fixture");
  const signerSha256 = "1".repeat(64);
  const actual = measuredArtifact(bytes, {
    packageName: "com.example.plugin",
    versionCode: 42,
    versionName: "1.2.3",
  }, signerSha256);
  assert.deepEqual(compareArtifactMetadata({ ...actual }, actual), []);

  const expected = Object.fromEntries(Object.entries(actual).map(([field, value]) => [
    field,
    typeof value === "number" ? value + 1 : `wrong-${value}`,
  ]));
  assert.deepEqual(
    compareArtifactMetadata(expected, actual).map((issue) => issue.field).sort(),
    [
      "artifact.packageName",
      "artifact.sha256",
      "artifact.signerSha256",
      "artifact.sizeBytes",
      "artifact.versionCode",
      "artifact.versionName",
    ],
  );
});
