/**
 * The page's credential vault, and the crypto it is built on.
 *
 * A ceremony that finishes and hands back nothing has orphaned its own result:
 * the connection exists, and the person who made it has no way to name it or
 * use it. This is the other half. Every completed ceremony on this page issues
 * exactly two things — a reference, which is safe to say out loud, and a key,
 * which is not — and puts the connection behind them.
 *
 * The split is the whole point. The reference is a `uuid`: it identifies the
 * connection and grants nothing, so it can be written to a document, pasted
 * into a prompt, or handed to an assistant without handing over access. The key
 * is 32 random bytes that exist in this browser and nowhere else: never sent to
 * the store, never written to the diagnostics document, never rendered as text
 * until somebody presses Show. Only the two together redeem a connection.
 *
 * So the vault stores the key the way any credential store stores one — salted,
 * derived, compared without branching on content — and holds the plaintext for
 * nobody, including itself.
 */

const encoder = new TextEncoder();

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

export const randomBytes = (size: number): Uint8Array =>
  globalThis.crypto.getRandomValues(new Uint8Array(size));

export const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(bytes instanceof Uint8Array ? bytes.buffer : bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const bytesOf = (value: string): Uint8Array => {
  const out = new Uint8Array(value.length / 2);
  for (let index = 0; index < out.length; index += 1)
    out[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return out;
};

/** PBKDF2-SHA256. The iteration count travels with the record it produced. */
export async function derive(
  secret: string,
  salt: string,
  iterations: number,
): Promise<string> {
  const key = await subtle().importKey(
    "raw",
    encoder.encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return hex(
    await subtle().deriveBits(
      {
        name: "PBKDF2",
        salt: bytesOf(salt) as unknown as BufferSource,
        iterations,
        hash: "SHA-256",
      },
      key,
      256,
    ),
  );
}

export async function digest(value: string): Promise<string> {
  return hex(await subtle().digest("SHA-256", encoder.encode(value)));
}

/**
 * Comparison that takes the same time whichever character differs first.
 *
 * Both sides here are derived values of a fixed length, so the early return
 * leaks only a length that is never secret.
 */
export function matches(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

/** Digits, drawn without the modulo bias a naïve `% 10` would introduce. */
export function digits(count: number): string {
  let out = "";
  while (out.length < count) {
    for (const byte of randomBytes(count * 2)) {
      if (byte >= 250) continue;
      out += String(byte % 10);
      if (out.length === count) break;
    }
  }
  return out;
}

/** Crockford's alphabet: no I, L, O or U, so nothing is misread aloud. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function passphrase(groups = 4, size = 5): string {
  const out: string[] = [];
  for (let group = 0; group < groups; group += 1) {
    let word = "";
    while (word.length < size)
      for (const byte of randomBytes(size)) {
        if (byte >= 256 - (256 % ALPHABET.length)) continue;
        word += ALPHABET[byte % ALPHABET.length];
        if (word.length === size) break;
      }
    out.push(word);
  }
  return out.join("-");
}

/** How the vault derives a key's stored form. Interactive, so not PBKDF2-slow. */
const KEY_ITERATIONS = 100_000;

/** One thing a completed ceremony hands back, and whether it must stay hidden. */
export interface Issued {
  name: string;
  label: string;
  value: string;
  note: string;
  /** Rendered in a masked field with Show and Copy, rather than as text. */
  secret: boolean;
}

/** A connection, named by something that grants nothing. */
export interface ConnectionRecord {
  secretRef: string;
  connectorId: string;
  connectorName: string;
  scopes: readonly string[];
  /** The provider's own non-secret name for what was connected. */
  reference: string;
  issuedAt: string;
}

/** What redeeming a connection gives back — for a connector, a way to call it. */
export interface RedeemedConnection extends ConnectionRecord {
  call?: (tool: string, input?: unknown) => Promise<unknown>;
}

export interface Handback {
  record: ConnectionRecord;
  issued: readonly Issued[];
  headline: string;
}

interface Held {
  record: ConnectionRecord;
  keySalt: string;
  keyHash: string;
  call?: (tool: string, input?: unknown) => Promise<unknown>;
}

/**
 * The vault itself: in memory, in this tab, and gone when the tab is.
 *
 * Deliberately not the artifact store. Everything the store holds is readable
 * by everyone who can open this page, so a key written there would be a key
 * given away. A connection that does not survive a reload is the correct
 * trade: the ceremony that produced it takes seconds to run again.
 */
class ConnectionVault {
  private readonly held = new Map<string, Held>();

  /** Mint a reference and a key, put the connection behind both, hand them out. */
  async issue(
    record: Omit<ConnectionRecord, "secretRef" | "issuedAt">,
    extra: readonly Issued[] = [],
    call?: (tool: string, input?: unknown) => Promise<unknown>,
  ): Promise<Handback> {
    const secretRef = globalThis.crypto.randomUUID();
    const key = hex(randomBytes(32));
    const keySalt = hex(randomBytes(16));
    const full: ConnectionRecord = {
      ...record,
      secretRef,
      issuedAt: new Date().toISOString(),
    };
    this.held.set(secretRef, {
      record: full,
      keySalt,
      keyHash: await derive(key, keySalt, KEY_ITERATIONS),
      ...(call ? { call } : {}),
    });
    return {
      record: full,
      headline: `Connected to ${record.connectorName}`,
      issued: [
        {
          name: "connectionKey",
          label: "Connection key",
          value: key,
          note: "The bearer half. It redeems the connection, it exists only in this tab, and the vault keeps a derived form of it rather than this value.",
          secret: true,
        },
        ...extra,
      ],
    };
  }

  /** Both halves, or nothing. A wrong key is indistinguishable from a wrong reference. */
  async redeem(
    secretRef: string,
    key: string,
  ): Promise<RedeemedConnection | undefined> {
    const entry = this.held.get(String(secretRef));
    if (!entry) return undefined;
    const attempt = await derive(String(key), entry.keySalt, KEY_ITERATIONS);
    if (!matches(attempt, entry.keyHash)) return undefined;
    return { ...entry.record, ...(entry.call ? { call: entry.call } : {}) };
  }

  /** What an assistant may be told: references and scopes, never a key. */
  list(): ConnectionRecord[] {
    return [...this.held.values()].map((entry) => entry.record);
  }

  forget(secretRef: string): void {
    this.held.delete(secretRef);
  }
}

export const connections = new ConnectionVault();

/** The call a person can paste into the console, with their own reference in it. */
export function redemption(
  record: ConnectionRecord,
  callable: boolean,
): string {
  return [
    `const key = prompt("Connection key");`,
    `const connection = await ceremony.redeem(`,
    `  "${record.secretRef}",`,
    `  key,`,
    `);`,
    ...(callable
      ? [`await connection.call("${record.scopes[0] ?? "list"}");`]
      : [`connection.scopes; // ${record.scopes.join(", ")}`]),
  ].join("\n");
}
