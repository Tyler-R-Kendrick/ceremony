import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { verifyingEvidenceKinds } from "../src/core/browser-session-contracts.js";
import {
  createFixtureVerifier,
  createVerifierRegistry,
  mintAttestation,
  mintLoginEvidence,
  NoVerifier,
  type ContextRequestLike,
} from "../src/server/browser-verification.js";

/**
 * What counts as knowing which account is logged in.
 *
 * The conformance suite proves this end to end in real browsers. These cases
 * cover the decisions that suite cannot stage cheaply: what a verifier does
 * with an unreachable provider, an unparseable answer, or an account that is
 * present but wrong — and the rule that a person's word is recorded without
 * ever becoming evidence.
 */

const origin = "https://provider.example";
const planDigest = "a".repeat(64);

/** A context request that answers exactly what a test tells it to. */
function answering(
  answer: { status: number; body: string } | Error,
): ContextRequestLike {
  return {
    get: async () => {
      if (answer instanceof Error) throw answer;
      return {
        status: () => answer.status,
        text: async () => answer.body,
      };
    },
  };
}

const target = {
  browserGeneration: "bgen_one",
  browserSessionRef: "bsess_00000000000000000000000000000001",
  effectivePlanDigest: planDigest,
};

describe("the fixture verifier", () => {
  const verifier = createFixtureVerifier({ origin });

  test("a recognised session verifies the account it names", async () => {
    const outcome = await verifier.verify(
      {
        ...target,
        request: answering({ status: 200, body: '{"account":"ada"}' }),
      },
      { accountRef: "ada" },
    );
    assert.deepEqual(outcome, { verified: true, accountRef: "ada" });
  });

  test("no session is not a failure to reach the provider", async () => {
    // These are different situations for a caller: one means try again, the
    // other means the login did not take.
    for (const status of [401, 403])
      assert.deepEqual(
        await verifier.verify(
          { ...target, request: answering({ status, body: "{}" }) },
          {},
        ),
        { verified: false, reason: "no-session" },
      );
    assert.deepEqual(
      await verifier.verify(
        { ...target, request: answering(new Error("connect ECONNREFUSED")) },
        {},
      ),
      { verified: false, reason: "unreachable" },
    );
  });

  test("an answer that is not an account is not an account", async () => {
    for (const body of ["not json", "{}", '{"account":""}', '{"account":7}'])
      assert.equal(
        (
          await verifier.verify(
            { ...target, request: answering({ status: 200, body }) },
            {},
          )
        ).verified,
        false,
        `${body} must not verify anyone`,
      );
  });

  test("AUTH-WRONG: the wrong account is reported, with who is actually there", async () => {
    const outcome = await verifier.verify(
      {
        ...target,
        request: answering({ status: 200, body: '{"account":"grace"}' }),
      },
      { accountRef: "ada" },
    );
    // Naming the account present is what lets a caller offer a choice. It is
    // not permission to log that person out or switch to another account.
    assert.deepEqual(outcome, {
      verified: false,
      reason: "account-mismatch",
      accountRef: "grace",
    });
  });

  test("with no expected account, whoever is there is reported", async () => {
    assert.deepEqual(
      await verifier.verify(
        {
          ...target,
          request: answering({ status: 200, body: '{"account":"grace"}' }),
        },
        {},
      ),
      { verified: true, accountRef: "grace" },
    );
  });
});

describe("the verifier registry", () => {
  const verifier = createFixtureVerifier({ origin });
  const registry = createVerifierRegistry([verifier]);

  test("origins are exact: a lookalike gets nobody else's verifier", () => {
    assert.equal(registry.find(origin), verifier);
    for (const other of [
      "https://evil-provider.example",
      "https://provider.example.attacker.test",
      "https://sub.provider.example",
      "http://provider.example",
    ])
      assert.equal(
        registry.find(other),
        undefined,
        `${other} must not resolve to another origin's verifier`,
      );
  });

  test("a provider with no verifier stops honestly rather than falling back", () => {
    assert.throws(
      () => registry.require("https://unregistered.example"),
      NoVerifier,
    );
    assert.deepEqual(registry.origins(), [origin]);
  });

  test("a later registration replaces the earlier one for that origin", () => {
    const replacement = createFixtureVerifier({ origin, path: "/api/me" });
    const local = createVerifierRegistry([verifier]);
    local.register(replacement);
    assert.equal(local.require(origin), replacement);
  });
});

describe("evidence", () => {
  test("a person's word is recorded and never counts as verification", () => {
    const { evidence, evidenceRef } = mintAttestation({
      browserSessionRef: target.browserSessionRef,
      browserGeneration: target.browserGeneration,
      accountRef: "ada",
      effectivePlanDigest: planDigest,
      now: new Date(1_000_000_000_000),
    });
    assert.equal(evidence.kind, "human-attested");
    assert.match(evidenceRef, /^bevd_[0-9a-f]{32}$/);
    // The rule that makes attestation safe to record at all.
    assert.equal(verifyingEvidenceKinds.includes(evidence.kind), false);
  });

  test("evidence names the verifier and version that produced it", () => {
    const { evidence } = mintLoginEvidence({
      kind: "fixture-verified",
      verifier: { verifierRef: "fixture:x", verifierVersion: "2.1.0" },
      browserSessionRef: target.browserSessionRef,
      browserGeneration: target.browserGeneration,
      accountRef: "ada",
      effectivePlanDigest: planDigest,
      now: new Date(1_000_000_000_000),
      freshnessMs: 60_000,
    });
    // A parser change is a new verifier version, which is why the version is
    // recorded rather than assumed stable.
    assert.equal(evidence.verifierVersion, "2.1.0");
    assert.equal(evidence.expiresAt, new Date(1_000_000_060_000).toISOString());
  });

  test("evidence without a declared lifetime does not expire on its own", () => {
    const { evidence } = mintLoginEvidence({
      kind: "provider-verified",
      verifier: { verifierRef: "live:x", verifierVersion: "1.0.0" },
      browserSessionRef: target.browserSessionRef,
      browserGeneration: target.browserGeneration,
      accountRef: "ada",
      effectivePlanDigest: planDigest,
      now: new Date(1_000_000_000_000),
    });
    assert.equal(evidence.expiresAt, undefined);
  });
});
