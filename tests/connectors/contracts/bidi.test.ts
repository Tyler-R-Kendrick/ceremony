import assert from "node:assert/strict";
import test from "node:test";
import {
  nativeIdentifierSchema,
  safeTextSchema,
} from "../../../src/core/connectors/identity.js";

/*
 * SEC-F7. An identifier is read by a person deciding what a connector may
 * touch, so a character that changes how it renders without changing what it
 * is belongs nowhere near one.
 *
 * The explicit embedding and isolate controls were already refused. The
 * implicit marks were not, and they are the easier attack: U+200E, U+200F and
 * U+061C set the direction of what follows with no range to close, so they
 * need no terminator. Written with escapes and asserted by code point, never
 * as literal bytes: a literal control character in a source file is the hazard
 * this repository now fails the build over.
 */

const MARKS = [
  { name: "LEFT-TO-RIGHT MARK", code: 0x200e },
  { name: "RIGHT-TO-LEFT MARK", code: 0x200f },
  { name: "ARABIC LETTER MARK", code: 0x061c },
];

const EXPLICIT = [
  { name: "LEFT-TO-RIGHT EMBEDDING", code: 0x202a },
  { name: "RIGHT-TO-LEFT OVERRIDE", code: 0x202e },
  { name: "FIRST STRONG ISOLATE", code: 0x2068 },
  { name: "POP DIRECTIONAL ISOLATE", code: 0x2069 },
];

test("SEC-F7: an identifier carrying a bidirectional mark is refused", () => {
  for (const { name, code } of MARKS) {
    const spoofed = `read${String.fromCodePoint(code)}-only`;
    assert.equal(
      nativeIdentifierSchema.safeParse(spoofed).success,
      false,
      `${name} must be refused in an identifier`,
    );
    assert.equal(
      safeTextSchema.safeParse(spoofed).success,
      false,
      `${name} must be refused in text shown to a person`,
    );
  }
});

test("SEC-F7: the explicit controls stay refused", () => {
  // Regression guard: widening the expression must not have dropped what it
  // already covered.
  for (const { name, code } of EXPLICIT)
    assert.equal(
      nativeIdentifierSchema.safeParse(`a${String.fromCodePoint(code)}b`)
        .success,
      false,
      `${name} must stay refused`,
    );
});

test("SEC-F7: ordinary upstream identifiers are unaffected", () => {
  // The refusal is narrow. An upstream identifier with dots, slashes, dashes,
  // colons or non-Latin script is still preserved exactly as spelled, because
  // this repository never slugs a native identifier.
  for (const identifier of [
    "io.github.acme/server",
    "orders-topic",
    "listItems",
    "Microsoft.Graph/users:read",
    "テスト",
    "منتج",
  ])
    assert.equal(
      nativeIdentifierSchema.safeParse(identifier).success,
      true,
      `${identifier} must still be accepted`,
    );
});
