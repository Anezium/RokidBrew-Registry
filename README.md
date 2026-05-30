# RokidBrew Registry

Community app registry consumed by RokidBrew.

## Quick start — adding a new app

```bash
# 1. Create the app definition
#    Edit apps/<app-id>.json (see format below).

# 2. Build the manifest locally to validate
node scripts/build-registry.mjs

# 3. Commit and push
git add apps/<app-id>.json dist/apps.v1.json
git commit -m "Add <app-name>"
git push

# 4. Go to GitHub Actions — run "Extract missing icons" (force: false)
#    This downloads the APK, extracts the launcher icon, and auto-commits.

# 5. Go to GitHub Actions — run "Update artifact metadata" (force: false)
#    This downloads the APK, computes sha256 / size / package metadata, and auto-commits.
```

After these steps, the app is live. RokidBrew pulls from:

```text
https://raw.githubusercontent.com/Anezium/RokidBrew-Registry/main/dist/apps.v1.json
```

---

## App file format (`apps/<app-id>.json`)

```json
{
  "id": "example-app",
  "name": "Example App",
  "category": "Utility",
  "type": "glasses",
  "version": "1.0.0",
  "summary": "Short one-line summary.",
  "description": "Longer detail shown in RokidBrew.",
  "author": "Example Author",
  "sourceUrl": "https://github.com/owner/repo",
  "phoneRequired": false,
  "artifacts": [
    {
      "target": "glasses",
      "url": "https://github.com/owner/repo/releases/download/v1.0.0/example.apk"
    }
  ]
}
```

### Required fields

| Field | Notes |
|---|---|
| `id` | Unique slug. Use kebab-case (e.g. `my-app`). |
| `name` | Display name shown in RokidBrew. |
| `category` | `AI`, `Navigation`, `Media`, `Games`, `Utility`, `Browser`, `Launcher`, `Translation`, `Learning`, `Shopping`, `Camera`, `Fitness`, `Experiment`, `Mobility`, `Music`, `Reader`, `Developer`, `Accessibility` |
| `type` | `glasses`, `phone`, or `combo` (both phone and glasses APKs). |
| `version` | Human-readable version string. |
| `summary` | One-line description. |
| `description` | Longer description. Defaults to `summary` if omitted. |
| `phoneRequired` | `true` if the glasses-side APK needs a phone companion. |
| `artifacts` | Array of APK download objects (see below). |

### Artifact object

| Field | Required | Notes |
|---|---|---|
| `target` | Yes | `glasses` or `phone`. |
| `url` | Yes | Direct APK download URL. |
| `sha256` | No | Populated by the "Update artifact metadata" Action. |
| `sizeBytes` | No | Populated by the "Update artifact metadata" Action. |
| `packageName` | No | Populated by the "Update artifact metadata" Action. |
| `versionCode` | No | Populated by the "Update artifact metadata" Action. |
| `versionName` | No | Populated by the "Update artifact metadata" Action. |

### Optional fields

| Field | Notes |
|---|---|
| `author` | Inferred from the GitHub repository owner if omitted. |
| `sourceUrl` | Inferred from the artifact download URL if omitted. |
| `iconAsset` | Filename in `assets/icons/`. Auto-populated by the icon extraction Action. |
| `iconUrl` | Remote URL for the icon. Auto-generated from the registry repo. |
| `screenshotAssets` | Array of filenames in `assets/screenshots/`. Add manually. |
| `screenshotUrls` | Remote URLs for screenshots. Auto-generated from the registry repo. |
| `listing.descriptionMarkdown` | Store-detail body shown in RokidBrew. Supports readable Markdown-style paragraphs, headings, and bullets. |
| `releases` | Store-detail changelog entries shown in RokidBrew. |

### Combo apps

For `"type": "combo"`, provide both a `phone` and `glasses` artifact:

```json
"artifacts": [
  { "target": "glasses", "url": "..." },
  { "target": "phone", "url": "..." }
]
```

---

## GitHub Actions

All write workflows create or update pull requests against `main`. They do not
push registry changes directly to `main`.

### 1. Build registry (`build-registry.yml`)

| Trigger | Purpose |
|---|---|
| Push to `main` | Validates the manifest builds correctly. |
| Pull request | CI check. |
| Manual dispatch | Rebuild on demand. |

`scripts/build-registry.mjs` uses the current git branch for generated raw asset URLs
(`main`, `dev`, etc.). Override with `ROKIDBREW_PUBLIC_BASE_URL` or
`ROKIDBREW_PUBLIC_BRANCH` when building a manifest for another branch.

### 2. Daily registry maintenance (`registry-maintenance.yml`)

Runs once per day and can also be triggered manually. It checks upstream APK
sources, refreshes APK metadata, extracts missing icons, rebuilds the registry,
and opens or updates a review PR.

The workflow is resilient by design: individual APK metadata or icon failures are
reported in logs, but do not block unrelated app updates from being proposed.

### 3. Add app from GitHub URL (`add-app-from-github.yml`)

Manual trigger for adding a new app from a GitHub URL.

Supported inputs:

- Normal GitHub repo, release, or release tag URL.
- EUNG SOFT `info.json` URL, or a GitHub tree URL like
  `download/RokidGlasses/<App>`.

The workflow creates `apps/<id>.json`, adds future update rules, copies GitHub
release bodies into `releases[]`, optionally uses OpenRouter only for the store
description fields, refreshes APK metadata, extracts the launcher icon, and opens
a PR. Screenshot import is best-effort only and checks a few likely folders:
`screenshots`, `docs/screenshots`, `docs/images`, `assets/screenshots`, `images`.

### 4. Extract missing icons (`extract-icons.yml`)

Manual trigger only. For every app in `apps/*.json` that is missing `assets/icons/<app-id>.png`:

1. Downloads the first APK artifact (preferring glasses).
2. Reads the launcher icon with `aapt dump badging`.
3. Extracts a direct raster icon when available.
4. Falls back to `apktool` + `rsvg-convert` for adaptive / vector launcher icons.
5. Opens or updates a PR with the generated icons and rebuilt manifest.

| Input | Value |
|---|---|
| `force: false` | Skip apps that already have an icon (normal use). |
| `force: true` | Regenerate all icons even if they already exist. |

### 5. Update artifact metadata (`update-artifact-metadata.yml`)

Manual trigger only. Downloads every APK referenced in the registry and populates:

- `sha256` — SHA-256 checksum of the APK.
- `sizeBytes` — File size in bytes.
- `packageName` — Android package name (from AndroidManifest).
- `versionCode` — Integer version code.
- `versionName` — Human-readable version name.

Opens or updates a PR with the updated `apps/*.json` and rebuilt manifest.

| Input | Value |
|---|---|
| `force: false` | Only fill in missing metadata (normal use). |
| `force: true` | Recompute all metadata even if already present (use after APK URL changes). |

### 6. Check app updates (`check-updates.yml`)

Manual trigger for checking upstream APK sources without running the full daily
maintenance pipeline. It opens a pull request when it finds newer artifacts.

Supported sources:

- Normal GitHub Releases: inferred automatically from existing `github.com/<owner>/<repo>/releases/download/...` URLs.
- Release buckets: use an app-level `update` block to pin a release tag and match APK assets by regex. This is used for `eung3392/eungsoft`, where many apps live under the single `RokidGlassesApp` release.
- Raw GitHub APK URLs: exact-file monitoring only. If the file at the current URL changes, the workflow refreshes checksum/package metadata, but it does not guess new filenames.

Example release-bucket rule:

```json
"update": {
  "source": "githubReleaseAssets",
  "repo": "eung3392/eungsoft",
  "release": "RokidGlassesApp",
  "assets": [
    {
      "target": "glasses",
      "match": "^EKReader_v(?<version>\\d+(?:\\.\\d+)*)\\.apk$"
    }
  ]
}
```

`update` rules are registry-maintenance metadata only. They are stripped from `dist/apps.v1.json`.

---

## Adding screenshots

Screenshots are best-effort during the "Add app from GitHub URL" workflow. The
workflow intentionally checks only a few likely folders and never blocks a PR if
screenshots cannot be found. To add or fix screenshots manually:

1. Place image files in `assets/screenshots/`.
2. Reference them in the app JSON:
   ```json
   "screenshotAssets": ["my-app-1.jpg", "my-app-2.png"]
   ```
3. Rebuild and push:
   ```bash
   node scripts/build-registry.mjs
   git add assets/screenshots/ apps/*.json dist/apps.v1.json
   git commit -m "Add screenshots for <app-name>"
   git push
```

---

## Importing EUNG SOFT info.json

EUNG SOFT apps expose localized metadata in `download/RokidGlasses/<App>/info.json`.
Use the importer to generate or refresh the app entry from the English fields:

```bash
node scripts/import-eung-info.mjs \
  https://github.com/eung3392/eungsoft/blob/main/download/RokidGlasses/EKMeta/info.json \
  --category Utility
node scripts/build-registry.mjs
```

The importer maps:

| EUNG field | Registry field |
|---|---|
| `title.en` | `name` |
| `version` | `version` |
| `releaseDate` | `publishedAt` and latest release date |
| `shortDescription.en` | `summary` |
| `description.en` | `description` and `listing.descriptionMarkdown` |
| `control.en` | Appended to `listing.descriptionMarkdown` as usage/control notes |
| `updated[].en` | `releases[].notes` |
| `download[0]` | Current APK artifact URL |
| `images[]` | Downloaded to `assets/screenshots/` and referenced as `screenshotAssets` |

For apps that use the same APK on phone and glasses, run with `--type combo`.
For one-off cleanup, use `--id`, `--category`, `--phone-required`, or `--no-screenshots`.

---

## Generating listings from README with AI

For apps that only have a README, use OpenRouter to generate a reviewable
store description from the README. GitHub Releases are copied mechanically into
`releases[]`; the AI does not rewrite changelogs.

```bash
OPENROUTER_API_KEY=... \
node scripts/generate-ai-listing.mjs rokid-scribe \
  --repo Anezium/Rokid-Scribe \
  --release-limit 5 \
  --report .tmp/ai-listing-report.md
node scripts/build-registry.mjs
```

The AI part only writes:

- `summary`
- `description`
- `listing.descriptionMarkdown`

The script also copies GitHub release bodies into `releases[]` without asking the
model to summarize or rewrite them, and stores private maintenance metadata in
`listingSource`.

It does not update APK URLs, checksums, package names, icons, screenshots, or
install targets. Those stay managed by the normal registry scripts and Actions.

To import only GitHub release changelogs without AI:

```bash
node scripts/import-github-releases.mjs rokid-scribe --limit 5
node scripts/build-registry.mjs
```

### GitHub Action

Set the repository secret `OPENROUTER_API_KEY`, then run **Generate AI listing**
from the Actions tab. Run it from `dev` while testing. The workflow creates or
updates a PR branch named `automation/ai-listing-<app-id>` against the branch
where the workflow was started.

Useful inputs:

| Input | Notes |
|---|---|
| `app` | Required app id from `apps/<id>.json`. |
| `repo` | Optional `owner/repo` override if it cannot be inferred. |
| `readme_path` | Optional README path inside the repo. |
| `readme_ref` | Optional branch, tag, or SHA. |
| `model` | OpenRouter model, defaults to `openai/gpt-4.1-mini`. |
| `release_limit` | Number of GitHub Releases to copy into `releases[]`. |
| `dry_run` | Runs generation without creating a PR. |

---

## Full workflow summary

```
1. Run "Add app from GitHub URL" for new apps
2. Review the generated PR
3. Run "Extract missing icons"  → gets the icon
4. Run "Update artifact metadata" → gets sha256, package info
5. Daily registry maintenance opens PRs for new releases, metadata, and icons
6. (Optional) Add or adjust screenshots manually
```
