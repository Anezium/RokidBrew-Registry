import { spawnSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";

export const VERSION_CONTROL_INFO_ENTRY = "META-INF/version-control-info.textproto";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

function findEndOfCentralDirectory(zip) {
  const minimumOffset = Math.max(0, zip.length - 22 - 0xffff);
  for (let offset = zip.length - 22; offset >= minimumOffset; offset -= 1) {
    if (zip.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = zip.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === zip.length) return offset;
  }
  throw new Error("APK is not a valid ZIP: end-of-central-directory record is missing");
}

function requireRange(zip, offset, length, description) {
  if (offset < 0 || length < 0 || offset + length > zip.length) {
    throw new Error(`APK is not a valid ZIP: truncated ${description}`);
  }
}

function extractCentralDirectoryEntry(zip, offset, entryName) {
  requireRange(zip, offset, 46, "central-directory entry");
  if (zip.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY) {
    throw new Error("APK is not a valid ZIP: invalid central-directory entry");
  }

  const flags = zip.readUInt16LE(offset + 8);
  const compressionMethod = zip.readUInt16LE(offset + 10);
  const compressedSize = zip.readUInt32LE(offset + 20);
  const uncompressedSize = zip.readUInt32LE(offset + 24);
  const nameLength = zip.readUInt16LE(offset + 28);
  const extraLength = zip.readUInt16LE(offset + 30);
  const commentLength = zip.readUInt16LE(offset + 32);
  const diskNumber = zip.readUInt16LE(offset + 34);
  const localHeaderOffset = zip.readUInt32LE(offset + 42);
  const endOffset = offset + 46 + nameLength + extraLength + commentLength;
  requireRange(zip, offset, endOffset - offset, "central-directory entry");

  const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
  if (name !== entryName) return { bytes: null, endOffset };
  if (diskNumber !== 0) throw new Error("APK uses an unsupported multi-disk ZIP entry");
  if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff) {
    throw new Error("APK uses unsupported ZIP64 metadata");
  }
  if ((flags & 0x1) !== 0) throw new Error(`${entryName} is encrypted`);
  if (compressionMethod !== 0 && compressionMethod !== 8) {
    throw new Error(`${entryName} uses unsupported ZIP compression method ${compressionMethod}`);
  }

  requireRange(zip, localHeaderOffset, 30, "local file header");
  if (zip.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER) {
    throw new Error(`APK is not a valid ZIP: invalid local header for ${entryName}`);
  }
  if (zip.readUInt16LE(localHeaderOffset + 8) !== compressionMethod) {
    throw new Error(`APK is not a valid ZIP: compression method mismatch for ${entryName}`);
  }

  const localNameLength = zip.readUInt16LE(localHeaderOffset + 26);
  const localExtraLength = zip.readUInt16LE(localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
  requireRange(zip, dataOffset, compressedSize, `${entryName} data`);
  const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);
  const bytes = compressionMethod === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
  if (bytes.length !== uncompressedSize) {
    throw new Error(`APK is not a valid ZIP: size mismatch for ${entryName}`);
  }
  return { bytes, endOffset };
}

export function extractZipEntry(zipBytes, entryName) {
  const zip = Buffer.isBuffer(zipBytes) ? zipBytes : Buffer.from(zipBytes);
  const endOffset = findEndOfCentralDirectory(zip);
  const diskNumber = zip.readUInt16LE(endOffset + 4);
  const centralDirectoryDisk = zip.readUInt16LE(endOffset + 6);
  const diskEntries = zip.readUInt16LE(endOffset + 8);
  const entryCount = zip.readUInt16LE(endOffset + 10);
  const centralDirectorySize = zip.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = zip.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || diskEntries !== entryCount) {
    throw new Error("APK uses an unsupported multi-disk ZIP");
  }
  if (entryCount === 0xffff || centralDirectorySize === 0xffffffff ||
      centralDirectoryOffset === 0xffffffff) {
    throw new Error("APK uses unsupported ZIP64 metadata");
  }
  requireRange(zip, centralDirectoryOffset, centralDirectorySize, "central directory");
  if (centralDirectoryOffset + centralDirectorySize > endOffset) {
    throw new Error("APK is not a valid ZIP: central directory overlaps its end record");
  }

  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    const entry = extractCentralDirectoryEntry(zip, offset, entryName);
    if (entry.bytes) return entry.bytes;
    offset = entry.endOffset;
  }
  return null;
}

function textprotoScalar(source, field) {
  const match = String(source).match(new RegExp(
    `^\\s*${field}\\s*:\\s*(?:"((?:\\\\.|[^"\\\\])*)"|([A-Za-z0-9_.-]+))\\s*$`,
    "m",
  ));
  if (!match) return null;
  if (match[1] == null) return match[2];
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    throw new Error(`version-control-info.textproto has an invalid ${field} value`);
  }
}

export function parseVersionControlInfo(textproto) {
  const system = textprotoScalar(textproto, "system");
  if (system == null) {
    throw new Error("version-control-info.textproto is missing system");
  }
  if (system !== "GIT") {
    throw new Error(
      `version-control-info.textproto must declare system GIT, found ${JSON.stringify(system)}`,
    );
  }

  const revision = textprotoScalar(textproto, "revision");
  if (revision == null) {
    throw new Error("version-control-info.textproto is missing revision");
  }
  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    throw new Error(
      "version-control-info.textproto revision must be exactly 40 hexadecimal characters",
    );
  }
  return { system, revision: revision.toLowerCase() };
}

export function deriveGitHubRelease(artifactUrl) {
  let parsed;
  try {
    parsed = new URL(artifactUrl);
  } catch {
    throw new Error("artifact.url is not a valid URL");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com" ||
      segments.length < 6 || segments[2] !== "releases" || segments[3] !== "download") {
    throw new Error(
      "artifact.url must match https://github.com/<owner>/<repo>/releases/download/<tag>/<file>",
    );
  }

  let owner;
  let repo;
  let tag;
  try {
    [owner, repo, tag] = [segments[0], segments[1], segments[4]].map(decodeURIComponent);
  } catch {
    throw new Error("artifact.url contains invalid percent-encoding");
  }
  if (![owner, repo].every((value) => /^[A-Za-z0-9_.-]+$/.test(value)) || !tag) {
    throw new Error(
      "artifact.url must match https://github.com/<owner>/<repo>/releases/download/<tag>/<file>",
    );
  }
  return { repoUrl: `https://github.com/${owner}/${repo}`, tag };
}

export function parseGitLsRemoteTagCommit(output, tag) {
  const directRef = `refs/tags/${tag}`;
  const peeledRef = `${directRef}^{}`;
  const refs = new Map(String(output || "").trim().split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [revision, ref] = line.split(/\s+/, 2);
      return [ref, revision];
    }));
  const revision = refs.get(peeledRef) || refs.get(directRef);
  if (!revision) throw new Error("git ls-remote returned no matching tag");
  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    throw new Error(`git ls-remote returned invalid revision ${JSON.stringify(revision)}`);
  }
  return revision.toLowerCase();
}

export function resolveGitTagCommit(repoUrl, tag, { cwd } = {}) {
  const directRef = `refs/tags/${tag}`;
  const peeledRef = `${directRef}^{}`;
  const result = spawnSync("git", ["ls-remote", repoUrl, directRef, peeledRef], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`git ls-remote failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `git ls-remote failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`,
    );
  }
  return parseGitLsRemoteTagCommit(result.stdout, tag);
}

export function verifyApkBuildProvenance(apkBytes, artifactUrl, {
  cwd,
  resolveTagCommit = (repoUrl, tag) => resolveGitTagCommit(repoUrl, tag, { cwd }),
} = {}) {
  const textproto = extractZipEntry(apkBytes, VERSION_CONTROL_INFO_ENTRY);
  if (!textproto) {
    throw new Error(
      `${VERSION_CONTROL_INFO_ENTRY} is missing; the APK cannot be authenticated. ` +
      "The developer must build from a git checkout with AGP vcsInfo enabled " +
      "(default for release builds).",
    );
  }

  const { revision: embeddedRevision } = parseVersionControlInfo(textproto.toString("utf8"));
  const { repoUrl, tag } = deriveGitHubRelease(artifactUrl);
  let tagCommit;
  try {
    tagCommit = resolveTagCommit(repoUrl, tag);
  } catch (failure) {
    const detail = failure instanceof Error ? failure.message : String(failure);
    throw new Error(`could not resolve release tag ${JSON.stringify(tag)} from ${repoUrl}: ${detail}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(tagCommit)) {
    throw new Error(
      `could not resolve release tag ${JSON.stringify(tag)} from ${repoUrl}: ` +
      `invalid revision ${JSON.stringify(tagCommit)}`,
    );
  }
  tagCommit = tagCommit.toLowerCase();

  if (embeddedRevision !== tagCommit) {
    throw new Error(
      `embedded revision ${embeddedRevision} does not match release tag ${JSON.stringify(tag)} ` +
      `commit ${tagCommit}; build after committing and tagging — dirty-tree builds cannot be ` +
      "authenticated (see plugins/AGENTS.md Publishing step 5 in the Rokid-Nexus repo)",
    );
  }
  return { embeddedRevision, repoUrl, tag, tagCommit };
}
