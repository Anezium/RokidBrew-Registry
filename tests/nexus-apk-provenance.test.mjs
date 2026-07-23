import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  deriveGitHubRelease,
  extractZipEntry,
  parseGitLsRemoteTagCommit,
  parseVersionControlInfo,
  verifyApkBuildProvenance,
  VERSION_CONTROL_INFO_ENTRY,
} from "../scripts/lib-nexus-apk-provenance.mjs";

const revision = "365ae01453211fdc1ad1b5d5677d7f44dac3d4d6";
const artifactUrl = "https://github.com/beyondlevi/lume-nexus/releases/download/lume-v1.0.4/lume.apk";
const textproto = `repositories {
  system: GIT
  local_root_path: "$PROJECT_DIR"
  revision: "${revision}"
}
`;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipFixture(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const { name, content, method } of entries) {
    const nameBytes = Buffer.from(name);
    const bytes = Buffer.from(content);
    const compressed = method === 8 ? deflateRawSync(bytes) : bytes;
    const checksum = crc32(bytes);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(bytes.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localParts.push(localHeader, nameBytes, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(bytes.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, nameBytes);
    localOffset += localHeader.length + nameBytes.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

test("parses a valid AGP Git version-control textproto", () => {
  assert.deepEqual(parseVersionControlInfo(textproto), { system: "GIT", revision });
});

test("rejects a version-control textproto with no revision", () => {
  assert.throws(
    () => parseVersionControlInfo(textproto.replace(/^\s*revision:.*\n/m, "")),
    /missing revision/,
  );
});

test("rejects a non-Git version-control textproto", () => {
  assert.throws(
    () => parseVersionControlInfo(textproto.replace("system: GIT", "system: SVN")),
    /must declare system GIT, found "SVN"/,
  );
});

test("rejects a revision that is not a 40-character Git hash", () => {
  assert.throws(
    () => parseVersionControlInfo(textproto.replace(revision, "abc123")),
    /exactly 40 hexadecimal/,
  );
});

test("derives the source repository and decoded release tag from artifact.url", () => {
  assert.deepEqual(
    deriveGitHubRelease(
      "https://github.com/example/plugin/releases/download/release%2Fv1.2.3/plugin.apk?download=1",
    ),
    { repoUrl: "https://github.com/example/plugin", tag: "release/v1.2.3" },
  );
});

test("rejects a malformed GitHub release artifact URL", () => {
  assert.throws(
    () => deriveGitHubRelease("https://github.com/example/plugin/releases/latest/download/plugin.apk"),
    /must match https:\/\/github\.com/,
  );
});

test("prefers a peeled annotated-tag commit and falls back to a lightweight tag", () => {
  const tagObject = "1".repeat(40);
  const peeledCommit = "2".repeat(40);
  assert.equal(
    parseGitLsRemoteTagCommit(
      `${tagObject}\trefs/tags/v1.2.3\n${peeledCommit}\trefs/tags/v1.2.3^{}\n`,
      "v1.2.3",
    ),
    peeledCommit,
  );
  assert.equal(
    parseGitLsRemoteTagCommit(`${revision}\trefs/tags/v1.2.3\n`, "v1.2.3"),
    revision,
  );
});

for (const [description, method] of [["stored", 0], ["deflated", 8]]) {
  test(`extracts a ${description} version-control entry from an in-memory ZIP`, () => {
    const zip = zipFixture([
      { name: "unrelated.txt", content: "fixture", method: 0 },
      { name: VERSION_CONTROL_INFO_ENTRY, content: textproto, method },
    ]);
    assert.equal(extractZipEntry(zip, VERSION_CONTROL_INFO_ENTRY).toString("utf8"), textproto);
    assert.equal(extractZipEntry(zip, "missing.txt"), null);
  });
}

test("requires the APK to contain AGP version-control information", () => {
  const zip = zipFixture([{ name: "unrelated.txt", content: "fixture", method: 0 }]);
  assert.throws(
    () => verifyApkBuildProvenance(zip, artifactUrl, {
      resolveTagCommit: () => revision,
    }),
    /APK cannot be authenticated.*AGP vcsInfo enabled/s,
  );
});

test("reports both revisions and the dirty-tree publishing hint on mismatch", () => {
  const tagCommit = "abcffeb71ccedb9fb5356733f5f4f63e842ec3a1";
  const zip = zipFixture([
    { name: VERSION_CONTROL_INFO_ENTRY, content: textproto, method: 8 },
  ]);
  assert.throws(
    () => verifyApkBuildProvenance(zip, artifactUrl, {
      resolveTagCommit: () => tagCommit,
    }),
    (failure) => {
      assert.match(failure.message, new RegExp(revision));
      assert.match(failure.message, new RegExp(tagCommit));
      assert.match(failure.message, /dirty-tree builds cannot be authenticated/);
      assert.match(failure.message, /plugins\/AGENTS\.md Publishing step 5/);
      return true;
    },
  );
});

test("reports the release tag and repository when tag resolution fails", () => {
  const zip = zipFixture([
    { name: VERSION_CONTROL_INFO_ENTRY, content: textproto, method: 8 },
  ]);
  assert.throws(
    () => verifyApkBuildProvenance(zip, artifactUrl, {
      resolveTagCommit: () => {
        throw new Error("network unavailable");
      },
    }),
    /could not resolve release tag "lume-v1\.0\.4" from https:\/\/github\.com\/beyondlevi\/lume-nexus/,
  );
});

test("accepts an APK whose embedded revision matches the release tag", () => {
  const zip = zipFixture([
    { name: VERSION_CONTROL_INFO_ENTRY, content: textproto, method: 8 },
  ]);
  assert.deepEqual(
    verifyApkBuildProvenance(zip, artifactUrl, { resolveTagCommit: () => revision }),
    {
      embeddedRevision: revision,
      repoUrl: "https://github.com/beyondlevi/lume-nexus",
      tag: "lume-v1.0.4",
      tagCommit: revision,
    },
  );
});
