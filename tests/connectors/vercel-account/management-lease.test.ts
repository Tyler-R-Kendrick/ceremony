import assert from "node:assert/strict";
import test from "node:test";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import {
  connectionLifecycles,
  type ConnectionLifecycle,
} from "../../../src/core/connectors/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  createVercelConnectAdapter,
  resolveCredential,
  vercelOperationRef,
  type ManagementLease,
} from "../../../src/server/connectors/providers/vercel/index.js";
import { accountManagementSource } from "../../../src/server/connectors/providers/vercel-account/index.js";
import {
  bearerOf,
  CONFIGURED_TOKEN,
  list,
  rig,
  settings,
} from "./management-rig.js";

/*
 * A person who signed in to act as themselves is never silently replaced by
 * the organisation's token. Whatever state their sign-in is in, the answer is
 * a refusal that says what to do; the configured team token serves only a
 * person for whom the host found no sign-in at all. And the lease the Connect
 * provider reads is checked against the caller wherever it came from, not
 * only by the one factory the account adapter ships.
 */

type Rigged = Awaited<ReturnType<typeof rig>>;

/** The host's lookup finds the person's connection, in the state given. */
async function withLifecycle(
  rigged: Rigged,
  lifecycle: ConnectionLifecycle,
  options: { holdsNoCredential?: boolean } = {},
) {
  const { credentialRef: _held, ...rest } = rigged.accountCtx.connection!;
  void _held;
  const connection = {
    ...(options.holdsNoCredential
      ? rest
      : {
          ...rest,
          credentialRef: rigged.accountCtx.connection!.credentialRef,
        }),
    lifecycle,
  } as NonNullable<AdapterCallContext["connection"]>;
  const source = accountManagementSource({
    account: async () => ({ ...rigged.accountCtx, connection }),
  });
  return createVercelConnectAdapter({ managementToken: source });
}

const answers: Record<ConnectionLifecycle, string> = {
  "configuration-required": "human-required",
  "authorization-required": "human-required",
  "human-required": "human-required",
  verifying: "conflict",
  active: "n/a",
  degraded: "conflict",
  expired: "expired",
  "reconnect-required": "human-required",
  "locally-disconnected": "human-required",
  "upstream-revoked": "human-required",
  indeterminate: "conflict",
};

for (const lifecycle of connectionLifecycles.filter((l) => l !== "active"))
  test(`a sign-in that is ${lifecycle} is refused, and the configured team token does not take over`, async (t) => {
    const rigged = await rig(t, { configured: true });
    const adapter = await withLifecycle(rigged, lifecycle);
    await assert.rejects(
      adapter.invoke!(rigged.connectCtx(), {
        operationRef: vercelOperationRef("connect.connectors.list"),
        input: {},
        commandId: `lifecycle-${lifecycle}`,
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === answers[lifecycle] &&
        error.detail?.startsWith("vercel-account.management.") === true,
    );
    assert.equal(
      rigged.connect.calls.length,
      0,
      `nothing reached Vercel Connect, so ${CONFIGURED_TOKEN} was not sent`,
    );
  });

test("an active sign-in with no credential held is refused the same way", async (t) => {
  const rigged = await rig(t, { configured: true });
  const adapter = await withLifecycle(rigged, "active", {
    holdsNoCredential: true,
  });
  await assert.rejects(
    adapter.invoke!(rigged.connectCtx(), {
      operationRef: vercelOperationRef("connect.connectors.list"),
      input: {},
      commandId: "no-credential",
    }),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "human-required",
  );
  assert.equal(rigged.connect.calls.length, 0);
});

test("a sign-in that works is used, and a person with no sign-in at all is served by the configured token", async (t) => {
  const signedIn = await rig(t, { configured: true });
  assert.equal((await list(signedIn)).state, "complete");
  const held = await signedIn.setup.heldMaterial(signedIn.connectionRef);
  assert.equal(
    bearerOf(signedIn.connect.routed("connect.connectors.list")[0]!),
    held["access_token"],
  );
  const stranger = await rig(t, { configured: true, account: "none" });
  assert.equal((await list(stranger)).state, "complete");
  assert.equal(
    bearerOf(stranger.connect.routed("connect.connectors.list")[0]!),
    CONFIGURED_TOKEN,
  );
});

/*
 * The seam, not the factory. A host may write its own ManagementTokenSource;
 * whatever lease it returns is checked against the calling person before any
 * bearer is read.
 */

async function leaseOf(rigged: Rigged): Promise<ManagementLease> {
  const source = accountManagementSource({
    account: async () => rigged.accountCtx,
  });
  const lease = await source(rigged.connectCtx());
  assert.ok(lease, "the person's own sign-in yields a lease");
  return lease;
}

const lease = (
  rigged: Rigged,
  change: (l: ManagementLease) => ManagementLease,
) => leaseOf(rigged).then(change);

test("a hand-written source returning another person's lease is refused", async (t) => {
  const rigged = await rig(t, { configured: true });
  const theirs = await leaseOf(rigged);
  const caller = {
    ...rigged.connectCtx(),
    actor: { ...rigged.setup.person, subjectId: "someone-else" },
  };
  await assert.rejects(
    resolveCredential(caller, "management", settings, {
      managementToken: async () => theirs,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "vercel.management.lease-not-owner",
  );
  const adapter = createVercelConnectAdapter({
    managementToken: async () => theirs,
  });
  await assert.rejects(
    adapter.invoke!(caller, {
      operationRef: vercelOperationRef("connect.connectors.list"),
      input: {},
      commandId: "borrowed",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "vercel.management.lease-not-owner",
  );
  assert.equal(rigged.connect.calls.length, 0);
});

test("a lease from another tenant, or held by an organisation, is refused whoever supplied it", async (t) => {
  const rigged = await rig(t, { configured: true });
  const ctx = rigged.connectCtx();
  const foreignTenant = await lease(rigged, (l) => ({
    ...l,
    scope: { ...l.scope, tenantId: "tenant-elsewhere" },
  }));
  const organisation = await lease(rigged, (l) => ({
    ...l,
    scope: { ...l.scope, ownerKind: "organization" },
  }));
  for (const bad of [foreignTenant, organisation])
    await assert.rejects(
      resolveCredential({ ...ctx }, "management", settings, {
        managementToken: async () => bad,
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "vercel.management.lease-not-owner",
    );
  assert.equal(rigged.connect.calls.length, 0);
});

test("the person's own lease still resolves through a hand-written source", async (t) => {
  const rigged = await rig(t);
  const own = await leaseOf(rigged);
  const credential = await resolveCredential(
    rigged.connectCtx(),
    "management",
    settings,
    { managementToken: async () => own },
  );
  assert.equal(credential.ref, own.ref);
});
