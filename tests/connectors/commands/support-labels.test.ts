import assert from "node:assert/strict";
import { test } from "node:test";
import { SupportEvidenceError } from "../../../src/core/connectors/index.js";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import { createConnectorRegistration } from "../../../src/server/connectors/commands/index.js";
import type { ConnectorPolicy } from "../../../src/server/connectors/commands/policy.js";
import { createMicrosoftCustomConnectorAdapter } from "../../../src/server/connectors/formats/microsoft/index.js";
import { createMcpRemoteAdapter } from "../../../src/server/connectors/mcp/index.js";
import { createSupportLabeler } from "../../../src/server/connectors/support.js";
import { recordedSupportEvidence } from "../../../src/server/connectors/recorded-evidence.js";
import type { SupportLabelOptions } from "../../../src/server/connectors/support.js";
import {
  completeOauthCallback,
  createHarness,
  FIXTURE_DOCUMENT,
  human,
  type Harness,
} from "./harness.js";

/*
 * Support labels at run time: what the catalog and a registration show, and
 * the one thing a label may gate -- only when the host opts in. The fixture
 * adapter stands in for a fixture-family adapter (the generic OpenAPI and
 * catalog adapters declare `fixture` the same way), and every entry here is
 * a synthetic host entry dated against the harness clock.
 */

const SESSION = "human-session";
const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-09-18T12:00:00.000Z");

function clock(start = START) {
  let value = start;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}

const entry = (
  target: "in-process-fixture" | "local-double" | "recorded-live",
  recordedAt = "2026-09-18",
  extra: { definition?: string } = {},
) => ({
  adapterId: "fixture-http",
  check: "tests/connectors/commands/support-labels.test.ts",
  target,
  recordedAt,
  ...extra,
});

/** Admits the loopback fixture provider as a public destination, so its binding is a production binding. */
const publicDestinations = (base: ConnectorPolicy): ConnectorPolicy => ({
  ...base,
  allowDestination: () => "public",
});

async function harnessWith(
  support: SupportLabelOptions,
  options: {
    now?: () => number;
    policy?: (base: ConnectorPolicy) => ConnectorPolicy;
    generic?: boolean;
  } = {},
) {
  return createHarness({
    service: { support: { recorded: false, ...support } },
    ...(options.now ? { now: options.now } : {}),
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.generic ? { adapter: { evidenceScope: "definition" } } : {}),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function importDefinition(
  harness: Harness,
  actor: ActorContext,
  origin = harness.provider.origin,
) {
  harness.register(SESSION, actor);
  const imported = await json(
    await harness.fetch("/api/v1/connectors/import", {
      body: {
        kind: "upload",
        mediaType: "application/json",
        text: FIXTURE_DOCUMENT(origin),
      },
      session: SESSION,
    }),
  );
  return (imported.definitions as string[])[0]!;
}

async function bind(
  harness: Harness,
  actor: ActorContext,
  origin = harness.provider.origin,
) {
  const definitionRef = await importDefinition(harness, actor, origin);
  return harness.fetch("/api/v1/connectors/bindings", {
    body: {
      definitionRef,
      adapterId: "fixture-http",
      approvals: {
        destinations: [origin],
        operations: ["listItems"],
        profileId: "oauth",
      },
    },
    session: SESSION,
  });
}

async function connect(harness: Harness, bindingRef: string) {
  return harness.fetch("/api/v1/connectors/connections", {
    body: {
      bindingRef,
      intent: { profileId: "oauth", requestedPermissions: ["read"] },
    },
    session: SESSION,
  });
}

async function catalogEntry(harness: Harness, actor: ActorContext) {
  const entry = (await harness.service.catalog(actor)).find(
    (item) => item.id === "fixture-http",
  );
  assert.ok(entry);
  return entry;
}

test("the catalog shows the label evidence earns; local evidence leaves the family default alone", async (t) => {
  const harness = await harnessWith(
    { evidence: [entry("local-double")] },
    { now: () => START },
  );
  t.after(() => harness.close());
  const row = await catalogEntry(harness, human());
  assert.equal(row.supportLabel, "local");
  assert.equal(
    row.support,
    "fixture",
    "exercised locally is not provider-backed",
  );
});

test("with no entry at all the catalog says unverified, not fixture", async (t) => {
  const harness = await harnessWith({}, { now: () => START });
  t.after(() => harness.close());
  const row = await catalogEntry(harness, human());
  assert.equal(row.supportLabel, "unverified");
  assert.equal(row.support, "fixture");
});

test("host live evidence promotes a fixture-family adapter, and it lapses back when the evidence expires", async (t) => {
  const time = clock();
  const harness = await harnessWith(
    { evidence: [entry("local-double"), entry("recorded-live")] },
    { now: time.now },
  );
  t.after(() => harness.close());
  const actor = human();

  const live = await catalogEntry(harness, actor);
  assert.equal(live.supportLabel, "live");
  assert.equal(live.support, "provider-backed");

  const binding = await json(await bind(harness, actor));
  const reviewed = harness.definitions
    .bindings()
    .find((item) => item.bindingRef === binding.bindingRef)!;
  const definition = await harness.definitions.getDefinition(
    actor.tenantId,
    reviewed.definitionRef,
  );
  assert.ok(definition);
  // The manifest a registration derives follows the same evidence.
  const manifestSupport = () =>
    createConnectorRegistration(harness.service, "fixture-http", {
      connectorId: "fixture",
      definition,
      bindingRef: reviewed.bindingRef,
      actorFor: () => actor,
    }).manifest.support;
  assert.equal(manifestSupport(), "live-adapter");

  // Ninety-one days on, the live run has expired; the local check has not.
  time.advance(91 * DAY);
  const lapsed = await catalogEntry(harness, actor);
  assert.equal(lapsed.supportLabel, "local");
  assert.equal(lapsed.support, "fixture");
  assert.equal(manifestSupport(), "fixture");
});

test("a host entry that is malformed or dated after today stops the labeler from being built", () => {
  const now = () => START;
  assert.throws(
    () =>
      createSupportLabeler({
        now,
        evidence: [entry("recorded-live", "2026-09-19")],
      }),
    (error: unknown) =>
      error instanceof SupportEvidenceError &&
      /dated 2026-09-19, after 2026-09-18/.test(error.message),
  );
  assert.throws(
    () =>
      createSupportLabeler({
        now,
        evidence: [{ ...entry("local-double"), check: "../outside.ts" }],
      }),
    SupportEvidenceError,
  );
  assert.throws(
    () =>
      createSupportLabeler({
        now,
        evidence: [{ ...entry("local-double"), target: "attended-live" }],
      }),
    /names who attended/,
  );
  assert.throws(() =>
    createSupportLabeler({
      now,
      minimumForProduction: "gold" as never,
    }),
  );
});

test("the recorded entries never make a label live, and never fail a clock set before they were recorded", () => {
  assert.ok(recordedSupportEvidence.length > 0);
  assert.ok(
    recordedSupportEvidence.every(
      (item) =>
        item.target !== "recorded-live" && item.target !== "attended-live",
    ),
  );
  const early = createSupportLabeler({
    now: () => Date.parse("2026-01-01T00:00:00.000Z"),
  });
  const openapi = { id: "openapi-http", evidenceScope: "definition" } as const;
  const catalog = { id: "catalog-http", evidenceScope: "definition" } as const;
  assert.equal(early.label(openapi, true), "unverified");
  const current = createSupportLabeler({
    now: () => Date.parse("2026-09-23T12:00:00.000Z"),
  });
  // The generic code paths are described; no imported definition is.
  assert.equal(current.label(openapi, true), "local");
  assert.equal(current.label(catalog, true), "local");
  assert.equal(
    current.label(openapi, true, ["definition:anything-imported"]),
    "unverified",
  );
  // A single-provider adapter's own suites against its loopback double earn
  // `local`; one whose suites never reach a stand-in server stays `fixture`.
  assert.equal(current.label({ id: "nango" }, true), "local");
  assert.equal(current.label({ id: "supabase-wrappers" }, true), "fixture");
});

test("the MCP remote and Microsoft custom-connector adapters are labelled per definition", () => {
  // Both run whatever a person imported -- a remote MCP server, a custom
  // connector -- so, like the OpenAPI and catalog adapters, their own suites
  // describe the code path and never an imported definition.
  const mcp = createMcpRemoteAdapter();
  const microsoft = createMicrosoftCustomConnectorAdapter();
  const imported = `sha256:${"b".repeat(64)}`;
  for (const adapter of [mcp, microsoft]) {
    assert.equal(adapter.evidenceScope, "definition", adapter.id);
    const hostEntry = (
      target: "recorded-live" | "local-double",
      extra: { definition?: string } = {},
    ) => ({
      adapterId: adapter.id,
      check: "tests/connectors/commands/support-labels.test.ts",
      target,
      recordedAt: "2026-09-22",
      ...extra,
    });
    const recordedOnly = createSupportLabeler({
      now: () => Date.parse("2026-09-23T12:00:00.000Z"),
    });
    assert.equal(recordedOnly.label(adapter, true), "local", adapter.id);
    assert.equal(
      recordedOnly.label(adapter, true, [imported]),
      "unverified",
      `${adapter.id}: a definition nobody exercised`,
    );
    // An adapter-wide live entry names no provider, so it promotes no
    // definition and is not read even for the code path.
    const adapterWide = createSupportLabeler({
      now: () => Date.parse("2026-09-23T12:00:00.000Z"),
      evidence: [hostEntry("recorded-live")],
    });
    assert.equal(adapterWide.label(adapter, true), "local", adapter.id);
    assert.equal(adapterWide.label(adapter, true, [imported]), "unverified");
    // Only an entry naming the definition speaks for it, and only for it.
    const named = createSupportLabeler({
      now: () => Date.parse("2026-09-23T12:00:00.000Z"),
      evidence: [hostEntry("recorded-live", { definition: imported })],
    });
    assert.equal(named.label(adapter, true, [imported]), "live", adapter.id);
    assert.equal(
      named.label(adapter, true, [`sha256:${"c".repeat(64)}`]),
      "unverified",
    );
    assert.equal(named.label(adapter, true), "local");
  }
});

test("a labeler whose clock is not a finite instant refuses rather than admits", () => {
  // Regression: every comparison against NaN is false, so a future attended
  // entry read `certified`.
  assert.throws(
    () => createSupportLabeler({ now: () => Number.NaN }),
    RangeError,
  );
  let now = START;
  const labeler = createSupportLabeler({
    now: () => now,
    recorded: false,
    minimumForProduction: "fixture",
    evidence: [entry("in-process-fixture")],
  });
  const subject = { id: "fixture-http" };
  const destinations = [
    {
      origin: "https://items.example.test",
      network: "public",
    },
  ] as never;
  labeler.require(subject, destinations, true, []);
  now = Number.NaN;
  assert.throws(() => labeler.label(subject, true), RangeError);
  assert.throws(
    () => labeler.require(subject, destinations, true, []),
    (error: Error & { detail?: string }) => error.detail === "support.clock",
  );
});

test("the production minimum is off by default: a public binding with no evidence is approved", async (t) => {
  const harness = await harnessWith(
    {},
    { now: () => START, policy: publicDestinations },
  );
  t.after(() => harness.close());
  const response = await bind(harness, human());
  assert.equal(response.status, 201);
});

test("an opt-in minimum refuses a production binding below it, and leaves loopback fixtures alone", async (t) => {
  const production = await harnessWith(
    { minimumForProduction: "local", evidence: [entry("in-process-fixture")] },
    { now: () => START, policy: publicDestinations },
  );
  t.after(() => production.close());
  const refused = await bind(production, human());
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).detail, "support.below-minimum");

  const fixtures = await harnessWith(
    { minimumForProduction: "live" },
    { now: () => START },
  );
  t.after(() => fixtures.close());
  assert.equal((await bind(fixtures, human())).status, 201);
});

test("the minimum is rechecked at connect and invoke, so expired evidence stops new work", async (t) => {
  const time = clock();
  const harness = await harnessWith(
    { minimumForProduction: "local", evidence: [entry("local-double")] },
    { now: time.now, policy: publicDestinations },
  );
  t.after(() => harness.close());
  const actor = human();
  const binding = await json(await bind(harness, actor));
  const bindingRef = binding.bindingRef as string;
  const connected = await json(await connect(harness, bindingRef));
  assert.equal(
    (
      await completeOauthCallback(
        harness,
        SESSION,
        (connected.presentation as { url: string }).url,
      )
    ).status,
    303,
  );
  const listItems = harness.definitions
    .bindings()
    .find((item) => item.bindingRef === bindingRef)!
    .operations.find((item) => item.nativeId === "listItems")!.operationRef;
  const invoke = (commandId: string) =>
    harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connected.connectionRef as string)}/invoke`,
      {
        body: { operationRef: listItems, input: {}, commandId },
        session: SESSION,
      },
    );
  assert.equal((await invoke("cmd-1")).status, 200);

  // A year and a day later the only local entry has expired.
  time.advance(366 * DAY);
  const refusedInvoke = await invoke("cmd-2");
  assert.equal(refusedInvoke.status, 403);
  assert.equal((await json(refusedInvoke)).detail, "support.below-minimum");
  const refusedConnect = await connect(harness, bindingRef);
  assert.equal(refusedConnect.status, 403);
  assert.equal((await json(refusedConnect)).detail, "support.below-minimum");
});

test("a connection's label is read through its owner's view only", async (t) => {
  const harness = await harnessWith(
    { evidence: [entry("local-double")] },
    { now: () => START },
  );
  t.after(() => harness.close());
  const owner = human();
  const binding = await json(await bind(harness, owner));
  const connected = await json(
    await connect(harness, binding.bindingRef as string),
  );
  const connectionRef = connected.connectionRef as string;
  assert.equal(
    await harness.service.connectionSupportLabel(owner, connectionRef),
    "local",
  );
  await assert.rejects(
    harness.service.connectionSupportLabel(
      human({ subjectId: "someone-else", sessionId: "other-session" }),
      connectionRef,
    ),
    (error: Error & { code?: string }) => error.code === "not-found",
  );
});

/** The day after START's day begins two minutes after this. */
const LATE = Date.parse("2026-09-18T23:59:00.000Z");

async function rejectsBelowMinimum(promise: Promise<unknown>, what: string) {
  await assert.rejects(
    promise,
    (error: Error & { detail?: string }) =>
      error.detail === "support.below-minimum",
    what,
  );
}

test("evidence that lapses mid-ceremony stops verify, reconnect, poll and the callback", async (t) => {
  // Regression: the gate ran at approve, connect and invoke only, so with
  // expired evidence verify still called the provider, reconnect started a
  // new ceremony and a pending handoff could still complete.
  const time = clock(LATE);
  // 365 days old on 2026-09-18, expired from 2026-09-19.
  const harness = await harnessWith(
    {
      minimumForProduction: "local",
      evidence: [entry("local-double", "2025-09-18")],
    },
    { now: time.now, policy: publicDestinations },
  );
  t.after(() => harness.close());
  const owner = human();
  const binding = await json(await bind(harness, owner));
  const bindingRef = binding.bindingRef as string;
  const active = await json(await connect(harness, bindingRef));
  assert.equal(
    (
      await completeOauthCallback(
        harness,
        SESSION,
        (active.presentation as { url: string }).url,
      )
    ).status,
    303,
  );
  const activeRef = active.connectionRef as string;

  const second = human({ subjectId: "second", sessionId: "second-session" });
  harness.register("second", second);
  const pending = await json(
    await harness.fetch("/api/v1/connectors/connections", {
      body: {
        bindingRef,
        intent: { profileId: "oauth", requestedPermissions: ["read"] },
      },
      session: "second",
    }),
  );
  const pendingRef = pending.connectionRef as string;
  const redirect = await fetch((pending.presentation as { url: string }).url, {
    redirect: "manual",
  });
  await redirect.body?.cancel().catch(() => {});
  const location = redirect.headers.get("location");
  assert.ok(location);

  time.advance(2 * 60 * 1000);
  await rejectsBelowMinimum(harness.service.verify(owner, activeRef), "verify");
  const view = (await harness.service.status(owner, activeRef)) as {
    revision: number;
  };
  await rejectsBelowMinimum(
    harness.service.reconnect(owner, activeRef, {
      expectedRevision: view.revision,
    }),
    "reconnect",
  );
  await rejectsBelowMinimum(harness.service.poll(second, pendingRef), "poll");
  await rejectsBelowMinimum(
    harness.service.callback(second, new URL(location)),
    "callback",
  );
  // Cleaning up is never gated: a person can always let go of a connection.
  await harness.service.disconnect(owner, activeRef, {
    expectedRevision: view.revision,
  });
});

/** A description on a fixed origin, so its definition reference is the same in every harness. */
const FIXED_ORIGIN = "https://items.example.test";

test("a generic adapter's code-path evidence does not admit a definition nobody exercised", async (t) => {
  // Regression: labels were keyed by adapter id alone, so the generic
  // OpenAPI and catalog adapters passed a `local` gate for any imported
  // document on the strength of their own loopback suites.
  const unexercised = await harnessWith(
    { minimumForProduction: "local", evidence: [entry("local-double")] },
    { now: () => START, policy: publicDestinations, generic: true },
  );
  t.after(() => unexercised.close());
  const owner = human();
  assert.equal(
    (await catalogEntry(unexercised, owner)).supportLabel,
    "local",
    "the code path itself is described",
  );
  const refused = await bind(unexercised, owner, FIXED_ORIGIN);
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).detail, "support.below-minimum");

  const definitionRef = await importDefinition(
    unexercised,
    owner,
    FIXED_ORIGIN,
  );
  const definition = await unexercised.definitions.getDefinition(
    owner.tenantId,
    definitionRef,
  );
  assert.ok(definition);
  for (const named of [
    definitionRef,
    `sha256:${definition.normalizedDigest}`,
  ]) {
    const exercised = await harnessWith(
      {
        minimumForProduction: "local",
        evidence: [entry("local-double", "2026-09-18", { definition: named })],
      },
      { now: () => START, policy: publicDestinations, generic: true },
    );
    t.after(() => exercised.close());
    assert.equal(
      (await bind(exercised, owner, FIXED_ORIGIN)).status,
      201,
      named,
    );
    assert.equal(
      (await catalogEntry(exercised, owner)).supportLabel,
      "unverified",
      "one definition's evidence does not describe the code path",
    );
  }
});

test("a generic adapter is promoted per definition, never by an adapter-wide live entry", async (t) => {
  const owner = human();
  const adapterWide = await harnessWith(
    { evidence: [entry("local-double"), entry("recorded-live")] },
    { now: () => START, generic: true },
  );
  t.after(() => adapterWide.close());
  const row = await catalogEntry(adapterWide, owner);
  assert.equal(row.supportLabel, "local");
  assert.equal(row.support, "fixture");

  const definitionRef = await importDefinition(
    adapterWide,
    owner,
    FIXED_ORIGIN,
  );
  const definition = (await adapterWide.definitions.getDefinition(
    owner.tenantId,
    definitionRef,
  ))!;
  const manifestSupport = (harness: Harness) =>
    createConnectorRegistration(harness.service, "fixture-http", {
      connectorId: "fixture",
      definition,
      bindingRef: "binding:unused",
      actorFor: () => owner,
    }).manifest.support;
  assert.equal(manifestSupport(adapterWide), "fixture");

  const certified = await harnessWith(
    {
      evidence: [
        entry("recorded-live", "2026-09-18", { definition: definitionRef }),
      ],
    },
    { now: () => START, generic: true },
  );
  t.after(() => certified.close());
  assert.equal(manifestSupport(certified), "live-adapter");
  assert.equal((await catalogEntry(certified, owner)).support, "fixture");
});
