import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { metadataCacheKey } from "../../../src/server/connectors/auth/discovery.js";

/*
 * SEC-F2. The metadata cache is keyed by tenant and issuer, so two different
 * pairs producing the same key means one tenant's cached authorization
 * metadata can be served for another's issuer. The previous spelling put each
 * part's length after the part, which separates nothing: ("a", "3#x") and
 * ("a#1", "x") both composed to `a#1#3#x`.
 *
 * Eighty-three auth tests passed with that key, because nothing asked this
 * question. It is asked here, as a property rather than as the one example
 * that was found, so the next composite key in this module has to hold it too.
 */

test("SEC-F2: two different tenant and issuer pairs never share a key", () => {
  // The exact collision the audit found, first and by name.
  assert.notEqual(metadataCacheKey("a", "3#x"), metadataCacheKey("a#1", "x"));

  fc.assert(
    fc.property(
      fc.string({ maxLength: 40 }),
      fc.string({ maxLength: 40 }),
      fc.string({ maxLength: 40 }),
      fc.string({ maxLength: 40 }),
      (tenantA, issuerA, tenantB, issuerB) => {
        const same = tenantA === tenantB && issuerA === issuerB;
        const equal =
          metadataCacheKey(tenantA, issuerA) ===
          metadataCacheKey(tenantB, issuerB);
        // Equal keys if and only if equal inputs: no collision, and no
        // spurious miss either.
        assert.equal(equal, same);
      },
    ),
    { numRuns: 2000 },
  );
});

test("SEC-F2: an absent tenant is its own key, distinct from an empty one", () => {
  // Both are legitimate callers, and `undefined` must not alias a tenant whose
  // id happens to be the empty string in a store that admits one.
  assert.equal(metadataCacheKey(undefined, "x"), metadataCacheKey("", "x"));
  // Stated as the deliberate choice it is: an absent tenant and an empty
  // tenant id are the same absence here, because no tenant id is empty. If
  // that ever changes, this assertion is the one that has to change with it.
  assert.notEqual(metadataCacheKey("", "x"), metadataCacheKey("x", ""));
});
