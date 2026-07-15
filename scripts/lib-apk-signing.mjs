const signerSha256Pattern = /^[0-9a-f]{64}$/;

export function assertSignerSha256(value, label = "signerSha256") {
  if (!signerSha256Pattern.test(value || "")) {
    throw new Error(`${label} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

export function parseApksignerCertificateSha256(output) {
  const digests = [...String(output || "").matchAll(
    /^Signer #\d+ certificate SHA-256 digest:\s*([0-9a-f]{64})\s*$/gim,
  )].map((match) => match[1].toLowerCase());

  if (digests.length !== 1) {
    throw new Error(`apksigner reported ${digests.length} signer certificates; exactly one is required`);
  }
  return digests[0];
}
