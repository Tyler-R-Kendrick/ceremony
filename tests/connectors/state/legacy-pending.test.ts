import assert from "node:assert/strict";
import test from "node:test";
import { connectionKey } from "../../../src/server/connectors/state/keys.js";
import type { StoredConnectionValue } from "../../../src/server/connectors/state/schemas.js";
import type { AsyncCeremonyStore } from "../../../src/server/persistence/index.js";
import * as aws from "../aws-identity-center/harness.js";
import * as vercel from "../vercel-account/harness.js";

/*
 * A connection that was waiting for a person's choice before the waiting
 * sign-in was recorded on the connection (`pendingSession`) has only its open
 * choice to say where that sign-in is held: the adapter put the custody
 * reference in the choice's private half, and the connection's state says
 * nothing (the service did not merge an adapter's state on a
 * `human-required` completion then). Each test makes a fresh choice and then
 * writes the stored record back exactly as the code before `pendingSession`
 * left it: the same record without that key. A disconnect by an agent, who
 * cannot read the handoff, and a cancel must still find and drop the sign-in.
 */

type Setup = {
  store: AsyncCeremonyStore;
  ports: aws.AwsSetup["ports"];
  service: aws.AwsSetup["service"];
  person: aws.AwsSetup["person"];
  agent: aws.AwsSetup["agent"];
  stored: string[];
};

const PROVIDERS = [
  {
    name: "AWS (role choice)",
    setup: (t: test.TestContext) => aws.awsSetup(t),
    approve: (setup: Setup) => aws.connectAndApprove(setup as aws.AwsSetup),
  },
  {
    name: "Vercel (team choice)",
    setup: (t: test.TestContext) => vercel.accountSetup(t),
    approve: (setup: Setup) =>
      vercel.connectAndApprove(setup as unknown as vercel.AccountSetup),
  },
] as const;

/** Writes the connection back as the code before `pendingSession` wrote it. */
async function asWrittenBefore(setup: Setup, connectionRef: string) {
  await setup.store.transaction(async (tx) => {
    const key = connectionKey(setup.person.tenantId, connectionRef);
    const stored = await tx.get<StoredConnectionValue>(key);
    if (!stored) throw new Error("no such connection");
    const { pendingSession, ...state } = stored.value.record.state;
    assert.equal(typeof pendingSession, "string", "the choice was recorded");
    await tx.put(
      key,
      {
        ...stored.value,
        record: {
          ...stored.value.record,
          state,
          revision: stored.revision + 1,
        },
      },
      stored.revision,
    );
  });
  const raw = await setup.store.transaction((tx) =>
    tx.get<StoredConnectionValue>(
      connectionKey(setup.person.tenantId, connectionRef),
    ),
  );
  assert.ok(
    raw && !Object.hasOwn(raw.value.record.state, "pendingSession"),
    "the stored record names no waiting sign-in",
  );
}

async function leftInCustody(setup: Setup, connectionRef: string) {
  const record = (await setup.ports.connections.get(
    setup.person,
    connectionRef,
  ))!.record;
  const scope = {
    tenantId: record.tenantId,
    ownerKind: record.ownerKind,
    ownerId: record.ownerId,
    connectionRef: record.connectionRef,
    bindingRef: record.bindingRef,
    custody: record.custody,
  };
  const left: string[] = [];
  for (const ref of setup.stored)
    if (await setup.ports.credentials.describe(scope, ref)) left.push(ref);
  return left;
}

for (const provider of PROVIDERS) {
  test(`${provider.name}: a disconnect by an agent finds the sign-in a choice made before pendingSession was waiting on`, async (t) => {
    const setup = (await provider.setup(t)) as unknown as Setup;
    const { connectionRef } = await provider.approve(setup);
    await asWrittenBefore(setup, connectionRef);
    assert.equal((await leftInCustody(setup, connectionRef)).length, 1);
    const current = await setup.ports.connections.get(
      setup.person,
      connectionRef,
    );
    const result = await setup.service.disconnect(setup.agent, connectionRef, {
      expectedRevision: current!.revision,
      scope: "local",
    });
    assert.equal(result.result.local, "applied");
    assert.equal(result.result.release?.revoked, true);
    assert.deepEqual(await leftInCustody(setup, connectionRef), []);
  });

  test(`${provider.name}: a cancel drops the sign-in a choice made before pendingSession was waiting on`, async (t) => {
    const setup = (await provider.setup(t)) as unknown as Setup;
    const { connectionRef } = await provider.approve(setup);
    await asWrittenBefore(setup, connectionRef);
    const [waiting] = setup.stored;
    await setup.service.cancelPending(setup.person, connectionRef);
    assert.deepEqual(await leftInCustody(setup, connectionRef), []);
    const record = (await setup.ports.connections.get(
      setup.person,
      connectionRef,
    ))!.record;
    assert.equal(record.state["pendingSession"], null);
    assert.deepEqual(record.state["droppedCredentials"], [waiting]);
  });
}
