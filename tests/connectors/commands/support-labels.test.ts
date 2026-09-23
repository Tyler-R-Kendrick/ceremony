import assert from "node:assert/strict";
import { test } from "node:test";
import { SupportEvidenceError } from "../../../src/core/connectors/index.js";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import { createConnectorRegistration } from "../../../src/server/connectors/commands/index.js";
import type { ConnectorPolicy } from "../../../src/server/connectors/commands/policy.js";
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
) => ({
  adapterId: "fixture-http",
  check: "tests/connectors/commands/support-labels.test.ts",
  target,
  recordedAt,
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
  } = {},
) {
  return createHarness({
    service: { support: { recorded: false, ...support } },
    ...(options.now ? { now: options.now } : {}),
    ...(options.policy ? { policy: options.policy } : {}),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function bind(harness: Harness, actor: ActorContext) {
  harness.register(SESSION, actor);
  const imported = await json(
    await harness.fetch("/api/v1/connectors/import", {
      body: {
        kind: "upload",
        mediaType: "application/json",
        text: FIXTURE_DOCUMENT(harness.provider.origin),
      },
      session: SESSION,
    }),
  );
  return harness.fetch("/api/v1/connectors/bindings", {
    body: {
      definitionRef: (imported.definitions as string[])[0]!,
      adapterId: "fixture-http",
      approvals: {
        destinations: [harness.provider.origin],
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
  assert.equal(early.label("openapi-http", true), "unverified");
  const current = createSupportLabeler({
    now: () => Date.parse("2026-09-23T12:00:00.000Z"),
  });
  assert.equal(current.label("openapi-http", true), "local");
  assert.equal(current.label("catalog-http", true), "local");
  assert.equal(current.label("nango", true), "fixture");
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
