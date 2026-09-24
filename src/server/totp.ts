import { createHash, createHmac } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238), computed from a seed the host
 * holds.
 *
 * A login that asks for an authenticator code used to have exactly one source
 * for it: a person reading their phone. A host that *holds* the enrolment seed
 * — because the account is a service account it enrolled itself — can compute
 * the same code, and this module is that computation and nothing else. It does
 * not fetch or log anything and keeps no seed or code, so the only way either
 * leaves it is through the caller that asked. The one thing it remembers is
 * which time step it last issued a code for, per seed digest, so that it never
 * issues the same code twice (`nextTotpCode`).
 *
 * The seed is the long-lived secret here, not the code. A code is valid for one
 * period; a seed mints every future code. Callers treat it accordingly: it is
 * resolved at the moment a code is needed, never placed in a plan, a snapshot,
 * an event or a tool result, and the driver's canary is armed with it before
 * the first page is read.
 */

export const totpAlgorithms = ["SHA1", "SHA256", "SHA512"] as const;
export type TotpAlgorithm = (typeof totpAlgorithms)[number];

export type TotpParameters = {
  /** The shared secret, as bytes. */
  secret: Uint8Array;
  algorithm: TotpAlgorithm;
  digits: 6 | 8;
  /** Seconds per step. */
  period: number;
};

/** Why a held value could not be read as a seed. Finite, and never the value. */
export class InvalidTotpSeed extends Error {
  constructor(
    readonly reason:
      "encoding" | "empty" | "algorithm" | "digits" | "period" | "type",
  ) {
    // The message names the rule that failed and nothing about the input: a
    // seed quoted into an error is a seed in a log.
    super(`Unusable TOTP seed: ${reason}`);
    this.name = "InvalidTotpSeed";
  }
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * RFC 4648 base32, the encoding every authenticator enrolment uses.
 *
 * Lenient where enrolment screens are inconsistent — case, spaces, hyphens and
 * trailing padding — and strict about everything else. A character outside the
 * alphabet is refused rather than skipped, because a silently shortened seed
 * produces codes that are wrong in a way nobody can diagnose.
 */
export function decodeBase32(text: string): Uint8Array {
  const cleaned = text.replace(/[\s-]/g, "").toUpperCase().replace(/=+$/, "");
  if (cleaned.length === 0) throw new InvalidTotpSeed("empty");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of cleaned) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new InvalidTotpSeed("encoding");
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
    buffer &= (1 << bits) - 1;
  }
  if (bytes.length === 0) throw new InvalidTotpSeed("empty");
  return Uint8Array.from(bytes);
}

/** RFC 4226 HOTP: the counter-based code TOTP is defined in terms of. */
export function hotp(
  secret: Uint8Array,
  counter: bigint | number,
  options: { algorithm?: TotpAlgorithm; digits?: 6 | 8 } = {},
): string {
  const digits = options.digits ?? 6;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac((options.algorithm ?? "SHA1").toLowerCase(), secret)
    .update(message)
    .digest();
  // Dynamic truncation, RFC 4226 section 5.3.
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** RFC 6238 TOTP at a given instant, in milliseconds since the epoch. */
export function totp(parameters: TotpParameters, atMs: number): string {
  const step = BigInt(Math.floor(atMs / 1000 / parameters.period));
  return hotp(parameters.secret, step, parameters);
}

/**
 * Read a held seed in either form an enrolment hands out.
 *
 * - A bare base32 secret, which means the RFC defaults: SHA-1, six digits,
 *   thirty seconds.
 * - An `otpauth://totp/...` URI, the QR code's content, whose `algorithm`,
 *   `digits` and `period` parameters override those defaults. The label and
 *   issuer are ignored: they describe the account, and nothing here needs to.
 *
 * Parameters outside what authenticators actually implement are refused by
 * name rather than approximated, so a misconfigured seed fails before a wrong
 * code is typed into somebody's login and counted against their lockout.
 */
export function parseTotpSeed(held: string): TotpParameters {
  const text = held.trim();
  if (!/^otpauth:/i.test(text))
    return {
      secret: decodeBase32(text),
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new InvalidTotpSeed("encoding");
  }
  // `otpauth://hotp/...` is a counter-based seed. Computing a time-based code
  // from it would type a wrong code, so it is refused as the wrong kind.
  if (url.host.toLowerCase() !== "totp") throw new InvalidTotpSeed("type");
  const secret = decodeBase32(url.searchParams.get("secret") ?? "");
  const algorithm = (
    url.searchParams.get("algorithm") ?? "SHA1"
  ).toUpperCase() as TotpAlgorithm;
  if (!totpAlgorithms.includes(algorithm))
    throw new InvalidTotpSeed("algorithm");
  const digits = Number(url.searchParams.get("digits") ?? 6);
  if (digits !== 6 && digits !== 8) throw new InvalidTotpSeed("digits");
  const period = Number(url.searchParams.get("period") ?? 30);
  if (!Number.isInteger(period) || period < 1 || period > 300)
    throw new InvalidTotpSeed("period");
  return { secret, algorithm, digits, period };
}

/** The code a held seed produces at `atMs`. */
export function totpCode(held: string, atMs: number): string {
  return totp(parseTotpSeed(held), atMs);
}

/**
 * The last time step this process issued a code for, per seed. Keyed by a
 * digest of the seed's parameters, never the seed, and bounded.
 */
const issuedSteps = new Map<string, number>();
const issuedLimit = 1024;

/** The clock did not reach a new period while a code was waited for. */
export class TotpClockStalled extends Error {
  constructor() {
    super("The clock did not reach a new TOTP period");
    this.name = "TotpClockStalled";
  }
}

/**
 * The code to type now, never one this process already issued.
 *
 * A verifier accepts a code once: RFC 6238 section 5.2 has it refuse a code
 * for a time step it already accepted one for. Two answers from one seed in
 * the same period - the code that confirmed an enrolment, then the first
 * sign-in; two sign-ins in a row - would send the same code twice, and the
 * second is refused. So when the current period's code was already issued,
 * this waits for the next period, as a person reading an authenticator
 * would, and issues that one. A code is recorded when it is issued, whether
 * or not it was then submitted, because nothing here can tell.
 *
 * The record is this process's only: another process holding the same seed
 * does not see it, and its code may be refused instead.
 */
export async function nextTotpCode(
  held: string,
  options: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<string> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const parameters = parseTotpSeed(held);
  const key = createHash("sha256")
    .update(parameters.secret)
    .update(
      `/${parameters.algorithm}/${parameters.digits}/${parameters.period}`,
    )
    .digest("hex");
  const periodMs = parameters.period * 1000;
  // Two waits reach the next period on any clock that moves.
  for (let waits = 0; ; waits++) {
    const at = now();
    const step = Math.floor(at / periodMs);
    const last = issuedSteps.get(key);
    if (last === undefined || step > last) {
      issuedSteps.delete(key);
      issuedSteps.set(key, step);
      if (issuedSteps.size > issuedLimit)
        issuedSteps.delete(issuedSteps.keys().next().value!);
      return totp(parameters, at);
    }
    if (waits >= 2) throw new TotpClockStalled();
    // A little past the boundary, so a clock that lags this one's by a few
    // milliseconds is in the new period too.
    await sleep((last + 1) * periodMs - at + 250);
  }
}

/**
 * Every spelling of a held seed a page could plausibly display.
 *
 * The driver's canary matches exact substrings, and a seed is routinely shown
 * in more than one form — the raw held value, the bare base32 secret, and the
 * grouped, lower-case form enrolment screens print. Guarding only the first
 * would let a page echo the seed in the second without tripping anything.
 */
export function totpSeedSpellings(held: string): string[] {
  const spellings = new Set<string>([held, held.trim()]);
  try {
    const text = held.trim();
    const raw = /^otpauth:/i.test(text)
      ? (new URL(text).searchParams.get("secret") ?? "")
      : text;
    const canonical = raw
      .replace(/[\s-]/g, "")
      .toUpperCase()
      .replace(/=+$/, "");
    if (canonical) {
      spellings.add(raw);
      spellings.add(canonical);
      spellings.add(canonical.toLowerCase());
      const grouped = canonical.match(/.{1,4}/g)?.join(" ");
      if (grouped) {
        spellings.add(grouped);
        spellings.add(grouped.toLowerCase());
      }
    }
  } catch {
    // An unparseable seed still has its raw spelling guarded above.
  }
  return [...spellings].filter((spelling) => spelling.length >= 4);
}
