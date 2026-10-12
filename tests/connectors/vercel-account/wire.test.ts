import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import {
  issuerPolicy,
  resolveAuthorizationServer,
  resolveClientRegistration,
} from "../../../src/server/connectors/auth/index.js";
import { runtimeBindingSchema } from "../../../src/server/connectors/binding.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  accountApiDestination,
  apiFailure,
  createVercelAccountAdapter,
  VERCEL_ACCOUNT_ASSUMPTIONS,
  vercelAccountIssuerPolicy,
  vercelAccountSettings,
} from "../../../src/server/connectors/providers/vercel-account/index.js";
import {
  listTeams,
  readUser,
} from "../../../src/server/connectors/providers/vercel-account/client.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import { memoryRegistrationStore } from "../auth/harness.js";
import {
  accountSetup,
  alice,
  CLIENT_ID,
  connectAndApprove,
  START_TIME,
} from "./harness.js";

/*
 * The edges of the adapter: where it will send a bearer, what it does with an
 * issuer it was told to trust, how it names what Vercel answered, and what it
 * refuses to believe. A binding that points the sign-in somewhere else is the
 * attack the destination rule exists for.
 */

const detailOf = (error: unknown) =>
  error instanceof ConnectorError ? error.detail : undefined;

const recordedDiscovery = readFileSync(
  new URL("../fixtures/vercel/openid-configuration.json", import.meta.url),
  "utf8",
);

/** Serves the recorded discovery document at Vercel's real issuer, and refuses everything else. */
const recordedVercel: typeof fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === "https://vercel.com/.well-known/openid-configuration")
    return new Response(recordedDiscovery, {
      headers: { "content-type": "application/json" },
    });
  return new Response("not found", { status: 404 });
};

test("the recorded discovery document resolves under the policy a host pins for the real Vercel", async () => {
  const policy = issuerPolicy(vercelAccountIssuerPolicy());
  const server = await resolveAuthorizationServer(policy, {
    fetch: recordedVercel,
  });
  assert.equal(server.issuer, "https://vercel.com");
  assert.equal(
    server.metadata.device_authorization_endpoint,
    "https://api.vercel.com/login/oauth/device-authorization",
  );
  assert.equal(
    server.metadata.token_endpoint,
    "https://api.vercel.com/login/oauth/token",
  );
  assert.equal(
    server.metadata.revocation_endpoint,
    "https://api.vercel.com/login/oauth/token/revoke",
  );
  assert.ok(
    server.metadata.grant_types_supported?.includes(
      "urn:ietf:params:oauth:grant-type:device_code",
    ),
  );
  // Without the host naming api.vercel.com, Vercel's own metadata cannot move the endpoints there.
  await assert.rejects(
    resolveAuthorizationServer(
      issuerPolicy({
        ...vercelAccountIssuerPolicy(),
        trustedOrigins: [],
        acceptIssuerDeclaredOrigins: false,
      }),
      { fetch: recordedVercel },
    ),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "network-policy",
  );
});

test("a pre-registered public client resolves against the recorded document; dynamic registration is refused by it", async () => {
  const ports = memoryPorts();
  ports.configuration.set("VERCEL_ACCOUNT_CLIENT_ID", CLIENT_ID);
  const sent: string[] = [];
  const spy: typeof fetch = (input, init) => {
    sent.push(`${init?.method ?? "GET"} ${String(input)}`);
    return recordedVercel(input, init);
  };
  const policy = issuerPolicy(vercelAccountIssuerPolicy());
  const server = await resolveAuthorizationServer(policy, { fetch: spy });
  const resolve = (candidate: typeof policy) =>
    resolveClientRegistration({
      actor: fixtureActor,
      policy: candidate,
      server,
      redirectUri: "https://app.example/callback",
      hostOrigin: "https://app.example",
      configuration: ports.configuration,
      fetch: spy,
      registrations: memoryRegistrationStore(),
      effects: ports.effects,
      now: () => START_TIME,
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code"],
    });
  const client = await resolve(policy);
  assert.equal(client.method, "none");
  assert.equal(client.client.client_id, CLIENT_ID);
  // The recorded document lists no `none` method, and registration will not
  // invent one: the host's only road is an application made on the dashboard.
  sent.length = 0;
  await assert.rejects(
    resolve(
      issuerPolicy({
        ...vercelAccountIssuerPolicy(),
        registration: {
          allowed: ["dynamic"],
          clientAuthentication: "none",
        },
      }),
    ),
    (error: unknown) => detailOf(error) === "oauth.registration.auth-method",
  );
  assert.deepEqual(sent, [], "nothing was sent to the registration endpoint");
});

test("the issuer policy for the real Vercel is pre-registered, `none`, and revokes only when asked", () => {
  const policy = issuerPolicy(vercelAccountIssuerPolicy());
  assert.equal(policy.issuer, "https://vercel.com");
  assert.deepEqual(policy.trustedOrigins, ["https://api.vercel.com"]);
  assert.deepEqual(policy.registration.allowed, ["pre-registered"]);
  assert.equal(policy.registration.clientAuthentication, "none");
  assert.equal(policy.allowLoopbackHttp, false);
  assert.equal(policy.revocation, "disabled");
  assert.equal(
    issuerPolicy(vercelAccountIssuerPolicy({ revoke: true })).revocation,
    "on-upstream-disconnect",
  );
});

function withDestinations(
  binding: ReturnType<typeof runtimeBindingSchema.parse>,
  destinations: Array<Record<string, unknown>>,
): AdapterCallContext {
  return {
    binding: runtimeBindingSchema.parse({
      ...binding,
      destinations,
      operations: [],
    }),
  } as AdapterCallContext;
}

test("a public destination is accepted only at api.vercel.com", async (t) => {
  const { binding } = await accountSetup(t);
  const api = (origin: string, extra = {}) => ({
    id: "api",
    origin,
    network: "public",
    ...extra,
  });
  assert.equal(
    accountApiDestination(
      withDestinations(binding, [api("https://api.vercel.com")]),
    ).origin,
    "https://api.vercel.com",
  );
  for (const origin of [
    "https://attacker.example",
    "https://vercel.com",
    "https://api.vercel.com.attacker.example",
  ])
    assert.throws(
      () => accountApiDestination(withDestinations(binding, [api(origin)])),
      (error: unknown) =>
        detailOf(error) === "vercel-account.destination.api-host",
      origin,
    );
  // A public destination is HTTPS before this rule is asked.
  assert.throws(() =>
    withDestinations(binding, [api("http://api.vercel.com")]),
  );
  assert.throws(
    () =>
      accountApiDestination(
        withDestinations(binding, [
          api("https://api.vercel.com", { pathPrefix: "/proxy" }),
        ]),
      ),
    (error: unknown) =>
      detailOf(error) === "vercel-account.destination.api-host",
  );
  assert.throws(
    () => accountApiDestination(withDestinations(binding, [])),
    (error: unknown) =>
      detailOf(error) === "vercel-account.destination.api-missing",
  );
});

test("a binding that points the account calls somewhere else is refused before the sign-in begins", async (t) => {
  const setup = await accountSetup(t, {
    apiOrigin: "https://attacker.example",
    apiNetwork: "public",
  });
  await assert.rejects(
    setup.service.connect(setup.person, {
      bindingRef: setup.binding.bindingRef,
      intent: {},
    }),
    (error: unknown) =>
      detailOf(error) === "vercel-account.destination.api-host",
  );
  assert.equal(setup.fixture.counts.device, 0, "no device request was made");
});

test("settings are reviewed values: an unknown key or an empty scope list is a configuration error", async (t) => {
  const { binding } = await accountSetup(t);
  const settingsOf = (value: unknown) =>
    ({ ...binding, settings: { "vercel-account": value } }) as typeof binding;
  assert.deepEqual(vercelAccountSettings(settingsOf({})).scopes, [
    "openid",
    "offline_access",
  ]);
  for (const bad of [{ scopes: [] }, { scopes: [""] }, { extra: 1 }, "x"])
    assert.throws(
      () => vercelAccountSettings(settingsOf(bad)),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "configuration-required" &&
        error.detail === "vercel-account.settings.invalid",
    );
});

test("the scopes the binding reviewed are the scopes asked for, and the scopes Vercel reports are what is recorded", async (t) => {
  const setup = await accountSetup(t, {
    teams: ["team_dummy_acme"],
    settings: { scopes: ["openid", "email", "offline_access"] },
  });
  const { connectionRef } = await connectAndApprove(setup);
  const [request] = setup.fixture.apiRequests.filter(
    (item) => item.url.pathname === "/login/oauth/device-authorization",
  );
  assert.equal(
    new URLSearchParams(request!.body.toString("utf8")).get("scope"),
    "openid email offline_access",
  );
  const held = await setup.heldMaterial(connectionRef);
  assert.equal(held["scope"], "openid email offline_access");
});

test("a binding that names no team is refused before anyone signs in", async (t) => {
  const setup = await accountSetup(t, { teams: [] });
  await assert.rejects(
    setup.service.connect(setup.person, {
      bindingRef: setup.binding.bindingRef,
      intent: {},
    }),
    (error: unknown) => detailOf(error) === "vercel-account.targets-missing",
  );
  assert.equal(setup.fixture.counts.device, 0);
});

test("only a person signs in: an organization or workload owner is refused", async (t) => {
  const setup = await accountSetup(t);
  for (const ownerKind of ["organization", "workload"] as const)
    await assert.rejects(
      setup.service.connect(setup.person, {
        bindingRef: setup.binding.bindingRef,
        ownerKind,
        intent: {},
      }),
      (error: unknown) => detailOf(error) === "vercel-account.owner-kind",
    );
  assert.equal(setup.fixture.counts.device, 0);
});

test("a host that has not configured the client id is told which configuration to set", async (t) => {
  const setup = await accountSetup(t, { clientId: null });
  const view = (await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  })) as { lifecycle: string; lastOutcome?: string; connectionRef: string };
  assert.equal(view.lifecycle, "configuration-required");
  assert.equal(view.lastOutcome, "configuration.missing");
  assert.equal(setup.fixture.counts.device, 0);
  // The adapter itself names the one setting that is missing.
  const started = await createVercelAccountAdapter().authorize!(
    await setup.adapterContext(view.connectionRef),
    { ownerKind: "user" } as never,
  );
  assert.deepEqual(started, {
    kind: "configuration-required",
    missing: ["VERCEL_ACCOUNT_CLIENT_ID"],
  });
});

test("a verification page that is not HTTPS or loopback is never shown to a person", async (t) => {
  const setup = await accountSetup(t, {
    double: { verificationBase: "http://phish.example.test" },
  });
  await assert.rejects(
    setup.service.connect(setup.person, {
      bindingRef: setup.binding.bindingRef,
      intent: {},
    }),
    (error: unknown) => detailOf(error) === "oauth.device.verification-uri",
  );
});

test("an unfamiliar status collapses to a fixed code, and the provider's words never travel", () => {
  const cases: Array<[number, string, string]> = [
    [401, "upstream-rejected", "vercel-account.api.unauthorized"],
    [403, "denied", "vercel-account.api.forbidden"],
    [404, "not-found", "vercel-account.api.not-found"],
    [429, "rate-limited", "vercel-account.api.throttled"],
    [500, "upstream-unavailable", "vercel-account.api.unavailable"],
    [503, "upstream-unavailable", "vercel-account.api.unavailable"],
    [418, "upstream-rejected", "vercel-account.api.rejected"],
    [400, "upstream-rejected", "vercel-account.api.rejected"],
  ];
  for (const [status, code, detail] of cases) {
    const error = apiFailure(status);
    assert.equal(error.code, code, String(status));
    assert.equal(error.detail, detail, String(status));
  }
});

function contextFor(
  binding: ReturnType<typeof runtimeBindingSchema.parse>,
  origin: string,
): AdapterCallContext {
  return {
    binding: runtimeBindingSchema.parse({
      ...binding,
      destinations: [{ id: "api", origin, network: "loopback-fixture" }],
      operations: [],
    }),
    signal: new AbortController().signal,
    environment: { fetch: globalThis.fetch },
  } as unknown as AdapterCallContext;
}

test("a response over the byte ceiling, a redirect, a malformed body and a body of the wrong shape are refused", async (t) => {
  const { binding } = await accountSetup(t);
  let mode = "large";
  const server = await startHttpFixture(() => {
    switch (mode) {
      case "large":
        return {
          status: 200,
          body: `{"user":{"id":"${"x".repeat(1_048_577)}"}}`,
        };
      case "redirect":
        return {
          status: 302,
          headers: { location: "https://elsewhere.example/" },
        };
      case "garbage":
        return { status: 200, body: "not json at all" };
      case "shape":
        return { status: 200, body: { user: { id: 7 } } };
      case "teams-shape":
        return { status: 200, body: { teams: [{ id: "t" }] } };
      default:
        return { status: 200, body: { user: { id: "u" } } };
    }
  });
  t.after(() => server.close());
  const ctx = contextFor(binding, server.origin);
  const outcome = async (as: string) => {
    mode = as;
    try {
      await readUser(ctx, "vca_dummy_bearer");
    } catch (error) {
      return detailOf(error);
    }
    return "ok";
  };
  assert.equal(await outcome("large"), "vercel-account.response.too-large");
  assert.equal(await outcome("redirect"), "vercel-account.network");
  assert.equal(await outcome("garbage"), "vercel-account.api.invalid-response");
  assert.equal(await outcome("shape"), "vercel-account.api.invalid-response");
  assert.equal(await outcome("fine"), "ok");
  mode = "teams-shape";
  await assert.rejects(
    listTeams(ctx, "vca_dummy_bearer"),
    (error: unknown) =>
      detailOf(error) === "vercel-account.api.invalid-response",
  );
  assert.equal(
    server.requests.at(-1)!.headers["authorization"],
    "Bearer vca_dummy_bearer",
  );
});

test("a bearer is sent once per request, to the approved origin, and a team listing is bounded", async (t) => {
  const { binding } = await accountSetup(t);
  let served = 0;
  const server = await startHttpFixture(() => ({
    status: 200,
    body: {
      teams: [{ id: `team_${served++}`, slug: "s" }],
      pagination: { next: 5 },
    },
  }));
  t.after(() => server.close());
  const listing = await listTeams(
    contextFor(binding, server.origin),
    "vca_dummy_bearer",
  );
  assert.equal(
    listing.truncated,
    true,
    "an endless listing stops at the page bound",
  );
  assert.equal(listing.teams.length, 5);
  assert.equal(server.requests.length, 5);
  for (const request of server.requests) {
    assert.equal(request.headers["authorization"], "Bearer vca_dummy_bearer");
    assert.equal(request.url.pathname, "/v2/teams");
    assert.equal(request.url.searchParams.get("limit"), "100");
  }
});

test("teams beyond the page bound are reported as more, and are not found by name", async (t) => {
  const many = {
    ...alice,
    teams: Array.from({ length: 7 }, (_, index) => ({
      id: `team_dummy_${index}`,
      slug: `team-${index}`,
      createdAt: START_TIME - (index + 1) * 86_400_000,
    })),
  };
  const setup = await accountSetup(t, {
    people: [many],
    teams: many.teams.map((team) => team.id),
    double: { pageCap: 1 },
  });
  const first = await connectAndApprove(setup);
  const view = first.polled as { presentation?: { instructions?: string } };
  assert.match(view.presentation!.instructions!, /more are available/);
  assert.match(view.presentation!.instructions!, /team-0/);
  assert.equal(
    view.presentation!.instructions!.includes("team-6"),
    false,
    "the sixth and seventh pages were not read",
  );
  assert.equal(setup.fixture.counts.teams, 5);
});

test("the adapter refuses completions it has no meaning for, and operations it was not bound to", async (t) => {
  const setup = await accountSetup(t);
  const adapter = createVercelAccountAdapter();
  const ctx = {
    binding: setup.binding,
    generation: 0,
  } as unknown as AdapterCallContext;
  const redirect = await adapter.complete!(ctx, {
    kind: "redirect",
    url: new URL("https://app.example/callback"),
  });
  assert.equal(redirect.state, "denied");
  assert.equal(redirect.code, "vercel-account.completion.unsupported");
  await assert.rejects(
    adapter.invoke!(ctx, {
      operationRef: "nothing",
      input: {},
      commandId: "c",
    }),
    (error: unknown) => detailOf(error) === "vercel-account.operation.unbound",
  );
  assert.equal(
    (await adapter.verify!(ctx)).code,
    "vercel-account.not-connected",
  );
  assert.deepEqual(await adapter.disconnect!(ctx, "broker"), {
    local: "not-attempted",
    broker: "unsupported",
    upstream: "not-attempted",
  });
  assert.deepEqual(await adapter.disconnect!(ctx, "local"), {
    local: "not-attempted",
    broker: "not-attempted",
    upstream: "not-attempted",
  });
  assert.equal((await adapter.revoke!(ctx)).upstream, "not-attempted");
});

test("an operation on a connection with no credential, or with the wrong input, does nothing", async (t) => {
  const setup = await accountSetup(t);
  const adapter = createVercelAccountAdapter();
  const base = { binding: setup.binding, generation: 0 };
  const idle = await adapter.invoke!(
    {
      ...base,
      connection: { credentialRef: undefined },
    } as unknown as AdapterCallContext,
    { operationRef: "vercel-account.get-user", input: {}, commandId: "c" },
  );
  assert.equal(idle.state, "human-required");
  assert.equal(idle.code, "vercel-account.not-connected");
  const { connectionRef } = await connectAndApprove(setup, {
    target: { kind: "vercel-team", id: "team_dummy_labs" },
  });
  const ctx = await setup.adapterContext(connectionRef);
  const before = setup.fixture.apiRequests.length;
  await assert.rejects(
    adapter.invoke!(ctx, {
      operationRef: "vercel-account.get-user",
      input: { extra: 1 },
      commandId: "c",
    }),
    (error: unknown) => detailOf(error) === "vercel-account.input.invalid",
  );
  assert.equal(setup.fixture.apiRequests.length, before);
});

test("an upstream disconnect with the endpoint down is reported failed, not applied", async (t) => {
  const setup = await accountSetup(t, {
    revoke: true,
    teams: ["team_dummy_acme"],
  });
  const { connectionRef, polled } = await connectAndApprove(setup);
  await setup.fixture.stopApi();
  const result = await setup.service.disconnect(setup.person, connectionRef, {
    expectedRevision: (polled as { revision: number }).revision,
    scope: "upstream",
  });
  assert.equal(result.result.upstream, "failed");
});

test("the capability rows state protocol-fixture evidence and nothing live, and name the non-goal", () => {
  const rows = createVercelAccountAdapter().capabilities(
    new Set(["VERCEL_ACCOUNT_CLIENT_ID"]),
  );
  for (const row of rows) {
    assert.notEqual(row.evidence, "live");
    assert.notEqual(row.evidence, "certified");
    if (row.implementation === "implemented")
      assert.equal(row.evidence, "protocol-fixture", row.dimension);
  }
  const authorize = rows.find((row) => row.dimension === "authorize")!;
  assert.match(authorize.limitations.join(" "), /loopback double/);
  assert.match(
    authorize.limitations.join(" "),
    /Authorization code with PKCE is not implemented here/,
  );
  // Without the client id configured the sign-in is not ready.
  const missing = createVercelAccountAdapter()
    .capabilities(new Set())
    .find((row) => row.dimension === "authorize")!;
  assert.equal(missing.configuration, "missing");
});

test("every assumption the double serves is written down once, in the module", () => {
  assert.equal(
    new Set(VERCEL_ACCOUNT_ASSUMPTIONS).size,
    VERCEL_ACCOUNT_ASSUMPTIONS.length,
  );
  for (const keyword of [
    "device authorization endpoint",
    "Sign in with Vercel dashboard",
    "`none`",
    "verification page",
    "revocation endpoint",
    "rotates",
    "offline_access",
    "private beta",
    "until",
  ])
    assert.ok(
      VERCEL_ACCOUNT_ASSUMPTIONS.some((line) => line.includes(keyword)),
      keyword,
    );
});
