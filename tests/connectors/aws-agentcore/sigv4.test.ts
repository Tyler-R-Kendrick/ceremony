import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  AWS_SIGV4_ALGORITHM,
  EMPTY_PAYLOAD_SHA256,
  amzDateTime,
  canonicalQueryString,
  canonicalUri,
  signRequest,
  signingKey,
  uriEncode,
} from "../../../src/server/connectors/providers/aws-agentcore/sigv4.js";

/*
 * The signer against the rules AWS publishes in
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
 * (retrieved 2026-09-18). The one value that documentation states outright —
 * the hash of an empty payload — is asserted as a known answer; the rest are
 * the structural rules, and interoperability is proven separately by the
 * loopback double, which verifies signatures with its own implementation.
 */

const credentials = {
  accessKeyId: "AKIDEXAMPLE000001",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const AT = Date.parse("2026-09-18T12:36:00.000Z");

test("the documented empty-payload hash is the one the signer uses", () => {
  assert.equal(
    EMPTY_PAYLOAD_SHA256,
    createHash("sha256").update("", "utf8").digest("hex"),
  );
  assert.equal(
    EMPTY_PAYLOAD_SHA256,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("UriEncode follows the documented rules, including the characters encodeURIComponent leaves alone", () => {
  assert.equal(uriEncode("abcXYZ019-._~"), "abcXYZ019-._~");
  assert.equal(uriEncode(" "), "%20");
  assert.equal(uriEncode("/"), "%2F");
  assert.equal(uriEncode("!'()*"), "%21%27%28%29%2A");
  assert.equal(uriEncode("a+b"), "a%2Bb");
});

test("the timestamp is UTC ISO 8601 basic format without milliseconds", () => {
  assert.equal(amzDateTime(AT), "20260918T123600Z");
});

test("the canonical query string sorts by encoded name then encoded value", () => {
  const url = new URL(
    "https://example.invalid/x?b=2&a=zz&a=aa&nextToken=a%2Fb",
  );
  assert.equal(canonicalQueryString(url), "a=aa&a=zz&b=2&nextToken=a%2Fb");
});

test("the canonical URI keeps the path but refuses segments it cannot encode unambiguously", () => {
  assert.equal(
    canonicalUri("/gateways/ceremony-fixture-gw-a1b2c3d4e5/targets/"),
    "/gateways/ceremony-fixture-gw-a1b2c3d4e5/targets/",
  );
  assert.throws(
    () => canonicalUri("/gateways/a b/"),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "invalid-request",
  );
});

test("the signing key chain is date, region, service, aws4_request", () => {
  const key = signingKey(
    credentials.secretAccessKey,
    "20260918",
    "us-east-1",
    "bedrock-agentcore",
  );
  assert.equal(key.byteLength, 32);
  assert.notDeepEqual(
    key,
    signingKey(
      credentials.secretAccessKey,
      "20260918",
      "us-west-2",
      "bedrock-agentcore",
    ),
    "a different region must derive a different key",
  );
});

test("a signed request carries the documented Authorization header and canonical form", () => {
  const url = new URL(
    "https://bedrock-agentcore-control.us-east-1.amazonaws.com/gateways/?maxResults=50",
  );
  const signed = signRequest(
    { method: "GET", url, headers: { accept: "application/json" } },
    {
      region: "us-east-1",
      service: "bedrock-agentcore",
      credentials,
      now: AT,
    },
  );
  assert.equal(
    signed.credentialScope,
    "20260918/us-east-1/bedrock-agentcore/aws4_request",
  );
  assert.match(
    signed.headers["authorization"]!,
    new RegExp(
      `^${AWS_SIGV4_ALGORITHM} Credential=${credentials.accessKeyId}/20260918/us-east-1/bedrock-agentcore/aws4_request, SignedHeaders=accept;host;x-amz-date, Signature=[0-9a-f]{64}$`,
    ),
  );
  assert.equal(signed.headers["x-amz-date"], "20260918T123600Z");
  assert.equal(
    signed.canonicalRequest.split("\n")[0],
    "GET",
    "the canonical request starts with the HTTP method",
  );
  assert.equal(
    signed.canonicalRequest.split("\n").at(-1),
    EMPTY_PAYLOAD_SHA256,
    "a body-less request hashes the empty string",
  );
  assert.equal(
    signed.stringToSign.split("\n")[0],
    AWS_SIGV4_ALGORITHM,
    "the string to sign names the algorithm first",
  );
});

test("a session token is signed, not merely sent", () => {
  const signed = signRequest(
    {
      method: "GET",
      url: new URL("https://host.invalid/gateways/"),
    },
    {
      region: "us-east-1",
      service: "bedrock-agentcore",
      credentials: { ...credentials, sessionToken: "temporary-token" },
      now: AT,
    },
  );
  assert.match(
    signed.headers["authorization"]!,
    /SignedHeaders=host;x-amz-date;x-amz-security-token/,
  );
  assert.equal(signed.headers["x-amz-security-token"], "temporary-token");
});

test("expired workload credentials fail before a request is built", () => {
  assert.throws(
    () =>
      signRequest(
        { method: "GET", url: new URL("https://host.invalid/gateways/") },
        {
          region: "us-east-1",
          service: "bedrock-agentcore",
          credentials: { ...credentials, expiresAt: AT - 1 },
          now: AT,
        },
      ),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "expired",
  );
});

test("a caller cannot smuggle an Authorization or Host header into the signature", () => {
  for (const header of ["authorization", "Host"])
    assert.throws(
      () =>
        signRequest(
          {
            method: "GET",
            url: new URL("https://host.invalid/gateways/"),
            headers: { [header]: "attacker" },
          },
          {
            region: "us-east-1",
            service: "bedrock-agentcore",
            credentials,
            now: AT,
          },
        ),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "invalid-request",
    );
});

test("a malformed access key id or region is refused rather than signed", () => {
  const bad = [
    {
      credentials: { ...credentials, accessKeyId: "short" },
      region: "us-east-1",
    },
    { credentials, region: "US-EAST-1" },
  ];
  for (const attempt of bad)
    assert.throws(
      () =>
        signRequest(
          { method: "GET", url: new URL("https://host.invalid/gateways/") },
          {
            region: attempt.region,
            service: "bedrock-agentcore",
            credentials: attempt.credentials,
            now: AT,
          },
        ),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "invalid-request",
    );
});
