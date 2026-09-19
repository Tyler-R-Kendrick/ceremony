import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createWorkOsPipesAdapter } from "../../../src/server/connectors/providers/workos/index.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import { canaryValues } from "../fixtures/builders.js";
import {
  API_KEY,
  ORGANIZATION_ID,
  PROVIDER,
  USER_ID,
  connectionRecord,
  credentialBinding,
  defaultPrincipals,
  harness,
  principalPort,
  relayBinding,
} from "./support.js";

/*
 * IB-05, WorkOS half: the recorded documented payloads are replayed verbatim
 * from `tests/connectors/fixtures/workos/`, so the adapter is exercised
 * against what WorkOS publishes rather than against a shape this repository
 * invented. The recordings carry canary values in every field that must not
 * reach a caller.
 */

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../fixtures/workos/${name}`, import.meta.url)),
      "utf8",
    ),
  ) as Record<string, unknown>;

const adapter = () =>
  createWorkOsPipesAdapter({ principals: principalPort(defaultPrincipals()) });

/** Serves one recorded body for every request; the adapter still has to ask correctly. */
async function replay(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return startHttpFixture((request) => {
    if (request.headers.authorization !== `Bearer ${API_KEY}`)
      return { status: 401, body: { code: "unauthorized" } };
    return {
      status: init.status ?? 200,
      ...(init.headers ? { headers: init.headers } : {}),
      body: body as Record<string, unknown>,
    };
  });
}

test("WorkOS documented active token response: the token reaches custody and nothing else", async () => {
  const recorded = fixture("vend-active.json");
  const server = await replay(recorded);
  const binding = credentialBinding(server.origin);
  const app = harness({ binding });
  const connection = connectionRecord(binding);
  const result = await adapter().invoke!(app.context({ connection }), {
    operationRef: "operation:workos.credential",
    input: {},
    commandId: "command:fixture",
  });
  assert.equal(result.state, "complete");
  const serialized = JSON.stringify(result);
  for (const canary of canaryValues)
    assert.equal(serialized.includes(canary), false, canary);
  const output = result.output as Record<string, unknown>;
  assert.deepEqual(output.scopes, ["repo", "user:email"]);
  assert.deepEqual(output.missingScopes, ["admin:org"]);
  // The credential itself is in custody, under the broker custody kind.
  const described = await app.ports.credentials.describe(
    {
      tenantId: binding.tenantId,
      ownerKind: connection.ownerKind,
      ownerId: connection.ownerId,
      connectionRef: connection.connectionRef,
      bindingRef: binding.bindingRef,
      custody: "external-credential-broker",
    },
    String(output.credentialRef),
  );
  assert.equal(described?.custody, "external-credential-broker");
  await server.close();
});

test("WorkOS documented inactive responses each map to participation, including an unknown reason", async () => {
  const recorded = fixture("vend-inactive.json");
  const expected: Record<string, [string, string]> = {
    not_installed: ["human-required", "workos.not-installed"],
    needs_reauthorization: ["human-required", "workos.needs-reauthorization"],
    account_selection_required: ["denied", "workos.account-selection-required"],
    // WorkOS documents that new error values may appear and must be handled
    // gracefully: an unknown reason is still not a credential.
    unknown_future_reason: ["human-required", "workos.inactive"],
  };
  for (const [name, [state, code]] of Object.entries(expected)) {
    const server = await replay(recorded[name]);
    const binding = credentialBinding(server.origin);
    const app = harness({ binding });
    const result = await adapter().invoke!(
      app.context({ connection: connectionRecord(binding) }),
      {
        operationRef: "operation:workos.credential",
        input: {},
        commandId: `command:${name}`,
      },
    );
    assert.equal(result.state, state, name);
    assert.equal(result.code, code, name);
    assert.deepEqual(app.ports.inspect.credentialRefs(), [], name);
    await server.close();
  }
});

test("WorkOS documented relay 402 keeps its authorization URL inside the private handoff", async () => {
  const recorded = fixture("relay-authorization-required.json");
  const server = await replay(recorded, { status: 402 });
  const binding = relayBinding(server.origin);
  const app = harness({ binding });
  const result = await adapter().invoke!(
    app.context({ connection: connectionRecord(binding) }),
    {
      operationRef: "operation:listRepositories",
      input: {},
      commandId: "command:402",
    },
  );
  assert.equal(result.state, "human-required");
  assert.equal(result.code, "workos.relay.authorization-required");
  assert.ok(result.handoff);
  // The link, with the state the provider embedded in it, is private material.
  assert.ok(String(result.handoff.private.url).includes("CANARY_SECRET_9f3"));
  const withoutPrivate = JSON.stringify({
    ...result,
    handoff: { ...result.handoff, private: undefined },
  });
  for (const canary of canaryValues)
    assert.equal(withoutPrivate.includes(canary), false, canary);
  await server.close();
});

test("WorkOS refuses an organization-owned account returned on a user lookup", async () => {
  const recorded = fixture("connected-account-organization.json");
  const server = await replay(recorded);
  const binding = credentialBinding(server.origin);
  const app = harness({ binding });
  // The host resolved this actor as themselves; WorkOS answered with the
  // organization's shared connection. A shared grant is not this person's.
  const result = await adapter().verify!(
    app.context({ connection: connectionRecord(binding) }),
  );
  assert.equal(result.state, "denied");
  assert.equal(result.code, "workos.owner-mismatch");
  assert.deepEqual(result.claims, []);

  // Asked for as the organization's, with host policy permitting it, the same
  // record verifies — the difference is the authority, not the payload.
  const organization = await adapter().verify!(
    app.context({
      connection: connectionRecord(binding, {
        ownerKind: "organization",
        ownerId: ORGANIZATION_ID,
      }),
    }),
  );
  assert.equal(organization.state, "complete");
  assert.equal(organization.externalIds?.workosOrganizationId, ORGANIZATION_ID);
  assert.equal(organization.externalIds?.workosUserId, USER_ID);
  assert.equal(organization.target?.id, "acme-workspace");
  await server.close();
});

test("WorkOS provider fixtures stay in their own directory", async () => {
  // A cheap guard against fixtures migrating between providers: every recorded
  // body here names the WorkOS documentation it came from.
  for (const name of [
    "vend-active.json",
    "vend-inactive.json",
    "relay-authorization-required.json",
    "connected-account-organization.json",
  ]) {
    const recorded = fixture(name);
    assert.match(String(recorded._source), /workos\.com\/docs/);
    assert.match(String(recorded._source), /retrieved 2026-09-18/);
  }
  assert.equal(PROVIDER, "github");
});
