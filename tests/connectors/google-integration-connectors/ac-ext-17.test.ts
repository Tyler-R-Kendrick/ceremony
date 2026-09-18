import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  createGoogleConnectorsAdapter,
  googleConnectorsConfigurationNames,
} from "../../../src/server/connectors/providers/google-integration-connectors/index.js";
import { startGoogleConnectorsDouble } from "../doubles/google-connectors.js";
import {
  ACCESS_TOKEN,
  ACTION,
  CONNECTION,
  END_USER_TOKEN,
  ENTITY_TYPE,
  LOCATION,
  PROJECT,
  googleBinding,
  googleConnection,
  googleContext,
  googlePorts,
} from "./support.js";

/*
 * AC-EXT-17 (Google half): "... or Google resource identity substituted ->
 * inbound/outbound identities and resource bounds stay separate."
 *
 * The substitutions a connection is exposed to are the resource name, the
 * identity that calls, and the per-call auth override the connector itself
 * offers. Each has its own assertion below.
 */

const adapter = createGoogleConnectorsAdapter();
const resource = {
  project: PROJECT,
  location: LOCATION,
  connection: CONNECTION,
};

async function withDouble<T>(
  options: Partial<Parameters<typeof startGoogleConnectorsDouble>[0]>,
  work: (
    double: Awaited<ReturnType<typeof startGoogleConnectorsDouble>>,
  ) => Promise<T>,
): Promise<T> {
  const double = await startGoogleConnectorsDouble({
    tokens: [ACCESS_TOKEN, END_USER_TOKEN],
    resource,
    entityTypes: [{ entity: ENTITY_TYPE, operations: ["LIST", "GET"] }],
    actions: [{ action: ACTION }],
    entities: { [ENTITY_TYPE]: [{ id: "001", Name: "Acme" }] },
    ...options,
  });
  try {
    return await work(double);
  } finally {
    await double.close();
  }
}

test("AC-EXT-17: a binding that selects the end user's identity never falls back to the service identity", async () => {
  await withDouble({}, async (double) => {
    /*
     * The service-identity token is configured and would work. The binding
     * selects the end user, and this connection holds no credential, so the
     * call must stop rather than quietly run as the deployment's own identity.
     */
    const ports = googlePorts();
    const ctx = googleContext(
      googleBinding({ origin: double.origin, identity: { kind: "end-user" } }),
      ports,
      { connection: googleConnection() },
    );
    await assert.rejects(
      adapter.invoke!(ctx, {
        operationRef: "operation:accounts.list",
        input: {},
        commandId: "command-identity",
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "configuration-required" &&
        error.detail === "google-connectors.end-user-credential.missing",
    );
    assert.equal(double.requests.length, 0);
  });
});

test("AC-EXT-17: the project, location and connection come from the binding, never from the call", async () => {
  await withDouble({}, async (double) => {
    const ctx = googleContext(
      googleBinding({ origin: double.origin }),
      googlePorts(),
      { connection: googleConnection() },
    );
    for (const input of [
      {
        name: `projects/other/locations/${LOCATION}/connections/${CONNECTION}`,
      },
      { project: "other-project" },
      { location: "europe-west1" },
      { connection: "another-connection" },
    ])
      await assert.rejects(
        adapter.invoke!(ctx, {
          operationRef: "operation:accounts.list",
          input,
          commandId: "command-resource",
        }),
        (error: unknown) =>
          error instanceof ConnectorError &&
          error.code === "denied" &&
          error.detail === "google-connectors.resource.substituted",
        `input ${JSON.stringify(input)} must not select a resource`,
      );
    assert.equal(double.requests.length, 0);
  });
});

test("AC-EXT-17: the connector's own per-call auth override is never exercised by a caller", async () => {
  await withDouble({}, async (double) => {
    const ctx = googleContext(
      googleBinding({ origin: double.origin }),
      googlePorts(),
      { connection: googleConnection() },
    );
    await assert.rejects(
      adapter.invoke!(ctx, {
        operationRef: "operation:sendEmail",
        input: {
          parameters: {},
          executionConfig: {
            headers:
              '{"x-integration-connectors-managed-connection-id":"other-connection"}',
          },
        },
        commandId: "command-override",
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "google-connectors.execution-config.denied",
    );
    const ok = await adapter.invoke!(ctx, {
      operationRef: "operation:sendEmail",
      input: { parameters: { to: "person@example.invalid" } },
      commandId: "command-plain",
    });
    assert.equal(ok.state, "complete");
    for (const request of double.requests) {
      const body = request.body.length
        ? (JSON.parse(request.body.toString("utf8")) as Record<string, unknown>)
        : {};
      assert.ok(
        !("executionConfig" in body),
        "no request ever carries an executionConfig",
      );
    }
  });
});

test("AC-EXT-17: the service identity's token never reaches a call made for the end user", async () => {
  await withDouble({}, async (double) => {
    const ports = googlePorts();
    const connection = googleConnection();
    const credentialRef = await ports.credentials.store(
      {
        tenantId: connection.tenantId,
        ownerKind: connection.ownerKind,
        ownerId: connection.ownerId,
        connectionRef: connection.connectionRef,
        bindingRef: "binding:google-connectors",
        custody: connection.custody,
      },
      { accessToken: END_USER_TOKEN },
    );
    const ctx = googleContext(
      googleBinding({ origin: double.origin, identity: { kind: "end-user" } }),
      ports,
      { connection: { ...connection, credentialRef } },
    );
    const result = await adapter.invoke!(ctx, {
      operationRef: "operation:accounts.list",
      input: {},
      commandId: "command-end-user-only",
    });
    assert.equal(result.state, "complete");
    for (const request of double.requests)
      assert.equal(
        request.headers["authorization"],
        `Bearer ${END_USER_TOKEN}`,
        "the deployment's own token is not substituted for the user's",
      );
  });
});
