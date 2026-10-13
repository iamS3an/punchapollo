import { createHmac } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeBase32(text) {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const character of clean) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error("TOTP secret is not valid base32.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }

  if (bytes.length === 0) throw new Error("TOTP secret is empty.");
  return Buffer.from(bytes);
}

// Accepts a bare base32 secret or a full otpauth://totp/... URI from a QR code.
export function parseTotpSecret(input) {
  const text = input.trim();
  if (!text.toLowerCase().startsWith("otpauth://")) {
    return { key: decodeBase32(text), algorithm: "sha1", digits: 6, period: 30 };
  }

  const url = new URL(text);
  if (url.hostname.toLowerCase() !== "totp") throw new Error("Only otpauth://totp URIs are supported.");
  const secret = url.searchParams.get("secret");
  if (!secret) throw new Error("The otpauth URI has no secret parameter.");

  return {
    key: decodeBase32(secret),
    algorithm: (url.searchParams.get("algorithm") ?? "SHA1").toLowerCase(),
    digits: Number(url.searchParams.get("digits") ?? 6),
    period: Number(url.searchParams.get("period") ?? 30)
  };
}

export function generateTotp(secret, now = Date.now()) {
  const { key, algorithm, digits, period } = parseTotpSecret(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)));

  const digest = createHmac(algorithm, key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}

// Seconds until the current code stops being valid.
export function totpSecondsRemaining(secret, now = Date.now()) {
  const { period } = parseTotpSecret(secret);
  return period - (Math.floor(now / 1000) % period);
}
