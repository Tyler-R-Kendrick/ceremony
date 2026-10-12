import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  awsSetup,
  connectAndApprove,
  connectAndChoose,
  connectionRefOf,
  handoffRefOf,
  START_TIME,
  userCodeOf,
} from "./harness.js";

/*
 * The ceremony as a person lives it: connect, approve on the provider's own
 * page, pick an account and role, and end up with a connection whose
 * credentials the caller never sees. Each test fails without the behaviour it
 * names: remove the permitted-account filter and the third account is offered,
 * drop the portal listing check and an unassigned role reaches
 * GetRoleCredentials, and so on.
 */

type View = {
  lifecycle: string;
  lastOutcome?: string;
  target?: { kind: string; id: string };
  verification?: { kinds: string[]; validUntil?: string };
  presentation?: { url?: string; userCode?: string; instructions?: string };
  handoff?: { kind: string; state: string; handoffRef: string };
};
const asView = (value: unknown) => value as View;

test("a person signs in, picks an account and role, and the connection is active", async (t) => {
  const setup = await awsSetup(t);
  const { fixture } = setup;
  const connected = asView(
    await setup.service.connect(setup.person, {
      bindingRef: setup.binding.bindingRef,
      intent: {},
    }),
  );
  // The person is shown the page to open and the code to type, nothing else.
  assert.equal(connected.lifecycle, "authorization-required");
  assert.equal(connected.handoff?.kind, "device-code");
  const userCode = userCodeOf(connected);
  assert.match(connected.presentation!.url!, /\/device\?user_code=/);
  assert.equal(
    JSON.stringify(connected).includes(fixture.issued.deviceCodes[0]!),
    false,
    "the device code is never presented",
  );
  assert.equal(fixture.counts.register, 1);
  assert.equal(fixture.counts.deviceAuthorization, 1);
  // The registration asked for the device grant, a refresh grant and a scope.
  const [client] = fixture.clients();
  assert.equal(client!.name, "Ceremony");
  assert.deepEqual(client!.grants.sort(), [
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:device_code",
  ]);
  assert.deepEqual(client!.scopes, ["sso:account:access"]);

  // Before anyone approves, a poll is pending; an immediate second one waits.
  const connectionRef = connectionRefOf(connected);
  setup.advance(6_000);
  const pending = asView(await setup.service.poll(setup.person, connectionRef));
  assert.equal(pending.lastOutcome, "aws-identity-center.device.pending");
  const before = fixture.counts.token;
  const waiting = asView(await setup.service.poll(setup.person, connectionRef));
  assert.equal(waiting.lastOutcome, "aws-identity-center.device.wait");
  assert.equal(fixture.counts.token, before, "no request inside the interval");

  // The person approves on the provider's page; the next poll asks them to choose.
  assert.ok(fixture.approve(userCode));
  setup.advance(6_000);
  const choose = asView(await setup.service.poll(setup.person, connectionRef));
  assert.equal(choose.lifecycle, "human-required");
  assert.equal(choose.handoff?.kind, "input-required");
  const offered = choose.presentation!.instructions!;
  assert.match(offered, /111122223333 Production/);
  assert.match(offered, /444455556666 Sandbox/);
  assert.equal(
    offered.includes("777788889999"),
    false,
    "an account the binding does not permit is never offered",
  );

  const active = asView(
    await setup.service.provideInput(
      setup.person,
      connectionRef,
      handoffRefOf(choose),
      { accountId: "111122223333", roleName: "ReadOnlyAccess" },
    ),
  );
  assert.equal(active.lifecycle, "active");
  assert.deepEqual(active.target, {
    kind: "aws-role",
    id: "111122223333:ReadOnlyAccess",
  });
  assert.deepEqual(active.verification?.kinds, [
    "credential-accepted",
    "account-identity",
    "resource-access",
  ]);
  // The caller sees the expiry the portal gave: an hour after the credentials were issued.
  assert.equal(
    active.verification?.validUntil,
    new Date(setup.clock() + 3_600_000).toISOString(),
  );
  assert.deepEqual(fixture.violations, []);
  const held = await setup.heldMaterial(connectionRef);
  assert.equal(held["phase"], "role-bound");
  assert.equal(
    held["access_key_id"],
    fixture.issued.roleCredentials[0]!.accessKeyId,
  );
});

test("exactly one account and one role binds without asking", async (t) => {
  const setup = await awsSetup(t, { accounts: ["444455556666"] });
  const { polled } = await connectAndApprove(setup);
  const view = asView(polled);
  assert.equal(view.lifecycle, "active");
  assert.equal(view.target?.id, "444455556666:PowerUserAccess");
  assert.equal(setup.fixture.counts.roleCredentials, 1);
});

test("an intent naming an account narrows what is offered", async (t) => {
  const setup = await awsSetup(t);
  const { polled } = await connectAndApprove(setup, {
    target: { kind: "aws-account", id: "444455556666" },
  });
  const view = asView(polled);
  assert.equal(view.lifecycle, "active");
  assert.equal(view.target?.id, "444455556666:PowerUserAccess");
});

test("an intent naming a role binds that role of a two-role account", async (t) => {
  const setup = await awsSetup(t);
  const { polled } = await connectAndApprove(setup, {
    target: { kind: "aws-role", id: "111122223333:AdministratorAccess" },
  });
  const view = asView(polled);
  assert.equal(view.lifecycle, "active");
  assert.equal(view.target?.id, "111122223333:AdministratorAccess");
});

test("a role the binding does not list is neither offered nor accepted", async (t) => {
  const setup = await awsSetup(t, {
    accounts: ["111122223333"],
    roles: ["111122223333:ReadOnlyAccess"],
  });
  // One account, one permitted role: nothing to ask.
  const { polled } = await connectAndApprove(setup);
  assert.equal(asView(polled).target?.id, "111122223333:ReadOnlyAccess");
  const restricted = await awsSetup(t, {
    accounts: ["111122223333", "444455556666"],
    roles: ["111122223333:ReadOnlyAccess", "444455556666:PowerUserAccess"],
  });
  const first = await connectAndApprove(restricted);
  await assert.rejects(
    restricted.service.provideInput(
      restricted.person,
      first.connectionRef,
      handoffRefOf(first.polled),
      { accountId: "111122223333", roleName: "AdministratorAccess" },
    ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "aws-identity-center.role.not-permitted",
  );
  assert.equal(restricted.fixture.counts.roleCredentials, 0);
});

test("an account the binding does not permit is refused even when typed", async (t) => {
  const setup = await awsSetup(t);
  const first = await connectAndApprove(setup);
  await assert.rejects(
    setup.service.provideInput(
      setup.person,
      first.connectionRef,
      handoffRefOf(first.polled),
      { accountId: "777788889999", roleName: "ReadOnlyAccess" },
    ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "aws-identity-center.account.not-permitted",
  );
  assert.equal(setup.fixture.counts.roleCredentials, 0);
  assert.equal(setup.fixture.counts.listRoles, 0, "the portal was not asked");
});

test("a role the account does not hold is refused, the choice stays open, and a valid one then works", async (t) => {
  const setup = await awsSetup(t);
  const first = await connectAndApprove(setup);
  const handoffRef = handoffRefOf(first.polled);
  await assert.rejects(
    setup.service.provideInput(setup.person, first.connectionRef, handoffRef, {
      accountId: "111122223333",
      roleName: "BillingAdministrator",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "aws-identity-center.role.unassigned",
  );
  assert.equal(
    setup.fixture.counts.roleCredentials,
    0,
    "GetRoleCredentials is not asked for a role the portal does not list",
  );
  const retried = asView(
    await setup.service.provideInput(
      setup.person,
      first.connectionRef,
      handoffRef,
      {
        accountId: "111122223333",
        roleName: "AdministratorAccess",
      },
    ),
  );
  assert.equal(retried.lifecycle, "active");
});

test("a choice outside the two fields, or in the wrong shape, is refused before the portal is asked", async (t) => {
  const setup = await awsSetup(t);
  const first = await connectAndApprove(setup);
  const handoffRef = handoffRefOf(first.polled);
  const attempt = (values: Record<string, string>) =>
    setup.service.provideInput(
      setup.person,
      first.connectionRef,
      handoffRef,
      values,
    );
  await assert.rejects(attempt({ accountId: "111122223333" }), /not valid/);
  await assert.rejects(
    attempt({
      accountId: "111122223333",
      roleName: "ReadOnlyAccess",
      extra: "x",
    }),
    /not valid/,
  );
  await assert.rejects(
    attempt({ accountId: "1111", roleName: "ReadOnlyAccess" }),
    /not valid/,
  );
  await assert.rejects(
    attempt({ accountId: "111122223333", roleName: "../etc/passwd" }),
    /not valid/,
  );
  assert.equal(setup.fixture.counts.listRoles, 0);
});

test("an agent can read the connection but cannot make the choice", async (t) => {
  const setup = await awsSetup(t);
  const first = await connectAndApprove(setup);
  await assert.rejects(
    setup.service.provideInput(
      setup.agent,
      first.connectionRef,
      handoffRefOf(first.polled),
      { accountId: "111122223333", roleName: "ReadOnlyAccess" },
    ),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "input.human-only",
  );
  const seen = (await setup.service.status(
    setup.agent,
    first.connectionRef,
  )) as Record<string, unknown>;
  assert.equal(seen["lifecycle"], "human-required");
  assert.equal("presentation" in seen, false);
});

test("a denied approval ends the attempt with no credential held", async (t) => {
  const setup = await awsSetup(t);
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  const connectionRef = connectionRefOf(connected);
  const registration = (
    await setup.ports.handoffs.present(setup.person, handoffRefOf(connected))
  )?.private["registrationRef"];
  assert.ok(registration);
  assert.ok(setup.fixture.deny(userCodeOf(connected)));
  setup.advance(6_000);
  const view = asView(await setup.service.poll(setup.person, connectionRef));
  assert.equal(view.lifecycle, "authorization-required");
  assert.equal(view.lastOutcome, "aws-identity-center.device.access-denied");
  assert.equal(view.handoff?.state, "denied");
  assert.equal((await setup.record(connectionRef)).credentialRef, undefined);
  assert.equal(setup.fixture.issued.accessTokens.length, 0);
  // The client secret the attempt registered is released with it.
  const record = await setup.record(connectionRef);
  assert.equal(
    await setup.ports.credentials.describe(
      {
        tenantId: record.tenantId,
        ownerKind: record.ownerKind,
        ownerId: record.ownerId,
        connectionRef,
        bindingRef: record.bindingRef,
        custody: record.custody,
      },
      registration,
    ),
    undefined,
  );
});

test("a code the server expired is expired, whatever the handoff said", async (t) => {
  const setup = await awsSetup(t);
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  setup.fixture.expireDevice(userCodeOf(connected));
  setup.advance(6_000);
  const view = asView(
    await setup.service.poll(setup.person, connectionRefOf(connected)),
  );
  assert.equal(view.lifecycle, "authorization-required");
  assert.equal(view.lastOutcome, "aws-identity-center.device.expired");
  assert.equal(view.handoff?.state, "expired");
});

test("a handoff that outlives its own expiry never reaches the token endpoint", async (t) => {
  const setup = await awsSetup(t);
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  setup.advance(601_000);
  const view = asView(
    await setup.service.poll(setup.person, connectionRefOf(connected)),
  );
  assert.equal(view.lifecycle, "authorization-required");
  assert.equal(view.lastOutcome, "handoff.expired");
  assert.equal(setup.fixture.counts.token, 0);
});

test("a stricter server answers slow_down and the interval grows, honoured on the next poll", async (t) => {
  const setup = await awsSetup(t, { double: { enforcedIntervalSeconds: 8 } });
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  const connectionRef = connectionRefOf(connected);
  const poll = async () =>
    asView(await setup.service.poll(setup.person, connectionRef));
  setup.advance(5_000);
  assert.equal(
    (await poll()).lastOutcome,
    "aws-identity-center.device.pending",
  );
  // Five seconds later is the advertised interval and inside the server's.
  setup.advance(5_000);
  assert.equal(
    (await poll()).lastOutcome,
    "aws-identity-center.device.slow-down",
  );
  assert.equal(setup.fixture.counts.tooFastPolls, 1);
  // The adapter now waits ten seconds: a poll at six sends nothing.
  const sent = setup.fixture.counts.token;
  setup.advance(6_000);
  assert.equal((await poll()).lastOutcome, "aws-identity-center.device.wait");
  assert.equal(setup.fixture.counts.token, sent);
  // Past ten seconds it asks again; the server, now at thirteen, still says slow_down.
  setup.advance(5_000);
  assert.equal(
    (await poll()).lastOutcome,
    "aws-identity-center.device.slow-down",
  );
  assert.equal(setup.fixture.counts.token, sent + 1);
});

test("a token response lost in transit is indeterminate, and the code is not presented again", async (t) => {
  const setup = await awsSetup(t);
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
  assert.equal(view.lastOutcome, "aws-identity-center.device.indeterminate");
  const requests = setup.fixture.counts.token;
  setup.advance(60_000);
  const again = asView(await setup.service.poll(setup.person, connectionRef));
  assert.equal(setup.fixture.counts.token, requests, "no second CreateToken");
  assert.equal(again.lifecycle, "indeterminate");
  assert.ok(
    setup.journal.some(
      (entry) =>
        "status" in entry &&
        entry.status === "indeterminate" &&
        entry.code === "aws-identity-center.device.indeterminate",
    ),
    "the journal records the lost outcome",
  );
});

test("the list operations show only the accounts and roles the binding permits", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  const accounts = await setup.service.invoke(setup.person, connectionRef, {
    operationRef: "aws-identity-center.list-accounts",
    input: {},
    commandId: "list-accounts-1",
  });
  assert.equal(accounts.state, "complete");
  assert.deepEqual(
    (
      accounts.output as { accounts: Array<{ accountId: string }> }
    ).accounts.map((account) => account.accountId),
    ["111122223333", "444455556666"],
  );
  const roles = await setup.service.invoke(setup.person, connectionRef, {
    operationRef: "aws-identity-center.list-account-roles",
    input: { "aws-account": "111122223333" },
    commandId: "list-roles-1",
  });
  assert.deepEqual((roles.output as { roles: string[] }).roles, [
    "ReadOnlyAccess",
    "AdministratorAccess",
  ]);
  await assert.rejects(
    setup.service.invoke(setup.person, connectionRef, {
      operationRef: "aws-identity-center.list-account-roles",
      input: { "aws-account": "777788889999" },
      commandId: "list-roles-2",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "target.not-permitted",
  );
  // No operation hands back the credentials: asking for one by name is unbound.
  await assert.rejects(
    setup.service.invoke(setup.person, connectionRef, {
      operationRef: "aws-identity-center.get-role-credentials",
      input: { accountId: "111122223333", roleName: "ReadOnlyAccess" },
      commandId: "creds-1",
    }),
  );
});

test("the start time is the harness clock", () => {
  assert.equal(new Date(START_TIME).toISOString(), "2026-10-12T09:00:00.000Z");
});
