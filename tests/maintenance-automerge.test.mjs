import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateChanges, validatePullRequest, validateGitUpdate } from "../scripts/validate-maintenance-update.mjs";

const sha = "a".repeat(40);
const repository = "Anezium/RokidBrew-Registry";
const expected = { repository, number: 123, headSha: sha };
const pr = {
  number: 123, state: "open", draft: false, user: { login: "github-actions[bot]" },
  head: { sha, ref: "automation/registry-maintenance", repo: { full_name: repository } },
  base: { ref: "main", repo: { full_name: repository } },
};
const app = {
  id: "example", version: "1.0", update: { github: { repo: "owner/example" } },
  artifacts: [{ target: "glasses", url: "https://github.com/owner/example/releases/download/v1/app.apk",
    packageName: "com.example.app", versionCode: 1, sha256: "a".repeat(64) }],
};
function changed(before = app, after = app, filename = "apps/example.json") {
  return { filename, status: "M", before: Buffer.from(JSON.stringify(before)), after: Buffer.from(JSON.stringify(after)),
    beforeMode: "100644", afterMode: "100644" };
}

test("only bot PRs from the allowed repository, branch, and exact revision qualify", () => {
  validatePullRequest(pr, expected);
  for (const altered of [
    { ...pr, user: { login: "Anezium" } }, { ...pr, draft: true }, { ...pr, state: "closed" },
    { ...pr, head: { ...pr.head, sha: "b".repeat(40) } },
    { ...pr, head: { ...pr.head, ref: "automation/other" } },
    { ...pr, head: { ...pr.head, repo: { full_name: "attacker/fork" } } },
    { ...pr, base: { ...pr.base, ref: "other" } },
    { ...pr, labels: [{ name: "do-not-merge" }] },
  ]) assert.throws(() => validatePullRequest(altered, expected));
});

test("ordinary version, release note, checksum and missing package updates qualify", () => {
  const next = structuredClone(app);
  next.version = "2.0";
  next.releases = [{ version: "2.0", notes: "New release" }];
  Object.assign(next.artifacts[0], { url: "https://github.com/owner/example/releases/download/v2/app.apk", versionCode: 2 });
  validateChanges([changed(app, next)]);
  const missing = structuredClone(app);
  delete missing.artifacts[0].packageName;
  validateChanges([changed(missing, app)]);
});

test("configuration, identity, package, download source, and downgrade changes are blocked", () => {
  const mutations = [
    (entry) => { entry.id = "other"; },
    (entry) => { entry.update.github.repo = "attacker/app"; },
    (entry) => { entry.artifacts[0].packageName = "com.other.app"; },
    (entry) => { entry.artifacts[0].url = "https://evil.example/app.apk"; },
    (entry) => { entry.artifacts[0].url = "https://github.com/attacker/app/releases/download/v1/app.apk"; },
    (entry) => { entry.artifacts[0].versionCode = 0; },
    (entry) => { delete entry.artifacts[0].versionCode; },
    (entry) => { entry.artifacts[0].target = "phone"; },
    (entry) => { entry.artifacts.push(entry.artifacts[0]); },
  ];
  for (const mutate of mutations) {
    const next = structuredClone(app);
    mutate(next);
    assert.throws(() => validateChanges([changed(app, next)]));
  }
});

test("new apps, deletions, symlinks, executable files, plugins, and code require manual review", () => {
  for (const alteration of [
    { status: "A" }, { status: "D" }, { afterMode: "120000" }, { afterMode: "100755" },
    { filename: "scripts/check-updates.mjs" }, { filename: ".github/workflows/registry-maintenance.yml" },
    { filename: "plugins-nexus/example.json" }, { filename: "apps/example.template.json" },
  ]) assert.throws(() => validateChanges([{ ...changed(), ...alteration }]));
});

test("icons must be regular PNG additions or modifications; feeds are rebuilt by the workflow", () => {
  const icon = { filename: "assets/icons/example.png", status: "A", afterMode: "100644",
    after: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) };
  validateChanges([icon, changed({}, {}, "dist/apps.v1.json")]);
  assert.throws(() => validateChanges([{ ...icon, after: Buffer.from("not a png") }]));
  assert.throws(() => validateChanges([{ ...icon, status: "D" }]));
});

test("RokidBrew self-updates preserve the APK repository and version code", () => {
  const brew = { version: "1.0", versionCode: 1, apkUrl: app.artifacts[0].url };
  validateChanges([changed(brew, { ...brew, versionCode: 2, notes: "New" }, "brew.json")]);
  assert.throws(() => validateChanges([changed(brew, { ...brew, versionCode: 0 }, "brew.json")]));
});

test("git validation uses the PR diff and rejects code before candidate code can run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-automerge-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const previous = process.cwd();
  try {
    git("init", "--quiet");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    fs.mkdirSync(path.join(dir, "apps"));
    fs.writeFileSync(path.join(dir, "apps/example.json"), JSON.stringify(app));
    git("add", "."); git("commit", "--quiet", "-m", "Base");
    const base = git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(dir, "apps/example.json"), JSON.stringify({ ...app, version: "2.0" }));
    git("commit", "--quiet", "-am", "Update");
    process.chdir(dir);
    validateGitUpdate(base, git("rev-parse", "HEAD"));
    fs.writeFileSync(path.join(dir, "malicious.mjs"), "throw new Error('must never execute')");
    git("add", "."); git("commit", "--quiet", "-m", "Unexpected code");
    assert.throws(() => validateGitUpdate(base, git("rev-parse", "HEAD")));
  } finally {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
