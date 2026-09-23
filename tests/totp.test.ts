import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  decodeBase32,
  hotp,
  InvalidTotpSeed,
  parseTotpSeed,
  totp,
  totpCode,
  totpSeedSpellings,
  type TotpAlgorithm,
} from "../src/server/totp.js";

/**
 * The generator is checked against the published vectors, not against itself.
 * RFC 4226 Appendix D fixes HOTP; RFC 6238 Appendix B fixes TOTP for all three
 * hash functions, including a time past 2038 that needs a 64-bit counter.
 */

const ascii = (text: string) => new TextEncoder().encode(text);

describe("RFC 4226 Appendix D", () => {
  const expected = [
    "755224",
    "287082",
    "359152",
    "969429",
    "338314",
    "254676",
    "287922",
    "162583",
    "399871",
    "520489",
  ];
  for (const [counter, code] of expected.entries())
    test(`HOTP counter ${counter}`, () => {
      assert.equal(hotp(ascii("12345678901234567890"), counter), code);
    });
});

describe("RFC 6238 Appendix B", () => {
  const seeds: Record<TotpAlgorithm, Uint8Array> = {
    SHA1: ascii("12345678901234567890"),
    SHA256: ascii("12345678901234567890123456789012"),
    SHA512: ascii(
      "1234567890123456789012345678901234567890123456789012345678901234",
    ),
  };
  const vectors: [number, Record<TotpAlgorithm, string>][] = [
    [59, { SHA1: "94287082", SHA256: "46119246", SHA512: "90693936" }],
    [1111111109, { SHA1: "07081804", SHA256: "68084774", SHA512: "25091201" }],
    [1111111111, { SHA1: "14050471", SHA256: "67062674", SHA512: "99943326" }],
    [1234567890, { SHA1: "89005924", SHA256: "91819424", SHA512: "93441116" }],
    [2000000000, { SHA1: "69279037", SHA256: "90698825", SHA512: "38618901" }],
    [20000000000, { SHA1: "65353130", SHA256: "77737706", SHA512: "47863826" }],
  ];
  for (const [seconds, codes] of vectors)
    for (const algorithm of ["SHA1", "SHA256", "SHA512"] as const)
      test(`T=${seconds} ${algorithm}`, () => {
        assert.equal(
          totp(
            { secret: seeds[algorithm], algorithm, digits: 8, period: 30 },
            seconds * 1000,
          ),
          codes[algorithm],
        );
      });
});

describe("held seeds", () => {
  /** Base32 of the RFC's SHA-1 seed, the form an enrolment screen shows. */
  const base32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  test("base32 decodes to the RFC seed, tolerating the ways screens print it", () => {
    for (const spelling of [
      base32,
      base32.toLowerCase(),
      "GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ",
      "gezd-gnbv-gy3t-qojq-gezd-gnbv-gy3t-qojq",
      `${base32}====`,
    ])
      assert.deepEqual(
        decodeBase32(spelling),
        ascii("12345678901234567890"),
        spelling,
      );
  });

  test("a bare secret means SHA-1, six digits, thirty seconds", () => {
    const parsed = parseTotpSeed(base32);
    assert.equal(parsed.algorithm, "SHA1");
    assert.equal(parsed.digits, 6);
    assert.equal(parsed.period, 30);
    // The six-digit truncation of the RFC's T=59 vector.
    assert.equal(totpCode(base32, 59_000), "287082");
  });

  test("an otpauth URI's parameters are honoured", () => {
    const seed = `otpauth://totp/Example:ada?secret=${base32}&issuer=Example&algorithm=SHA1&digits=8&period=30`;
    assert.equal(totpCode(seed, 59_000), "94287082");
    const sixty = `otpauth://totp/x?secret=${base32}&period=60`;
    // Step 0 at 59s with a sixty-second period is HOTP counter 0.
    assert.equal(totpCode(sixty, 59_000), "755224");
  });

  test("unusable seeds are refused by rule, and the error never quotes the seed", () => {
    const cases: [string, InvalidTotpSeed["reason"]][] = [
      ["", "empty"],
      ["NOT*BASE32", "encoding"],
      [`otpauth://hotp/x?secret=${base32}&counter=1`, "type"],
      [`otpauth://totp/x?secret=${base32}&algorithm=MD5`, "algorithm"],
      [`otpauth://totp/x?secret=${base32}&digits=7`, "digits"],
      [`otpauth://totp/x?secret=${base32}&period=0`, "period"],
    ];
    for (const [seed, reason] of cases)
      assert.throws(
        () => totpCode(seed, 0),
        (error: unknown) =>
          error instanceof InvalidTotpSeed &&
          error.reason === reason &&
          !(seed.length > 0 && error.message.includes(base32)),
        seed,
      );
  });

  test("every spelling a page could show is guarded, including the URI's secret", () => {
    const spellings = totpSeedSpellings(
      `otpauth://totp/x?secret=${base32.toLowerCase()}`,
    );
    for (const expected of [
      base32,
      base32.toLowerCase(),
      "GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ",
      "gezd gnbv gy3t qojq gezd gnbv gy3t qojq",
    ])
      assert.ok(spellings.includes(expected), expected);
  });
});
