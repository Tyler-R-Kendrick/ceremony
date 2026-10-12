import assert from "node:assert/strict";
import test from "node:test";
import type { PersonSeed } from "../doubles/aws-identity-center.js";
import {
  awsSetup,
  connectAndApprove,
  connectAndChoose,
  handoffRefOf,
  type AwsSetup,
} from "./harness.js";

/*
 * Custody refuses a callback result that contains anything the record holds.
 * What the record holds must therefore be secret, or an account or role whose
 * name happens to contain a word the record keeps for its own bookkeeping
 * makes a list operation fail. The record holds no bookkeeping words: the
 * phase of a sign-in is read from which members it has.
 */

const person: PersonSeed = {
  id: "alice",
  accounts: [
    {
      accountId: "111122223333",
      accountName: "role-bound signed-in registered",
      roles: ["role-bound-admins", "ReadOnlyAccess"],
    },
    { accountId: "444455556666", accountName: "Sandbox", roles: ["Power"] },
  ],
};

async function connected(setup: AwsSetup) {
  const first = await connectAndApprove(setup);
  await setup.service.provideInput(
    setup.person,
    first.connectionRef,
    handoffRefOf(first.polled),
    { accountId: "111122223333", roleName: "ReadOnlyAccess" },
  );
  return first.connectionRef;
}

test("an account named with the words a sign-in goes through is listed", async (t) => {
  const setup = await awsSetup(t, { people: [person] });
  const connectionRef = await connected(setup);
  const result = await setup.service.invoke(setup.person, connectionRef, {
    operationRef: "aws-identity-center.list-accounts",
    input: {},
    commandId: "names-1",
  });
  assert.equal(result.state, "complete");
  assert.match(
    JSON.stringify(result.output),
    /role-bound signed-in registered/,
  );
});

test("a role named with those words is listed", async (t) => {
  const setup = await awsSetup(t, { people: [person] });
  const connectionRef = await connected(setup);
  const result = await setup.service.invoke(setup.person, connectionRef, {
    operationRef: "aws-identity-center.list-account-roles",
    input: { "aws-account": "111122223333" },
    commandId: "names-2",
  });
  assert.equal(result.state, "complete");
  assert.deepEqual((result.output as { roles: string[] }).roles, [
    "role-bound-admins",
    "ReadOnlyAccess",
  ]);
});

test("the record keeps no bookkeeping word, and its phase follows from what it holds", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  const held = await setup.heldMaterial(connectionRef);
  assert.equal("phase" in held, false);
  assert.ok(held["access_key_id"], "a bound role is recognised by its members");
});
