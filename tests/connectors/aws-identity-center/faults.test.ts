import assert from "node:assert/strict";
import test from "node:test";
import { capabilityStatusSchema } from "../../../src/core/connectors/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { createAwsIdentityCenterAdapter } from "../../../src/server/connectors/providers/aws-identity-center/index.js";
import {
  awsSetup,
  connectAndApprove,
  connectAndChoose,
  connectionRefOf,
  handoffRefOf,
  userCodeOf,
} from "./harness.js";

/*
 * What happens when AWS is not there, says something unexpected, or the
 * person takes too long. The rule for a token request is the journal's: one
 * that never left is not spent, one that may have reached AWS is never sent
 * again, and neither is guessed to have worked.
 */

type View = { lifecycle: string; lastOutcome?: string };
const asView = (value: unknown) => value as View;

test("a token endpoint that answers 5xx leaves the exchange indeterminate and the code unspent by us", async (t) => {
  const setup = await awsSetup(t);
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  setup.fixture.approve(userCodeOf(connected));
  setup.fixture.failTokens(503);
  setup.advance(6_000);
  const view = asView(
    await setup.service.poll(setup.person, connectionRefOf(connected)),
  );
  assert.equal(view.lifecycle, "indeterminate");
  assert.equal(view.lastOutcome, "aws-identity-center.device.indeterminate");
  assert.equal(setup.fixture.issued.accessTokens.length, 0);
});

test("a token endpoint that is not listening is a request that never left", async (t) => {
  const setup = await awsSetup(t);
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  await setup.fixture.stopOidc();
  setup.advance(6_000);
  await assert.rejects(
    setup.service.poll(setup.person, connectionRefOf(connected)),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "upstream-unavailable",
  );
  assert.ok(
    setup.journal.some(
      (entry) =>
        "status" in entry &&
        entry.status === "not-applied" &&
        entry.code === "aws-identity-center.device.unreachable",
    ),
    "the journal says the request did not leave",
  );
});

test("a refresh answered 5xx is never presented again", async (t) => {
  const setup = await awsSetup(t, {
    double: { accessTokenLifetimeSeconds: 1200, roleLifetimeMs: 30 * 60_000 },
  });
  const { connectionRef } = await connectAndChoose(setup);
  setup.advance(26 * 60_000);
  setup.fixture.failTokens(500);
  await assert.rejects(
    setup.service.verify(setup.person, connectionRef),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "upstream-unavailable",
  );
  const sent = setup.fixture.counts.token;
  setup.fixture.failTokens(null);
  await assert.rejects(
    setup.service.verify(setup.person, connectionRef),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "indeterminate",
  );
  assert.equal(setup.fixture.counts.token, sent, "no second presentation");
});

test("nothing the binding permits is held by the person: the attempt ends and nothing is kept", async (t) => {
  const setup = await awsSetup(t, { accounts: ["999900001111"] });
  const { connectionRef, polled } = await connectAndApprove(setup);
  const view = asView(polled);
  assert.equal(view.lifecycle, "authorization-required");
  assert.equal(
    view.lastOutcome,
    "aws-identity-center.selection.nothing-permitted",
  );
  assert.equal((await setup.record(connectionRef)).credentialRef, undefined);
  assert.equal(setup.fixture.counts.roleCredentials, 0);
});

test("a choice left open past its time, or a poll past the handoff's, is expired and releases what it held", async (t) => {
  const setup = await awsSetup(t);
  const adapter = createAwsIdentityCenterAdapter();
  const { connectionRef, polled } = await connectAndApprove(setup);
  const handoff = await setup.ports.handoffs.present(
    setup.person,
    handoffRefOf(polled),
  );
  assert.ok(handoff);
  setup.advance(601_000);
  const ctx = { ...(await setup.adapterContext(connectionRef)), handoff };
  const expired = await adapter.complete!(ctx, {
    kind: "input",
    values: { accountId: "111122223333", roleName: "ReadOnlyAccess" },
  });
  assert.equal(expired.state, "expired");
  assert.equal(expired.code, "aws-identity-center.selection.expired");
  const sessionRef = handoff.private["sessionRef"]!;
  const scope = {
    tenantId: ctx.actor.tenantId,
    ownerKind: "user" as const,
    ownerId: ctx.actor.subjectId,
    connectionRef,
    bindingRef: setup.binding.bindingRef,
    custody: "host-owned" as const,
  };
  assert.equal(
    await setup.ports.credentials.describe(scope, sessionRef),
    undefined,
  );

  // The same rule for the device handoff, asked of the adapter directly.
  const other = await awsSetup(t);
  const connected = await other.service.connect(other.person, {
    bindingRef: other.binding.bindingRef,
    intent: {},
  });
  const pending = await other.ports.handoffs.present(
    other.person,
    handoffRefOf(connected),
  );
  assert.ok(pending);
  other.advance(601_000);
  const lapsed = await adapter.complete!(
    {
      ...(await other.adapterContext(connectionRefOf(connected))),
      handoff: pending,
    },
    { kind: "poll" },
  );
  assert.equal(lapsed.state, "expired");
  assert.equal(lapsed.code, "aws-identity-center.device.expired");
  assert.equal(other.fixture.counts.token, 0);
});

test("the capability rows state protocol-fixture evidence and nothing live", () => {
  const adapter = createAwsIdentityCenterAdapter();
  const rows = adapter.capabilities(new Set());
  assert.equal(rows.length, 12);
  for (const row of rows) {
    capabilityStatusSchema.parse(row);
    assert.equal(
      row.evidence,
      row.implementation === "implemented" ? "protocol-fixture" : "not-tested",
    );
  }
  const implemented = rows
    .filter((row) => row.implementation === "implemented")
    .map((row) => row.dimension);
  assert.deepEqual(implemented, [
    "authorize",
    "verify",
    "invoke",
    "reconnect",
    "disconnect",
    "revoke",
  ]);
  assert.match(
    rows.find((row) => row.dimension === "authorize")!.limitations.join(" "),
    /loopback double/,
  );
});
