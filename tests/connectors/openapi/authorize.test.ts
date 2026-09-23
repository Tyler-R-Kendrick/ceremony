import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  ConnectorAdapterRegistry,
  type RuntimeBinding,
} from "../../../src/server/connectors/index.js";
import { CONNECTOR_CALLBACK_PATH } from "../../../src/server/connectors/commands/service.js";
import { createOpenApiHttpAdapter } from "../../../src/server/connectors/formats/openapi/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  startAuthorizationServer,
  type AuthorizationServerOptions,
} from "../doubles/authorization-server.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import { agent, createHarness, human, ORIGIN } from "../commands/harness.js";

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

/**
 * The reviewed path a deployment takes: the description is imported through
 * the command service, and a person approves a binding naming the destination,
 * the operation and the issuer policy. The adapter compiles the plans from the
 * imported bytes; nothing is written into the store by hand.
 */
async function approveThroughReview(
  harness: Awaited<ReturnType<typeof createHarness>>,
  reviewer: ReturnType<typeof human>,
  input: {
    document: unknown;
    destination: string;
    oauth?: Record<string, unknown>;
    /** Per-profile policies, built from the imported definition's profile ids. */
    oauthProfiles?: (profileIds: string[]) => Record<string, unknown>;
    settings?: Record<string, unknown>;
    verifier?: { nativeId: string };
  },
): Promise<RuntimeBinding> {
  const imported = await harness.service.import(reviewer, {
    kind: "upload",
    mediaType: "application/json",
    text: JSON.stringify(input.document),
    adapterId: "openapi-http",
  });
  const definitionRef = imported.definitions[0];
  assert.ok(definitionRef, "the description imported");
  const definition = await harness.definitions.getDefinition(
    reviewer.tenantId,
    definitionRef,
  );
  assert.ok(definition);
  const reference = await harness.service.approveBinding(reviewer, {
    definitionRef,
    adapterId: "openapi-http",
    approvals: {
      destinations: [input.destination],
      operations: ["listItems"],
      ...(input.oauth ? { oauth: input.oauth } : {}),
      ...(input.oauthProfiles
        ? {
            oauthProfiles: input.oauthProfiles(
              definition.authentication.map((profile) => profile.id),
            ),
          }
        : {}),
      ...(input.settings ? { settings: input.settings } : {}),
      ...(input.verifier ? { verifier: input.verifier } : {}),
    },
  });
  const binding = harness.definitions
    .bindings()
    .find(
      (item) =>
        item.bindingRef === reference.bindingRef &&
        item.revision === reference.revision,
    );
  assert.ok(binding, "the approval persisted a binding");
  return binding;
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function setup(
  t: TestContext,
  input: {
    document: unknown;
    server?: AuthorizationServerOptions;
    policy?: Record<string, unknown> | false;
    /** Pin the policy per profile instead of binding-wide. */
    perProfile?: boolean;
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
  const reviewer = human();
  const binding = await approveThroughReview(harness, reviewer, {
    document: input.document,
    destination: api.origin,
    ...(policy && !input.perProfile ? { oauth: policy } : {}),
    ...(policy && input.perProfile
      ? {
          oauthProfiles: (ids: string[]) =>
            Object.fromEntries(ids.map((id) => [id, policy])),
        }
      : {}),
  });
  const operation = binding.operations.find(
    (item) => item.nativeId === "listItems",
  );
  assert.ok(operation, "listItems was approved");
  const actor = reviewer;
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

test("a 401 to a live-looking token triggers one refresh and one retry, each journaled as its own attempt", async (t) => {
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
  // Every request sent is its own journal entry: the first read, the one the
  // destination refused (not applied), and the retry after renewal. None of
  // them overwrites another's outcome.
  assert.deepEqual(attempts, ["applied", "not-applied", "applied"]);
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

test("only a person pins an issuer policy, only through review, and only for an issuer host policy admits", async (t) => {
  const api = await startHttpFixture(() => ({ status: 200, body: [] }));
  t.after(() => api.close());
  const registry = new ConnectorAdapterRegistry();
  registry.register(createOpenApiHttpAdapter());
  // Delegation checks are another test's subject: this policy lets the agent
  // reach the approval, so the refusal below is the issuer rule's own.
  const harness = await createHarness({
    service: { registry },
    policy: (base) => ({ ...base, authorize: () => true }),
  });
  t.after(() => harness.close());
  const reviewer = human();
  const declared = {
    issuer: "https://declared.example.test",
    registration: { clientIdConfiguration: "ITEMS_CLIENT_ID" },
  };
  const refused = (detail: string) => (error: unknown) =>
    error instanceof ConnectorError && error.detail === detail;

  await assert.rejects(
    approveThroughReview(
      harness,
      agent({ capabilities: ["author", "reviewer", "executor"] }),
      {
        document: description("authorizationCode"),
        destination: api.origin,
        oauth: declared,
      },
    ),
    refused("oauth.policy.human-only"),
  );
  for (const key of ["oauth", "oauth-profiles", "openapi-http"])
    await assert.rejects(
      approveThroughReview(harness, reviewer, {
        document: description("authorizationCode"),
        destination: api.origin,
        settings: { [key]: declared },
      }),
      refused("settings.reserved"),
      `${key} cannot ride in free-form settings`,
    );
  await assert.rejects(
    approveThroughReview(harness, reviewer, {
      document: description("authorizationCode"),
      destination: api.origin,
      oauth: { ...declared, issuer: "https://elsewhere.example.test" },
    }),
    refused("oauth.issuer.not-permitted"),
  );
  await assert.rejects(
    approveThroughReview(harness, reviewer, {
      document: description("authorizationCode"),
      destination: api.origin,
      oauth: {
        ...declared,
        trustedOrigins: ["https://elsewhere.example.test"],
      },
    }),
    refused("oauth.issuer.not-permitted"),
    "every origin the policy may contact is judged, not only the issuer's",
  );

  // The declared issuer, named by a person: approved, pinned and digested,
  // with the approved read the reviewer named as verifier.
  const binding = await approveThroughReview(harness, reviewer, {
    document: description("authorizationCode"),
    destination: api.origin,
    oauth: declared,
    verifier: { nativeId: "listItems" },
  });
  assert.equal(
    (
      binding.settings["openapi-http"] as {
        verifier?: { operationRef: string };
      }
    ).verifier?.operationRef,
    binding.operations[0]?.operationRef,
  );
  assert.equal(
    (binding.settings["oauth"] as { issuer?: string }).issuer,
    declared.issuer,
  );
  assert.ok(binding.settings["openapi-http"], "the plans were compiled");
  assert.deepEqual(
    binding.operations.map((item) => item.nativeId),
    ["listItems"],
  );
});

test("an upstream disconnect revokes the grant at the issuer only when the reviewed policy allows it; a local one never does", async (t) => {
  // Revocation allowed by the host's reviewed policy.
  const allowed = await setup(t, {
    document: description("authorizationCode", { refreshUrl: true }),
    policy: { revocation: "on-upstream-disconnect" },
  });
  const local = await connectWithBrowser(allowed);
  const localView = await allowed.harness.service.disconnect(
    allowed.actor,
    local.done.connectionRef,
    { expectedRevision: local.done.revision, scope: "local" },
  );
  assert.equal(localView.result.upstream, "not-attempted");
  assert.equal(localView.connection.lifecycle, "locally-disconnected");
  assert.equal(
    allowed.as.counts.revocation,
    0,
    "a local unlink is not revocation",
  );

  const { done } = await connectWithBrowser(allowed);
  const first = await allowed.harness.service.invoke(
    allowed.actor,
    done.connectionRef,
    {
      operationRef: allowed.operationRef,
      commandId: "before-revoke",
      confirm: true,
    },
  );
  assert.equal(first.state, "complete");
  const presented = allowed.api.requests
    .at(-1)!
    .headers["authorization"]!.slice(7);
  assert.ok(allowed.as.accessTokenActive(presented));
  const held = heldSecrets(allowed);
  const current = await allowed.harness.service.status(
    allowed.actor,
    done.connectionRef,
  );
  const upstream = await allowed.harness.service.disconnect(
    allowed.actor,
    done.connectionRef,
    { expectedRevision: current.revision, scope: "upstream" },
  );
  assert.equal(upstream.result.upstream, "applied");
  assert.equal(upstream.connection.lifecycle, "upstream-revoked");
  // Refresh token first, then the access token, each to the issuer's endpoint.
  assert.equal(allowed.as.counts.revocation, 2);
  assert.equal(allowed.as.accessTokenActive(presented), false);
  assertNoSecrets(allowed, [presented, ...held], "revocation", upstream);

  // The same deployment without the policy flag: nothing is presented.
  const off = await setup(t, {
    document: description("authorizationCode", { refreshUrl: true }),
  });
  const kept = await connectWithBrowser(off);
  const unrevoked = await off.harness.service.disconnect(
    off.actor,
    kept.done.connectionRef,
    { expectedRevision: kept.done.revision, scope: "upstream" },
  );
  assert.equal(unrevoked.result.upstream, "not-attempted");
  assert.equal(unrevoked.connection.lifecycle, "locally-disconnected");
  assert.equal(off.as.counts.revocation, 0);
});

test("a person pins a per-profile issuer policy through the same review, and the profile connects with it", async (t) => {
  const state = await setup(t, {
    document: description("authorizationCode"),
    perProfile: true,
  });
  // Nothing binding-wide: the only policy is the profile's own.
  assert.equal(state.binding.settings["oauth"], undefined);
  const pinned = state.binding.settings["oauth-profiles"] as Record<
    string,
    { issuer?: string }
  >;
  assert.deepEqual(
    Object.values(pinned).map((policy) => policy.issuer),
    [state.as.issuer],
  );
  const { done } = await connectWithBrowser(state);
  assert.equal(done.lifecycle, "active");
  assert.equal(state.as.counts.token, 1);
});

test("per-profile issuer policies are refused for agents, unknown profiles, invalid policies and issuers host policy does not admit", async (t) => {
  const api = await startHttpFixture(() => ({ status: 200, body: [] }));
  t.after(() => api.close());
  const registry = new ConnectorAdapterRegistry();
  registry.register(createOpenApiHttpAdapter());
  const harness = await createHarness({
    service: { registry },
    policy: (base) => ({ ...base, authorize: () => true }),
  });
  t.after(() => harness.close());
  const reviewer = human();
  const declared = {
    issuer: "https://declared.example.test",
    registration: { clientIdConfiguration: "ITEMS_CLIENT_ID" },
  };
  const refused = (detail: string) => (error: unknown) =>
    error instanceof ConnectorError && error.detail === detail;
  const each =
    (policy: Record<string, unknown>) =>
    (ids: string[]): Record<string, unknown> =>
      Object.fromEntries(ids.map((id) => [id, policy]));
  const review = (
    actor: ReturnType<typeof human>,
    oauthProfiles: (ids: string[]) => Record<string, unknown>,
  ) =>
    approveThroughReview(harness, actor, {
      document: description("authorizationCode"),
      destination: api.origin,
      oauthProfiles,
    });

  await assert.rejects(
    review(
      agent({ capabilities: ["author", "reviewer", "executor"] }),
      each(declared),
    ),
    refused("oauth.policy.human-only"),
  );
  await assert.rejects(
    review(reviewer, () => ({ "no-such-profile": declared })),
    refused("oauth.policy.profile-unknown"),
  );
  await assert.rejects(
    review(reviewer, each({ ...declared, issuer: "not a url" })),
    refused("oauth.policy.invalid"),
  );
  await assert.rejects(
    review(reviewer, each({ ...declared, unexpected: true })),
    refused("oauth.policy.invalid"),
  );
  await assert.rejects(
    review(
      reviewer,
      each({ ...declared, issuer: "https://elsewhere.example.test" }),
    ),
    refused("oauth.issuer.not-permitted"),
  );
  await assert.rejects(
    review(
      reviewer,
      each({ ...declared, trustedOrigins: ["https://elsewhere.example.test"] }),
    ),
    refused("oauth.issuer.not-permitted"),
    "a profile's policy is judged on every origin, like the binding-wide one",
  );
  // Admitted: pinned under the reserved key, next to a binding-wide policy.
  const binding = await approveThroughReview(harness, reviewer, {
    document: description("authorizationCode"),
    destination: api.origin,
    oauth: declared,
    oauthProfiles: each({
      ...declared,
      responseIssuerParameter: "required",
    }),
  });
  const pinned = binding.settings["oauth-profiles"] as Record<
    string,
    { issuer: string; responseIssuerParameter: string }
  >;
  assert.equal(Object.keys(pinned).length, 1);
  assert.equal(Object.values(pinned)[0]!.responseIssuerParameter, "required");
  assert.equal(
    (binding.settings["oauth"] as { responseIssuerParameter: string })
      .responseIssuerParameter,
    "if-advertised",
  );
});
