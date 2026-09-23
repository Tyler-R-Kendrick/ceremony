import assert from "node:assert/strict";
import test from "node:test";
import {
  destinationUrl,
  destinationUrlFromSegments,
  type ApprovedDestination,
} from "../../../src/server/connectors/binding.js";
import {
  encodePathSegment,
  canonicalConnectorJson,
} from "../../../src/core/connectors/identity.js";

/*
 * `destinationUrl` decides whether a request an operation asks for stays inside
 * what a reviewer approved. Its neighbour `segments.test.ts` proves values
 * cannot become structure; this proves the containment itself, which that file
 * exercises with one destination, one prefix and always a path beneath it.
 *
 * Mutation testing is what asked for this: with only that destination, the
 * prefix comparison could be inverted, the trailing separator dropped, or the
 * root-prefix case negated, and every test still passed. A guard whose
 * boundaries are never crossed in a test is a guard nobody has checked, and the
 * boundary here is the difference between reaching `/v1` and reaching
 * `/v1-internal`.
 */

const at = (
  pathPrefix: string | undefined,
  origin = "https://api.example.com",
): ApprovedDestination => ({
  id: "api",
  origin,
  ...(pathPrefix === undefined ? {} : { pathPrefix }),
  network: "public",
});

test("INT-CONT-01: a path must be one absolute path, not a relative or foreign one", () => {
  const destination = at("/v1");
  for (const path of [
    "v1/things", // relative: resolved against the origin it would still move
    "", // nothing at all
    "//evil.example.com/v1", // protocol-relative: a different host entirely
    "///v1", // and its longer spelling
  ])
    assert.throws(
      () => destinationUrl(destination, path),
      /single absolute path/,
      JSON.stringify(path),
    );
});

test("INT-CONT-02: an encoded separator is refused in either case", () => {
  // The plain builder refuses it outright rather than deciding what an
  // intermediary will do with it; a value that needs one goes through
  // destinationUrlFromSegments instead.
  for (const path of ["/v1/a%2Fb", "/v1/a%2fb", "/v1/%2F", "/v1/%2f"])
    assert.throws(
      () => destinationUrl(at("/v1"), path),
      /single absolute path/,
      path,
    );
});

test("INT-CONT-03: the prefix boundary is a path boundary, not a string prefix", () => {
  const destination = at("/v1");
  // Inside: the prefix itself, and anything beneath it.
  assert.equal(destinationUrl(destination, "/v1").pathname, "/v1");
  assert.equal(
    destinationUrl(destination, "/v1/things").pathname,
    "/v1/things",
  );
  assert.equal(destinationUrl(destination, "/v1/").pathname, "/v1/");

  // Outside: a sibling that merely starts with the same characters. This is the
  // case the guard exists for -- approving /v1 must not approve /v1-internal --
  // and nothing tested it before.
  for (const path of [
    "/v1-internal/secrets",
    "/v1extra",
    "/v10/things",
    "/v2/things",
    "/",
    "/other",
  ])
    assert.throws(
      () => destinationUrl(destination, path),
      /outside the approved prefix/,
      path,
    );
});

test("INT-CONT-04: a prefix that already ends in a separator behaves the same", () => {
  const destination = at("/v1/");
  assert.equal(
    destinationUrl(destination, "/v1/things").pathname,
    "/v1/things",
  );
  assert.equal(destinationUrl(destination, "/v1/").pathname, "/v1/");
  // Still a path boundary: the separator is not doubled and the sibling is out.
  assert.throws(
    () => destinationUrl(destination, "/v1-internal"),
    /outside the approved prefix/,
  );
});

test("INT-CONT-05: a root prefix admits any path, and an absent one means root", () => {
  for (const destination of [at("/"), at(undefined)]) {
    for (const path of ["/", "/anything", "/deep/er/still"])
      assert.equal(destinationUrl(destination, path).pathname, path, path);
    // Root is not a licence to leave the origin.
    assert.throws(() => destinationUrl(destination, "//evil.example.com/x"));
    // A dot segment under a root prefix normalizes and is allowed, because
    // there is no prefix to climb out of: everything on this origin was
    // approved. Worth stating plainly, because a reader who has just seen
    // traversal refused under /v1 will assume it is refused everywhere, and the
    // thing being contained is the prefix rather than the shape of the path.
    assert.equal(
      destinationUrl(destination, "/../etc/passwd").pathname,
      "/etc/passwd",
    );
    // An encoded dot segment is decoded and normalized by the URL parser before
    // containment is judged, so it is the normalized path that has to be
    // inside. Under a root prefix that is still inside.
    assert.equal(destinationUrl(destination, "/a/%2e%2e/b").pathname, "/b");
  }
});

test("INT-CONT-06: a dot segment cannot climb out of the prefix", () => {
  const destination = at("/v1");
  for (const path of [
    "/v1/../etc/passwd",
    "/v1/a/../../etc/passwd",
    "/v1/..",
    "/..",
  ])
    assert.throws(
      () => destinationUrl(destination, path),
      /outside the approved prefix/,
      path,
    );
  // A dot segment that stays inside is normalized and kept.
  assert.equal(destinationUrl(destination, "/v1/a/../b").pathname, "/v1/b");
  // Encoded the same way: the parser decodes "%2e" and normalizes before
  // containment is judged, so an encoded climb is caught by this same check
  // rather than slipping past it as an opaque value.
  assert.throws(
    () => destinationUrl(destination, "/v1/%2e%2e/etc/passwd"),
    /outside the approved prefix/,
  );
  assert.equal(destinationUrl(destination, "/v1/a/%2e%2e/b").pathname, "/v1/b");
});

test("INT-CONT-07: the origin is kept exactly, including a loopback port", () => {
  const loopback = at("/v1", "http://127.0.0.1:4173");
  const url = destinationUrl(loopback, "/v1/things");
  assert.equal(url.origin, "http://127.0.0.1:4173");
  assert.equal(url.pathname, "/v1/things");
  // A query or fragment in the operation path stays with the request rather
  // than being read as part of the path being contained.
  const withQuery = destinationUrl(at("/v1"), "/v1/things?page=2#top");
  assert.equal(withQuery.pathname, "/v1/things");
  assert.equal(withQuery.search, "?page=2");
});

test("INT-CONT-08: the segment builder enforces the same boundary", () => {
  const destination = at("/v1");
  // A value cannot reach a sibling of the prefix any more than a template can.
  assert.throws(
    () => destinationUrlFromSegments(destination, "/v1-internal/{}", ["x"]),
    /outside the approved prefix/,
  );
  // With a root prefix the segment builder still encodes values once.
  assert.equal(
    destinationUrlFromSegments(at("/"), "/{}", ["a/b"]).pathname,
    "/a%2Fb",
  );
  // And a prefix ending in a separator is accepted by it too.
  assert.equal(
    destinationUrlFromSegments(at("/v1/"), "/v1/{}", ["thing"]).pathname,
    "/v1/thing",
  );
});

test("INT-CONT-09: the sub-delimiters encodeURIComponent leaves alone are escaped", () => {
  // These five are the reason encodePathSegment exists rather than a bare
  // encodeURIComponent: registries and brokers do treat them as syntax.
  assert.equal(encodePathSegment("!"), "%21");
  assert.equal(encodePathSegment("'"), "%27");
  assert.equal(encodePathSegment("("), "%28");
  assert.equal(encodePathSegment(")"), "%29");
  assert.equal(encodePathSegment("*"), "%2A");
  assert.equal(encodePathSegment("a!b'c(d)e*f"), "a%21b%27c%28d%29e%2Af");
  // Hexadecimal is upper case, so one spelling reaches an upstream that
  // compares the encoded form byte for byte.
  assert.match(encodePathSegment("*"), /%2A/);
  // Unreserved characters are left exactly as they are.
  assert.equal(encodePathSegment("Aa0-_.~"), "Aa0-_.~");
});

test("INT-CONT-10: canonicalization refuses a document deeper than its ceiling", () => {
  const nest = (depth: number) => {
    let value: unknown = 1;
    for (let index = 0; index < depth; index++) value = { a: value };
    return value;
  };
  // At the ceiling it still canonicalizes; one deeper is refused with an error
  // rather than a stack overflow inside a digest.
  assert.equal(typeof canonicalConnectorJson(nest(256)), "string");
  assert.throws(() => canonicalConnectorJson(nest(257)), RangeError);
  // An array nests the same way and is bounded the same way.
  const nestArray = (depth: number) => {
    let value: unknown = 1;
    for (let index = 0; index < depth; index++) value = [value];
    return value;
  };
  assert.equal(typeof canonicalConnectorJson(nestArray(256)), "string");
  assert.throws(() => canonicalConnectorJson(nestArray(257)), RangeError);
});
