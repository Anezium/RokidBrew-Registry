# RokidBrew Registry

Community app registry consumed by RokidBrew.

## Add or update an app

1. Add or edit one file in `apps/<app-id>.json`.
2. Optional: add an icon at `assets/icons/<app-id>.png`.
3. Optional: add screenshots in `assets/screenshots/` and reference their file names in `screenshotAssets`.
4. Run:

```bash
node scripts/build-registry.mjs
```

The generated manifest is written to `dist/apps.v1.json`.

## App file format

```json
{
  "id": "example-app",
  "name": "Example App",
  "category": "Utility",
  "type": "glasses",
  "version": "1.0.0",
  "summary": "Short one-line summary.",
  "description": "Longer detail shown in RokidBrew.",
  "screenshotAssets": ["example-app-1.jpg"],
  "phoneRequired": false,
  "artifacts": [
    {
      "target": "glasses",
      "url": "https://github.com/owner/repo/releases/download/v1.0.0/example.apk"
    }
  ]
}
```

`type` must be `combo`, `phone`, or `glasses`.

For `combo` apps, provide both `phone` and `glasses` artifacts when possible.

## Distribution

RokidBrew reads:

```text
https://raw.githubusercontent.com/Anezium/RokidBrew-Registry/main/dist/apps.v1.json
```

GitHub Pages is optional. If Pages is enabled and configured to deploy from GitHub Actions, it can also serve the same file:

```text
https://anezium.github.io/RokidBrew-Registry/apps.v1.json
```

## Extract missing icons

The repo has a manual GitHub Action named **Extract missing icons**.

It:

1. scans `apps/*.json`;
2. skips apps that already have `assets/icons/<app-id>.png`;
3. downloads the first APK artifact, preferring glasses artifacts;
4. reads the declared launcher icon with `aapt dump badging`;
5. extracts a direct raster icon when available;
6. falls back to `apktool` + `rsvg-convert` for adaptive/vector launcher icons;
7. commits the new icons and rebuilt manifest back to `main`.

Run it from GitHub Actions with `force=false` for normal use. Use `force=true` only when you want to regenerate existing icons.

Adaptive/vector XML icons are rendered to PNG when their foreground/background resources can be resolved.

## Update checksums and package metadata

The manual GitHub Action **Update artifact metadata** downloads APK artifacts, then writes:

- `sha256`
- `sizeBytes`
- `packageName`
- `versionCode`
- `versionName`

Use `force=false` for normal updates. Use `force=true` when a release URL changed and existing metadata should be recomputed.
