import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appFile,
  cleanMarkdown,
  compactRelease,
  githubReleases,
  inferRepo,
  parseArgs,
  pickStoreFields,
  readJson,
  readmeText,
  writeJson,
} from "./lib-github-content.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultModel = process.env.OPENROUTER_MODEL || "openai/gpt-4.1-mini";
const openRouterUrl = "https://openrouter.ai/api/v1/chat/completions";

const usage = `Usage:
  node scripts/generate-ai-listing.mjs <app-id> [options]

Options:
  --repo <owner/repo>         Override GitHub repository.
  --readme-path <path>        README path inside the repo, default README.md.
  --readme-url <url>          Full README/raw markdown URL.
  --ref <branch-or-sha>       README git ref, default repo default branch.
  --model <model>             OpenRouter model, default OPENROUTER_MODEL or ${defaultModel}.
  --release-limit <n>         Number of GitHub releases to pass to the model, default 5.
  --no-releases              Do not fetch or update releases[].
  --report <path>             Write a markdown report for PR bodies.
  --dry-run                  Print generated JSON without writing the app.

Required env:
  OPENROUTER_API_KEY
`;

const listingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "description", "listing", "releases"],
  properties: {
    summary: {
      type: "string",
      description: "One-line app-store summary, max 140 characters.",
    },
    description: {
      type: "string",
      description: "Plain text app-store description, 1-3 sentences.",
    },
    listing: {
      type: "object",
      additionalProperties: false,
      required: ["descriptionMarkdown"],
      properties: {
        descriptionMarkdown: {
          type: "string",
          description: "Readable Markdown detail body for end users.",
        },
      },
    },
    releases: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["version", "date", "sourceReleaseUrl", "notes", "changes"],
        properties: {
          version: { type: ["string", "null"] },
          date: { type: ["string", "null"] },
          sourceReleaseUrl: { type: ["string", "null"] },
          notes: { type: ["string", "null"] },
          changes: {
            type: "array",
            maxItems: 8,
            items: { type: "string" },
          },
        },
      },
    },
  },
};

function truncate(text, max) {
  const value = String(text || "").trim();
  return value.length > max ? `${value.slice(0, max)}\n\n[Truncated]` : value;
}

function extractJson(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    if (fenced) return JSON.parse(fenced[1]);
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(raw.slice(first, last + 1));
    throw new Error("OpenRouter response was not valid JSON");
  }
}

function messageText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => typeof part === "string" ? part : part.text || "")
      .join("");
  }
  return "";
}

function validateGenerated(value) {
  if (!value || typeof value !== "object") throw new Error("Generated listing must be an object");
  if (!value.summary || typeof value.summary !== "string") throw new Error("Generated listing is missing summary");
  if (!value.description || typeof value.description !== "string") throw new Error("Generated listing is missing description");
  if (!value.listing?.descriptionMarkdown) throw new Error("Generated listing is missing listing.descriptionMarkdown");
  if (!Array.isArray(value.releases)) value.releases = [];
  return value;
}

function prompt(app, repo, readme, releases) {
  const releaseInstruction = releases.length > 0
    ? "Summarize GitHub Releases into releases[]. Use concise notes plus bullet changes. Keep sourceReleaseUrl unchanged."
    : "Return an empty releases array because no release notes were provided.";

  return [
    {
      role: "system",
      content: [
        "You write concise app-store listings for RokidBrew, an app store for Rokid AR glasses and companion phone apps.",
        "Use only the provided README, app metadata, and release notes.",
        "Do not invent features, versions, pricing, compatibility, APK URLs, package names, or screenshots.",
        "Do not include developer build instructions, contribution notes, license text, badges, raw tables, or API-key setup unless they are necessary for an end user.",
        "Write in English. Keep the tone polished, clear, and practical.",
        "Return strict JSON matching the supplied schema.",
      ].join(" "),
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "Generate RokidBrew store fields from README and releases.",
        outputRules: {
          summary: "Max 140 characters. No trailing period if it reads like a label.",
          description: "Plain text, 1-3 short sentences.",
          listingDescriptionMarkdown: [
            "Start with a direct About paragraph.",
            "Then add short sections only when supported by the README, such as Key features, How it works, Controls, Requirements, or Notes.",
            "Prefer bullets for scannability.",
            "Avoid marketing fluff and developer-only setup.",
          ],
          releases: releaseInstruction,
        },
        app: {
          id: app.id,
          name: app.name,
          category: app.category,
          type: app.type,
          currentSummary: app.summary,
          currentDescription: app.description,
          phoneRequired: app.phoneRequired,
          sourceUrl: app.sourceUrl,
          targets: (app.artifacts || []).map((artifact) => artifact.target),
        },
        repo,
        readme: truncate(cleanMarkdown(readme), 24000),
        releases,
      }),
    },
  ];
}

async function callOpenRouter({ model, messages }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");
  const response = await fetch(openRouterUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://github.com/Anezium/RokidBrew-Registry",
      "X-Title": "RokidBrew Registry",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "rokidbrew_store_listing",
          strict: true,
          schema: listingSchema,
        },
      },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`OpenRouter failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return validateGenerated(extractJson(messageText(data.choices?.[0]?.message)));
}

function writeReport(file, { app, repo, model, generated, releases }) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    `# AI listing update for ${app.name}`,
    "",
    `- App: \`${app.id}\``,
    `- Repo: \`${repo}\``,
    `- Model: \`${model}\``,
    `- Release notes provided: ${releases.length}`,
    "",
    "## Summary",
    "",
    generated.summary,
    "",
    "## Description",
    "",
    generated.description,
    "",
    "## Listing Preview",
    "",
    generated.listing.descriptionMarkdown,
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), usage);
  const appId = args._[0];
  if (!appId) throw new Error(usage);

  const file = appFile(root, appId);
  const app = readJson(file);
  const repo = args.repo || inferRepo(app);
  if (!repo && !args.readmeUrl) throw new Error(`${appId}: cannot infer GitHub repo; pass --repo or --readme-url`);

  const source = app.listingSource || {};
  const readme = await readmeText({
    repo,
    ref: args.ref || source.branch || source.ref,
    readmePath: args.readmePath || source.path,
    readmeUrl: args.readmeUrl,
  });
  const releases = args.noReleases
    ? []
    : repo
      ? (await githubReleases(repo, args.releaseLimit || 5)).map(compactRelease)
      : [];
  const model = args.model || defaultModel;
  const generated = await callOpenRouter({ model, messages: prompt(app, repo, readme, releases) });
  const updated = pickStoreFields(app, generated);
  if (repo) {
    updated.listingSource = {
      type: "githubReadme",
      repo,
      ...(args.ref || source.branch || source.ref ? { branch: args.ref || source.branch || source.ref } : {}),
      path: args.readmePath || source.path || "README.md",
    };
  }

  writeReport(args.report, { app, repo, model, generated, releases });

  if (args.dryRun) {
    console.log(JSON.stringify(updated, null, 2));
    return;
  }

  writeJson(file, updated);
  console.log(`Generated AI listing for ${appId} with ${model}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
