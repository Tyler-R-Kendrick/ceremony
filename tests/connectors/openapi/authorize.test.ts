import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  ConnectorAdapterRegistry,
  type RuntimeBinding,
} from "../../../src/server/connectors/index.js";
import { CONNECTOR_CALLBACK_PATH } from "../../../src/server/connectors/commands/service.js";
import {
  compileOperations,
  createOpenApiHttpAdapter,
  isReadResult,
  readOpenApi,
} from "../../../src/server/connectors/formats/openapi/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  startAuthorizationServer,
  type AuthorizationServerOptions,
} from "../doubles/authorization-server.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import { createHarness, human, ORIGIN, TENANT } from "../commands/harness.js";
import { loopbackDestination } from "./helpers.js";

/*
 * An imported OpenAPI description, approved into a binding, connected by a
 * person and invoked -- through the real command service, against a real
 * fixture authorization server and a protected API that asks that server
 * whether the bearer it received is live. Nothing here fabricates a token or
 * a callback: every credential came out of the fixture's token endpoint, and
 * every callback URL is the one the fixture redirected to.
 *
 * The same run checks the other half of the contract: the access and refresh
 * tokens custody holds never appear in a view, an invocation result, the
 * connection record, the effect journal or a handoff summary.
 */

type Flow = "authorizationCode" | "deviceAuthorization" | "clientCredentials";

function description(flow: Flow, extra: { refreshUrl?: boolean } = {}) {
  const flows: Record<string, unknown> = {
    authorizationCode: {
      authorizationUrl: "https://declared.example.test/authorize",
      tokenUrl: "https://declared.example.test/token",
      ...(extra.refreshUrl
        ? { refreshUrl: "https://declared.example.test/token" }
        : {}),
      scopes: { "items:read": "Read items", "items:write": "Write items" },
    },
    deviceAuthorization: {
      deviceAuthorizationUrl: "https://declared.example.test/device",
      tokenUrl: "https://declared.example.test/token",
      scopes: { "items:read": "Read items" },
    },
    clientCredentials: {
      tokenUrl: "https://declared.example.test/token",
      scopes: { "items:read": "Read items" },
    },
  };
  return {
    openapi: flow === "deviceAuthorization" ? "3.2.0" : "3.1.0",
    info: { title: "Items", version: "1.0.0" },
    servers: [{ url: "https://items.example.test/v1" }],
    components: {
      securitySchemes: {
        oauth: { type: "oauth2", flows: { [flow]: flows[flow] } },
      },
    },
    security: [{ oauth: ["items:read"] }],
    paths: {
      "/items": {
        get: {
          operationId: "listItems",
          responses: {
            "200": {
              description: "Items",
              content: {
                "application/json": {
                  schema: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  };
}

const apiKeyDescription = {
  openapi: "3.1.0",
  info: { title: "Keyed", version: "1.0.0" },
  servers: [{ url: "https://keyed.example.test/v1" }],
  components: {
    securitySchemes: {
      key: { type: "apiKey", name: "X-Api-Key", in: "header" },
    },
  },
  security: [{ key: [] }],
  paths: {
    "/items": {
      get: {
        operationId: "listItems",
        responses: {
          "200": {
            description: "Items",
            content: {
              "application/json": {
                schema: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
  },
};

type Setup = Awaited<ReturnType<typeof setup>>;

async function setup(
  t: TestContext,
  input: {
    document: unknown;
    server?: AuthorizationServerOptions;
    policy?: Record<string, unknown> | false;
    configuration?: Record<string, string>;
    /** How the protected API answers; defaults to checking the bearer with the fixture issuer. */
    api?: "introspect" | "always-401" | "api-key";
  },
) {
  let clock = Date.parse("2026-09-23T12:00:00.000Z");
  const now = () => clock;
  const as = await startAuthorizationServer({
    clientId: "items-client",
    redirectUris: [`${ORIGIN}${CONNECTOR_CALLBACK_PATH}`],
    now,
    ...input.server,
  });
  t.after(() => as.close());
  const mode = input.api ?? "introspect";
  const api = await startHttpFixture((request) => {
    if (mode === "api-key")
      return request.headers["x-api-key"] === "key-9f3c-live"
        ? { status: 200, body: ["one", "two"] }
        : { status: 401, body: { error: "unauthorized" } };
    const header = request.headers["authorization"] ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (mode === "always-401" || !as.accessTokenActive(token))
      return { status: 401, body: { error: "invalid_token" } };
    return { status: 200, body: ["one", "two"] };
  });
  t.after(() => api.close());

  const registry = new ConnectorAdapterRegistry();
  registry.register(createOpenApiHttpAdapter());
  const harness = await createHarness({ now, service: { registry } });
  t.after(() => harness.close());

  const read = await readOpenApi(input.document);
  assert.ok(isReadResult(read), "the description reads");
  const destination = loopbackDestination(api.origin, "api");
  const compiled = compileOperations(read.definition, read, {
    destinationId: destination.id,
    destination,
  });
  const operation = compiled.operations.find(
    (item) => item.nativeId === "listItems",
  );
  assert.ok(operation, "listItems compiled");
  const policy =
    input.policy === false
      ? undefined
      : {
          issuer: as.issuer,
          allowLoopbackHttp: true,
          registration: {
            allowed: ["pre-registered"],
            clientIdConfiguration: "ITEMS_CLIENT_ID",
            ...(input.server?.clientSecret
              ? { clientSecretConfiguration: "ITEMS_CLIENT_SECRET" }
              : {}),
          },
          ...input.policy,
        };
  const binding: RuntimeBinding = {
    bindingRef: "binding:items",
    definitionRef: read.definition.definitionRef,
    revision: 1,
    adapterId: "openapi-http",
    adapterVersion: "1.0.0",
    runtime: "hosted-server",
    custody: "host-owned",
    authorityInstance: api.origin,
    status: "approved",
    approvedAt: "2026-09-23T00:00:00.000Z",
    policyRevision: harness.policy.revision,
    tenantId: TENANT,
    destinations: [destination],
    operations: compiled.operations,
    configuration: [],
    permittedTargets: [],
    reviewedDigest: "b".repeat(64),
    settings: {
      ...compiled.settings,
      "openapi-http-profiles": read.definition.authentication,
      ...(policy ? { oauth: policy } : {}),
    },
  };
  await harness.definitions.putDefinition(TENANT, read.definition);
  await harness.definitions.putBinding(binding);
  const actor = human();
  for (const [name, value] of Object.entries(
    input.configuration ?? { ITEMS_CLIENT_ID: "items-client" },
  ))
    harness.setConfiguration(actor, name, value);
  return {
    as,
    api,
    harness,
    actor,
    binding,
    operationRef: operation.operationRef,
    advance(ms: number) {
      clock += ms;
    },
  };
}

/** The last outcome a person's view carries; an agent's projection has none. */
function outcome(view: object): string | undefined {
  return (view as { lastOutcome?: string }).lastOutcome;
}

/** Every secret custody holds for any connection, for canary checks. */
function heldSecrets(state: Setup): string[] {
  const secrets: string[] = [];
  for (const ref of state.harness.ports.inspect.credentialRefs()) {
    const material = state.harness.ports.inspect.credentialMaterial(ref) ?? {};
    // The token type ("bearer") names a scheme, not a secret.
    for (const [name, value] of Object.entries(material))
      if (
        /token|apiKey|password|secret/i.test(name) &&
        name !== "token_type" &&
        value
      )
        secrets.push(value);
  }
  return secrets;
}

function assertNoSecrets(
  state: Setup,
  seen: string[],
  label: string,
  ...values: unknown[]
): void {
  const everything = JSON.stringify([
    values,
    state.harness.ports.inspect.connections(),
    state.harness.ports.inspect.effects(),
    state.harness.ports.inspect
      .handoffs()
      .map(({ private: _private, ...summary }) => summary),
  ]);
  const secrets = new Set([...seen, ...heldSecrets(state)]);
  assert.ok(secrets.size > 0, `${label}: the canary has something to look for`);
  for (const secret of secrets)
    assert.ok(!everything.includes(secret), `${label}: a secret leaked`);
}

async function connectWithBrowser(state: Setup) {
  const started = await state.harness.service.connect(state.actor, {
    bindingRef: state.binding.bindingRef,
  });
  assert.equal(started.lifecycle, "authorization-required");
  const url = (started as { presentation?: { url?: string } }).presentation
    ?.url;
  assert.ok(url, "the person is shown where to authorize");
  assert.equal(new URL(url).origin, state.as.origin);
  const callback = await state.as.authorize(url);
  const done = await state.harness.service.callback(
    state.actor,
    new URL(callback),
  );
  return { started, done };
}

test("authorization code: connect, callback and invoke present the issued bearer, and no token reaches a result or record", async (t) => {
  const state = await setup(t, { document: description("authorizationCode") });
  const { started, done } = await connectWithBrowser(state);
  assert.equal(done.lifecycle, "active");
  assert.equal(outcome(done), "authorization.complete");
  // The declared endpoints in the description were never contacted.
  assert.equal(state.as.counts.token, 1);
  const tokenRequest = state.as.tokenRequests[0]!;
  assert.equal(tokenRequest.grantType, "authorization_code");
  assert.ok(tokenRequest.parameters["code_verifier"]);

  const result = await state.harness.service.invoke(
    state.actor,
    done.connectionRef,
    { operationRef: state.operationRef, commandId: "list-1", confirm: true },
  );
  assert.equal(result.state, "complete");
  assert.deepEqual(result.output, ["one", "two"]);
  const [call] = state.api.requests;
  assert.ok(call?.headers["authorization"]?.startsWith("Bearer "));
  const presented = call!.headers["authorization"]!.slice(7);
  assert.ok(state.as.accessTokenActive(presented));
  assertNoSecrets(
    state,
    [presented],
    "authorization code",
    started,
    done,
    result,
  );
});

test("an expired token is refreshed once and the call proceeds, even when two calls find it expired together", async (t) => {
  const state = await setup(t, {
    document: description("authorizationCode", { refreshUrl: true }),
  });
  const { done } = await connectWithBrowser(state);
  state.advance(3_601_000);
  const [first, second] = await Promise.all([
    state.harness.service.invoke(state.actor, done.connectionRef, {
      operationRef: state.operationRef,
      commandId: "after-expiry-1",
      confirm: true,
    }),
    state.harness.service.invoke(state.actor, done.connectionRef, {
      operationRef: state.operationRef,
      commandId: "after-expiry-2",
      confirm: true,
    }),
  ]);
  assert.equal(first.state, "complete");
  assert.equal(second.state, "complete");
  const refreshes = state.as.tokenRequests.filter(
    (request) => request.grantType === "refresh_token",
  );
  assert.equal(refreshes.length, 1, "one refresh for both calls");
  // Custody refused the stale token before anything was sent: the API saw
  // only the two calls made with the renewed one.
  assert.equal(state.api.requests.length, 2);
  for (const request of state.api.requests)
    assert.ok(
      state.as.accessTokenActive(request.headers["authorization"]!.slice(7)),
    );
  assertNoSecrets(state, [], "refresh", first, second);
});

test("a 401 to a live-looking token triggers one refresh and one retry, journaled as two attempts", async (t) => {
  const state = await setup(t, { document: description("authorizationCode") });
  const { done } = await connectWithBrowser(state);
  const first = await state.harness.service.invoke(
    state.actor,
    done.connectionRef,
    {
      operationRef: state.operationRef,
      commandId: "before-revocation",
      confirm: true,
    },
  );
  assert.equal(first.state, "complete");
  const revoked = state.api.requests[0]!.headers["authorization"]!.slice(7);
  state.as.revokeAccessToken(revoked);

  const result = await state.harness.service.invoke(
    state.actor,
    done.connectionRef,
    {
      operationRef: state.operationRef,
      commandId: "after-revocation",
      confirm: true,
    },
  );
  assert.equal(result.state, "complete");
  assert.deepEqual(result.output, ["one", "two"]);
  assert.equal(state.api.requests.length, 3, "one refused call, one retry");
  assert.equal(
    state.as.tokenRequests.filter((r) => r.grantType === "refresh_token")
      .length,
    1,
  );
  const attempts = state.harness.ports.inspect
    .effects()
    .filter((entry) => entry.intent.operation === state.operationRef)
    .map((entry) => entry.outcome?.status);
  // Identical reads share one journal entry (read-only replay), so the first
  // call and the refused one are the same entry, now recorded as refused; the
  // retry after renewal is an entry of its own.
  assert.deepEqual(attempts, ["not-applied", "applied"]);
  assertNoSecrets(state, [revoked], "401 retry", result);
});

test("a 401 that a renewal does not cure is reported once, not retried in a loop", async (t) => {
  const state = await setup(t, {
    document: description("authorizationCode"),
    api: "always-401",
  });
  const { done } = await connectWithBrowser(state);
  const result = await state.harness.service.invoke(
    state.actor,
    done.connectionRef,
    {
      operationRef: state.operationRef,
      commandId: "always-refused",
      confirm: true,
    },
  );
  assert.equal(result.state, "failed");
  assert.equal(result.code, "upstream-rejected");
  assert.equal(state.api.requests.length, 2, "the first call and one retry");
  assert.equal(
    state.as.tokenRequests.filter((r) => r.grantType === "refresh_token")
      .length,
    1,
  );
});

test("a refused token with no way to renew it returns the refusal and asks nothing of the issuer", async (t) => {
  const state = await setup(t, {
    document: description("deviceAuthorization"),
    server: { deviceFlow: true },
    api: "always-401",
  });
  const started = await state.harness.service.connect(state.actor, {
    bindingRef: state.binding.bindingRef,
  });
  const presentation = (
    started as { presentation?: { url?: string; userCode?: string } }
  ).presentation;
  assert.ok(presentation?.userCode);
  assert.ok(state.as.approveDevice(presentation.userCode));
  const done = await state.harness.service.poll(
    state.actor,
    started.connectionRef,
  );
  assert.equal(done.lifecycle, "active");
  const tokenCalls = state.as.counts.token;
  // The device grant here issued no refresh token: nothing to renew with.
  const result = await state.harness.service.invoke(
    state.actor,
    done.connectionRef,
    {
      operationRef: state.operationRef,
      commandId: "no-refresh",
      confirm: true,
    },
  );
  assert.equal(result.state, "failed");
  assert.equal(result.code, "upstream-rejected");
  assert.equal(state.api.requests.length, 1);
  assert.equal(state.as.counts.token, tokenCalls);
});

test("device authorization: a slow_down interval survives between polls, then the approved grant is used", async (t) => {
  const state = await setup(t, {
    document: description("deviceAuthorization"),
    server: { deviceFlow: true, misbehave: { slowDown: 1 } },
  });
  const started = await state.harness.service.connect(state.actor, {
    bindingRef: state.binding.bindingRef,
  });
  assert.equal(started.handoff?.kind, "device-code");
  const presentation = (
    started as { presentation?: { url?: string; userCode?: string } }
  ).presentation;
  assert.ok(presentation?.userCode, "the person sees the user code");
  assert.ok(presentation?.url?.startsWith(state.as.origin));
  assert.ok(state.as.approveDevice(presentation.userCode));

  const slowed = await state.harness.service.poll(
    state.actor,
    started.connectionRef,
  );
  assert.equal(outcome(slowed), "oauth.device.slow-down");
  assert.equal(state.as.counts.deviceToken, 1);
  // Polling again at once is answered locally: the grown interval was kept.
  const waited = await state.harness.service.poll(
    state.actor,
    started.connectionRef,
  );
  assert.equal(outcome(waited), "oauth.device.wait");
  assert.equal(state.as.counts.deviceToken, 1);

  state.advance(6_000);
  const done = await state.harness.service.poll(
    state.actor,
    started.connectionRef,
  );
  assert.equal(done.lifecycle, "active");
  const result = await state.harness.service.invoke(
    state.actor,
    done.connectionRef,
    {
      operationRef: state.operationRef,
      commandId: "device-list",
      confirm: true,
    },
  );
  assert.equal(result.state, "complete");
  assertNoSecrets(state, [], "device", started, slowed, waited, done, result);
});

test("client credentials: connect binds a token with no handoff, and an expired one is re-granted", async (t) => {
  const state = await setup(t, {
    document: description("clientCredentials"),
    server: { clientCredentials: true, clientSecret: "items-secret-4b1d" },
    configuration: {
      ITEMS_CLIENT_ID: "items-client",
      ITEMS_CLIENT_SECRET: "items-secret-4b1d",
    },
  });
  const done = await state.harness.service.connect(state.actor, {
    bindingRef: state.binding.bindingRef,
  });
  assert.equal(done.lifecycle, "active");
  assert.equal(done.handoff, undefined);
  const grants = () =>
    state.as.tokenRequests.filter((r) => r.grantType === "client_credentials");
  assert.equal(grants().length, 1);
  assert.equal(grants()[0]!.parameters["scope"], "items:read");
  assert.ok(grants()[0]!.authorization?.startsWith("Basic "));

  const first = await state.harness.service.invoke(
    state.actor,
    done.connectionRef,
    { operationRef: state.operationRef, commandId: "cc-1", confirm: true },
  );
  assert.equal(first.state, "complete");
  state.advance(3_601_000);
  const second = await state.harness.service.invoke(
    state.actor,
    done.connectionRef,
    { operationRef: state.operationRef, commandId: "cc-2", confirm: true },
  );
  assert.equal(second.state, "complete");
  assert.equal(grants().length, 2, "expiry re-ran the grant once");
  assertNoSecrets(
    state,
    ["items-secret-4b1d"],
    "client credentials",
    done,
    first,
    second,
  );
});

test("client credentials are refused for a public client before anything is sent", async (t) => {
  const state = await setup(t, {
    document: description("clientCredentials"),
    server: { clientCredentials: true },
  });
  await assert.rejects(
    state.harness.service.connect(state.actor, {
      bindingRef: state.binding.bindingRef,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "configuration-required" &&
      error.detail === "oauth.client-credentials.public-client",
  );
  assert.equal(state.as.counts.token, 0);
});

test("an OAuth profile without a host issuer policy is refused rather than calling the declared endpoints", async (t) => {
  const state = await setup(t, {
    document: description("authorizationCode"),
    policy: false,
  });
  await assert.rejects(
    state.harness.service.connect(state.actor, {
      bindingRef: state.binding.bindingRef,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "unsupported" &&
      error.detail === "openapi.oauth-policy-missing",
  );
  assert.equal(state.as.counts.metadata, 0);
});

test("a missing client id is reported as configuration by name, not as a failure", async (t) => {
  const state = await setup(t, {
    document: description("authorizationCode"),
    configuration: {},
  });
  const view = await state.harness.service.connect(state.actor, {
    bindingRef: state.binding.bindingRef,
  });
  assert.equal(view.lifecycle, "configuration-required");
  assert.equal(outcome(view), "configuration.missing");
});

test("an API key is entered privately, held in custody and placed where the profile says", async (t) => {
  const state = await setup(t, {
    document: apiKeyDescription,
    policy: false,
    api: "api-key",
  });
  const started = await state.harness.service.connect(state.actor, {
    bindingRef: state.binding.bindingRef,
  });
  assert.equal(started.lifecycle, "human-required");
  assert.equal(started.handoff?.kind, "input-required");
  assert.match(
    (started as { presentation?: { instructions?: string } }).presentation
      ?.instructions ?? "",
    /API key/,
  );
  const handoffRef = (started.handoff as { handoffRef: string }).handoffRef;
  await assert.rejects(
    state.harness.service.provideInput(
      state.actor,
      started.connectionRef,
      handoffRef,
      { apiKey: "key-9f3c-live", header: "X-Other" },
    ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "openapi.credential-fields",
  );
  const done = await state.harness.service.provideInput(
    state.actor,
    started.connectionRef,
    handoffRef,
    { apiKey: "key-9f3c-live" },
  );
  assert.equal(done.lifecycle, "active");
  const result = await state.harness.service.invoke(
    state.actor,
    done.connectionRef,
    { operationRef: state.operationRef, commandId: "keyed-1", confirm: true },
  );
  assert.equal(result.state, "complete");
  assert.equal(state.api.requests[0]?.headers["x-api-key"], "key-9f3c-live");
  assertNoSecrets(state, ["key-9f3c-live"], "api key", started, done, result);
});

test("capabilities describe authorize by profile kind and name what is unsupported", () => {
  const rows = createOpenApiHttpAdapter().capabilities(new Set());
  const authorize = rows.find((row) => row.dimension === "authorize");
  assert.equal(authorize?.implementation, "implemented");
  const text = authorize?.limitations.join(" ") ?? "";
  for (const phrase of [
    "authorization code",
    "device",
    "client-credentials",
    "API key",
    "not supported",
  ])
    assert.ok(text.includes(phrase), phrase);
});
