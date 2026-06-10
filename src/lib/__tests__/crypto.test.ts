import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptCredentials, decryptIfNeeded } from "@/lib/crypto";

/**
 * Security tests for the at-rest credential cipher (AES-256-GCM).
 *
 * This module is the ONLY thing standing between a Postgres dump and
 * plaintext partner App-Keys / Secret-Keys / webhook secrets. The tests
 * below lock in the security properties we depend on:
 *   - confidentiality + integrity round-trips correctly
 *   - GCM authentication rejects the wrong key and any tampering
 *   - IVs are unique per encryption (nonce reuse would break GCM)
 *   - key material is validated (must be 32 bytes of base64)
 *   - the plaintext-passthrough path stays backward compatible
 *
 * Each test states the property it guards so a reviewer can see WHY it
 * exists, not just what it asserts.
 */

// A valid 32-byte (256-bit) key, base64-encoded — what AES-256 requires.
const KEY_A = randomBytes(32).toString("base64");
// A second, different valid key used to prove cross-key decryption fails.
const KEY_B = randomBytes(32).toString("base64");

// Restore the real env after each test so we never leak a test key into
// other suites running in the same process.
const ORIGINAL_KEY = process.env.PARTNER_CREDENTIAL_KEY;
beforeEach(() => {
  process.env.PARTNER_CREDENTIAL_KEY = KEY_A;
});
afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.PARTNER_CREDENTIAL_KEY;
  else process.env.PARTNER_CREDENTIAL_KEY = ORIGINAL_KEY;
});

describe("encryptCredentials / decryptIfNeeded — round-trip", () => {
  it("encrypts then decrypts back to the original object", () => {
    // Confidentiality + correctness: what goes in comes back out intact.
    const plain = { appKey: "AK-123", secretKey: "SK-xyz", webhookSecret: "wh_9" };
    const blob = encryptCredentials(plain);
    expect(decryptIfNeeded(blob)).toEqual(plain);
  });

  it("produces an encrypted blob that does not contain the plaintext", () => {
    // A DB dump of the blob must not reveal the secret in any field.
    const blob = encryptCredentials({ secretKey: "SUPER-SECRET-VALUE" });
    expect(JSON.stringify(blob)).not.toContain("SUPER-SECRET-VALUE");
    expect(blob.__enc).toBe(1);
    expect(typeof blob.iv).toBe("string");
    expect(typeof blob.ct).toBe("string");
    expect(typeof blob.tag).toBe("string");
  });
});

describe("decryptIfNeeded — GCM authentication (tamper + wrong key)", () => {
  it("throws when decrypting with a different key (auth tag mismatch)", () => {
    // Integrity: a stolen blob can't be read with any other key. GCM's
    // auth tag verification fails, so we throw rather than return garbage.
    const blob = encryptCredentials({ secretKey: "SK-xyz" });
    process.env.PARTNER_CREDENTIAL_KEY = KEY_B;
    expect(() => decryptIfNeeded(blob)).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    // Any modification of the ciphertext must be detected, not silently
    // decrypted into attacker-influenced plaintext.
    const blob = encryptCredentials({ secretKey: "SK-xyz" });
    const tampered = { ...blob, ct: flipFirstBase64Byte(blob.ct) };
    expect(() => decryptIfNeeded(tampered)).toThrow();
  });

  it("rejects a tampered authentication tag", () => {
    // Forging/altering the tag must fail — this is the integrity guarantee.
    const blob = encryptCredentials({ secretKey: "SK-xyz" });
    const tampered = { ...blob, tag: flipFirstBase64Byte(blob.tag) };
    expect(() => decryptIfNeeded(tampered)).toThrow();
  });

  it("rejects a tampered IV", () => {
    // The IV feeds the GCM tag computation, so altering it also fails auth.
    // (Documents that a swapped nonce can't be used to coerce plaintext.)
    const blob = encryptCredentials({ secretKey: "SK-xyz" });
    const tampered = { ...blob, iv: flipFirstBase64Byte(blob.iv) };
    expect(() => decryptIfNeeded(tampered)).toThrow();
  });
});

describe("encryptCredentials — IV uniqueness", () => {
  it("uses a fresh random IV for every encryption (no nonce reuse)", () => {
    // GCM security collapses if an IV is ever reused under the same key.
    // Encrypting identical plaintext many times must yield distinct IVs.
    const ivs = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ivs.add(encryptCredentials({ secretKey: "same" }).iv);
    }
    expect(ivs.size).toBe(100);
  });

  it("produces different ciphertext for identical plaintext", () => {
    // A direct consequence of unique IVs: identical secrets don't yield
    // identical blobs, so equal values aren't detectable on disk.
    const a = encryptCredentials({ secretKey: "same" });
    const b = encryptCredentials({ secretKey: "same" });
    expect(a.ct).not.toBe(b.ct);
  });
});

describe("decryptIfNeeded — plaintext passthrough & null handling", () => {
  it("returns objects without the __enc marker unchanged", () => {
    // Backward compatibility: seed data and pre-encryption-era partners
    // are stored as plaintext and must keep working without migration.
    const plain = { appKey: "plain-AK", secretKey: "plain-SK" };
    expect(decryptIfNeeded(plain)).toEqual(plain);
  });

  it("treats an unknown __enc version as plaintext (forward-compat guard)", () => {
    // Only the exact current version (1) is decrypted; anything else is
    // returned as-is rather than mis-decrypted.
    const future = { __enc: 999, iv: "x", ct: "y", tag: "z" } as unknown as Record<string, unknown>;
    expect(decryptIfNeeded(future)).toEqual(future);
  });

  it("returns null for null or undefined input", () => {
    // Defensive: a missing credentials column must not throw.
    expect(decryptIfNeeded(null)).toBeNull();
    expect(decryptIfNeeded(undefined)).toBeNull();
  });
});

describe("key validation (PARTNER_CREDENTIAL_KEY)", () => {
  it("throws a clear error when the key is not set", () => {
    // Fail loudly at call time rather than encrypting under an empty key.
    delete process.env.PARTNER_CREDENTIAL_KEY;
    expect(() => encryptCredentials({ a: 1 })).toThrow(/PARTNER_CREDENTIAL_KEY is not set/);
  });

  it("throws when the key does not decode to 32 bytes", () => {
    // AES-256 requires exactly 32 bytes; a short/long key must be rejected
    // rather than silently truncated.
    process.env.PARTNER_CREDENTIAL_KEY = Buffer.from("too-short").toString("base64");
    expect(() => encryptCredentials({ a: 1 })).toThrow(/32 bytes/);
  });
});

/**
 * Flip the first byte of a base64-encoded buffer to simulate corruption /
 * tampering, returning the re-encoded base64. Used by the GCM auth tests.
 */
function flipFirstBase64Byte(b64: string): string {
  const buf = Buffer.from(b64, "base64");
  buf[0] = buf[0] ^ 0xff;
  return buf.toString("base64");
}
