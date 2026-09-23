import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  approve,
  catalogHarness,
  CLIENT_ID,
  CLIENT_SECRET,
  commandId,
  completeRedirect,
  importDocument,
  startOAuthServer,
  startProviderApi,
} from "./harness.js";

/*
 * Authorization code with PKCE, end to end through the command service: a
 * Nango-format entry with loopback endpoints is imported as a draft, bound
 * through review, connected by a real redirect from the fixture authorization
 * server, used through the authenticated proxy, and refreshed when it expires.
 */

function nangoDocument(
  server: { origin: string },
  api: { origin: string },
  extra: Record<string, unknown> = {},
) {
  return {
    "local-crm": {
      ...extra,
      display_name: "Local CRM",
      categories: ["crm"],
      auth_mode: "OAUTH2",
      authorization_url: `${server.origin}/authorize`,
      token_url: `${server.origin}/token`,
      authorization_params: { response_type: "code", access_type: "offline" },
      default_scopes: ["items.read"],
      proxy: {
        base_url: `${api.origin}/v2`,
        headers: { "accept-version": "2026-01" },
      },
    },
  };
}

async function connected(
  t: TestContext,
  options: {
    destination?: (api: { origin: string }) => string;
    /** How the provider API decides a bearer is good; defaults to any bearer. */
    accept?: (
      server: Awaited<ReturnType<typeof startOAuthServer>>,
    ) => Parameters<typeof startProviderApi>[1];
    /** Extra keys for the provider's Nango description. */
    provider?: Record<string, unknown>;
  } = {},
) {
  const server = await startOAuthServer(t);
  const api = await startProviderApi(t, options.accept?.(server));
  const harness = await catalogHarness(t);
  harness.setConfiguration(harness.actor, "LOCAL_CRM_CLIENT_ID", CLIENT_ID);
  harness.setConfiguration(
    harness.actor,
    "LOCAL_CRM_CLIENT_SECRET",
    CLIENT_SECRET,
  );
  const { definitions } = await importDocument(
    harness,
    nangoDocument(server, api, options.provider),
  );
  const definition = definitions[0]!;
  const approved = await approve(harness, {
    definitionRef: definition.definitionRef,
    destination: options.destination?.(api) ?? `${api.origin}/v2`,
    profileId: "oauth2",
    operations: [
      { nativeId: "proxy.get", outputClassification: "public" },
      { nativeId: "proxy.post", outputClassification: "public" },
    ],
  });
  const view = await harness.service.connect(harness.actor, {
    bindingRef: approved.reference.bindingRef,
    intent: { profileId: "oauth2", requestedPermissions: ["items.write"] },
  });
  const presentation = (view as { presentation?: { url?: string } })
    .presentation;
  assert.ok(presentation?.url, "the person is given the provider's page");
  const authorization = new URL(presentation.url);
  const done = await completeRedirect(harness, presentation.url);
  return {
    server,
    api,
    harness,
    approved,
    authorization,
    view: done,
    connectionRef: (view as { connectionRef: string }).connectionRef,
  };
}

test("authorize → callback → proxy → refresh on expiry, all through the service", async (t) => {
  const { server, api, harness, approved, authorization, view, connectionRef } =
    await connected(t);

  // The authorization request is the engine's: S256 PKCE, the reviewed
  // parameters, default plus requested scopes, and the deployment's callback.
  assert.equal(authorization.origin, server.origin);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("access_type"), "offline");
  assert.equal(
    authorization.searchParams.get("scope"),
    "items.read items.write",
  );
  assert.equal(authorization.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(authorization.searchParams.get("response_type"), "code");
  assert.equal((view as { lifecycle: string }).lifecycle, "active");

  // Client authentication followed the entry: the secret went in the body.
  const exchange = server.tokenRequests.find(
    (item) => item.grantType === "authorization_code",
  );
  assert.equal(exchange?.parameters["client_secret"], CLIENT_SECRET);
  assert.ok(exchange?.parameters["code_verifier"]);

  const first = await harness.service.invoke(harness.actor, connectionRef, {
    operationRef: approved.operation("proxy.get"),
    input: { path: "/items", query: { page: 2 } },
    commandId: commandId(),
  });
  assert.equal(first.state, "complete");
  assert.deepEqual(first.output, {
    status: 200,
    body: { items: [{ id: "item-1" }], query: "?page=2" },
  });
  const call = api.requests.at(-1)!;
  assert.equal(call.url.pathname, "/v2/items");
  assert.equal(call.headers["accept-version"], "2026-01");
  const firstToken = call.headers["authorization"];
  assert.match(firstToken ?? "", /^Bearer at_/);

  // An hour later the access token is about to expire: the next call refreshes
  // it first, through the engine's single-flight refresh, and uses the new one.
  harness.clock.advance(3600_000);
  const second = await harness.service.invoke(harness.actor, connectionRef, {
    operationRef: approved.operation("proxy.get"),
    input: { path: "/items" },
    commandId: commandId(),
  });
  assert.equal(second.state, "complete");
  const refresh = server.tokenRequests.filter(
    (item) => item.grantType === "refresh_token",
  );
  assert.equal(refresh.length, 1);
  const secondToken = api.requests.at(-1)!.headers["authorization"];
  assert.match(secondToken ?? "", /^Bearer at_/);
  assert.notEqual(secondToken, firstToken);

  // Fresh again: no further refresh.
  await harness.service.invoke(harness.actor, connectionRef, {
    operationRef: approved.operation("proxy.get"),
    input: { path: "/me" },
    commandId: commandId(),
  });
  assert.equal(
    server.tokenRequests.filter((item) => item.grantType === "refresh_token")
      .length,
    1,
  );
});

test("the proxy refuses any origin but the entry's declared one", async (t) => {
  // The reviewer approved a destination that is not the entry's proxy origin.
  const other = await startProviderApi(t);
  const { harness, approved, connectionRef } = await connected(t, {
    destination: () => `${other.origin}/v2`,
  });
  await assert.rejects(
    harness.service.invoke(harness.actor, connectionRef, {
      operationRef: approved.operation("proxy.get"),
      input: { path: "/items" },
      commandId: commandId(),
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "network-policy" &&
      error.detail === "catalog.proxy.origin-mismatch",
  );
  assert.equal(other.requests.length, 0, "nothing reached the other origin");
});

test("a caller names a path under the base, never a host or a way out of it", async (t) => {
  const { api, harness, approved, connectionRef } = await connected(t);
  const before = api.requests.length;
  for (const input of [
    { path: "//evil.example/items" },
    { path: "/../admin" },
    { path: "/a/%2e%2e/admin" },
    { path: "/a%2fb" },
    { path: "https://evil.example/items" },
    { path: "/items", url: "https://evil.example" },
    { path: "/items", headers: { host: "evil.example" } },
  ])
    await assert.rejects(
      harness.service.invoke(harness.actor, connectionRef, {
        operationRef: approved.operation("proxy.get"),
        input,
        commandId: commandId(),
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        (error.code === "invalid-request" || error.code === "network-policy"),
      JSON.stringify(input),
    );
  assert.equal(api.requests.length, before, "no escaped request was sent");
});

test("no token or secret appears in an output, a view or an error", async (t) => {
  const { server, harness, approved, connectionRef } = await connected(t);
  const secrets = () => {
    const values = [CLIENT_SECRET];
    for (const ref of harness.ports.inspect.credentialRefs()) {
      const material = harness.ports.inspect.credentialMaterial(ref) ?? {};
      for (const key of ["access_token", "refresh_token"])
        if (material[key]) values.push(material[key]!);
    }
    return values;
  };
  const echoed = await harness.service.invoke(harness.actor, connectionRef, {
    operationRef: approved.operation("proxy.get"),
    input: { path: "/echo" },
    commandId: commandId(),
  });
  assert.equal(echoed.state, "complete");
  assert.deepEqual(
    (echoed.output as { body: { authorization: string } }).body.authorization,
    "Bearer [redacted]",
  );
  const failed = await harness.service.invoke(harness.actor, connectionRef, {
    operationRef: approved.operation("proxy.get"),
    input: { path: "/fail" },
    commandId: commandId(),
  });
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.output, { status: 500 });

  const status = await harness.service.status(harness.actor, connectionRef);
  const evidence = await harness.ports.evidence.list(
    harness.actor,
    connectionRef,
  );
  const surfaces = [echoed, failed, status, evidence];
  for (const surface of surfaces) {
    const text = JSON.stringify(surface);
    for (const secret of secrets())
      assert.ok(!text.includes(secret), "a secret leaked into a response");
  }
  assert.ok(secrets().length >= 3, "the test saw real token material");
  assert.ok(server.tokenRequests.length >= 1);
});

test("a token endpoint failure surfaces as a code, never as provider text", async (t) => {
  const server = await startOAuthServer(t, {
    misbehave: { tokenError: "invalid_grant" },
  });
  const api = await startProviderApi(t);
  const harness = await catalogHarness(t);
  harness.setConfiguration(harness.actor, "LOCAL_CRM_CLIENT_ID", CLIENT_ID);
  harness.setConfiguration(
    harness.actor,
    "LOCAL_CRM_CLIENT_SECRET",
    CLIENT_SECRET,
  );
  const { definitions } = await importDocument(
    harness,
    nangoDocument(server, api),
  );
  const approved = await approve(harness, {
    definitionRef: definitions[0]!.definitionRef,
    destination: `${api.origin}/v2`,
    profileId: "oauth2",
  });
  const view = await harness.service.connect(harness.actor, {
    bindingRef: approved.reference.bindingRef,
    intent: { profileId: "oauth2" },
  });
  const url = (view as { presentation?: { url?: string } }).presentation!.url!;
  const error = await completeRedirect(harness, url).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof ConnectorError);
  assert.equal(error.detail, "oauth.token.invalid-grant");
  assert.ok(!String(error.message).includes(CLIENT_SECRET));
});

test("a binding whose settings were altered after review is refused", async (t) => {
  const server = await startOAuthServer(t);
  const api = await startProviderApi(t);
  const harness = await catalogHarness(t);
  const { definitions } = await importDocument(
    harness,
    nangoDocument(server, api),
  );
  const { providerCatalogBindingSettings } =
    await import("../../../src/server/connectors/formats/provider-catalog/index.js");
  const settings = providerCatalogBindingSettings(definitions[0]!);
  // The reviewer's copy says one token URL; someone edits the auth section.
  const tampered = {
    ...settings,
    "provider-catalog/auth": {
      ...(settings["provider-catalog/auth"] as object),
      tokenUrl: `${api.origin}/token`,
    },
  };
  harness.setConfiguration(harness.actor, "LOCAL_CRM_CLIENT_ID", CLIENT_ID);
  harness.setConfiguration(
    harness.actor,
    "LOCAL_CRM_CLIENT_SECRET",
    CLIENT_SECRET,
  );
  const approved = await approve(harness, {
    definitionRef: definitions[0]!.definitionRef,
    destination: `${api.origin}/v2`,
    profileId: "oauth2",
    settings: tampered,
  });
  await assert.rejects(
    harness.service.connect(harness.actor, {
      bindingRef: approved.reference.bindingRef,
      intent: { profileId: "oauth2" },
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "catalog.binding.entry-digest",
  );
});

test("a provider's token_params ride on the code exchange only, as the reviewed entry wrote them", async (t) => {
  const { server, harness, approved, connectionRef } = await connected(t, {
    provider: {
      token_params: {
        grant_type: "authorization_code",
        audience: "https://api.local-crm.example",
      },
    },
  });
  const exchange = server.tokenRequests.find(
    (item) => item.grantType === "authorization_code",
  );
  assert.equal(
    exchange?.parameters["audience"],
    "https://api.local-crm.example",
  );
  // The grant's own parameters are the engine's, not the entry's.
  assert.equal(exchange?.parameters["grant_type"], "authorization_code");
  assert.ok(exchange?.parameters["code_verifier"]);
  // Refresh is a different message: Nango keeps its extras in refresh_params.
  harness.clock.advance(3600_000);
  const read = await harness.service.invoke(harness.actor, connectionRef, {
    operationRef: approved.operation("proxy.get"),
    input: { path: "/items" },
    commandId: commandId(),
  });
  assert.equal(read.state, "complete");
  const refresh = server.tokenRequests.find(
    (item) => item.grantType === "refresh_token",
  );
  assert.ok(refresh);
  assert.equal(refresh.parameters["audience"], undefined);
});

test("an ID token is never asked for without keys to verify it", async (t) => {
  const server = await startOAuthServer(t);
  const api = await startProviderApi(t);
  const harness = await catalogHarness(t);
  harness.setConfiguration(harness.actor, "LOCAL_CRM_CLIENT_ID", CLIENT_ID);
  harness.setConfiguration(
    harness.actor,
    "LOCAL_CRM_CLIENT_SECRET",
    CLIENT_SECRET,
  );
  const { definitions } = await importDocument(
    harness,
    nangoDocument(server, api),
  );
  const approved = await approve(harness, {
    definitionRef: definitions[0]!.definitionRef,
    destination: `${api.origin}/v2`,
    profileId: "oauth2",
  });
  await assert.rejects(
    harness.service.connect(harness.actor, {
      bindingRef: approved.reference.bindingRef,
      intent: { profileId: "oauth2", requestedPermissions: ["openid"] },
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "catalog.scope.openid",
  );
  assert.equal(server.counts.authorize, 0);
});

test("a token the provider refuses is renewed once and the call retried, each request journaled as its own attempt", async (t) => {
  const { server, api, harness, approved, connectionRef } = await connected(t, {
    accept: (issuer) => ({
      accept: (headers) =>
        issuer.accessTokenActive(
          (headers["authorization"] ?? "").replace(/^Bearer /, ""),
        ),
    }),
  });
  const read = () =>
    harness.service.invoke(harness.actor, connectionRef, {
      operationRef: approved.operation("proxy.get"),
      input: { path: "/items" },
      commandId: commandId(),
    });
  const first = await read();
  assert.equal(first.state, "complete");
  const revoked = api.requests
    .at(-1)!
    .headers["authorization"]!.replace(/^Bearer /, "");
  server.revokeAccessToken(revoked);

  const second = await read();
  assert.equal(second.state, "complete");
  assert.equal(api.requests.length, 3, "one refused request, one retry");
  assert.equal(
    server.tokenRequests.filter((item) => item.grantType === "refresh_token")
      .length,
    1,
  );
  const attempts = harness.ports.inspect
    .effects()
    .filter(
      (entry) => entry.intent.operation === approved.operation("proxy.get"),
    )
    .map((entry) => entry.outcome?.status);
  // A repeated read is its own entry every time; none overwrites another.
  assert.deepEqual(attempts, ["applied", "not-applied", "applied"]);
  for (const surface of [first, second])
    assert.ok(!JSON.stringify(surface).includes(revoked));
});
