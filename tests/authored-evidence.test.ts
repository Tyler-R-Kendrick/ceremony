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
  discoveredAuthSchema,
  issueAuthoredHandle,
  proposeAuthoredCredentialVerification,
  registerAuthoredOperations,
  saveAuthoredGrantSession,
} from "../src/server/authored-operations.js";
import {
  AUTHORED_ADAPTER_ID,
  authoredDefinitionName,
  authoredDefinitionOf,
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

/** The definition name of what is installed for `who` right now. */
async function currentDefinition(
  store: SQLiteCeremonyStore,
  who: ActorContext = actor,
) {
  const record = await store.transaction((tx) =>
    tx.get({
      tenant: who.tenantId,
      kind: "artifact",
      id: "installed-connector:novel",
    }),
  );
  const name = authoredDefinitionOf(record?.value, who);
  assert.ok(name);
  return name;
}

/** One authored API-key run through the collection form and the verifier. */
async function verifiedRun(
  store: SQLiteCeremonyStore,
  options: {
    evidence?: { target: AuthoredEvidenceTarget; now?: () => number };
    accept?: boolean;
    /** Runs while the provider is answering the verification request. */
    duringProbe?: () => Promise<void>;
    /** Runs after the key is collected and before the verifier starts. */
    beforeVerify?: () => Promise<void>;
  } = {},
) {
  const fetcher: typeof fetch = async (input, init) => {
    await options.duringProbe?.();
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
  await options.beforeVerify?.();
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

test("every discovery field that changes the ceremony changes the definition", async (t) => {
  const store = newStore();
  t.after(() => store.close());
  await install(store);
  await verifiedRun(store, {
    evidence: { target: "recorded-live", now: () => NOW },
  });
  const drafts = new ConnectorDrafts(store, { now: () => NOW });
  assert.equal((await drafts.supportLabel(actor, "novel")).label, "live");
  const key = {
    tenant: actor.tenantId,
    kind: "artifact" as const,
    id: "installed-connector:novel",
  };
  const rewrite = (change: (discovery: Record<string, unknown>) => void) =>
    store.transaction(async (tx) => {
      const current = await tx.get<{ discovery: Record<string, unknown> }>(key);
      const discovery = structuredClone(current!.value.discovery);
      change(discovery);
      await tx.put(key, { ...current!.value, discovery }, current!.revision);
    });
  const original = (
    (await store.transaction((tx) => tx.get(key)))!.value as {
      discovery: Record<string, unknown>;
    }
  ).discovery;
  for (const [field, value] of [
    ["methods", ["api-key", "oauth"]],
    ["grantTypes", ["authorization_code"]],
    ["revocationEndpoint", `${provider}/revoke`],
    ["clientIdMetadataDocumentSupported", true],
    ["codeChallengeMethods", ["S256"]],
    ["dpopSigningAlgorithms", ["ES256"]],
    ["scopes", ["read"]],
    ["userinfoEndpoint", `${provider}/userinfo`],
  ] as const) {
    await rewrite((discovery) => {
      discovery[field] = value;
    });
    assert.equal(
      (await drafts.supportLabel(actor, "novel")).label,
      "unverified",
      field,
    );
    await rewrite((discovery) => {
      for (const name of Object.keys(discovery)) delete discovery[name];
      Object.assign(discovery, structuredClone(original));
    });
    assert.equal((await drafts.supportLabel(actor, "novel")).label, "live");
  }
  // Bookkeeping, and an empty list where the field was absent, change
  // nothing a run does.
  await rewrite((discovery) => {
    discovery.documents = ["https://provider.example/.well-known/x"];
    discovery.searchUsed = true;
    discovery.retryable = true;
    discovery.codeChallengeMethods = [];
    delete discovery.grantTypes;
  });
  assert.equal((await drafts.supportLabel(actor, "novel")).label, "live");
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
      definition: await currentDefinition(store),
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
      definition: await currentDefinition(store),
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

test("a reinstall while the provider answers the probe records nothing for either definition", async (t) => {
  // Regression: the verifier probed with the definition it read first, then
  // recorded whatever was installed after the probe, so the new definition,
  // which nothing had run, read `live` and its manifest `live-adapter`.
  const store = newStore();
  t.after(() => store.close());
  await install(store);
  const probed = await currentDefinition(store);
  let reinstalled = false;
  const { commands, run } = await verifiedRun(store, {
    evidence: { target: "recorded-live", now: () => NOW },
    duringProbe: async () => {
      if (reinstalled) return;
      reinstalled = true;
      await install(store, actor, "Novel, renamed mid-probe");
    },
  });
  assert.ok(reinstalled);
  // The probe itself succeeded, so the run's connection stands.
  assert.equal((await commands.snapshot(actor, run.id)).status, "complete");
  assert.notEqual(await currentDefinition(store), probed);
  assert.deepEqual(await evidenceRecords(store), []);
  const drafts = new ConnectorDrafts(store, { now: () => NOW });
  assert.equal((await drafts.supportLabel(actor, "novel")).label, "unverified");
  assert.equal(
    (await drafts.getInstalled(actor, "novel"))?.manifest.support,
    "fixture",
  );
});

test("a credential collected under one definition is not evidence for the next", async (t) => {
  // The reinstall lands after the key was collected and before the verifier
  // reads the connector: the probe then proves a key collected for the old
  // definition against the new one, which is evidence for neither.
  const store = newStore();
  t.after(() => store.close());
  await install(store);
  const { commands, run } = await verifiedRun(store, {
    evidence: { target: "recorded-live", now: () => NOW },
    beforeVerify: () => install(store, actor, "Novel, reinstalled"),
  });
  assert.equal((await commands.snapshot(actor, run.id)).status, "complete");
  assert.deepEqual(await evidenceRecords(store), []);
  const drafts = new ConnectorDrafts(store, { now: () => NOW });
  assert.equal((await drafts.supportLabel(actor, "novel")).label, "unverified");
});

async function sessionRun(
  store: SQLiteCeremonyStore,
  options: { between?: () => Promise<void> } = {},
) {
  const registry = new OperationRegistry(authoredVocabulary);
  registerAuthoredOperations(registry, {
    store,
    // A verifier with no userinfo endpoint makes no call at all.
    fetch: async () => {
      throw new Error("no network call is expected");
    },
    evidence: { target: "recorded-live", now: () => NOW },
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
        id: "access",
        operationId: "authored.verify-access",
        operationVersion: "1.0.0",
        dependsOn: [],
        bindings: {},
      },
    ],
    {},
  );
  const context: OperationContext = {
    ...runContext,
    actor,
    runId: run.id,
    nodeId: "user",
    commandId: "user",
    effectId: "user",
    signal: new AbortController().signal,
  };
  const installed = await store.transaction((tx) =>
    tx.get<{ discovery: unknown }>({
      tenant: actor.tenantId,
      kind: "artifact",
      id: "installed-connector:novel",
    }),
  );
  // The token exchange that created the session: the provider's only
  // exercise in this flow when there is no userinfo endpoint.
  const created = await saveAuthoredGrantSession(
    store,
    actor,
    run.id,
    discoveredAuthSchema.parse(installed!.value.discovery),
    { access_token: "synthetic-access-token", sub: "provider-subject" },
    async () => {
      throw new Error("no userinfo call is expected");
    },
    undefined,
    "novel",
  );
  assert.ok(created);
  const session = await issueAuthoredHandle(store, context, "session");
  await options.between?.();
  return registry
    .require("authored.verify-access", "1.0.0")
    .handler({ ...context, nodeId: "access" }, { session });
}

test("a session is evidence for the definition it was created under", async (t) => {
  const store = newStore();
  t.after(() => store.close());
  await install(store);
  const verified = await sessionRun(store);
  assert.equal(verified.state, "complete");
  const drafts = new ConnectorDrafts(store, { now: () => NOW });
  assert.equal((await drafts.supportLabel(actor, "novel")).label, "live");
  const [stored] = await evidenceRecords(store);
  const [entry] = (stored?.value as { entries: Array<Record<string, unknown>> })
    .entries;
  assert.equal(entry!.definition, await currentDefinition(store));
  assert.match(String(entry!.notes), /authorization completed/);
});

test("a session verified after a reinstall records nothing for the definition it never ran", async (t) => {
  // Regression: with no userinfo endpoint the verifier makes no call, so a
  // session resumed after a reinstall credited the new definition from the
  // installed record alone.
  const store = newStore();
  t.after(() => store.close());
  await install(store);
  const verified = await sessionRun(store, {
    between: () => install(store, actor, "Novel, reinstalled"),
  });
  assert.equal(verified.state, "complete");
  assert.deepEqual(await evidenceRecords(store), []);
  const drafts = new ConnectorDrafts(store, { now: () => NOW });
  assert.equal((await drafts.supportLabel(actor, "novel")).label, "unverified");
});

test("a write naming a definition that is no longer installed is refused", async (t) => {
  const store = newStore();
  t.after(() => store.close());
  await install(store);
  const before = await currentDefinition(store);
  await install(store, actor, "Novel, renamed");
  assert.equal(
    await recordAuthoredEvidence(store, actor, {
      connectorId: "novel",
      runId: "run",
      definition: before,
      target: "recorded-live",
      proof: "credential-accepted",
      now: NOW,
    }),
    undefined,
  );
  assert.deepEqual(await evidenceRecords(store), []);
});
