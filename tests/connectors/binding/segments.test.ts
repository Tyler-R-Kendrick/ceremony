import assert from "node:assert/strict";
import test from "node:test";
import {
  destinationUrl,
  destinationUrlFromSegments,
  type ApprovedDestination,
} from "../../../src/server/connectors/binding.js";

/*
 * `destinationUrlFromSegments` exists because two providers needed a path
 * segment whose value legitimately contains a slash, and each grew a private
 * copy of the containment checks to get one. A duplicated check is a check
 * that drifts, so the shared helper has to be at least as strict as the
 * builder it wraps. These tests are the proof of that, written from the
 * attack side: a caller supplies values, never structure.
 */

const destination: ApprovedDestination = {
  id: "api",
  origin: "https://api.example.com",
  pathPrefix: "/v1",
  network: "public",
};

test("INT-BIND-01: a value containing a slash is carried as one segment", () => {
  const url = destinationUrlFromSegments(destination, "/v1/servers/{}", [
    "io.github.acme/server",
  ]);
  assert.equal(url.origin, destination.origin);
  assert.equal(url.pathname, "/v1/servers/io.github.acme%2Fserver");
  // The slash survives as data, so the upstream sees the identifier it published.
  assert.equal(
    decodeURIComponent(url.pathname.split("/").at(-1) ?? ""),
    "io.github.acme/server",
  );
  // And the plain builder still refuses the same spelling, unchanged.
  assert.throws(() =>
    destinationUrl(destination, "/v1/servers/io.github.acme%2Fserver"),
  );
});

test("INT-BIND-02: a value that would traverse once decoded is refused", () => {
  // The separators are encoded, so the path is inert as sent. But an
  // intermediary that decodes once would see /v1/servers/a/../../etc/passwd,
  // which is exactly the risk the plain builder refuses an encoded slash for.
  // Carrying a slash is allowed; carrying a traversal is not.
  assert.throws(
    () =>
      destinationUrlFromSegments(destination, "/v1/servers/{}", [
        "a/../../etc/passwd",
      ]),
    /outside the approved prefix/,
  );
  // A slash with no traversal in it is still carried.
  const fine = destinationUrlFromSegments(destination, "/v1/servers/{}", [
    "a/b/c",
  ]);
  assert.equal(fine.pathname, "/v1/servers/a%2Fb%2Fc");
});

test("INT-BIND-03: a value cannot escape the approved prefix or origin", () => {
  // A dot segment survives percent-encoding untouched, because a dot is
  // unreserved, and the URL parser would then normalize it away and move the
  // request. Caught by writing this test: it is refused, not encoded.
  for (const dotted of [".", ".."])
    assert.throws(
      () => destinationUrlFromSegments(destination, "/v1/x/{}", [dotted]),
      `value ${dotted} must be refused outright`,
    );

  // Everything else stays a value: encoded, inside the prefix, same origin.
  // "%2e%2e" is a literal value, not a dot segment: encoding it once more
  // yields "%252e%252e", which decodes back to the text and never to "..".
  for (const hostile of [
    "%2e%2e",
    "//evil.example.com",
    "\\evil",
    "a b",
    "?x=1",
    "#f",
  ]) {
    const url = destinationUrlFromSegments(destination, "/v1/x/{}", [hostile]);
    assert.equal(url.origin, destination.origin, hostile);
    assert.ok(url.pathname.startsWith("/v1/x/"), hostile);
    assert.equal(url.search, "", hostile);
    assert.equal(url.hash, "", hostile);
  }
});

test("INT-BIND-04: the template itself is still validated", () => {
  // A template escaping the prefix is refused even with a harmless value.
  assert.throws(() =>
    destinationUrlFromSegments(destination, "/other/{}", ["ok"]),
  );
  // As is a template that is not a single absolute path.
  assert.throws(() =>
    destinationUrlFromSegments(destination, "//evil.example.com/{}", ["ok"]),
  );
  // An encoded slash written into the template, rather than supplied as a
  // value, remains refused: there the shape itself is in doubt.
  assert.throws(() =>
    destinationUrlFromSegments(destination, "/v1/a%2Fb/{}", ["ok"]),
  );
});

test("INT-BIND-05: segment count must match the template exactly", () => {
  assert.throws(() =>
    destinationUrlFromSegments(destination, "/v1/a/{}/b/{}", ["one"]),
  );
  assert.throws(() =>
    destinationUrlFromSegments(destination, "/v1/a/{}", ["one", "two"]),
  );
  assert.throws(() =>
    destinationUrlFromSegments(destination, "/v1/a/{}", [""]),
  );
});

test("INT-BIND-06: several segments are each encoded once", () => {
  const url = destinationUrlFromSegments(
    destination,
    "/v1/repos/{}/issues/{}",
    ["acme/widgets", "42"],
  );
  assert.equal(url.pathname, "/v1/repos/acme%2Fwidgets/issues/42");
  // Encoding is once-only: a percent sign in the value is itself escaped,
  // never re-interpreted as an existing escape.
  const once = destinationUrlFromSegments(destination, "/v1/x/{}", ["a%2Fb"]);
  assert.equal(once.pathname, "/v1/x/a%252Fb");
});
