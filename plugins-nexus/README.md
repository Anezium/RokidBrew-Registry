# Rokid Nexus plugin descriptors

This directory is the source namespace for phone-only APK plugins installed into the Rokid Nexus host. Real descriptors use the filename `plugins-nexus/<id>.json`; they are published separately from normal RokidBrew apps in `dist/nexus-plugins.v1.json`.

`EXAMPLE.template.json` documents the complete descriptor shape and is copied into a temporary registry by the builder tests. Files ending in `.template.json` and non-JSON files such as this README are ignored by `scripts/build-registry.mjs`, so the example is never published as an installable plugin.

## Descriptor fields

- `id`: stable registry identifier and descriptor filename stem.
- `kind`: always `nexus-plugin`.
- `name`, `category`, `summary`, `description`, `author`, `sourceUrl`, and `publishedAt`: store metadata for the plugin and its published APK release.
- `iconAsset`: filename under `assets/icons/`.
- `screenshotAssets`: filenames under `assets/screenshots/`.
- `listing.descriptionMarkdown`: long-form store listing.
- `releases[]`: release history containing `version`, `date`, and `notes`.
- `nexus.pluginId`: must exactly equal the installed APK manifest metadata value `com.anezium.rokidbus.plugin.ID`. The Nexus client uses this as an installed-plugin join key.
- `nexus.apiVersion`: Nexus plugin API version declared by the plugin.
- `nexus.capabilities`: plugin capabilities, such as `surfaces`.
- `nexus.launchable`: whether Nexus may launch the plugin directly.
- `nexus.settingsActivity`: activity class Nexus opens for plugin settings.
- `nexus.minHostVersionCode`: minimum compatible Rokid Nexus host version code.
- `artifact`: the single phone APK. `artifact.packageName` is the second installed-plugin join key. `artifact.signerSha256` is the lowercase hexadecimal SHA-256 digest of the APK's single signing certificate (the certificate DER bytes, not the APK). The remaining fields identify and verify the exact release APK (`url`, `sha256`, `sizeBytes`, `versionCode`, and `versionName`).

Only add a real descriptor after its release APK is publicly available and all artifact verification fields have been extracted from that APK. Do not publish placeholder URLs, checksums, sizes, package names, or version metadata.

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

Run `node --test tests/*.test.mjs` to exercise the example descriptor, required join-key validation, and duplicate `nexus.pluginId` rejection.
