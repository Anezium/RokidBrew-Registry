import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const maintenanceBranches = new Set([
  "automation/registry-maintenance",
  "automation/app-updates",
]);

export function validatePullRequest(pr, { repository, number, headSha }) {
  assert.match(headSha, /^[a-f0-9]{40}$/, "Invalid expected head SHA");
  assert.equal(pr.number, Number(number), "Unexpected pull request number");
  assert.equal(pr.state, "open", "Pull request is not open");
  assert.equal(pr.draft, false, "Draft pull requests require manual review");
  assert.equal(pr.user?.login, "github-actions[bot]", "Pull request must be created by GitHub Actions");
  assert.equal(pr.head?.repo?.full_name, repository, "Fork pull requests require manual review");
  assert.equal(pr.base?.repo?.full_name, repository, "Unexpected base repository");
  assert.equal(pr.base?.ref, "main", "Unexpected base branch");
  assert.ok(maintenanceBranches.has(pr.head?.ref), "Unexpected automation branch");
  assert.equal(pr.head?.sha, headSha, "Pull request changed after maintenance completed");
  assert.ok(!(pr.labels || []).some(({ name }) => ["do-not-merge", "hold", "manual-review"].includes(name)),
    "Pull request is marked for manual review");
}

function without(value, keys) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function sameDownloadSource(before, after) {
  const oldUrl = new URL(before);
  const newUrl = new URL(after);
  assert.equal(newUrl.protocol, "https:", "APK URLs must use HTTPS");
  assert.equal(newUrl.origin, oldUrl.origin, "APK download origin changed");
  if (oldUrl.hostname === "github.com") {
    assert.equal(newUrl.pathname.split("/").slice(0, 3).join("/"),
      oldUrl.pathname.split("/").slice(0, 3).join("/"), "APK GitHub repository changed");
  }
}

function noDowngrade(before, after) {
  if (before.versionCode != null) {
    assert.ok(Number.isSafeInteger(after.versionCode) && after.versionCode >= before.versionCode,
      "APK versionCode was removed or decreased");
  }
}

export function validateChanges(changes) {
  assert.ok(changes.length > 0, "No maintenance changes found");
  for (const change of changes) {
    const { filename, status, before, after, beforeMode, afterMode } = change;
    assert.equal(afterMode, "100644", `Unexpected file mode: ${filename}`);
    if (status !== "A") assert.equal(beforeMode, "100644", `Unexpected old file mode: ${filename}`);
    if (/^assets\/icons\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.png$/.test(filename)) {
      assert.ok(status === "A" || status === "M", "Icons cannot be deleted or renamed");
      assert.ok(after.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "Invalid PNG icon");
      continue;
    }
    assert.equal(status, "M", `Only existing registry entries can be updated: ${filename}`);
    if (["dist/apps.v1.json", "dist/nexus-plugins.v1.json"].includes(filename)) continue;
    assert.ok(filename === "brew.json" || /^apps\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(filename),
      `File requires manual review: ${filename}`);
    assert.ok(!filename.endsWith(".template.json"), "Templates require manual review");
    const oldEntry = JSON.parse(before);
    const newEntry = JSON.parse(after);
    if (filename === "brew.json") {
      const mutable = ["version", "versionCode", "apkUrl", "releaseUrl", "notes", "changes"];
      assert.deepEqual(without(newEntry, mutable), without(oldEntry, mutable), "RokidBrew configuration changed");
      noDowngrade(oldEntry, newEntry);
      sameDownloadSource(oldEntry.apkUrl, newEntry.apkUrl);
      continue;
    }
    const mutable = ["version", "publishedAt", "releases", "artifacts"];
    assert.deepEqual(without(newEntry, mutable), without(oldEntry, mutable), `App configuration changed: ${filename}`);
    assert.ok(Array.isArray(oldEntry.artifacts) && Array.isArray(newEntry.artifacts), "Missing artifacts");
    assert.equal(newEntry.artifacts.length, oldEntry.artifacts.length, "Artifact count changed");
    newEntry.artifacts.forEach((artifact, index) => {
      const previous = oldEntry.artifacts[index];
      const fields = ["url", "sha256", "sizeBytes", "packageName", "versionCode", "versionName"];
      assert.deepEqual(without(artifact, fields), without(previous, fields), "Artifact configuration changed");
      if (previous.packageName) assert.equal(artifact.packageName, previous.packageName, "APK package changed");
      noDowngrade(previous, artifact);
      sameDownloadSource(previous.url, artifact.url);
    });
  }
}

function git(...args) {
  return execFileSync("git", args, { maxBuffer: 32 * 1024 * 1024 });
}

export function validateGitUpdate(base, head) {
  assert.match(base, /^[a-f0-9]{40}$/);
  assert.match(head, /^[a-f0-9]{40}$/);
  const ancestor = git("merge-base", base, head).toString().trim();
  const records = git("diff", "--no-renames", "--name-status", "-z", ancestor, head).toString().split("\0");
  const changes = [];
  for (let index = 0; index < records.length - 1; index += 2) {
    const status = records[index];
    const filename = records[index + 1];
    const read = (ref) => git("show", `${ref}:${filename}`);
    const mode = (ref) => git("ls-tree", ref, "--", filename).toString().split(" ")[0];
    changes.push({ filename, status, before: status === "A" ? null : read(ancestor),
      after: status === "D" ? null : read(head),
      beforeMode: status === "A" ? null : mode(ancestor), afterMode: status === "D" ? null : mode(head) });
  }
  validateChanges(changes);
  console.log(`Validated ${changes.length} maintenance file(s).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateGitUpdate(process.argv[2], process.argv[3]);
}
