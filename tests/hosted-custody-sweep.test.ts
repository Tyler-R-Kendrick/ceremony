import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { createConnectorPorts } from "../src/server/connectors/state/index.js";
import { dispatchHostedTenants } from "../src/server/hosted/continuations.js";
import { hostedHttp } from "../src/server/hosted/http.js";
import {
  createHostedRuntime,
  type HostedRuntime,
} from "../src/server/hosted/runtime.js";
import { hostedWorker } from "../src/server/hosted/worker.js";
import {
  connectionRecord,
  credentialScope,
} from "./connectors/fixtures/state/records.js";
import { postgresFixture } from "./fixtures/postgres.js";
import { teachingIdentityFixture } from "./fixtures/teaching-identity.js";

/*
 * The custody-drop sweep runs where the hosted deployment's other scheduled
 * work runs: the mounted dispatcher (`GET /api/internal/continuations`, which
 * the operator's scheduler calls with the cron secret) sweeps every tenant it
 * drains. A drop a connection noted and that never happened is made by the
 * next scheduled call, without an operator running the maintenance command;
 * what no connection noted stays.
 */

let database: Awaited<ReturnType<typeof postgresFixture>>;
let provider: Awaited<ReturnType<typeof teachingIdentityFixture>>;
let runtime: HostedRuntime;
const origin = "http://127.0.0.1:4198";
const TENANT = "tenant";
const secret = randomBytes(32).toString("hex");

before(async () => {
  database = await postgresFixture();
  provider = await teachingIdentityFixture();
  const cfg = database.config;
  runtime = await createHostedRuntime({
    NODE_ENV: "test",
    CEREMONY_TEST_PROFILE: "true",
    CEREMONY_PUBLIC_ORIGIN: origin,
    CEREMONY_DATABASE_URL: `postgresql://${cfg.user}:${cfg.password}@${cfg.host}:${cfg.port}/${cfg.database}`,
    CEREMONY_VAULT_KEY: randomBytes(32).toString("hex"),
    CEREMONY_VAULT_KEY_ID: "test",
    CEREMONY_OIDC_ISSUER: provider.issuer,
    CEREMONY_OIDC_CLIENT_ID: "client",
    CEREMONY_CONFIGURATION_VERSION: "v1",
    CEREMONY_TENANT_ID: TENANT,
  });
});
after(async () => {
  await runtime?.store.close();
  await provider?.close();
  await database?.close();
});

const scheduledCall = (authorization: string) =>
  hostedHttp(
    new Request(`${origin}/api/internal/continuations`, {
      headers: { authorization },
    }),
    runtime,
    async () => {},
    hostedWorker(runtime, secret),
    undefined,
    runtime.hosted.connectors?.runtime.http,
  );

test("the scheduled dispatcher makes the custody drops a connection noted, and only those", async () => {
  const ports = createConnectorPorts(runtime.store);
  const record = connectionRecord({ tenantId: TENANT });
  const scope = credentialScope(TENANT, {
    connectionRef: record.connectionRef,
  });
  const noted = await ports.credentials.store(scope, {
    token: "vtok_dummy_marker_0123456789abcdef",
  });
  const kept = await ports.credentials.store(scope, {
    signingKey: "vtok_dummy_marker_fedcba9876543210",
  });
  await ports.connections.create({
    ...record,
    state: { droppedCredentials: [noted] },
  });

  // Not the scheduler: refused, and nothing is swept.
  const refused = await scheduledCall("Bearer not-the-cron-secret");
  assert.notEqual(refused.status, 200);
  assert.ok(await ports.credentials.describe(scope, noted));

  const scheduled = await scheduledCall(`Bearer ${secret}`);
  assert.equal(scheduled.status, 200);
  assert.deepEqual(
    await scheduled.json(),
    { dispatched: true, sweep: { swept: 1, failed: 0, incomplete: 0 } },
    "the answer says what the sweep did, in counts",
  );
  assert.equal(
    await ports.credentials.describe(scope, noted),
    undefined,
    "the scheduled call made the noted drop",
  );
  assert.ok(
    await ports.credentials.describe(scope, kept),
    "a record no connection noted stays",
  );
});

test("one tenant's failed sweep is reported after every tenant had its turn", async () => {
  const swept: string[] = [];
  await assert.rejects(
    dispatchHostedTenants(
      runtime,
      { tenants: async () => ["tenant-a", "tenant-b"] },
      async (tenant) => {
        swept.push(tenant);
        if (tenant === "tenant-a") throw new Error("synthetic outage");
        return { swept: 0, failed: 0 };
      },
    ),
    /dispatch incomplete/,
  );
  assert.deepEqual(swept, ["tenant-a", "tenant-b"]);
});
