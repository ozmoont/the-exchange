import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for at-rest secrets stored in JSONB columns.
 * Used for `partners.credentials` so a database dump doesn't expose
 * partner App-Keys, Secret-Keys, or webhook secrets in plaintext.
 *
 * Format on disk:
 *   { __enc: 1, iv: base64, ct: base64, tag: base64 }
 *
 * `decryptIfNeeded` is safe to call on plaintext objects — seed data,
 * mock partner config, and anything migrated from a previous version
 * (which didn't encrypt) is returned as-is.
 */

const ENC_VERSION = 1;
const ALGO = "aes-256-gcm";
const IV_LEN = 12;        // GCM standard
const KEY_LEN = 32;       // 256 bits

type EncryptedBlob = {
  __enc: typeof ENC_VERSION;
  iv: string;
  ct: string;
  tag: string;
};

function requireKey(): Buffer {
  const raw = process.env.PARTNER_CREDENTIAL_KEY;
  if (!raw) {
    throw new Error(
      "PARTNER_CREDENTIAL_KEY is not set. Generate with: openssl rand -base64 32",
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error("PARTNER_CREDENTIAL_KEY is not valid base64");
  }
  if (key.length !== KEY_LEN) {
    throw new Error(
      `PARTNER_CREDENTIAL_KEY must decode to ${KEY_LEN} bytes (got ${key.length}). Regenerate with: openssl rand -base64 32`,
    );
  }
  return key;
}

/**
 * Encrypt an object. Returns the on-disk blob shape.
 */
export function encryptCredentials(plain: Record<string, unknown>): EncryptedBlob {
  const key = requireKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(plain), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    __enc: ENC_VERSION,
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * Decrypt a stored credentials object. Returns plaintext object if the value
 * is already plaintext (no `__enc` marker), or null if input is null/empty.
 * Throws if the blob is encrypted-shaped but fails to decrypt/authenticate.
 */
export function decryptIfNeeded(
  stored: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!stored) return null;

  // Plaintext fallback: anything without the version marker is treated as
  // already-decrypted. Lets seed data and pre-encryption-era partners keep
  // working without a forced migration.
  if (stored.__enc !== ENC_VERSION) {
    return stored;
  }

  const blob = stored as unknown as EncryptedBlob;
  const key = requireKey();
  const iv = Buffer.from(blob.iv, "base64");
  const ct = Buffer.from(blob.ct, "base64");
  const tag = Buffer.from(blob.tag, "base64");

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
}
