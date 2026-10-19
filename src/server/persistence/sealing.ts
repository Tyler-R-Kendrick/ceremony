import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/*
 * What the store does with the deployment's vault keys. Every record value is
 * sealed with AES-256-GCM under the current key, bound to where it is stored
 * (tenant, kind, id), its revision and the key's id; earlier keys stay in the
 * ring only to open what they sealed until it is sealed again.
 *
 * The same keys also give keyed digests: a record that has to recognise a
 * value later without holding it (a submission to a handoff) keeps an
 * HMAC-SHA-256 of it rather than a plain digest, so a short value cannot be
 * guessed back from the record by anyone without the vault key. The HMAC key
 * is derived from the vault key per purpose (HKDF-SHA-256), never the key
 * that seals records, so no digest is ever made under the encryption key.
 */

export type Keyring = {
  current: string;
  keys: Readonly<Record<string, Uint8Array>>;
};

export function validateKeys(keyring: Keyring): void {
  if (
    !Object.hasOwn(keyring.keys, keyring.current) ||
    !Object.entries(keyring.keys).every(
      ([id, key]) => /^[a-zA-Z0-9_-]{1,64}$/.test(id) && key.byteLength === 32,
    )
  )
    throw new Error("Invalid encryption key configuration");
}

/** `where` is the record's validated (tenant, kind, id). */
export function seal(
  where: readonly string[],
  revision: number,
  value: unknown,
  keyring: Keyring,
): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    keyring.keys[keyring.current]!,
    iv,
  );
  cipher.setAAD(
    Buffer.from(JSON.stringify([...where, revision, keyring.current])),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return Buffer.from(
    JSON.stringify({
      key: keyring.current,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: ciphertext.toString("base64"),
    }),
  );
}

export function open<T>(
  where: readonly string[],
  revision: number,
  value: unknown,
  keyring: Keyring,
): T {
  try {
    if (!(value instanceof Uint8Array)) throw new Error();
    const envelope = JSON.parse(Buffer.from(value).toString());
    if (
      typeof envelope.key !== "string" ||
      !Object.hasOwn(keyring.keys, envelope.key)
    )
      throw new Error();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyring.keys[envelope.key]!,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAAD(
      Buffer.from(JSON.stringify([...where, revision, envelope.key])),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.data, "base64")),
        decipher.final(),
      ]).toString(),
    ) as T;
  } catch {
    throw new Error("Protected record cannot be decrypted");
  }
}

const DIGEST_SALT = Buffer.from("ceremony.keyed-digest.v1");
const purposePattern = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/**
 * HMAC-SHA-256 of `data` under the key derived for `purpose` from each vault
 * key in the ring, the current key's first. A digest is written with the
 * current key and recognised under any key still in the ring, so a key
 * rotation does not make a value written just before it unrecognisable.
 */
export function keyedDigests(
  keyring: Keyring,
  purpose: string,
  data: string,
): string[] {
  if (!purposePattern.test(purpose))
    throw new Error("Invalid keyed digest purpose");
  const ids = [
    keyring.current,
    ...Object.keys(keyring.keys).filter((id) => id !== keyring.current),
  ];
  return ids.map((id) =>
    createHmac(
      "sha256",
      Buffer.from(
        hkdfSync(
          "sha256",
          keyring.keys[id]!,
          DIGEST_SALT,
          `ceremony.keyed-digest:${purpose}`,
          32,
        ),
      ),
    )
      .update(data)
      .digest("hex"),
  );
}
