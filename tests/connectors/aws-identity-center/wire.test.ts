import assert from "node:assert/strict";
import test from "node:test";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import { runtimeBindingSchema } from "../../../src/server/connectors/binding.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  AWS_ASSUMPTIONS,
  awsSettings,
  createAwsIdentityCenterAdapter,
  oidcErrorCode,
  portalFailure,
  registerClientResponseSchema,
} from "../../../src/server/connectors/providers/aws-identity-center/index.js";
import {
  awsDestination,
  callAws,
  readBounded,
} from "../../../src/server/connectors/providers/aws-identity-center/client.js";
import {
  parseMaterial,
  serializeMaterial,
  signedIn,
} from "../../../src/server/connectors/providers/aws-identity-center/material.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import {
  awsSetup,
  connectAndApprove,
  connectionRefOf,
  handoffRefOf,
  REGION,
  userCodeOf,
} from "./harness.js";

/*
 * The edges of the adapter: where it will send a secret, what it does with a
 * host it was not told to trust, how it names what AWS answered, and what it
 * refuses to believe. A binding that points the sign-in somewhere else is the
 * attack this module's destination rule exists for.
 */

const detailOf = (error: unknown) =>
  error instanceof ConnectorError ? error.detail : undefined;

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

test("a public destination is accepted only at the documented host for the reviewed Region", async (t) => {
  const { binding } = await awsSetup(t);
  const host = (id: string, origin: string, extra = {}) => ({
    id,
    origin,
    network: "public",
    ...extra,
  });
  const good = withDestinations(binding, [
    host("oidc", `https://oidc.${REGION}.amazonaws.com`),
    host("portal", `https://portal.sso.${REGION}.amazonaws.com`),
  ]);
  assert.equal(
    awsDestination(good, "oidc").origin,
    `https://oidc.${REGION}.amazonaws.com`,
  );
  assert.equal(
    awsDestination(good, "portal").origin,
    `https://portal.sso.${REGION}.amazonaws.com`,
  );
  const refused = (
    destinations: Array<Record<string, unknown>>,
    role: "oidc" | "portal",
  ) =>
    assert.throws(
      () => awsDestination(withDestinations(binding, destinations), role),
      (error: unknown) =>
        detailOf(error) === `aws-identity-center.destination.${role}-region`,
    );
  refused([host("oidc", "https://oidc.us-west-2.amazonaws.com")], "oidc");
  refused([host("oidc", "https://evil.example")], "oidc");
  refused(
    [
      host("oidc", `https://oidc.${REGION}.amazonaws.com`, {
        pathPrefix: "/x",
      }),
    ],
    "oidc",
  );
  // The portal's host is not the OIDC host, so swapping them cannot work.
  refused([host("portal", `https://oidc.${REGION}.amazonaws.com`)], "portal");
  assert.throws(
    () => awsDestination(withDestinations(binding, []), "oidc"),
    (error: unknown) =>
      detailOf(error) === "aws-identity-center.destination.oidc-missing",
  );
});

test("settings are reviewed values: a Region or a start URL of the wrong shape is a configuration error", async (t) => {
  const { binding } = await awsSetup(t);
  const settingsFor = (settings: unknown) =>
    runtimeBindingSchema.parse({
      ...binding,
      settings: { "aws-identity-center": settings },
    });
  const valid = awsSettings(
    settingsFor({
      region: "eu-west-2",
      startUrl: "https://a.awsapps.com/start",
    }),
  );
  assert.deepEqual(valid.scopes, ["sso:account:access"]);
  assert.equal(valid.clientName, "Ceremony");
  for (const bad of [
    { region: "us_east_1", startUrl: "https://a.awsapps.com/start" },
    { region: "eu-west-2", startUrl: "http://a.awsapps.com/start" },
    { region: "eu-west-2", startUrl: "https://a.awsapps.com/start", extra: 1 },
    { startUrl: "https://a.awsapps.com/start" },
  ])
    assert.throws(
      () => awsSettings(settingsFor(bad)),
      (error: unknown) =>
        detailOf(error) === "aws-identity-center.settings.invalid",
    );
});

test("a binding that names no account is refused before anyone signs in", async (t) => {
  const setup = await awsSetup(t, { accounts: [] });
  await assert.rejects(
    setup.service.connect(setup.person, {
      bindingRef: setup.binding.bindingRef,
      intent: {},
    }),
    (error: unknown) =>
      detailOf(error) === "aws-identity-center.targets-missing",
  );
  assert.equal(setup.fixture.counts.register, 0, "no client was registered");
});

test("only a person signs in: an organization or workload owner is refused", async (t) => {
  const setup = await awsSetup(t);
  await assert.rejects(
    setup.service.connect(setup.person, {
      bindingRef: setup.binding.bindingRef,
      ownerKind: "organization",
      intent: {},
    }),
    (error: unknown) => detailOf(error) === "aws-identity-center.owner-kind",
  );
  assert.equal(setup.fixture.counts.register, 0);
});

test("a client secret that is about to expire is not used", async (t) => {
  const setup = await awsSetup(t, {
    double: { clientSecretLifetimeSeconds: 120 },
  });
  await assert.rejects(
    setup.service.connect(setup.person, {
      bindingRef: setup.binding.bindingRef,
      intent: {},
    }),
    (error: unknown) =>
      detailOf(error) === "aws-identity-center.registration.expired",
  );
  assert.equal(setup.fixture.counts.deviceAuthorization, 0);
});

test("a verification page that is not HTTPS or loopback is never shown to a person", async (t) => {
  const setup = await awsSetup(t, {
    double: { verificationBase: "http://phish.example.test" },
  });
  await assert.rejects(
    setup.service.connect(setup.person, {
      bindingRef: setup.binding.bindingRef,
      intent: {},
    }),
    (error: unknown) =>
      detailOf(error) === "aws-identity-center.device.verification-uri",
  );
});

test("credentials whose expiration cannot be a role session are refused, not stored", async (t) => {
  for (const roleLifetimeMs of [30_000, 14 * 3_600_000]) {
    const setup = await awsSetup(t, {
      accounts: ["444455556666"],
      double: { roleLifetimeMs },
    });
    const connected = await setup.service.connect(setup.person, {
      bindingRef: setup.binding.bindingRef,
      intent: {},
    });
    setup.fixture.approve(userCodeOf(connected));
    setup.advance(6_000);
    await assert.rejects(
      setup.service.poll(setup.person, connectionRefOf(connected)),
      (error: unknown) =>
        detailOf(error) === "aws-identity-center.role.expiration",
    );
  }
});

test("an unfamiliar OIDC error code collapses to one detail and a portal status to a fixed code", () => {
  assert.equal(oidcErrorCode("invalid_grant"), "invalid-grant");
  assert.equal(oidcErrorCode("slow_down"), "slow-down");
  assert.equal(oidcErrorCode("<script>alert(1)</script>"), "rejected");
  assert.equal(oidcErrorCode(""), "rejected");
  const expectations: Array<[number, string, string]> = [
    [400, "invalid-request", "aws-identity-center.portal.invalid-request"],
    [401, "upstream-rejected", "aws-identity-center.portal.unauthorized"],
    [404, "not-found", "aws-identity-center.portal.not-found"],
    [429, "rate-limited", "aws-identity-center.portal.throttled"],
    [503, "upstream-unavailable", "aws-identity-center.portal.unavailable"],
    [418, "upstream-rejected", "aws-identity-center.portal.rejected"],
  ];
  for (const [status, code, detail] of expectations) {
    const failure = portalFailure(status);
    assert.equal(failure.code, code);
    assert.equal(failure.detail, detail);
  }
});

test("a response over the byte ceiling, a redirect and a malformed body are refused", async (t) => {
  await assert.rejects(
    readBounded(new Response("x".repeat(1_048_577))),
    (error: unknown) =>
      detailOf(error) === "aws-identity-center.response.too-large",
  );
  assert.equal(await readBounded(new Response("ok")), "ok");
  const setup = await awsSetup(t);
  const server = await startHttpFixture((request) => {
    if (request.url.pathname === "/client/register")
      return {
        status: 302,
        headers: { location: "https://elsewhere.example/" },
      };
    return { status: 200, body: "not json at all" };
  });
  t.after(() => server.close());
  const ctx = {
    binding: runtimeBindingSchema.parse({
      ...setup.binding,
      destinations: [
        { id: "oidc", origin: server.origin, network: "loopback-fixture" },
        { id: "portal", origin: server.origin, network: "loopback-fixture" },
      ],
    }),
    signal: new AbortController().signal,
    environment: { fetch: globalThis.fetch },
  } as unknown as AdapterCallContext;
  await assert.rejects(
    callAws(ctx, {
      role: "oidc",
      method: "POST",
      path: "/client/register",
      body: {},
      schema: registerClientResponseSchema,
    }),
    (error: unknown) => detailOf(error) === "aws-identity-center.network",
  );
  await assert.rejects(
    callAws(ctx, {
      role: "oidc",
      method: "POST",
      path: "/token",
      body: {},
      schema: registerClientResponseSchema,
    }),
    (error: unknown) =>
      detailOf(error) === "aws-identity-center.oidc.invalid-response",
  );
});

test("stored material that is not a whole sign-in is refused, and a whole one round-trips", () => {
  const whole = {
    phase: "role-bound" as const,
    clientId: "client",
    clientSecret: "secret",
    clientSecretExpiresAt: 2_000_000_000_000,
    accessToken: "token",
    accessTokenExpiresAt: 1_900_000_000_000,
    refreshToken: "refresh",
    role: {
      accessKeyId: "ASIAXXXXXXXXXXXXXXXX",
      secretAccessKey: "key",
      sessionToken: "session",
      expiresAt: 1_800_000_000_000,
    },
  };
  assert.deepEqual(parseMaterial(serializeMaterial(whole)), whole);
  const raw = serializeMaterial(whole);
  const broken: Array<Record<string, string>> = [
    { ...raw, client_id: "" },
    { ...raw, sso_access_token_expires_at: "soon" },
    { ...raw, role_expires_at: "-1" },
    Object.fromEntries(
      Object.entries(raw).filter(([key]) => key !== "session_token"),
    ),
    Object.fromEntries(
      Object.entries(raw).filter(([key]) => key !== "sso_access_token"),
    ),
  ];
  for (const material of broken)
    assert.throws(
      () => parseMaterial(material),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "conflict" &&
        error.detail === "aws-identity-center.credential.malformed",
    );
});

test("a token that is not a bearer token is refused, and an over-long lifetime is bounded", () => {
  const registered = {
    phase: "registered" as const,
    clientId: "c",
    clientSecret: "s",
    clientSecretExpiresAt: 2_000_000_000_000,
  };
  assert.throws(
    () =>
      signedIn(
        registered,
        { accessToken: "t", tokenType: "MAC", expiresIn: 60 },
        1000,
      ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "upstream-rejected" &&
      error.detail === "aws-identity-center.token.type",
  );
  const ok = signedIn(
    registered,
    { accessToken: "t", tokenType: "bearer", expiresIn: 10 ** 9 },
    1000,
  );
  assert.equal(ok.accessTokenExpiresAt, 1000 + 30 * 86_400_000);
  assert.equal(ok.phase, "signed-in");
  // A refresh answered without a refresh token leaves none: the one presented is spent.
  const again = signedIn(
    { ...ok, refreshToken: "spent" },
    { accessToken: "u", expiresIn: 60 },
    2000,
  );
  assert.equal("refreshToken" in again, false);
});

test("the adapter refuses completions it has no meaning for, and operations it was not bound to", async (t) => {
  const setup = await awsSetup(t);
  const adapter = createAwsIdentityCenterAdapter();
  const ctx = {
    binding: setup.binding,
    generation: 0,
  } as unknown as AdapterCallContext;
  const redirect = await adapter.complete!(ctx, {
    kind: "redirect",
    url: new URL("https://app.example/callback"),
  });
  assert.equal(redirect.state, "denied");
  assert.equal(redirect.code, "aws-identity-center.completion.unsupported");
  await assert.rejects(
    adapter.invoke!(ctx, {
      operationRef: "nothing",
      input: {},
      commandId: "c",
    }),
    (error: unknown) =>
      detailOf(error) === "aws-identity-center.operation.unbound",
  );
  assert.equal(
    (await adapter.verify!(ctx)).code,
    "aws-identity-center.not-connected",
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
  const setup = await awsSetup(t);
  const adapter = createAwsIdentityCenterAdapter();
  const base = { binding: setup.binding, generation: 0 };
  const idle = await adapter.invoke!(
    {
      ...base,
      connection: { credentialRef: undefined },
    } as unknown as AdapterCallContext,
    {
      operationRef: "aws-identity-center.list-accounts",
      input: {},
      commandId: "c",
    },
  );
  assert.equal(idle.state, "human-required");
  assert.equal(idle.code, "aws-identity-center.not-connected");
  const { connectionRef } = await connectAndApprove(setup, {
    target: { kind: "aws-account", id: "444455556666" },
  });
  const ctx = await setup.adapterContext(connectionRef);
  await assert.rejects(
    adapter.invoke!(ctx, {
      operationRef: "aws-identity-center.list-accounts",
      input: { extra: 1 },
      commandId: "c",
    }),
    (error: unknown) => detailOf(error) === "aws-identity-center.input.invalid",
  );
  await assert.rejects(
    adapter.invoke!(ctx, {
      operationRef: "aws-identity-center.list-account-roles",
      input: { "aws-account": "not-an-account" },
      commandId: "c",
    }),
    (error: unknown) => detailOf(error) === "aws-identity-center.input.invalid",
  );
  assert.equal(handoffRefOf({ handoff: { handoffRef: "h" } }), "h");
});

test("a sign-in session that is already over reports a failed upstream disconnect", async (t) => {
  const setup = await awsSetup(t, { accounts: ["444455556666"] });
  const { connectionRef } = await connectAndApprove(setup);
  setup.fixture.expireAccessToken(setup.fixture.issued.accessTokens[0]!);
  const adapter = createAwsIdentityCenterAdapter();
  const result = await adapter.disconnect!(
    await setup.adapterContext(connectionRef),
    "upstream",
  );
  assert.equal(result.upstream, "failed");
  assert.equal(setup.fixture.counts.logout, 1);
});

test("every assumption the double serves is written down once, in the module", () => {
  assert.equal(new Set(AWS_ASSUMPTIONS).size, AWS_ASSUMPTIONS.length);
  for (const keyword of [
    "portal.sso.<region>",
    "epoch milliseconds",
    "epoch seconds",
    "slow_down",
    "invalid_grant",
    "refresh_token grant",
    "single use",
    "ResourceNotFoundException",
    "lapsed access token",
    "another client",
    "Logout (POST /logout",
    "not known to stop working after Logout",
  ])
    assert.ok(
      AWS_ASSUMPTIONS.some((line) => line.includes(keyword)),
      keyword,
    );
});
