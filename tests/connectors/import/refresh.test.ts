import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diffSources,
  evaluateRefresh,
  importUpload,
  refreshDecision,
  refreshFromUpload,
  refreshFromUrl,
  resolvePinnedSource,
  type SourceSnapshot,
} from "../../../src/server/connectors/import/index.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import {
  CANARY,
  assertNoCanary,
  expectConnectorError,
  fixtureBytes,
  importActor,
  importPorts,
  loopbackPolicy,
} from "./support.js";

/*
 * IMP-05 and AC-IMP-16. A refresh produces a candidate revision and a diff.
 * It never mutates the previous record, and a catalog calling something
 * "latest" never replaces a pinned definition.
 */

async function snapshot(name: string, when = Date.UTC(2026, 8, 18, 12)) {
  const ports = { ...importPorts(), now: () => when };
  const outcome = await importUpload(
    importActor,
    await fixtureBytes(name),
    "application/yaml",
    ports,
    { fileName: "spec.yaml" },
  );
  return {
    ports,
    outcome,
    snapshot: {
      record: outcome.source,
      value: outcome.document.value,
    } satisfies SourceSnapshot,
  };
}

test("an identical refresh reports no change and invalidates nothing", async () => {
  const previous = await snapshot("refresh-v1.yaml");
  const next = await snapshot("refresh-v1.yaml", Date.UTC(2026, 8, 19, 12));
  const diff = diffSources(previous.snapshot, next.snapshot);
  assert.equal(diff.identical, true);
  assert.deepEqual(diff.changes, []);
  assert.equal(diff.previous.digest, diff.next.digest);
  // Same bytes, different capture: two records, not one mutated record.
  assert.notEqual(diff.previous.sourceRef, diff.next.sourceRef);
  const decision = refreshDecision(diff);
  assert.equal(decision.outcome, "no-change");
  assert.deepEqual(decision.invalidates, {
    approvals: false,
    evidence: false,
    bindings: false,
  });
});

test("a benign refresh is a candidate revision that invalidates no approval", async () => {
  const previous = await snapshot("refresh-v1.yaml");
  const next = await snapshot(
    "refresh-v2-benign.yaml",
    Date.UTC(2026, 8, 19, 12),
  );
  const diff = diffSources(previous.snapshot, next.snapshot);
  assert.equal(diff.identical, false);
  assert.equal(diff.security.length, 0);
  const decision = refreshDecision(diff);
  assert.equal(decision.outcome, "candidate-revision");
  assert.deepEqual(decision.invalidates, {
    approvals: false,
    evidence: false,
    bindings: false,
  });
  // The changes are still reported, by pointer, as informational issues.
  assert.ok(
    diff.changes.some((change) => change.pointer === "/info/description"),
  );
  assert.ok(
    diff.changes.some(
      (change) => change.pointer === "/paths/~1items/get/summary",
    ),
  );
  assert.ok(
    diff.changes.some(
      (change) => change.code === "version.declared-version-changed",
    ),
  );
  for (const issue of diff.issues) assert.notEqual(issue.severity, "blocking");
});

test("security-relevant changes are flagged by category and invalidate approvals", async () => {
  const previous = await snapshot("refresh-v1.yaml");
  const next = await snapshot(
    "refresh-v2-security.yaml",
    Date.UTC(2026, 8, 19, 12),
  );
  const diff = diffSources(previous.snapshot, next.snapshot);
  const codes = new Set(diff.security.map((issue) => issue.code));
  // Server host, token endpoint, added scope, parameter relocation and a new
  // operation are each identified as security semantics, not as text edits.
  for (const code of [
    "security.server-changed",
    "security.oauth-endpoint-changed",
    "security.scope-changed",
    "security.parameter-location-changed",
    "security.operation-changed",
  ])
    assert.ok(codes.has(code), `missing ${code}: ${[...codes].join(", ")}`);
  for (const issue of diff.security) {
    assert.equal(issue.category, "security");
    assert.equal(issue.severity, "blocking");
    assert.notEqual(issue.executionImpact, "none");
    // The pointer says where; the message never quotes the new value.
    assert.ok(issue.sourcePointer.startsWith("/"));
    assert.equal(issue.message.includes("evil.example"), false);
  }
  const decision = refreshDecision(diff);
  assert.equal(decision.outcome, "security-review-required");
  assert.deepEqual(decision.invalidates, {
    approvals: true,
    evidence: true,
    bindings: true,
  });
  assert.ok(decision.securityChanges >= 5);

  // The parameter move is identified specifically, at its own location.
  const relocation = diff.security.find(
    (issue) => issue.code === "security.parameter-location-changed",
  );
  assert.equal(relocation?.sourcePointer, "/paths/~1items/get/parameters/0/in");
});

test("a refresh never mutates the previous record", async () => {
  const previous = await snapshot("refresh-v1.yaml");
  const frozen = structuredClone(previous.snapshot.record);
  const ports = importPorts();
  const result = await refreshFromUpload(
    importActor,
    previous.snapshot,
    await fixtureBytes("refresh-v2-security.yaml"),
    "application/yaml",
    ports,
  );
  assert.deepEqual(previous.snapshot.record, frozen);
  assert.deepEqual(result.previous, frozen);
  assert.notEqual(result.candidate.source.sourceRef, frozen.sourceRef);
  assert.notEqual(result.candidate.source.digest.value, frozen.digest.value);
  // The candidate keeps the previous identity so the two are comparable.
  assert.deepEqual(result.candidate.source.identity, frozen.identity);
  assert.equal(result.decision.outcome, "security-review-required");
  // Both revisions exist side by side; neither replaced the other.
  assert.equal(ports.definitions.sources().length, 1);
});

test("a pinned definition is never replaced because a catalog says latest", async () => {
  const previous = await snapshot("refresh-v1.yaml");
  const next = await snapshot(
    "refresh-v2-security.yaml",
    Date.UTC(2026, 8, 19, 12),
  );
  const pin = {
    sourceRef: previous.snapshot.record.sourceRef,
    digest: previous.snapshot.record.digest.value,
  };
  const available = [
    { record: next.snapshot.record, latest: true },
    { record: previous.snapshot.record },
  ];
  const selection = resolvePinnedSource(pin, available);
  assert.equal(selection.outcome, "pinned-with-candidate");
  assert.equal(selection.selected?.sourceRef, pin.sourceRef);
  assert.equal(selection.selected?.digest.value, pin.digest);
  // The newer capture is offered for review, never selected.
  assert.equal(selection.candidate?.sourceRef, next.snapshot.record.sourceRef);

  // With only the pin available there is no candidate at all.
  assert.equal(
    resolvePinnedSource(pin, [{ record: previous.snapshot.record }]).outcome,
    "pinned",
  );
  // If the pinned bytes are gone, the caller is told so rather than being
  // silently moved onto a different revision.
  const missing = resolvePinnedSource(pin, [
    { record: next.snapshot.record, latest: true },
  ]);
  assert.equal(missing.outcome, "pin-missing");
  assert.equal(missing.selected, undefined);
  // A record with the pinned ref but different bytes does not satisfy the pin.
  const tampered = {
    ...previous.snapshot.record,
    digest: { algorithm: "sha256" as const, value: "0".repeat(64) },
  };
  assert.equal(
    resolvePinnedSource(pin, [{ record: tampered }]).outcome,
    "pin-missing",
  );
});

test("a refresh from a URL re-retrieves through the approved fetcher only", async (t) => {
  let revision = 0;
  const fixture = await startHttpFixture(async (request) => {
    if (request.url.pathname !== "/openapi.yaml")
      return { status: 404, body: "no" };
    revision += 1;
    return {
      headers: { "content-type": "application/yaml" },
      body: Buffer.from(
        await fixtureBytes(
          revision === 1 ? "refresh-v1.yaml" : "refresh-v2-security.yaml",
        ),
      ),
    };
  });
  t.after(() => fixture.close());
  const ports = importPorts();
  const policy = loopbackPolicy();
  const first = await importUpload(
    importActor,
    await fixtureBytes("refresh-v1.yaml"),
    "application/yaml",
    ports,
  );
  void first;

  const initial = await (
    await import("../../../src/server/connectors/import/index.js")
  ).importFromUrl(importActor, `${fixture.origin}/openapi.yaml`, policy, ports);
  assert.equal(initial.source.origin.kind, "url");
  assert.equal(
    initial.source.origin.location,
    `${fixture.origin}/openapi.yaml`,
  );

  const refreshed = await refreshFromUrl(
    importActor,
    { record: initial.source, value: initial.document.value },
    policy,
    ports,
  );
  assert.equal(refreshed.decision.outcome, "security-review-required");
  assert.deepEqual(
    fixture.requests.map((request) => request.url.pathname),
    ["/openapi.yaml", "/openapi.yaml"],
  );
  // A refresh needs a URL origin; an uploaded source has nothing to re-fetch.
  await expectConnectorError(
    refreshFromUrl(
      importActor,
      { record: first.source, value: first.document.value },
      policy,
      ports,
    ),
    "invalid-request",
    "import.refresh-origin-not-url",
  );
});

test("diff output is bounded and never carries document values", async () => {
  const previous = {
    record: (await snapshot("refresh-v1.yaml")).snapshot.record,
    value: {
      info: { description: `before ${CANARY}` },
      servers: [{ url: "https://a.example" }],
    },
  };
  const next = {
    record: (await snapshot("refresh-v2-benign.yaml", Date.UTC(2026, 8, 19)))
      .snapshot.record,
    value: {
      info: { description: `after ${CANARY}` },
      servers: [{ url: `https://b.example?token=${CANARY}` }],
    },
  };
  const diff = diffSources(previous, next);
  assertNoCanary(diff.issues, diff.changes, refreshDecision(diff));
  assert.ok(
    diff.security.some((issue) => issue.code === "security.server-changed"),
  );

  // A pathological pair of documents cannot produce unbounded output.
  const wide = (offset: number) =>
    Object.fromEntries(
      Array.from({ length: 6000 }, (_, index) => [`k${index}`, index + offset]),
    );
  const huge = diffSources(
    { ...previous, value: wide(0) },
    { ...next, value: wide(1) },
  );
  assert.equal(huge.truncated, true);
  assert.ok(huge.changes.length <= 4096);
  // A comparison that could not be completed is treated as security-relevant.
  assert.equal(refreshDecision(huge).outcome, "security-review-required");
});

test("evaluateRefresh pairs the candidate with its decision", async () => {
  const previous = await snapshot("refresh-v1.yaml");
  const candidate = await snapshot(
    "refresh-v2-security.yaml",
    Date.UTC(2026, 8, 19),
  );
  const result = evaluateRefresh(previous.snapshot, candidate.outcome);
  assert.equal(result.previous.sourceRef, previous.snapshot.record.sourceRef);
  assert.equal(
    result.candidate.source.sourceRef,
    candidate.snapshot.record.sourceRef,
  );
  assert.equal(result.diff.identical, false);
  assert.equal(result.decision.outcome, "security-review-required");
  assert.ok(result.decision.codes.includes("security.server-changed"));
});
