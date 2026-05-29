import fs from "node:fs";
import path from "node:path";

const githubApi = "https://api.github.com";

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function appFile(root, appId) {
  return path.join(root, "apps", `${appId}.json`);
}

export function parseArgs(argv, usage) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) {
      args._.push(value);
      continue;
    }
    const key = value.replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (["dryRun", "noReleases"].includes(key)) {
      args[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for ${value}\n\n${usage}`);
    args[key] = next;
    i += 1;
  }
  return args;
}

export function normalizeRepo(repo) {
  if (!repo) return null;
  const github = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/i.exec(repo);
  if (github) return `${github[1]}/${github[2].replace(/\.git$/i, "")}`;
  return repo.replace(/^github:/i, "").replace(/\.git$/i, "");
}

export function repoFromUrl(url) {
  if (!url) return null;
  const github = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/i.exec(url);
  if (github) return `${github[1]}/${github[2].replace(/\.git$/i, "")}`;
  const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)/i.exec(url);
  if (raw) return `${raw[1]}/${raw[2].replace(/\.git$/i, "")}`;
  return null;
}

export function inferRepo(app) {
  return normalizeRepo(app.listingSource?.repo) ||
    repoFromUrl(app.sourceUrl) ||
    repoFromUrl(app.artifacts?.[0]?.url);
}

export async function fetchJson(url, label = url, token = process.env.GITHUB_TOKEN) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "RokidBrew-Registry",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Failed to fetch ${label}: ${response.status} ${response.statusText}`);
  return response.json();
}

export async function fetchText(url, label = url, token = process.env.GITHUB_TOKEN) {
  const headers = { Accept: "text/plain,*/*", "User-Agent": "RokidBrew-Registry" };
  if (token && url.startsWith(githubApi)) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Failed to fetch ${label}: ${response.status} ${response.statusText}`);
  return response.text();
}

export async function repoInfo(repo) {
  return fetchJson(`${githubApi}/repos/${repo}`, repo);
}

export async function readmeText({ repo, ref, readmePath, readmeUrl }) {
  if (readmeUrl) return fetchText(readmeUrl, readmeUrl);
  const info = await repoInfo(repo);
  const branch = ref || info.default_branch || "main";
  const file = readmePath || "README.md";
  const url = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${file}`;
  return fetchText(url, `${repo}/${file}@${branch}`);
}

export async function githubReleases(repo, limit = 5) {
  const perPage = Math.min(Math.max(Number.parseInt(limit, 10) || 5, 1), 20);
  const releases = await fetchJson(`${githubApi}/repos/${repo}/releases?per_page=${perPage}`, `${repo} releases`);
  return Array.isArray(releases) ? releases.slice(0, perPage) : [];
}

export function cleanMarkdown(markdown) {
  return String(markdown || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[(?:!\[[^\]]*]\([^)]+\))]\([^)]+\)/g, "")
    .replace(/^\s*\[[^\]]+]\([^)]+\)\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripMarkdown(markdown) {
  return cleanMarkdown(markdown)
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function firstParagraph(markdown, maxLength = 360) {
  const paragraph = cleanMarkdown(markdown)
    .split(/\n\s*\n/)
    .map(stripMarkdown)
    .find((block) => block.length > 20) || "";
  return paragraph.slice(0, maxLength).trim();
}

export function bulletChanges(markdown, maxItems = 6) {
  const lines = cleanMarkdown(markdown)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const bullets = lines
    .map((line) => /^[-*+]\s+(.+)$/.exec(line) || /^\d+[.)]\s+(.+)$/.exec(line))
    .filter(Boolean)
    .map((match) => stripMarkdown(match[1]))
    .filter((line) => line.length > 0 && line.length <= 180)
    .filter((line) => !/\.apk(?:\s|$)/i.test(line));
  return [...new Set(bullets)].slice(0, maxItems);
}

export function releaseToRegistry(release) {
  const body = cleanMarkdown(release.body || "");
  return {
    version: String(release.tag_name || "").replace(/^v/i, "") || null,
    date: release.published_at || release.created_at || null,
    sourceReleaseUrl: release.html_url || null,
    notes: firstParagraph(body, 420) || null,
    changes: bulletChanges(body),
  };
}

export function compactRelease(release) {
  return {
    tag: release.tag_name,
    name: release.name,
    publishedAt: release.published_at,
    url: release.html_url,
    body: cleanMarkdown(release.body || "").slice(0, 4000),
  };
}

export function pickStoreFields(app, generated) {
  const out = { ...app };
  if (generated.summary) out.summary = String(generated.summary).trim().slice(0, 180);
  if (generated.description) out.description = String(generated.description).trim().slice(0, 700);
  if (generated.listing?.descriptionMarkdown) {
    out.listing = {
      ...(out.listing || {}),
      descriptionMarkdown: String(generated.listing.descriptionMarkdown).trim().slice(0, 8000),
    };
  }
  if (Array.isArray(generated.releases)) {
    out.releases = generated.releases.slice(0, 8).map((release) => ({
      version: release.version || null,
      date: release.date || null,
      sourceReleaseUrl: release.sourceReleaseUrl || null,
      notes: release.notes ? String(release.notes).trim().slice(0, 700) : null,
      changes: Array.isArray(release.changes)
        ? release.changes.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
        : [],
    }));
  }
  return out;
}
