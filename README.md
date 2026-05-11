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

Four workflows automate the registry maintenance.

### 1. Build registry (`build-registry.yml`)

| Trigger | Purpose |
|---|---|
| Push to `main` | Validates the manifest builds correctly. |
| Pull request | CI check. |
| Manual dispatch | Rebuild on demand. |

### 2. Extract missing icons (`extract-icons.yml`)

Manual trigger only. For every app in `apps/*.json` that is missing `assets/icons/<app-id>.png`:

1. Downloads the first APK artifact (preferring glasses).
2. Reads the launcher icon with `aapt dump badging`.
3. Extracts a direct raster icon when available.
4. Falls back to `apktool` + `rsvg-convert` for adaptive / vector launcher icons.
5. Commits the new icons and rebuilt manifest back to `main`.

| Input | Value |
|---|---|
| `force: false` | Skip apps that already have an icon (normal use). |
| `force: true` | Regenerate all icons even if they already exist. |

### 3. Update artifact metadata (`update-artifact-metadata.yml`)

Manual trigger only. Downloads every APK referenced in the registry and populates:

- `sha256` — SHA-256 checksum of the APK.
- `sizeBytes` — File size in bytes.
- `packageName` — Android package name (from AndroidManifest).
- `versionCode` — Integer version code.
- `versionName` — Human-readable version name.

Commits the updated `apps/*.json` and rebuilt manifest.

| Input | Value |
|---|---|
| `force: false` | Only fill in missing metadata (normal use). |
| `force: true` | Recompute all metadata even if already present (use after APK URL changes). |

### 4. Check app updates (`check-updates.yml`)

Runs every day and can also be triggered manually. It checks upstream APK sources and opens a pull request when it finds newer artifacts.

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

Screenshots are not extracted automatically. To add them:

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

## Full workflow summary

```
1. Create apps/<app-id>.json with artifact URLs
2. Rebuild + push
3. Run "Extract missing icons"  → gets the icon
4. Run "Update artifact metadata" → gets sha256, package info
5. The scheduled "Check app updates" workflow opens PRs for newer upstream APKs
6. (Optional) Add screenshots manually
```
