const signerSha256Pattern = /^[0-9a-f]{64}$/;

export function assertSignerSha256(value, label = "signerSha256") {
  if (!signerSha256Pattern.test(value || "")) {
    throw new Error(`${label} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

export function parseApksignerCertificateSha256(output) {
  // Build-tools <= 36 print "Signer #1 certificate ..."; build-tools >= 37 print
  // one block per signature scheme ("V2 Signer: certificate ...", "V3 Signer: ..."),
  // so the same certificate can legitimately appear once per scheme.
  const digests = [...String(output || "").matchAll(
    /^(?:Signer #\d+|V\d+(?:\.\d+)? Signer:)\s+certificate SHA-256 digest:\s*([0-9a-f]{64})\s*$/gim,
  )].map((match) => match[1].toLowerCase());

  const unique = [...new Set(digests)];
  if (unique.length !== 1) {
    throw new Error(`apksigner reported ${unique.length} signer certificates; exactly one is required`);
  }
  return unique[0];
}
