# Rokid Nexus plugin descriptors

This directory is the source namespace for phone-only APK plugins installed into the Rokid Nexus host. Real descriptors use the filename `plugins-nexus/<id>.json`; they are published separately from normal RokidBrew apps in `dist/nexus-plugins.v1.json`.

`EXAMPLE.template.json` documents the complete descriptor shape and is copied into a temporary registry by the builder tests. Files ending in `.template.json` and non-JSON files such as this README are ignored by `scripts/build-registry.mjs`, so the example is never published as an installable plugin.

## Descriptor fields

- `id`: stable registry identifier and descriptor filename stem; it must exactly equal `nexus.pluginId`.
- `kind`: always `nexus-plugin`.
- `name`, `category`, `summary`, `description`, `author`, `sourceUrl`, and `publishedAt`: store metadata for the plugin and its published APK release. `sourceUrl` must use HTTPS.
- `iconAsset`: filename under `assets/icons/`.
- `screenshotAssets`: filenames under `assets/screenshots/`.
- `listing.descriptionMarkdown`: long-form store listing.
- `releases[]`: release history containing `version`, `date`, and `notes`.
- `nexus.pluginId`: must exactly equal the installed APK manifest metadata value `com.anezium.rokidbus.plugin.ID`. The Nexus client uses this as an installed-plugin join key.
- `nexus.apiVersion`: Nexus plugin API version declared by the plugin; currently exactly `3`.
- `nexus.capabilities`: zero or more exact capability wire values: `surfaces`, `microphone`, `http_proxy`, or `camera`.
- `nexus.launchable`: whether Nexus may launch the plugin directly.
- `nexus.settingsActivity`: optional activity class Nexus opens for plugin settings.
- `nexus.minHostVersionCode`: minimum compatible Rokid Nexus host version code.
- `artifact`: the single phone APK, served from an HTTPS `url`. `artifact.packageName` is the second installed-plugin join key. `artifact.signerSha256` is the lowercase hexadecimal SHA-256 digest of the APK's single signing certificate (the certificate DER bytes, not the APK). The remaining fields identify and verify the exact release APK (`sha256`, `sizeBytes`, `versionCode`, and `versionName`).

Only add a real descriptor after its release APK is publicly available and all artifact verification fields have been extracted from that APK. Do not publish placeholder URLs, checksums, sizes, package names, or version metadata.

## Publishing descriptor changes

`plugins-nexus/*.json` files are the source of truth, while
`dist/nexus-plugins.v1.json` is the exact feed consumed by the Nexus Store.
Every pull request that adds or updates a real descriptor must rebuild and
commit the feed in the same change:

```bash
node scripts/build-registry.mjs
git add plugins-nexus/<plugin-id>.json dist/nexus-plugins.v1.json
git commit -m "Update <plugin-name>"
git push
```

Before opening or merging the pull request, confirm that the generated feed
contains the intended artifact version:

```bash
jq '.plugins[] | select(.id == "<plugin-id>") | .artifact' \
  dist/nexus-plugins.v1.json
```

The `Build registry` CI job rebuilds both published feeds and fails if the
committed files are stale. A green APK-verification job alone does not publish
the new release: the generated Nexus feed must also be part of the pull request.

### Updating an existing plugin

1. Publish the APK release first.
2. Update `publishedAt`, prepend the release notes, and replace every pinned
   `artifact` field with metadata extracted from that exact APK.
3. Run the APK verification and registry tests.
4. Rebuild `dist/nexus-plugins.v1.json`.
5. Commit the descriptor and generated feed together.

For example:

```bash
node --test tests/*.test.mjs
node scripts/build-registry.mjs
git add plugins-nexus/<plugin-id>.json dist/nexus-plugins.v1.json
git commit -m "Update <plugin-name>"
node scripts/verify-nexus-plugin-apks.mjs --base origin/main --head HEAD
```

## Importing a release

The add workflow passes `kind` through the shared importer, README listing, APK metadata, and icon extraction steps. For example:

```bash
gh workflow run add-app-from-github.yml --ref main \
  -f kind=nexus-plugin \
  -f url=https://github.com/Anezium/feeds/releases/tag/feeds-v0.1.0 \
  -f id=feeds \
  -f plugin_id=feeds \
  -f settings_activity=.FeedsSettingsActivity \
  -f asset_match='^feeds-phone-release\.apk$' \
  -f dry_run=false
```

The workflow downloads the APK to fill and verify `artifact.packageName`, `sha256`, `signerSha256`, `sizeBytes`, `versionCode`, and `versionName` before building the feed. Signer extraction uses `apksigner verify --print-certs` from Android build-tools. If `apksigner` is unavailable locally, independently obtain the lowercase certificate digest and pass it explicitly for one plugin:

```bash
node scripts/update-artifact-metadata.mjs --kind nexus-plugin --app feeds \
  --signer-sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

When `apksigner` is available, the script still extracts the digest and rejects a mismatched fallback value. To refresh changelog entries later, run `node scripts/import-github-releases.mjs feeds --kind nexus-plugin --limit 5`.

Pull requests that add or change a real plugin descriptor run `verify-nexus-plugins.yml`. The fork-safe job uses no secrets: it downloads the public APK, checks every pinned artifact field, verifies the single signer certificate, and enforces the exported plugin service metadata and headless manifest contract before merge.

Run `node --test` to exercise signer parsing, phone-aligned descriptor validation, ingestion, and the static APK manifest checks.
