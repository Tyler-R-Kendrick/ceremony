import assert from "node:assert/strict";
import test from "node:test";
import { capabilityStatusSchema } from "../../../src/core/connectors/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { createVercelAccountAdapter } from "../../../src/server/connectors/providers/vercel-account/index.js";
import {
  accountSetup,
  alice,
  connectAndApprove,
  connectAndChoose,
  connectionRefOf,
  handoffRefOf,
  userCodeOf,
} from "./harness.js";

/*
 * What happens when Vercel is not there, says something unexpected, or the
 * person takes too long. The rule for a token request is the journal's: one
 * that never left is not spent, one that may have reached Vercel is never
 * sent again, and neither is guessed to have worked.
 */

type View = { lifecycle: string; lastOutcome?: string };
const asView = (value: unknown) => value as View;
const MINUTE = 60_000;

test("a token endpoint that answers 5xx leaves the exchange indeterminate and the code unspent by us", async (t) => {
  const setup = await accountSetup(t);
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
  assert.equal(view.lastOutcome, "oauth.device.indeterminate");
  assert.equal(setup.fixture.issued.accessTokens.length, 0);
});

test("a token endpoint that is not listening is a request that never left", async (t) => {
  const setup = await accountSetup(t);
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  await setup.fixture.stopApi();
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
        entry.code === "oauth.device.unreachable",
    ),
    "the journal says the request did not leave",
  );
});

test("a token response lost in transit is indeterminate, and the code is not presented again", async (t) => {
  const setup = await accountSetup(t);
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  const connectionRef = connectionRefOf(connected);
  setup.fixture.approve(userCodeOf(connected));
  setup.fixture.dropNextTokenResponse();
  setup.advance(6_000);
  const view = asView(await setup.service.poll(setup.person, connectionRef));
  assert.equal(view.lifecycle, "indeterminate");
  assert.equal(view.lastOutcome, "oauth.device.indeterminate");
  const requests = setup.fixture.counts.token;
  setup.advance(60_000);
  const again = asView(await setup.service.poll(setup.person, connectionRef));
  assert.equal(setup.fixture.counts.token, requests, "no second token request");
  assert.equal(again.lifecycle, "indeterminate");
  assert.ok(
    setup.journal.some(
      (entry) =>
        "status" in entry &&
        entry.status === "indeterminate" &&
        entry.code === "oauth.device.indeterminate",
    ),
    "the journal records the lost outcome",
  );
});

test("a refresh answered 5xx is never presented again, and the session is over", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  setup.advance(59 * MINUTE);
  setup.fixture.failTokens(500);
  const first = asView(await setup.service.verify(setup.person, connectionRef));
  // The refresh token may have been spent before the 5xx: a person signs in again.
  assert.equal(first.lifecycle, "expired");
  assert.equal(first.lastOutcome, "vercel-account.session.refresh-unknown");
  const sent = setup.fixture.counts.token;
  setup.fixture.failTokens(null);
  const second = asView(
    await setup.service.verify(setup.person, connectionRef),
  );
  assert.equal(second.lifecycle, "expired");
  assert.equal(setup.fixture.counts.token, sent, "no second presentation");
  assert.ok(
    setup.journal.some(
      (entry) =>
        "status" in entry &&
        entry.status === "indeterminate" &&
        entry.code === "oauth.refresh.indeterminate",
    ),
  );
});

test("a refresh that never left is not spent: the next try presents the same token", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  setup.advance(59 * MINUTE);
  await setup.fixture.stopApi();
  await assert.rejects(
    setup.service.verify(setup.person, connectionRef),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "upstream-unavailable",
  );
  assert.equal(setup.fixture.counts.refresh, 0);
  assert.equal(
    setup.fixture.refreshTokenUsable(setup.fixture.issued.refreshTokens[0]!),
    true,
  );
});

async function nothingOutlives(
  setup: Awaited<ReturnType<typeof accountSetup>>,
  connectionRef: string,
) {
  assert.equal(
    setup.stored.length > 0,
    true,
    "something was stored to look for",
  );
  const connection = await setup.record(connectionRef);
  const scope = {
    tenantId: connection.tenantId,
    ownerKind: connection.ownerKind,
    ownerId: connection.ownerId,
    connectionRef: connection.connectionRef,
    bindingRef: connection.bindingRef,
    custody: connection.custody,
  };
  for (const ref of setup.stored)
    assert.equal(
      await setup.ports.credentials.describe(scope, ref),
      undefined,
      "no custody record outlives the attempt",
    );
  assert.equal(connection.credentialRef, undefined);
}

test("an API that is down when the teams are listed ends the attempt with nothing in custody", async (t) => {
  const setup = await accountSetup(t);
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  setup.fixture.approve(userCodeOf(connected));
  setup.fixture.failRest(503);
  setup.advance(6_000);
  await assert.rejects(
    setup.service.poll(setup.person, connectionRefOf(connected)),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "upstream-unavailable",
  );
  assert.equal(
    setup.fixture.issued.accessTokens.length,
    1,
    "Vercel did issue a token",
  );
  await nothingOutlives(setup, connectionRefOf(connected));
});

test("a token Vercel refuses at the team listing ends the attempt with nothing in custody", async (t) => {
  const setup = await accountSetup(t);
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  setup.fixture.approve(userCodeOf(connected));
  setup.fixture.failRest(401);
  setup.advance(6_000);
  await assert.rejects(
    setup.service.poll(setup.person, connectionRefOf(connected)),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "upstream-rejected",
  );
  await nothingOutlives(setup, connectionRefOf(connected));
});

test("nothing the binding permits is held by the person: the attempt ends and nothing is kept", async (t) => {
  const setup = await accountSetup(t, { teams: ["team_dummy_unrelated"] });
  const { connectionRef, polled } = await connectAndApprove(setup);
  const view = asView(polled);
  assert.equal(view.lifecycle, "authorization-required");
  assert.equal(view.lastOutcome, "vercel-account.selection.nothing-permitted");
  assert.equal((await setup.record(connectionRef)).credentialRef, undefined);
  // The token Vercel issued was released, not kept for a later try.
  assert.equal(setup.fixture.counts.teams > 0, true);
});

test("a choice left open past its time, or a poll past the handoff's, is expired and releases what it held", async (t) => {
  const setup = await accountSetup(t);
  const adapter = createVercelAccountAdapter();
  const { connectionRef, polled } = await connectAndApprove(setup);
  const handoff = await setup.ports.handoffs.present(
    setup.person,
    handoffRefOf(polled),
  );
  assert.ok(handoff);
  setup.advance(601_000);
  const ctx = { ...(await setup.adapterContext(connectionRef)), handoff };
  const teamsBefore = setup.fixture.counts.teams;
  const expired = await adapter.complete!(ctx, {
    kind: "input",
    values: { team: "acme" },
  });
  assert.equal(expired.state, "expired");
  assert.equal(expired.code, "vercel-account.selection.expired");
  assert.equal(setup.fixture.counts.teams, teamsBefore, "Vercel was not asked");
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

  // The same rule for the device handoff, asked of the service.
  const other = await accountSetup(t);
  const connected = await other.service.connect(other.person, {
    bindingRef: other.binding.bindingRef,
    intent: {},
  });
  other.advance(601_000);
  const lapsed = asView(
    await other.service.poll(other.person, connectionRefOf(connected)),
  );
  assert.equal(lapsed.lifecycle, "authorization-required");
  assert.equal(lapsed.lastOutcome, "handoff.expired");
  assert.equal(other.fixture.counts.token, 0, "the code was not presented");
});

test("a completion that is not for this adapter's handoffs is refused", async (t) => {
  const setup = await accountSetup(t);
  const adapter = createVercelAccountAdapter();
  const { connectionRef } = await connectAndChoose(setup);
  const ctx = await setup.adapterContext(connectionRef);
  await assert.rejects(
    adapter.complete!(ctx, { kind: "poll" }),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "oauth.handoff.kind",
  );
  await assert.rejects(
    adapter.complete!(ctx, { kind: "input", values: { team: "acme" } }),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "oauth.handoff.kind",
  );
});

test("the capability rows are well formed and cover every dimension once", () => {
  const rows = createVercelAccountAdapter().capabilities(new Set());
  assert.equal(rows.length, 12);
  for (const row of rows) capabilityStatusSchema.parse(row);
  assert.equal(new Set(rows.map((row) => row.dimension)).size, 12);
});
