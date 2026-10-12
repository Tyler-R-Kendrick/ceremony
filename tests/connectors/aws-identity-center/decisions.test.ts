import assert from "node:assert/strict";
import test from "node:test";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import { sha256Hex } from "../../../src/server/connectors/auth/wire.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  AWS_TOKEN_REFRESH_OPERATION,
  createAwsIdentityCenterAdapter,
} from "../../../src/server/connectors/providers/aws-identity-center/index.js";
import {
  parseMaterial,
  signedIn,
  type SessionMaterial,
} from "../../../src/server/connectors/providers/aws-identity-center/material.js";
import {
  boundIdentity,
  currentAccessToken,
  ensureCurrent,
  renewRole,
} from "../../../src/server/connectors/providers/aws-identity-center/refresh.js";
import type { PersonSeed } from "../doubles/aws-identity-center.js";
import {
  alice,
  awsSetup,
  connectAndApprove,
  connectAndChoose,
  connectionRefOf,
  handoffRefOf,
  userCodeOf,
} from "./harness.js";

/*
 * The decisions the ceremony and renewal tests exercise only through their
 * results, pinned one at a time: what an intent can and cannot narrow, what
 * fits in the line a person reads, the edges of each renewal rule, and what
 * the journal says about each attempt. Each of these was found by mutating
 * the adapter and seeing no test notice.
 */

type View = {
  lifecycle: string;
  lastOutcome?: string;
  presentation?: { instructions?: string };
};
const asView = (value: unknown) => value as View;
const MINUTE = 60_000;
const detailOf = (error: unknown) =>
  error instanceof ConnectorError ? error.detail : undefined;

const account = (index: number, name?: string) => ({
  accountId: String(100_000_000_000 + index),
  ...(name === undefined ? {} : { accountName: name }),
  roles: ["ReadOnlyAccess"],
});

function personWith(accounts: PersonSeed["accounts"]): PersonSeed {
  return { id: "alice", accounts };
}

test("an intent that names nothing the adapter can narrow by is ignored, not obeyed", async (t) => {
  for (const target of [
    { kind: "aws-user", id: "x" },
    { kind: "aws-role", id: "no-colon" },
    { kind: "aws-role", id: ":ReadOnlyAccess" },
  ]) {
    const setup = await awsSetup(t);
    const { polled } = await connectAndApprove(setup, { target });
    const view = asView(polled);
    assert.equal(view.lifecycle, "human-required", JSON.stringify(target));
    assert.match(view.presentation!.instructions!, /111122223333/);
    assert.match(view.presentation!.instructions!, /444455556666/);
  }
});

test("an intent for a role narrows to that account, and only that role of it", async (t) => {
  const setup = await awsSetup(t);
  const { polled } = await connectAndApprove(setup, {
    target: { kind: "aws-role", id: "111122223333:AdministratorAccess" },
  });
  assert.equal(
    (polled as { target?: { id: string } }).target?.id,
    "111122223333:AdministratorAccess",
  );
  assert.equal(setup.fixture.counts.roleCredentials, 1);
  // The other account was never asked about: the intent had ruled it out.
  assert.equal(
    setup.fixture.portalRequests.filter(
      (request) =>
        request.url.searchParams.get("account_id") === "444455556666",
    ).length,
    0,
  );
});

test("a binding whose role list leaves nothing in the only account permits nothing", async (t) => {
  const setup = await awsSetup(t, {
    accounts: ["111122223333"],
    roles: ["111122223333:NotARoleSheHolds"],
  });
  const { polled, connectionRef } = await connectAndApprove(setup);
  const view = asView(polled);
  assert.equal(view.lifecycle, "authorization-required");
  assert.equal(
    view.lastOutcome,
    "aws-identity-center.selection.nothing-permitted",
  );
  assert.equal((await setup.record(connectionRef)).credentialRef, undefined);
});

/** The line a person reads is `lead` plus each part and a two-character separator, within 440. */
const LEAD = "Enter the account id and the role name to use: ";
const LIMIT = 440;

test("the line a person reads is cleaned of control characters and capped, saying when there is more", async (t) => {
  const many = personWith(
    Array.from({ length: 30 }, (_, index) =>
      account(index, `Team\u0007 ${index} with a name long enough to matter`),
    ),
  );
  const setup = await awsSetup(t, {
    people: [many],
    accounts: many.accounts.map((item) => item.accountId),
  });
  const { polled } = await connectAndApprove(setup);
  const text = asView(polled).presentation!.instructions!;
  assert.ok(text.length <= 500, String(text.length));
  assert.ok(text.endsWith("; more are available."), text);
  assert.equal(
    /\p{Cc}/u.test(text),
    false,
    "no control character reaches a person",
  );
  assert.match(
    text,
    /^Enter the account id and the role name to use: 100000000000 Team {2}0 with/,
  );
  // Parts that fit are all shown, none is cut in half.
  const shown = text
    .slice(LEAD.length, -"; more are available.".length)
    .split("; ");
  assert.ok(shown.length > 1 && shown.length < 30);
  for (const part of shown)
    assert.match(
      part,
      /^\d{12} Team {2}\d+ with a name long enough to matter$/,
    );
});

test("a list that fits exactly is shown whole; one character more drops its last part", async (t) => {
  const fit = async (extra: number) => {
    // Three accounts; the last name is sized so the cumulative length reaches the limit exactly.
    const first = [account(0, "a".repeat(60)), account(1, "b".repeat(60))];
    const used =
      LEAD.length + first.reduce((sum, item) => sum + 12 + 1 + 60 + 2, 0);
    const room = LIMIT - used - 12 - 1 - 2;
    const people = personWith([...first, account(2, "c".repeat(room + extra))]);
    const setup = await awsSetup(t, {
      people: [people],
      accounts: people.accounts.map((item) => item.accountId),
    });
    const { polled } = await connectAndApprove(setup);
    return asView(polled).presentation!.instructions!;
  };
  const whole = await fit(0);
  assert.match(whole, /100000000002 c+\.$/);
  assert.equal(whole.includes("more are available"), false);
  const over = await fit(1);
  assert.equal(over.includes("100000000002"), false);
  assert.ok(over.endsWith("; more are available."));
});

test("a completion for a handoff of another kind, or one missing its session, is refused", async (t) => {
  const setup = await awsSetup(t);
  const adapter = createAwsIdentityCenterAdapter();
  const first = await connectAndApprove(setup);
  const choice = await setup.ports.handoffs.present(
    setup.person,
    handoffRefOf(first.polled),
  );
  assert.ok(choice);
  const ctx = await setup.adapterContext(first.connectionRef);
  const values = { accountId: "111122223333", roleName: "ReadOnlyAccess" };
  await assert.rejects(
    adapter.complete!(
      { ...ctx, handoff: { ...choice, intent: "oauth.device-code" } },
      { kind: "input", values },
    ),
    (error: unknown) => detailOf(error) === "oauth.handoff.kind",
  );
  await assert.rejects(
    adapter.complete!({ ...ctx }, { kind: "input", values }),
    (error: unknown) => detailOf(error) === "oauth.handoff.kind",
  );
  await assert.rejects(
    adapter.complete!(
      {
        ...ctx,
        handoff: { ...choice, private: { ...choice.private, sessionRef: "" } },
      },
      { kind: "input", values },
    ),
    (error: unknown) => detailOf(error) === "oauth.handoff.private-missing",
  );
  const { sessionRef: _dropped, ...rest } = choice.private;
  void _dropped;
  await assert.rejects(
    adapter.complete!(
      { ...ctx, handoff: { ...choice, private: rest } },
      { kind: "input", values },
    ),
    (error: unknown) => detailOf(error) === "oauth.handoff.private-missing",
  );
  // An input completion is the person's: the handoff stays theirs to settle.
  const done = await adapter.complete!(
    { ...ctx, handoff: choice },
    { kind: "input", values },
  );
  assert.equal(done.state, "complete");
  assert.equal(done.handoffSettled, undefined);
  // An expired choice releases what it held and carries no claim.
  setup.advance(601_000);
  const lapsed = await adapter.complete!(
    { ...ctx, handoff: choice },
    { kind: "input", values },
  );
  assert.equal(lapsed.state, "expired");
  assert.deepEqual(lapsed.claims, []);
});

test("the sign-in that has nothing to choose says it settled its own handoff", async (t) => {
  const setup = await awsSetup(t, { accounts: ["444455556666"] });
  const adapter = createAwsIdentityCenterAdapter();
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  setup.fixture.approve(userCodeOf(connected));
  setup.advance(6_000);
  const handoff = await setup.ports.handoffs.present(
    setup.person,
    handoffRefOf(connected),
  );
  assert.ok(handoff);
  const ctx = await setup.adapterContext(connectionRefOf(connected));
  const result = await adapter.complete!({ ...ctx, handoff }, { kind: "poll" });
  assert.equal(result.state, "complete");
  assert.equal(result.handoffSettled, true);
  assert.deepEqual(result.adapterState?.["aws"], {
    accountId: "444455556666",
    roleName: "PowerUserAccess",
    region: "us-east-1",
    expiresAt: setup.clock() + 3_600_000,
  });
});

// ------------------------------------------------------------- renewal rules

test("the connection's identity is read from its own state, and a connection without one is not bound", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  const ctx = await setup.adapterContext(connectionRef);
  assert.deepEqual(boundIdentity(ctx), {
    accountId: "111122223333",
    roleName: "ReadOnlyAccess",
  });
  const bare = {
    ...ctx,
    connection: undefined,
  } as unknown as AdapterCallContext;
  assert.throws(
    () => boundIdentity(bare),
    (error: unknown) =>
      detailOf(error) === "aws-identity-center.role.not-bound",
  );
  const empty = { ...ctx, connection: { ...ctx.connection!, state: {} } };
  assert.throws(
    () => boundIdentity(empty),
    (error: unknown) =>
      detailOf(error) === "aws-identity-center.role.not-bound",
  );
});

const material = (
  overrides: {
    [K in keyof SessionMaterial]?: SessionMaterial[K] | undefined;
  } = {},
): SessionMaterial => {
  const merged: Record<string, unknown> = {
    phase: "role-bound",
    clientId: "c",
    clientSecret: "s",
    clientSecretExpiresAt: 10_000_000,
    accessToken: "a",
    accessTokenExpiresAt: 5_000_000,
    refreshToken: "r",
    ...overrides,
  };
  for (const key of Object.keys(merged))
    if (merged[key] === undefined) delete merged[key];
  return merged as SessionMaterial;
};
const at = (now: number) =>
  ({ environment: { now: () => now } }) as unknown as AdapterCallContext;

test("an access token is used until a minute before it lapses, then refreshed", async () => {
  const current = material();
  // 60 000 ms of skew: with exactly that long left it is already due.
  assert.equal(
    await currentAccessToken(at(5_000_000 - 60_001), current),
    current,
  );
  await assert.rejects(
    currentAccessToken(
      at(5_000_000 - 60_000),
      material({ refreshToken: undefined }),
    ),
    (error: unknown) =>
      detailOf(error) === "aws-identity-center.session.expired",
  );
  // Nothing held at all is the same as lapsed.
  await assert.rejects(
    currentAccessToken(
      at(0),
      material({ accessToken: undefined, refreshToken: undefined }),
    ),
    (error: unknown) =>
      detailOf(error) === "aws-identity-center.session.expired",
  );
});

test("a client registration that has lapsed, or lapses this instant, is not presented", async () => {
  const lapsed = material({
    accessTokenExpiresAt: 1,
    clientSecretExpiresAt: 2_000,
  });
  for (const now of [2_000, 2_001])
    await assert.rejects(
      currentAccessToken(at(now), lapsed),
      (error: unknown) =>
        detailOf(error) === "aws-identity-center.registration.expired",
      String(now),
    );
});

test("role credentials are renewed when exactly five minutes remain, not before", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  const ctx = await setup.adapterContext(connectionRef);
  const ref = ctx.connection!.credentialRef!;
  const expiry = (await setup.heldMaterial(connectionRef))["role_expires_at"]!;
  setup.advance(Number(expiry) - setup.clock() - 5 * MINUTE - 1);
  const before = setup.fixture.counts.roleCredentials;
  await ensureCurrent(ctx, ref);
  assert.equal(
    setup.fixture.counts.roleCredentials,
    before,
    "one millisecond early",
  );
  setup.advance(1);
  await ensureCurrent(ctx, ref);
  assert.equal(
    setup.fixture.counts.roleCredentials,
    before + 1,
    "exactly five minutes left",
  );
});

test("a reference custody does not hold is unknown, and so is a record that was never bound to a role", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  const ctx = await setup.adapterContext(connectionRef);
  await assert.rejects(
    ensureCurrent(ctx, "cred:nothing-here"),
    (error: unknown) =>
      detailOf(error) === "aws-identity-center.credential.unknown",
  );
  await assert.rejects(
    renewRole(ctx, material({ phase: "signed-in" }), {
      accountId: "111122223333",
      roleName: "ReadOnlyAccess",
    }),
    (error: unknown) =>
      detailOf(error) === "aws-identity-center.role.not-bound",
  );
});

test("a portal that is down during a renewal is a failure to retry, not a role the person lost", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  setup.advance(56 * MINUTE);
  setup.fixture.failPortal(503);
  await assert.rejects(
    setup.service.verify(setup.person, connectionRef),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "upstream-unavailable",
  );
  setup.fixture.failPortal(null);
  const view = asView(await setup.service.verify(setup.person, connectionRef));
  assert.equal(view.lifecycle, "active");
});

test("the journal says what each refresh did: applied once exchanged, failed once refused", async (t) => {
  const setup = await awsSetup(t, {
    double: { accessTokenLifetimeSeconds: 1200, roleLifetimeMs: 30 * MINUTE },
  });
  const { connectionRef } = await connectAndChoose(setup);
  setup.advance(26 * MINUTE);
  await setup.service.verify(setup.person, connectionRef);
  const outcomes = () =>
    setup.journal.filter(
      (entry) => "status" in entry && String(entry.code).includes("refresh."),
    );
  assert.deepEqual(
    outcomes().map((entry) => [
      (entry as { status: string }).status,
      (entry as { code: string }).code,
    ]),
    [["applied", "aws-identity-center.refresh.exchanged"]],
  );
  // Someone else spends the new refresh token; the next refresh is refused.
  const held = await setup.heldMaterial(connectionRef);
  await fetch(`${setup.fixture.oidcOrigin}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: held["client_id"],
      clientSecret: held["client_secret"],
      refreshToken: held["sso_refresh_token"],
      grantType: "refresh_token",
    }),
  });
  setup.advance(26 * MINUTE);
  await setup.service.verify(setup.person, connectionRef);
  assert.deepEqual(
    outcomes().map((entry) => (entry as { status: string }).status),
    ["applied", "failed"],
  );
});

test("a refresh token the journal already holds is never presented again, whichever way that attempt ended", async (t) => {
  for (const status of ["applied", "indeterminate"] as const) {
    const setup = await awsSetup(t, {
      double: { accessTokenLifetimeSeconds: 1200, roleLifetimeMs: 30 * MINUTE },
    });
    const { connectionRef } = await connectAndChoose(setup);
    const held = await setup.heldMaterial(connectionRef);
    const connection = await setup.record(connectionRef);
    const begun = await setup.ports.effects.begin({
      actor: setup.person,
      connectionRef,
      bindingRef: connection.bindingRef,
      operation: AWS_TOKEN_REFRESH_OPERATION,
      digest: sha256Hex(
        "aws-refresh",
        held["client_id"]!,
        held["sso_refresh_token"]!,
      ),
    });
    await setup.ports.effects.complete(begun.effectRef, {
      status,
      at: setup.clock(),
    });
    setup.advance(26 * MINUTE);
    // Either way the token may be spent: the session ends for a person to start again.
    const view = (await setup.service.verify(setup.person, connectionRef)) as {
      lifecycle: string;
      lastOutcome?: string;
    };
    assert.equal(view.lifecycle, "expired", status);
    assert.equal(
      view.lastOutcome,
      "aws-identity-center.session.refresh-unknown",
      status,
    );
    assert.equal(setup.fixture.counts.refresh, 0, "nothing was sent");
  }
});

// ------------------------------------------------------------------ material

test("stored material is whole or refused: lifetimes are positive integers and a bound role carries all four members", () => {
  const raw = {
    client_id: "c",
    client_secret: "s",
    client_secret_expires_at: "10",
    sso_access_token: "a",
    sso_access_token_expires_at: "5",
    sso_refresh_token: "r",
    access_key_id: "k",
    secret_access_key: "x",
    session_token: "t",
    role_expires_at: "7",
  };
  assert.equal(parseMaterial(raw).role?.expiresAt, 7);
  // The phase is read from the members present; the record stores no word for it.
  assert.equal(parseMaterial(raw).phase, "role-bound");
  const signedInOnly = {
    client_id: raw.client_id,
    client_secret: raw.client_secret,
    client_secret_expires_at: raw.client_secret_expires_at,
    sso_access_token: raw.sso_access_token,
    sso_access_token_expires_at: raw.sso_access_token_expires_at,
  };
  assert.equal(parseMaterial(signedInOnly).phase, "signed-in");
  const registeredOnly = {
    client_id: raw.client_id,
    client_secret: raw.client_secret,
    client_secret_expires_at: raw.client_secret_expires_at,
  };
  assert.equal(parseMaterial(registeredOnly).phase, "registered");
  assert.equal(
    parseMaterial({ ...raw, sso_refresh_token: "" }).refreshToken,
    undefined,
  );
  const refused = (change: Record<string, string | undefined>) => {
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...raw, ...change }))
      if (value !== undefined) next[key] = value;
    assert.throws(
      () => parseMaterial(next),
      (error: unknown) =>
        detailOf(error) === "aws-identity-center.credential.malformed",
      JSON.stringify(change),
    );
  };
  refused({ client_secret_expires_at: undefined });
  refused({ client_secret_expires_at: "0" });
  refused({ client_secret_expires_at: "-1" });
  refused({ client_secret_expires_at: "1.5" });
  refused({ sso_access_token_expires_at: undefined });
  refused({ sso_access_token_expires_at: "0" });
  refused({ access_key_id: undefined });
  refused({ secret_access_key: "" });
  refused({ session_token: undefined });
  refused({ role_expires_at: undefined });
  refused({ role_expires_at: "0" });
  // Role credentials with no sign-in behind them are not a whole record.
  refused({
    sso_access_token: undefined,
    sso_access_token_expires_at: undefined,
  });
});

test("signing in again holds the refresh token the answer carries, and none when it carries none", () => {
  const current = material({ refreshToken: "spent" });
  // The token that was presented is spent; an answer without a new one leaves none.
  assert.equal(
    "refreshToken" in signedIn(current, { accessToken: "n", expiresIn: 60 }, 0),
    false,
  );
  assert.equal(
    signedIn(
      current,
      { accessToken: "n", expiresIn: 60, refreshToken: "new" },
      0,
    ).refreshToken,
    "new",
  );
  const bare = signedIn(
    material({ refreshToken: undefined }),
    { accessToken: "n", expiresIn: 60 },
    0,
  );
  assert.equal("refreshToken" in bare, false);
  void alice;
});

// ------------------------------------------------ what the adapter answers

test("an intent of another kind is ignored even when its id looks like a role, and names are cleaned at their edges", async (t) => {
  const named = personWith([
    account(0, "\u0007Prod\u0007"),
    account(1, "  Dev  "),
  ]);
  const setup = await awsSetup(t, {
    people: [named],
    accounts: named.accounts.map((item) => item.accountId),
  });
  const { polled } = await connectAndApprove(setup, {
    target: { kind: "aws-user", id: "100000000001:ReadOnlyAccess" },
  });
  const view = asView(polled);
  assert.equal(view.lifecycle, "human-required");
  assert.equal(
    view.presentation!.instructions,
    `${LEAD}100000000000 Prod; 100000000001 Dev.`,
  );
});

test("a poll answers a choice with no claim, a nothing-to-choose with a denial, and the person's input only in the two fields it asked for", async (t) => {
  const adapter = createAwsIdentityCenterAdapter();
  const pollOf = async (options: Parameters<typeof awsSetup>[1]) => {
    const setup = await awsSetup(t, options);
    const connected = await setup.service.connect(setup.person, {
      bindingRef: setup.binding.bindingRef,
      intent: {},
    });
    setup.fixture.approve(userCodeOf(connected));
    setup.advance(6_000);
    const handoff = await setup.ports.handoffs.present(
      setup.person,
      handoffRefOf(connected),
    );
    assert.ok(handoff);
    const ctx = await setup.adapterContext(connectionRefOf(connected));
    return {
      setup,
      ctx,
      result: await adapter.complete!({ ...ctx, handoff }, { kind: "poll" }),
    };
  };
  const choose = await pollOf({});
  assert.equal(choose.result.state, "human-required");
  assert.equal(choose.result.code, "aws-identity-center.selection.required");
  assert.deepEqual(choose.result.claims, []);
  assert.equal(choose.result.handoffSettled, true);
  assert.equal(
    choose.result.handoff?.intent,
    "aws-identity-center.select-role",
  );
  const none = await pollOf({ accounts: ["999900001111"] });
  assert.equal(none.result.state, "denied");
  assert.equal(
    none.result.code,
    "aws-identity-center.selection.nothing-permitted",
  );
  assert.deepEqual(none.result.claims, []);
  assert.equal(none.result.handoffSettled, true);

  // The choice itself: fields in any order, no more and no fewer, each well formed.
  const other = await awsSetup(t);
  const first = await connectAndApprove(other);
  const handoff = await other.ports.handoffs.present(
    other.person,
    handoffRefOf(first.polled),
  );
  assert.ok(handoff);
  const inputCtx = await other.adapterContext(first.connectionRef);
  const ask = (values: Record<string, string>) =>
    adapter.complete!({ ...inputCtx, handoff }, { kind: "input", values });
  const refused = (detail: string) => (error: unknown) =>
    detailOf(error) === detail;
  await assert.rejects(
    ask({ accountId: "111122223333" }),
    refused("aws-identity-center.selection.fields"),
  );
  await assert.rejects(
    ask({ accountId: "111122223333", roleName: "ReadOnlyAccess", extra: "x" }),
    refused("aws-identity-center.selection.fields"),
  );
  await assert.rejects(
    ask({ accountId: "11", roleName: "ReadOnlyAccess" }),
    refused("aws-identity-center.selection.shape"),
  );
  await assert.rejects(
    ask({ accountId: "111122223333", roleName: "../x" }),
    refused("aws-identity-center.selection.shape"),
  );
  const reversed = await ask({
    roleName: "ReadOnlyAccess",
    accountId: "111122223333",
  });
  assert.equal(reversed.state, "complete");
});

test("a connection that holds no intent still completes a sign-in", async (t) => {
  const setup = await awsSetup(t, { accounts: ["444455556666"] });
  const adapter = createAwsIdentityCenterAdapter();
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  setup.fixture.approve(userCodeOf(connected));
  setup.advance(6_000);
  const handoff = await setup.ports.handoffs.present(
    setup.person,
    handoffRefOf(connected),
  );
  assert.ok(handoff);
  const ctx = await setup.adapterContext(connectionRefOf(connected));
  const bare = { ...ctx, connection: { ...ctx.connection!, state: {} } };
  const result = await adapter.complete!(
    { ...bare, handoff },
    { kind: "poll" },
  );
  assert.equal(result.state, "complete");
});

test("a refresh that never left is not spent, and the journal says so", async (t) => {
  const setup = await awsSetup(t, {
    double: { accessTokenLifetimeSeconds: 1200, roleLifetimeMs: 30 * MINUTE },
  });
  const { connectionRef } = await connectAndChoose(setup);
  setup.advance(26 * MINUTE);
  await setup.fixture.stopOidc();
  await assert.rejects(
    setup.service.verify(setup.person, connectionRef),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "upstream-unavailable",
  );
  assert.ok(
    setup.journal.some(
      (entry) =>
        "status" in entry &&
        entry.status === "not-applied" &&
        entry.code === "aws-identity-center.refresh.unreachable",
    ),
  );
  assert.equal(setup.fixture.counts.refresh, 0);
});

test("a refresh the journal records as never sent may be tried again, and a lone account with two roles lists them", async (t) => {
  const setup = await awsSetup(t, {
    double: { accessTokenLifetimeSeconds: 1200, roleLifetimeMs: 30 * MINUTE },
  });
  const { connectionRef } = await connectAndChoose(setup);
  const held = await setup.heldMaterial(connectionRef);
  const connection = await setup.record(connectionRef);
  const begun = await setup.ports.effects.begin({
    actor: setup.person,
    connectionRef,
    bindingRef: connection.bindingRef,
    operation: AWS_TOKEN_REFRESH_OPERATION,
    digest: sha256Hex(
      "aws-refresh",
      held["client_id"]!,
      held["sso_refresh_token"]!,
    ),
  });
  await setup.ports.effects.complete(begun.effectRef, {
    status: "not-applied",
    at: setup.clock(),
  });
  setup.advance(26 * MINUTE);
  const view = asView(await setup.service.verify(setup.person, connectionRef));
  assert.equal(view.lifecycle, "active");
  assert.equal(setup.fixture.counts.refresh, 1);

  const lone = await awsSetup(t, { accounts: ["111122223333"] });
  const { polled } = await connectAndApprove(lone);
  assert.equal(
    asView(polled).presentation!.instructions,
    `${LEAD}111122223333 Production (ReadOnlyAccess, AdministratorAccess).`,
  );
});
