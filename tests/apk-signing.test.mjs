import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSignerSha256,
  parseApksignerCertificateSha256,
} from "../scripts/lib-apk-signing.mjs";

const digest = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

test("parses and normalizes the single certificate digest printed by apksigner", () => {
  assert.equal(
    parseApksignerCertificateSha256(
      `Signer #1 certificate DN: CN=Example\nSigner #1 certificate SHA-256 digest: ${digest.toUpperCase()}\n`,
    ),
    digest,
  );
});

test("rejects apksigner output with no certificate digest", () => {
  assert.throws(
    () => parseApksignerCertificateSha256("DOES NOT VERIFY\n"),
    /reported 0 signer certificates/,
  );
});

test("rejects APKs with multiple signer certificates", () => {
  assert.throws(
    () => parseApksignerCertificateSha256(
      `Signer #1 certificate SHA-256 digest: ${digest}\n` +
      `Signer #2 certificate SHA-256 digest: ${"1".repeat(64)}\n`,
    ),
    /reported 2 signer certificates/,
  );
});

test("parses the per-scheme format printed by apksigner from build-tools 37", () => {
  assert.equal(
    parseApksignerCertificateSha256(
      `V2 Signer: certificate DN: CN=Example\nV2 Signer: certificate SHA-256 digest: ${digest}\n`,
    ),
    digest,
  );
});

test("dedupes the same certificate printed once per signature scheme", () => {
  assert.equal(
    parseApksignerCertificateSha256(
      `V2 Signer: certificate SHA-256 digest: ${digest}\n` +
      `V3 Signer: certificate SHA-256 digest: ${digest}\n` +
      `V3.1 Signer: certificate SHA-256 digest: ${digest}\n`,
    ),
    digest,
  );
});

test("rejects per-scheme output carrying two distinct certificates", () => {
  assert.throws(
    () => parseApksignerCertificateSha256(
      `V2 Signer: certificate SHA-256 digest: ${digest}\n` +
      `V3 Signer: certificate SHA-256 digest: ${"1".repeat(64)}\n`,
    ),
    /reported 2 signer certificates/,
  );
});

test("requires the documented fallback digest to be lowercase hexadecimal", () => {
  assert.equal(assertSignerSha256(digest), digest);
  assert.throws(() => assertSignerSha256(digest.toUpperCase()), /64 lowercase hexadecimal/);
});
