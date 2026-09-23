import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import {
  OperationRegistry,
  type OperationContext,
} from "../src/server/recipes/registry.js";
import {
  ProtectedCommandService,
  type RunRecord,
} from "../src/server/commands.js";
import { authoredHuman } from "../src/server/authored-human.js";
import {
  approveAuthoredCredentialVerification,
  authoredVocabulary,
  declareAuthoredCredentialVerification,
  proposeAuthoredCredentialVerification,
  registerAuthoredOperations,
} from "../src/server/authored-operations.js";
import {
  AUTHORED_ADAPTER_ID,
  authoredDefinitionName,
  authoredSupportLabel,
  recordAuthoredEvidence,
  type AuthoredEvidenceTarget,
} from "../src/server/authored-evidence.js";
import { ConnectorDrafts } from "../src/server/connector-drafts.js";
import type { ActorContext } from "../src/core/operation-contracts.js";

/*
 * Authored connectors earn support labels only from their own verified runs.
 * The verifier records a dated, tenant-scoped entry for the connector's
 * current definition when the provider accepts the approved verification
 * request; nothing an author or an assistant does writes one, a definition
 * that changed is unverified again, and every provider here is an in-process
 * fake answering synthetic credentials.
 */

const provider = "https://provider.example";
const origin = "https://ceremony.example";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-23T12:00:00.000Z");
const actor: ActorContext = {
  tenantId: "tenant",
  subjectId: "owner",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["executor", "author"],
};
const KEY = "sk-synthetic-authored-evidence-key";

const form = (values: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(values).toString(),
});

function newStore() {
  return new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
}

async function install(
  store: SQLiteCeremonyStore,
  who: ActorContext = actor,
  name = "Novel",
) {
  await store.transaction(async (tx) => {
    const key = {
      tenant: who.tenantId,
      kind: "artifact" as const,
      id: "installed-connector:novel",
    };
    const prior = await tx.get(key);
    await tx.put(
      key,
      {
        author: who.subjectId,
        session: who.sessionId,
        manifest: {
          name,
          support: "fixture",
          methods: [{ kind: "api-key" }],
        },
        definition: {},
        discovery: {
          origin: provider,
          documents: [],
          methods: ["api-key"],
          grantTypes: [],
          searchUsed: false,
        },
      },
      prior?.revision ?? null,
    );
  });
  await declareAuthoredCredentialVerification(store, who, "novel", {
    url: `${provider}/v1/me`,
    placement: { in: "header", name: "Authorization", prefix: "Bearer " },
  });
}

/** One authored API-key run through the collection form and the verifier. */
async function verifiedRun(
  store: SQLiteCeremonyStore,
  options: {
    evidence?: { target: AuthoredEvidenceTarget; now?: () => number };
    accept?: boolean;
  } = {},
) {
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(String(input), init);
    const ok =
      (options.accept ?? true) &&
      request.headers.get("authorization") === `Bearer ${KEY}`;
    return new Response("{}", { status: ok ? 200 : 401 });
  };
  const registry = new OperationRegistry(authoredVocabulary);
  registerAuthoredOperations(registry, {
    store,
    fetch: fetcher,
    ...(options.evidence ? { evidence: options.evidence } : {}),
  });
  const commands = new ProtectedCommandService(
    store,
    registry,
    async () => true,
  );
  const runContext = {
    provider: "novel",
    profile: "authored",
    target: "novel",
    origin,
    environment: "test",
    configurationVersion: "v1",
  };
  const run = await commands.createRun(
    actor,
    runContext,
    [
      {
        id: "secret",
        operationId: "authored.collect-credential",
        operationVersion: "1.0.0",
        dependsOn: [],
        bindings: {},
      },
      {
        id: "access",
        operationId: "authored.verify-access",
        operationVersion: "1.0.0",
        dependsOn: ["secret"],
        bindings: {
          session: { from: "output" as const, node: "secret", name: "session" },
        },
      },
    ],
    {},
  );
  const advance = async (nodeId: string) => {
    const snapshot = await commands.snapshot(actor, run.id);
    await commands.advance(
      actor,
      run.id,
      nodeId,
      snapshot.revision,
      `advance:${nodeId}:${snapshot.revision}`,
    );
  };
  await advance("secret");
  const context: OperationContext = {
    ...runContext,
    actor,
    runId: run.id,
    nodeId: "secret",
    commandId: "human",
    effectId: "human",
    signal: new AbortController().signal,
  };
  const record = await store.transaction((tx) =>
    tx.get<RunRecord>({ tenant: actor.tenantId, kind: "run", id: run.id }),
  );
  assert.ok(record);
  const saved = await authoredHuman(
    store,
    context,
    record,
    new Request(`${origin}/api/v1/teaching/novel/${run.id}/human`, {
      ...form({ token: KEY }),
    }),
    origin,
    () => advance("secret"),
    { connectorId: "novel", name: "Novel", fetch: fetcher },
  );
  assert.equal(saved.status, 303);
  await advance("access");
  return { commands, run };
}

async function evidenceRecords(store: SQLiteCeremonyStore, tenant = "tenant") {
  return store.transaction((tx) => tx.list(tenant, "evidence", 100, ""));
}

test("a verified live run records a dated entry for its definition, and the label rises to live", async (t) => {
  const store = newStore();
  t.after(() => store.close());
  await install(store);
  const drafts = new ConnectorDrafts(store, { now: () => NOW });
  assert.deepEqual(await drafts.supportLabel(actor, "novel"), {
    label: "unverified",
  });

  const { commands, run } = await verifiedRun(store, {
    evidence: { target: "recorded-live", now: () => NOW },
  });
  assert.equal((await commands.snapshot(actor, run.id)).status, "complete");

  const [stored] = await evidenceRecords(store);
  const entries = (stored?.value as { entries: Array<Record<string, unknown>> })
    .entries;
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry!.adapterId, AUTHORED_ADAPTER_ID);
  assert.equal(entry!.target, "recorded-live");
  assert.equal(entry!.recordedAt, "2026-09-23");
  assert.match(String(entry!.check), /^authored-run:[a-f0-9]{32}$/);
  assert.match(String(entry!.definition), /^sha256:[a-f0-9]{64}$/);
  // The entry names no run id, key or endpoint.
  const text = JSON.stringify(stored);
  for (const value of [run.id, KEY, provider])
    assert.equal(text.includes(value), false, value);

  assert.deepEqual(await drafts.supportLabel(actor, "novel"), {
    label: "live",
    basis: { target: "recorded-live", recordedAt: "2026-09-23" },
  });
  const installed = await drafts.getInstalled(actor, "novel");
  assert.equal(installed?.manifest.support, "live-adapter");
  assert.deepEqual(
    (await drafts.listManifests(actor)).map((item) => item.support),
    ["live-adapter"],
  );

  // A live run lasts ninety days; then the label is unverified again.
  const later = new ConnectorDrafts(store, { now: () => NOW + 91 * DAY });
  assert.equal((await later.supportLabel(actor, "novel")).label, "unverified");
  assert.equal(
    (await later.getInstalled(actor, "novel"))?.manifest.support,
    "fixture",
  );
});

test("a loopback development run claims no more than a local double", async (t) => {
  const store = newStore();
  t.after(() => store.close());
  await install(store);
  await verifiedRun(store, {
    evidence: { target: "local-double", now: () => NOW },
  });
  const drafts = new ConnectorDrafts(store, { now: () => NOW });
  assert.equal((await drafts.supportLabel(actor, "novel")).label, "local");
  assert.equal(
    (await drafts.getInstalled(actor, "novel"))?.manifest.support,
    "fixture",
  );
});

test("a rejected run, or a runtime that declares no target, records nothing", async (t) => {
  const store = newStore();
  t.after(() => store.close());
  await install(store);
  const rejected = await verifiedRun(store, {
    evidence: { target: "recorded-live", now: () => NOW },
    accept: false,
  });
  assert.equal(
    (await rejected.commands.snapshot(actor, rejected.run.id)).status,
    "active",
  );
  assert.deepEqual(await evidenceRecords(store), []);

  const fresh = newStore();
  t.after(() => fresh.close());
  await install(fresh);
  const undeclared = await verifiedRun(fresh);
  assert.equal(
    (await undeclared.commands.snapshot(actor, undeclared.run.id)).status,
    "complete",
  );
  assert.deepEqual(await evidenceRecords(fresh), []);
  const drafts = new ConnectorDrafts(fresh, { now: () => NOW });
  assert.equal((await drafts.supportLabel(actor, "novel")).label, "unverified");
});

test("changing where the key goes or how it is proved leaves the new definition unverified", async (t) => {
  const store = newStore();
  t.after(() => store.close());
  await install(store);
  await verifiedRun(store, {
    evidence: { target: "recorded-live", now: () => NOW },
  });
  const drafts = new ConnectorDrafts(store, { now: () => NOW });
  assert.equal((await drafts.supportLabel(actor, "novel")).label, "live");

  // A new verification request, even reviewed and approved by a person, is
  // a new definition nobody has run.
  const proposal = await proposeAuthoredCredentialVerification(
    store,
    actor,
    "novel",
    {
      url: `${provider}/v2/whoami`,
      placement: { in: "header", name: "X-Api-Key" },
    },
  );
  // A pending proposal changes nothing that runs, so the label stands.
  assert.equal((await drafts.supportLabel(actor, "novel")).label, "live");
  await approveAuthoredCredentialVerification(
    store,
    actor,
    "novel",
    proposal.digest,
  );
  assert.equal((await drafts.supportLabel(actor, "novel")).label, "unverified");

  // Reverting to the verified definition regains its evidence.
  await declareAuthoredCredentialVerification(store, actor, "novel", {
    url: `${provider}/v1/me`,
    placement: { in: "header", name: "Authorization", prefix: "Bearer " },
  });
  assert.equal((await drafts.supportLabel(actor, "novel")).label, "live");

  // Reinstalling with a changed manifest is a new definition too.
  await install(store, actor, "Novel, renamed");
  assert.equal((await drafts.supportLabel(actor, "novel")).label, "unverified");
});

test("no authoring path writes evidence, and a damaged record reads as none", async (t) => {
  const store = newStore();
  t.after(() => store.close());
  // Installing, declaring, proposing and approving are everything an author
  // or an assistant can do to a connector; none of it is evidence.
  await install(store);
  const proposal = await proposeAuthoredCredentialVerification(
    store,
    actor,
    "novel",
    {
      url: `${provider}/v1/me`,
      placement: { in: "query", name: "api_key" },
    },
  );
  await approveAuthoredCredentialVerification(
    store,
    actor,
    "novel",
    proposal.digest,
  );
  assert.deepEqual(await evidenceRecords(store), []);

  // Back to the header placement the fake provider accepts, and one run.
  await install(store);
  assert.deepEqual(await evidenceRecords(store), []);
  await verifiedRun(store, {
    evidence: { target: "recorded-live", now: () => NOW },
  });
  const [stored] = await evidenceRecords(store);
  assert.ok(stored);
  assert.equal(
    (await authoredSupportLabel(store, actor, "novel", NOW)).label,
    "live",
  );

  // Rewritten under another connector's name, with an extra key, or with
  // an entry about another adapter: each reads as no evidence at all.
  const key = { tenant: "tenant", kind: "evidence" as const, id: stored.id };
  const value = stored.value as {
    schemaVersion: 1;
    connectorId: string;
    entries: Array<Record<string, unknown>>;
  };
  for (const damaged of [
    { ...value, connectorId: "other" },
    { ...value, extra: true },
    {
      ...value,
      entries: value.entries.map((entry) => ({
        ...entry,
        adapterId: "openapi-http",
      })),
    },
    {
      ...value,
      entries: value.entries.map((entry) => ({
        ...entry,
        check: "tests/authored-evidence.test.ts",
      })),
    },
  ]) {
    await store.transaction(async (tx) => {
      const current = await tx.get(key);
      await tx.put(key, damaged, current!.revision);
    });
    assert.equal(
      (await authoredSupportLabel(store, actor, "novel", NOW)).label,
      "unverified",
      JSON.stringify(Object.keys(damaged)),
    );
  }
});

test("evidence is scoped to its tenant and to the connector's author", async (t) => {
  const store = newStore();
  t.after(() => store.close());
  await install(store);
  await verifiedRun(store, {
    evidence: { target: "recorded-live", now: () => NOW },
  });
  const otherTenant = { ...actor, tenantId: "other-tenant" };
  await install(store, otherTenant);
  assert.equal(
    (await authoredSupportLabel(store, otherTenant, "novel", NOW)).label,
    "unverified",
  );
  // Another person in the same tenant does not see this author's connector,
  // so it has no label for them either, and cannot record against it.
  const stranger = { ...actor, subjectId: "stranger" };
  assert.equal(
    (await authoredSupportLabel(store, stranger, "novel", NOW)).label,
    "unverified",
  );
  assert.equal(
    await recordAuthoredEvidence(store, stranger, {
      connectorId: "novel",
      runId: "run",
      target: "recorded-live",
      proof: "authorization-verified",
      now: NOW,
    }),
    undefined,
  );
});

test("a completed authorization is recorded as such, one entry per definition and target", async (t) => {
  const store = newStore();
  t.after(() => store.close());
  await install(store);
  for (const [runId, day] of [
    ["run-1", NOW - 2 * DAY],
    ["run-2", NOW],
  ] as const)
    await recordAuthoredEvidence(store, actor, {
      connectorId: "novel",
      runId,
      target: "recorded-live",
      proof: "authorization-verified",
      now: day,
    });
  const [stored] = await evidenceRecords(store);
  const entries = (stored?.value as { entries: Array<Record<string, unknown>> })
    .entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.recordedAt, "2026-09-23");
  assert.match(String(entries[0]!.notes), /authorization completed/);
  // The definition name is stable across the bookkeeping discovery keeps.
  const installed = {
    manifest: { name: "Novel" },
    definition: {},
    discovery: { origin: provider, searchUsed: false, retryable: true },
  };
  assert.equal(
    authoredDefinitionName(installed),
    authoredDefinitionName({
      ...installed,
      discovery: { origin: provider, searchUsed: true, documents: ["x"] },
    }),
  );
  assert.notEqual(
    authoredDefinitionName(installed),
    authoredDefinitionName({
      ...installed,
      discovery: { origin: "https://elsewhere.example" },
    }),
  );
});
