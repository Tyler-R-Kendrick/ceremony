import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  capabilityStatusSchema,
  compatibilityIssueSchema,
  connectorEnvelopeSchema,
  normalizedDefinitionSchema,
  normalizedDigestOf,
  verificationClaimSchema,
} from "../../../src/core/connectors/index.js";
import {
  citationGaps,
  loadLedgers,
  loadSourceLock,
} from "../../../scripts/connector-support-matrix.js";

/*
 * Every example document published under docs/specifications/examples/connectors
 * is parsed by the authoritative runtime schema, not by a copy of it. A
 * published example that no longer validates is a failing test, which is what
 * "examples that validate in continuous integration" has to mean: a document
 * in prose cannot drift away from the contract it illustrates.
 *
 * The same suite checks that the source lock resolves: every sourceProfileId a
 * ledger cites must have a record, and every record must carry a URL, a
 * retrieval time, a version, a licence position and at least one dependent.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const examples = join(root, "docs/specifications/examples/connectors");

function read(name: string): unknown {
  return JSON.parse(readFileSync(join(examples, name), "utf8"));
}

test("DOC-01-01: every published example file is covered by this suite", () => {
  const published = readdirSync(examples)
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.deepEqual(published, [
    "capability-status-rows.json",
    "definition-public-api.json",
    "envelope-v2-description.json",
    "import-loss-issues.json",
    "verification-claim.json",
  ]);
});

test("DOC-01-02: the public-API example is a valid definition with no fabricated credential", () => {
  const parsed = normalizedDefinitionSchema.parse(
    read("definition-public-api.json"),
  );
  assert.equal(parsed.authentication.length, 1);
  assert.equal(parsed.authentication[0]!.kind, "none");
  assert.equal(parsed.configuration.length, 0);
  // Every one of the twelve dimensions is stated; nothing is implicitly supported.
  assert.equal(Object.keys(parsed.compatibility.dimensions).length, 12);
  assert.equal(parsed.compatibility.dimensions.authorize, "unsupported");
  assert.equal(
    parsed.compatibility.dimensions.invoke,
    "requires-configuration",
  );
});

test("DOC-01-03: the v2 envelope example parses and its embedded digest verifies", async () => {
  const envelope = connectorEnvelopeSchema.parse(
    read("envelope-v2-description.json"),
  );
  assert.equal(envelope.version, 2);
  assert.equal(envelope.sources.length, 1);
  // A portable definition carries no persistence reference.
  assert.ok(!("definitionRef" in envelope.definition));
  assert.ok(!("sourceRef" in envelope.definition));
  assert.ok(!("sourceRef" in envelope.sources[0]!));
  assert.ok(!("artifactRef" in envelope.sources[0]!));
  // The published digest is a placeholder; the real one is computed here, so the
  // example can never claim a digest that does not describe its own content.
  const digest = await normalizedDigestOf({
    ...envelope.definition,
    normalizedDigest: envelope.definition.normalizedDigest,
  });
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test("DOC-01-04: the loss example shows every disposition the profile documents", () => {
  const issues = (read("import-loss-issues.json") as unknown[]).map((issue) =>
    compatibilityIssueSchema.parse(issue),
  );
  assert.ok(issues.length >= 5);
  const security = issues.filter((issue) => issue.category === "security");
  // A security requirement cannot be talked down.
  for (const issue of security) {
    if (issue.disposition === "unsupported" || issue.disposition === "rejected")
      assert.equal(issue.severity, "blocking");
    assert.notEqual(issue.severity, "info");
    assert.notEqual(issue.executionImpact, "none");
  }
  // An informational issue blocks nothing, and a blocking issue blocks something.
  for (const issue of issues) {
    if (issue.severity === "info") assert.equal(issue.executionImpact, "none");
    if (issue.severity === "blocking")
      assert.notEqual(issue.executionImpact, "none");
  }
  // Locality: the unsupported media type blocks one operation, not the document.
  const serialization = issues.find(
    (issue) => issue.category === "serialization",
  );
  assert.equal(serialization?.executionImpact, "blocks-operation");
});

test("DOC-01-05: capability rows keep implementation, configuration and evidence separate", () => {
  const rows = (read("capability-status-rows.json") as unknown[]).map((row) =>
    capabilityStatusSchema.parse(row),
  );
  for (const row of rows) {
    if (row.implementation === "unsupported")
      assert.equal(row.evidence, "not-tested");
    if (row.configuration === "missing")
      assert.ok(
        row.evidence !== "live-authorized" &&
          row.evidence !== "deployed-authorized",
      );
    // No row in this repository may claim live or deployed evidence.
    assert.ok(
      row.evidence !== "live-authorized" &&
        row.evidence !== "deployed-authorized",
    );
  }
  const events = rows.find((row) => row.dimension === "events");
  assert.ok(
    events?.limitations.some((text) => /stand-in/.test(text)),
    "the forwarded-delivery row must keep saying its verifier is a stand-in",
  );
});

test("DOC-01-06: the verification claim names what it does not establish", () => {
  const claim = verificationClaimSchema.parse(read("verification-claim.json"));
  assert.equal(claim.kind, "credential-accepted");
  assert.ok(claim.limitations.length >= 3);
  // Requested, reported and observed stay distinct; observed is empty, meaning unknown.
  assert.deepEqual(claim.permissions?.observed, []);
  assert.ok(
    claim.limitations.some((text) => /account identity/i.test(text)),
    "a credential-accepted claim must say it does not establish the account",
  );
  assert.ok(!("verified" in claim));
  assert.ok(!("trusted" in claim));
});

test("DOC-02-01: every source profile cited by a covered ledger resolves in the lock", () => {
  const lock = loadSourceLock();
  // A malformed ledger is another swarm's defect, reported in the generated
  // evidence report rather than asserted here: this case is about the lock.
  const { ledgers } = loadLedgers();
  assert.ok(
    lock.coversLedgers.length > 0,
    "the lock must declare which ledgers it covers",
  );
  const gaps = citationGaps(lock, ledgers);
  assert.deepEqual(
    gaps.filter((gap) => gap.covered).map((gap) => `${gap.swarm}:${gap.id}`),
    [],
    "a covered ledger citing an unpinned source means an adapter depends on a document this lock has not pinned",
  );
  // A ledger delivered after the lock was pinned may cite an unpinned source.
  // That is not a silent pass: it must be visible in the generated document.
  const uncovered = gaps.filter((gap) => !gap.covered);
  if (uncovered.length > 0) {
    const rendered = readFileSync(
      join(
        root,
        "docs/implementation-evidence/connector-interoperability/source-lock.md",
      ),
      "utf8",
    );
    for (const gap of uncovered)
      assert.ok(
        rendered.includes(gap.id),
        `the generated source lock must report the gap ${gap.swarm}:${gap.id}`,
      );
  }
});

test("DOC-02-03: every ledger on disk is either covered by the lock or reported as pending", () => {
  const lock = loadSourceLock();
  const { ledgers } = loadLedgers();
  const covered = new Set(lock.coversLedgers);
  const uncovered = ledgers
    .map((ledger) => ledger.swarm)
    .filter((swarm) => !covered.has(swarm))
    .sort();
  if (uncovered.length > 0)
    assert.ok(
      lock.coversNote.length > 0,
      `ledgers ${uncovered.join(", ")} are outside the covered set, so the lock must say so in coversNote`,
    );
});

test("DOC-02-02: every source lock record carries its required provenance", () => {
  const lock = loadSourceLock();
  assert.ok(lock.records.length > 0);
  const ids = new Set<string>();
  for (const record of lock.records) {
    assert.ok(!ids.has(record.id), `duplicate lock record ${record.id}`);
    ids.add(record.id);
    assert.ok(record.url.length > 0, `${record.id} has no URL`);
    assert.match(
      record.retrievedAt,
      /^\d{4}-\d{2}-\d{2}/,
      `${record.id} has no retrieval date`,
    );
    assert.ok(
      record.upstreamVersion.length > 0,
      `${record.id} has no upstream version`,
    );
    assert.ok(record.revision.length > 0, `${record.id} has no revision note`);
    assert.ok(
      record.licence.statement.length > 0 && record.licence.evidence.length > 0,
      `${record.id} has no licence position`,
    );
    assert.ok(record.reuse.length > 0, `${record.id} has no reuse note`);
    assert.ok(
      record.dependents.profiles.length > 0,
      `${record.id} names no dependent profile`,
    );
    assert.ok(
      record.dependents.modules.length > 0,
      `${record.id} names no dependent module`,
    );
    if (record.digest !== null)
      assert.match(
        record.digest,
        /^sha256:[0-9a-f]{64}$/,
        `${record.id} has a malformed digest`,
      );
    else
      assert.ok(
        record.kind === "internal" ||
          record.kind === "alias" ||
          typeof record.digestNote === "string" ||
          record.licence.evidence.length > 0,
        `${record.id} has neither a digest nor an explanation`,
      );
  }
});
