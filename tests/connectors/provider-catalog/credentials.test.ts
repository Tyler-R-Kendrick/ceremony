import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import {
  approve,
  catalogHarness,
  commandId,
  importDocument,
  startProviderApi,
} from "./harness.js";

/*
 * The non-redirect modes, end to end through the command service: client
 * credentials acquired and re-acquired on expiry, API keys, Basic and bearer
 * credentials collected through the private collector and placed only where
 * the entry says, and a provider that needs no credential at all.
 */

const CC_ID = "machine-client";
const CC_SECRET = "machine-secret-value";

/** A client-credentials token endpoint that checks what it is sent. */
async function startTokenEndpoint(t: TestContext) {
  let issued = 0;
  const seen: Array<Record<string, string>> = [];
  const fixture = await startHttpFixture((request) => {
    if (request.url.pathname !== "/oauth2/token" || request.method !== "POST")
      return { status: 404, body: { error: "not_found" } };
    const form = Object.fromEntries(
      new URLSearchParams(request.body.toString("utf8")),
    );
    seen.push(form);
    // RFC 6749 §2.3.1: each half is form-encoded before the Basic encoding.
    const basic = (request.headers["authorization"] ?? "").replace(
      /^Basic /,
      "",
    );
    const [id, secret] = Buffer.from(basic, "base64")
      .toString("utf8")
      .split(":")
      .map((part) => decodeURIComponent(part));
    if (id !== CC_ID || secret !== CC_SECRET)
      return { status: 401, body: { error: "invalid_client" } };
    if (form["grant_type"] !== "client_credentials")
      return { status: 400, body: { error: "unsupported_grant_type" } };
    if (form["audience"] !== "api-metrics")
      return { status: 400, body: { error: "invalid_target" } };
    issued++;
    return {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
      body: {
        access_token: `cc_${issued}_${"x".repeat(16)}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: form["scope"] ?? "",
      },
    };
  });
  t.after(() => fixture.close());
  return { fixture, seen, issued: () => issued };
}

test("client credentials: acquired at connect, placed as bearer, re-acquired on expiry", async (t) => {
  const token = await startTokenEndpoint(t);
  const api = await startProviderApi(t, {
    accept: (headers) => /^Bearer cc_\d+_/.test(headers["authorization"] ?? ""),
  });
  const harness = await catalogHarness(t);
  harness.setConfiguration(harness.actor, "LOCAL_METRICS_CLIENT_ID", CC_ID);
  harness.setConfiguration(
    harness.actor,
    "LOCAL_METRICS_CLIENT_SECRET",
    CC_SECRET,
  );
  const { definitions } = await importDocument(harness, {
    "local-metrics": {
      display_name: "Local Metrics",
      auth_mode: "OAUTH2_CC",
      token_url: `${token.fixture.origin}/oauth2/token`,
      token_params: {
        grant_type: "client_credentials",
        audience: "api-metrics",
      },
      token_request_auth_method: "basic",
      default_scopes: ["metrics.read"],
      proxy: { base_url: api.origin },
    },
  });
  const approved = await approve(harness, {
    definitionRef: definitions[0]!.definitionRef,
    destination: api.origin,
    profileId: "client-credentials",
  });
  const view = await harness.service.connect(harness.actor, {
    bindingRef: approved.reference.bindingRef,
    intent: { profileId: "client-credentials" },
  });
  assert.equal((view as { lifecycle: string }).lifecycle, "active");
  assert.equal(token.issued(), 1);
  assert.equal(token.seen[0]?.["scope"], "metrics.read");
  const connectionRef = (view as { connectionRef: string }).connectionRef;

  const first = await harness.service.invoke(harness.actor, connectionRef, {
    operationRef: approved.operation("proxy.get"),
    input: { path: "/items" },
    commandId: commandId(),
  });
  assert.equal(first.state, "complete");
  assert.match(api.requests.at(-1)!.headers["authorization"]!, /^Bearer cc_1_/);

  harness.clock.advance(3600_000);
  const second = await harness.service.invoke(harness.actor, connectionRef, {
    operationRef: approved.operation("proxy.get"),
    input: { path: "/items" },
    commandId: commandId(),
  });
  assert.equal(second.state, "complete");
  assert.equal(token.issued(), 2);
  assert.match(api.requests.at(-1)!.headers["authorization"]!, /^Bearer cc_2_/);
  for (const surface of [view, first, second])
    assert.ok(!JSON.stringify(surface).includes("cc_"));
});

async function collectedConnection(
  t: TestContext,
  input: {
    provider: Record<string, unknown>;
    accept: (headers: Record<string, string>, url: URL) => boolean;
    destination: (origin: string) => string;
    profileId: string;
    configuration?: Record<string, string>;
  },
) {
  const api = await startProviderApi(t, { accept: input.accept });
  const harness = await catalogHarness(t);
  for (const [name, value] of Object.entries(input.configuration ?? {}))
    harness.setConfiguration(harness.actor, name, value);
  const provider = JSON.parse(
    JSON.stringify(input.provider).replaceAll("API_ORIGIN", api.origin),
  ) as Record<string, unknown>;
  const { definitions } = await importDocument(harness, { local: provider });
  const approved = await approve(harness, {
    definitionRef: definitions[0]!.definitionRef,
    destination: input.destination(api.origin),
    profileId: input.profileId,
  });
  const view = await harness.service.connect(harness.actor, {
    bindingRef: approved.reference.bindingRef,
    intent: { profileId: input.profileId },
  });
  const connectionRef = (view as { connectionRef: string }).connectionRef;
  assert.equal((view as { lifecycle: string }).lifecycle, "human-required");
  // The credential is asked for through the private collector, never through
  // anything a model reads.
  assert.equal(
    (view as { presentation?: { url?: string } }).presentation?.url,
    undefined,
  );
  const handoff = harness.ports.inspect
    .handoffs()
    .find((item) => item.connectionRef === connectionRef);
  assert.ok(handoff);
  assert.equal(handoff.kind, "private-collector");
  const provide = (values: Record<string, string>) =>
    harness.service.provideInput(
      harness.actor,
      connectionRef,
      handoff.handoffRef,
      values,
    );
  return { api, harness, approved, connectionRef, provide };
}

const mailProvider = {
  display_name: "Local Mail",
  auth_mode: "API_KEY",
  proxy: {
    base_url: "API_ORIGIN/v3",
    headers: { "X-Api-Key": "${apiKey}" },
    verification: { method: "GET", endpoints: ["/me"] },
  },
};
const MAIL_KEY = "key-correct-1234567890";

test("an API key is collected privately, verified, placed in its header and never echoed", async (t) => {
  const { api, harness, approved, connectionRef, provide } =
    await collectedConnection(t, {
      provider: mailProvider,
      accept: (headers) => headers["x-api-key"] === MAIL_KEY,
      destination: (origin) => `${origin}/v3`,
      profileId: "api-key",
    });
  const view = await provide({ apiKey: MAIL_KEY });
  assert.equal((view as { lifecycle: string }).lifecycle, "active");
  // The verification read went to the declared path under the base.
  assert.equal(api.requests.at(-1)!.url.pathname, "/v3/me");
  const claims = await harness.ports.evidence.list(
    harness.actor,
    connectionRef,
  );
  assert.equal(claims[0]?.kind, "credential-accepted");

  const echoed = await harness.service.invoke(harness.actor, connectionRef, {
    operationRef: approved.operation("proxy.get"),
    input: { path: "/echo" },
    commandId: commandId(),
  });
  assert.equal(echoed.state, "complete");
  assert.equal(
    (echoed.output as { body: { apiKey: string } }).body.apiKey,
    "[redacted]",
  );
  assert.equal(api.requests.at(-1)!.headers["x-api-key"], MAIL_KEY);
  assert.equal(api.requests.at(-1)!.headers["authorization"], undefined);
  for (const surface of [view, echoed, claims])
    assert.ok(!JSON.stringify(surface).includes(MAIL_KEY));
});

test("a key the provider rejects is denied and not kept", async (t) => {
  const { harness, connectionRef, provide } = await collectedConnection(t, {
    provider: mailProvider,
    accept: (headers) => headers["x-api-key"] === MAIL_KEY,
    destination: (origin) => `${origin}/v3`,
    profileId: "api-key",
  });
  const view = await provide({ apiKey: "key-wrong-0000000000" });
  assert.notEqual((view as { lifecycle: string }).lifecycle, "active");
  assert.equal(
    (view as { lastOutcome?: string }).lastOutcome,
    "credential.rejected",
  );
  assert.equal(harness.ports.inspect.credentialRefs().length, 0);
  void connectionRef;
});

test("a query-parameter key is placed by the entry and cannot be overridden by a caller", async (t) => {
  const key = "weather-key-0987654321";
  const { api, harness, approved, connectionRef, provide } =
    await collectedConnection(t, {
      provider: {
        display_name: "Local Weather",
        auth_mode: "API_KEY",
        proxy: { base_url: "API_ORIGIN", query: { appid: "${apiKey}" } },
      },
      accept: (_headers, url) => url.searchParams.get("appid") === key,
      destination: (origin) => origin,
      profileId: "api-key",
    });
  const view = await provide({ apiKey: key });
  assert.equal((view as { lifecycle: string }).lifecycle, "active");
  const echoed = await harness.service.invoke(harness.actor, connectionRef, {
    operationRef: approved.operation("proxy.get"),
    input: { path: "/echo", query: { units: "metric" } },
    commandId: commandId(),
  });
  assert.equal(echoed.state, "complete");
  assert.ok(!JSON.stringify(echoed).includes(key));
  assert.equal(api.requests.at(-1)!.url.searchParams.get("appid"), key);
  await assert.rejects(
    harness.service.invoke(harness.actor, connectionRef, {
      operationRef: approved.operation("proxy.get"),
      input: { path: "/echo", query: { appid: "attacker" } },
      commandId: commandId(),
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "catalog.proxy.credential-parameter",
  );
});

test("Basic credentials fill the path template and go only in Authorization", async (t) => {
  const expected = `Basic ${Buffer.from("ada:pa55word").toString("base64")}`;
  const { api, harness, approved, connectionRef, provide } =
    await collectedConnection(t, {
      provider: {
        display_name: "Local Board",
        auth_mode: "BASIC",
        proxy: { base_url: "API_ORIGIN/rest/${connectionConfig.workspace}" },
        connection_config: {
          workspace: { type: "string", title: "Workspace" },
        },
      },
      accept: (headers) => headers["authorization"] === expected,
      destination: (origin) => `${origin}/rest`,
      profileId: "basic",
      // The per-connection value is host configuration, read by name.
      configuration: { LOCAL_WORKSPACE: "team_7" },
    });
  await assert.rejects(
    provide({ username: "ada:admin", password: "x" }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "catalog.credential.invalid",
  );
  const view = await provide({ username: "ada", password: "pa55word" });
  assert.equal((view as { lifecycle: string }).lifecycle, "active");
  const result = await harness.service.invoke(harness.actor, connectionRef, {
    operationRef: approved.operation("proxy.get"),
    input: { path: "/items" },
    commandId: commandId(),
  });
  assert.equal(result.state, "complete");
  assert.equal(api.requests.at(-1)!.url.pathname, "/rest/team_7/items");
  assert.equal(api.requests.at(-1)!.headers["authorization"], expected);
  assert.ok(!JSON.stringify([view, result]).includes("pa55word"));
});

test("a provider that echoes a Basic credential back has it redacted", async (t) => {
  const username = "ada.lovelace";
  const password = "pa55word-echoed";
  const encoded = Buffer.from(`${username}:${password}`).toString("base64");
  const { harness, approved, connectionRef, provide } =
    await collectedConnection(t, {
      provider: {
        display_name: "Local Board",
        auth_mode: "BASIC",
        proxy: { base_url: "API_ORIGIN/rest" },
      },
      accept: (headers) => headers["authorization"] === `Basic ${encoded}`,
      destination: (origin) => `${origin}/rest`,
      profileId: "basic",
    });
  const view = await provide({ username, password });
  assert.equal((view as { lifecycle: string }).lifecycle, "active");
  const echoed = await harness.service.invoke(harness.actor, connectionRef, {
    operationRef: approved.operation("proxy.get"),
    input: { path: "/echo" },
    commandId: commandId(),
  });
  assert.equal(echoed.state, "complete");
  assert.equal(
    (echoed.output as { body: { authorization: string } }).body.authorization,
    "Basic [redacted]",
  );
  for (const secret of [encoded, username, password])
    assert.ok(!JSON.stringify(echoed).includes(secret));
});

test("an API key's placed value, prefix and all, is redacted when echoed", async (t) => {
  const key = "prefixed-key-1234567890";
  const { harness, approved, connectionRef, provide } =
    await collectedConnection(t, {
      provider: {
        display_name: "Local Mail",
        auth_mode: "API_KEY",
        proxy: {
          base_url: "API_ORIGIN/v3",
          headers: { "X-Api-Key": "Token ${apiKey}" },
        },
      },
      accept: (headers) => headers["x-api-key"] === `Token ${key}`,
      destination: (origin) => `${origin}/v3`,
      profileId: "api-key",
    });
  const view = await provide({ apiKey: key });
  assert.equal((view as { lifecycle: string }).lifecycle, "active");
  const echoed = await harness.service.invoke(harness.actor, connectionRef, {
    operationRef: approved.operation("proxy.get"),
    input: { path: "/echo" },
    commandId: commandId(),
  });
  assert.equal(echoed.state, "complete");
  assert.equal(
    (echoed.output as { body: { apiKey: string } }).body.apiKey,
    "[redacted]",
  );
});

test("a provider that needs no credential connects and proxies without one", async (t) => {
  const api = await startProviderApi(t, {
    accept: (headers) => headers["authorization"] === undefined,
  });
  const harness = await catalogHarness(t);
  const { definitions } = await importDocument(harness, {
    "open-data": {
      display_name: "Open Data",
      auth_mode: "NONE",
      proxy: { base_url: api.origin },
    },
  });
  const approved = await approve(harness, {
    definitionRef: definitions[0]!.definitionRef,
    destination: api.origin,
    profileId: "none",
  });
  const view = await harness.service.connect(harness.actor, {
    bindingRef: approved.reference.bindingRef,
    intent: { profileId: "none" },
  });
  assert.equal((view as { lifecycle: string }).lifecycle, "active");
  const result = await harness.service.invoke(
    harness.actor,
    (view as { connectionRef: string }).connectionRef,
    {
      operationRef: approved.operation("proxy.get"),
      input: { path: "/text" },
      commandId: commandId(),
    },
  );
  assert.deepEqual(result.output, { status: 200, body: "plain body" });
});
