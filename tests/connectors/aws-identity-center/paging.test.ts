import assert from "node:assert/strict";
import test from "node:test";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import { runtimeBindingSchema } from "../../../src/server/connectors/binding.js";
import {
  listAccountRoles,
  listAccounts,
} from "../../../src/server/connectors/providers/aws-identity-center/portal.js";
import type { PersonSeed } from "../doubles/aws-identity-center.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import { awsSetup, connectAndApprove, handoffRefOf } from "./harness.js";

/*
 * A listing is read a page at a time, up to a bound. What it returns is a set
 * (the same account on two pages is one), and a listing that was cut off, or
 * that stopped advancing, is unknown rather than complete: "nothing permitted"
 * and "exactly one" are claims about the whole list, so neither is made from a
 * part of it.
 */

const many = (count: number): PersonSeed["accounts"] =>
  Array.from({ length: count }, (_, index) => ({
    accountId: String(100_000_000_000 + index),
    accountName: `Account ${index}`,
    roles: ["ReadOnlyAccess"],
  }));

async function portalAt(
  t: Parameters<typeof awsSetup>[0],
  serve: () => Record<string, unknown>,
) {
  const setup = await awsSetup(t);
  const server = await startHttpFixture(() => ({
    status: 200,
    body: serve(),
  }));
  t.after(() => server.close());
  const ctx = {
    binding: runtimeBindingSchema.parse({
      ...setup.binding,
      destinations: [
        { id: "oidc", origin: server.origin, network: "loopback-fixture" },
        { id: "portal", origin: server.origin, network: "loopback-fixture" },
      ],
    }),
    signal: new AbortController().signal,
    environment: { fetch: globalThis.fetch },
  } as unknown as AdapterCallContext;
  return { ctx, server };
}

test("an account the portal lists on two pages is one account, and a listing that stops advancing is cut off", async (t) => {
  let served = 0;
  const { ctx, server } = await portalAt(t, () => ({
    accountList: [
      {
        accountId: "111122223333",
        accountName: "Production",
        emailAddress: "p@example.test",
      },
    ],
    nextToken: `more-${served++}`,
  }));
  const listing = await listAccounts(ctx, "aws_dummy_token");
  assert.deepEqual(
    listing.items.map((item) => item.accountId),
    ["111122223333"],
  );
  assert.equal(listing.truncated, true, "no new account on the second page");
  assert.equal(
    server.requests.length,
    2,
    "it stopped asking once nothing was new",
  );
});

test("a role listed twice is one role", async (t) => {
  let served = 0;
  const { ctx } = await portalAt(t, () => ({
    roleList: [
      { roleName: "ReadOnlyAccess", accountId: "111122223333" },
      { roleName: "ReadOnlyAccess", accountId: "111122223333" },
    ],
    nextToken: served++ < 1 ? "next" : null,
  }));
  const listing = await listAccountRoles(
    ctx,
    "aws_dummy_token",
    "111122223333",
  );
  assert.deepEqual(listing.items, ["ReadOnlyAccess"]);
  assert.equal(listing.truncated, false);
});

test("a permitted account beyond the pages that were read is asked about, not reported as nothing permitted", async (t) => {
  // 600 accounts, five pages of 100 read: the one account the binding permits is the last.
  const person: PersonSeed = { id: "alice", accounts: many(600) };
  const permitted = person.accounts[599]!.accountId;
  const setup = await awsSetup(t, { people: [person], accounts: [permitted] });
  const { polled } = await connectAndApprove(setup);
  const view = polled as {
    lifecycle: string;
    presentation?: { instructions?: string };
  };
  assert.equal(
    view.lifecycle,
    "human-required",
    "a person is asked, nothing is denied",
  );
  assert.match(view.presentation!.instructions!, /more are available/);
  assert.equal(setup.fixture.counts.roleCredentials, 0);
  // Typing what the binding permits works: the portal, not the cut-off list, decides.
  const done = (await setup.service.provideInput(
    setup.person,
    (view as unknown as { connectionRef: string }).connectionRef,
    handoffRefOf(polled),
    { accountId: permitted, roleName: "ReadOnlyAccess" },
  )) as { lifecycle: string };
  assert.equal(done.lifecycle, "active");
});

test("the one permitted account that was found is not bound while the listing was cut off", async (t) => {
  // The permitted account is on page one; 600 accounts follow it, so the list was cut off.
  const person: PersonSeed = { id: "alice", accounts: many(600) };
  const permitted = person.accounts[0]!.accountId;
  const setup = await awsSetup(t, { people: [person], accounts: [permitted] });
  const { polled } = await connectAndApprove(setup);
  const view = polled as { lifecycle: string };
  assert.equal(view.lifecycle, "human-required");
  assert.equal(setup.fixture.counts.roleCredentials, 0);
});

test("a listing that was read whole still binds the one permitted account without asking", async (t) => {
  const person: PersonSeed = { id: "alice", accounts: many(3) };
  const setup = await awsSetup(t, {
    people: [person],
    accounts: [person.accounts[1]!.accountId],
  });
  const { polled } = await connectAndApprove(setup);
  assert.equal((polled as { lifecycle: string }).lifecycle, "active");
});
