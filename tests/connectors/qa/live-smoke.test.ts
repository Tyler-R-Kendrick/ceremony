import assert from "node:assert/strict";
import test from "node:test";
import {
  CONSENT_VALUE,
  CONSENT_VARIABLE,
  LiveSmokeBlocked,
  REDACTED,
  evaluateLiveSmoke,
  liveSmokeManifest,
  redactTranscript,
  runLiveSmoke,
} from "./live-manifest.js";

/*
 * QA-06. The live and deployed manifests are exercised as code, in the one
 * state this host can be in: no authorized credentials and no operator
 * consent. Every entry must therefore report `blocked` and name the exact
 * prerequisite that is missing, and no path may turn a fixture into live
 * evidence.
 */

const AT = () => Date.parse("2026-09-18T12:00:00.000Z");

test("AC-PKG-03: every live and deployed check is blocked in this environment", () => {
  const report = evaluateLiveSmoke(process.env, AT);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.entries.length, liveSmokeManifest.length);
  assert.equal(
    report.ready,
    0,
    "no live or deployed check may be runnable without an operator's consent",
  );
  assert.equal(report.blocked, liveSmokeManifest.length);

  for (const outcome of report.entries) {
    assert.equal(outcome.outcome, "blocked");
    assert.equal(outcome.evidenceLevel, "not-tested");
    assert.ok(
      outcome.missing.includes(CONSENT_VARIABLE),
      `${outcome.id} names the missing consent variable exactly`,
    );
    const entry = liveSmokeManifest.find((item) => item.id === outcome.id)!;
    for (const required of entry.requires)
      assert.ok(
        outcome.missing.includes(required),
        `${outcome.id} names the missing prerequisite ${required}`,
      );
  }
});

test("QA-06: a credential in the environment is not consent", () => {
  const withCredentials: Record<string, string> = {};
  for (const entry of liveSmokeManifest)
    for (const name of entry.requires) withCredentials[name] = "supplied";

  const report = evaluateLiveSmoke(withCredentials, AT);
  assert.equal(report.ready, 0, "still nothing may run");
  for (const outcome of report.entries) {
    assert.equal(outcome.outcome, "blocked");
    assert.equal(outcome.reason, "missing-consent");
    assert.deepEqual(
      outcome.missing,
      [CONSENT_VARIABLE],
      "the only thing missing is the operator's explicit authorization",
    );
  }
});

test("QA-06: consent alone is not credentials, and the report names what is absent", () => {
  const report = evaluateLiveSmoke({ [CONSENT_VARIABLE]: CONSENT_VALUE }, AT);
  assert.equal(report.ready, 0);
  for (const outcome of report.entries) {
    assert.equal(outcome.reason, "missing-credentials");
    const entry = liveSmokeManifest.find((item) => item.id === outcome.id)!;
    assert.deepEqual(
      outcome.missing,
      [...entry.requires],
      `${outcome.id} reports exactly its own prerequisites`,
    );
  }
});

test("QA-06: a near-miss consent value does not unlock anything", () => {
  const environment: Record<string, string> = {
    [CONSENT_VARIABLE]: "true",
  };
  for (const entry of liveSmokeManifest)
    for (const name of entry.requires) environment[name] = "supplied";
  const report = evaluateLiveSmoke(environment, AT);
  assert.equal(report.ready, 0, "only the exact consent value counts");
  assert.equal(report.entries[0]!.reason, "missing-consent");
});

test("QA-06: a blocked entry refuses before any network access", async () => {
  let performed = 0;
  const entry = liveSmokeManifest[0]!;
  await assert.rejects(
    () =>
      runLiveSmoke(entry, process.env, async () => {
        performed += 1;
        return { transcript: "should never happen" };
      }),
    (error: unknown) => {
      assert.ok(error instanceof LiveSmokeBlocked);
      assert.equal(error.outcome.outcome, "blocked");
      assert.ok(error.message.includes(CONSENT_VARIABLE));
      return true;
    },
  );
  assert.equal(performed, 0, "the operation was never attempted");
});

test("QA-06: every approved operation is read-only and names one resource", () => {
  const destructive =
    /\b(delete|remove|revoke|deprovision|purge|drop|rotate|disable|create|provision)\b/i;
  for (const entry of liveSmokeManifest) {
    assert.equal(
      entry.operation.effect,
      "read",
      `${entry.id} is limited to a read`,
    );
    assert.equal(
      entry.operation.method,
      "GET",
      `${entry.id} uses a safe method`,
    );
    assert.equal(
      destructive.test(entry.operation.description),
      false,
      `${entry.id} describes no destructive verb`,
    );
    assert.ok(entry.accountScope.length > 20, `${entry.id} names its account`);
    assert.ok(
      entry.resourceScope.length > 20,
      `${entry.id} names its resource`,
    );
    assert.deepEqual(
      entry.cleanup,
      [],
      `${entry.id} creates nothing, so it has nothing to clean up`,
    );
    assert.ok(entry.requires.length > 0, `${entry.id} declares prerequisites`);
    assert.ok(
      entry.acceptanceIds.length > 0,
      `${entry.id} says which oracle it would upgrade`,
    );
  }
});

test("QA-06: transcripts are redacted by value and by header name", () => {
  const entry = liveSmokeManifest[0]!;
  const environment = {
    CEREMONY_LIVE_NANGO_SECRET_KEY: "nango-sk-SUPERSECRET-0001",
    CEREMONY_LIVE_NANGO_ENVIRONMENT: "prod",
    CEREMONY_LIVE_NANGO_INTEGRATION: "github-prod",
  };
  const transcript = [
    "GET /integrations",
    "authorization: Bearer nango-sk-SUPERSECRET-0001",
    '{"token":"tok_abc123","connect_link":"https://connect.nango.dev/?session_token=tok_abc123"}',
  ].join("\n");

  const redacted = redactTranscript(transcript, entry, environment);
  assert.equal(
    redacted.includes("nango-sk-SUPERSECRET-0001"),
    false,
    "the secret value is gone",
  );
  assert.equal(redacted.includes("tok_abc123"), false, "so is the token");
  assert.ok(redacted.includes(REDACTED));
  assert.ok(
    redacted.includes("GET /integrations"),
    "the useful part of the transcript survives",
  );
});

test("QA-06: a satisfied entry runs the real operation and labels it live, never a fixture", async () => {
  // The positive control for the gate itself: with consent and credentials
  // present the runner proceeds, and the evidence it returns carries the
  // manifest's own kind. It is still the caller's `perform` that must make a
  // real call; nothing here can manufacture one.
  const entry = liveSmokeManifest[0]!;
  const environment: Record<string, string> = {
    [CONSENT_VARIABLE]: CONSENT_VALUE,
    CEREMONY_LIVE_NANGO_SECRET_KEY: "nango-sk-SUPERSECRET-0002",
    CEREMONY_LIVE_NANGO_ENVIRONMENT: "prod",
    CEREMONY_LIVE_NANGO_INTEGRATION: "github-prod",
  };
  const result = await runLiveSmoke(entry, environment, async () => ({
    transcript:
      "GET /integrations\nauthorization: Bearer nango-sk-SUPERSECRET-0002",
  }));
  assert.equal(result.evidenceLevel, "live-authorized");
  assert.equal(
    result.transcript.includes("nango-sk-SUPERSECRET-0002"),
    false,
    "the recorded transcript is redacted before it is returned",
  );
  assert.deepEqual(result.cleanup, []);
});

test("QA-06: the manifest covers both a live and a deployed profile", () => {
  const kinds = new Set(liveSmokeManifest.map((entry) => entry.kind));
  assert.ok(kinds.has("live-authorized"));
  assert.ok(kinds.has("deployed"));
  const ids = liveSmokeManifest.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
});
