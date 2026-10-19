import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { inspect } from "node:util";
import {
  accountSetup,
  alice,
  connectAndChoose,
  connectionRefOf,
  type AccountSetup,
  type AccountSetupOptions,
} from "./harness.js";

/*
 * A disconnect that was not asked to go to Vercel still ends the sign-in
 * there, on a best-effort basis: the refresh token and then the access token
 * go to the revocation endpoint (RFC 7009) with the `none` client's client_id,
 * and the result says whether Vercel acknowledged (`release`: revoked true,
 * false or "unavailable", and a stable code). Nothing Vercel does, or fails to
 * do, stops the disconnect, and no token or provider word is in what comes
 * back.
 */

type Disconnected = Awaited<ReturnType<AccountSetup["service"]["disconnect"]>>;
type View = { lifecycle: string; revision: number };
const CANARY = "CANARY_PROVIDER_WORDS_77ac";

async function disconnect(
  setup: AccountSetup,
  scope: "local" | "upstream" = "local",
) {
  const { connectionRef, done } = await connectAndChoose(setup);
  const before = await setup.record(connectionRef);
  const result = await setup.service.disconnect(setup.person, connectionRef, {
    expectedRevision: (done as View).revision,
    scope,
  });
  return { connectionRef, before, result };
}

/** Custody holds nothing for the connection any more. */
async function custodyEmpty(
  setup: AccountSetup,
  before: Awaited<ReturnType<AccountSetup["record"]>>,
) {
  const scope = {
    tenantId: before.tenantId,
    ownerKind: before.ownerKind,
    ownerId: before.ownerId,
    connectionRef: before.connectionRef,
    bindingRef: before.bindingRef,
    custody: before.custody,
  };
  return (
    (await setup.ports.credentials.describe(scope, before.credentialRef!)) ===
    undefined
  );
}

const closedLocally = (result: Disconnected) => {
  assert.equal(result.result.local, "applied");
  assert.equal(result.result.upstream, "not-attempted");
  assert.equal((result.connection as View).lifecycle, "locally-disconnected");
};

test("a local disconnect presents the refresh token, then the access token, and says Vercel acknowledged", async (t) => {
  const setup = await accountSetup(t);
  const { before, result } = await disconnect(setup);
  const { accessTokens, refreshTokens } = setup.fixture.issued;

  closedLocally(result);
  assert.deepEqual(result.result.release, {
    revoked: true,
    reason: "oauth.revoke.applied",
  });
  assert.deepEqual(
    setup.fixture.revocations.map((item) => [item.token, item.hint]),
    [
      [refreshTokens[0], "refresh_token"],
      [accessTokens[0], "access_token"],
    ],
  );
  assert.equal(setup.fixture.accessTokenValid(accessTokens[0]!), false);
  assert.equal(setup.fixture.refreshTokenUsable(refreshTokens[0]!), false);
  assert.deepEqual(
    setup.fixture.violations,
    [],
    "a none client sent its client_id and nothing that authenticates it",
  );
  assert.equal(await custodyEmpty(setup, before), true);
});

test("an upstream disconnect still reports its revocation as the upstream outcome, once", async (t) => {
  const setup = await accountSetup(t);
  const { result } = await disconnect(setup, "upstream");
  assert.equal(result.result.upstream, "applied");
  assert.equal(result.result.release, undefined);
  assert.equal(setup.fixture.counts.revoke, 2, "two tokens, not four");
});

test("revocation pinned off in the issuer policy is said to be unavailable, and nothing is sent", async (t) => {
  const setup = await accountSetup(t, { revoke: false });
  const { before, result } = await disconnect(setup);
  closedLocally(result);
  assert.deepEqual(result.result.release, {
    revoked: "unavailable",
    reason: "oauth.revoke.disabled",
  });
  assert.equal(setup.fixture.counts.revoke, 0);
  assert.equal(await custodyEmpty(setup, before), true);
});

test("an issuer whose metadata names no revocation endpoint is said to have none, and the disconnect completes", async (t) => {
  const setup = await accountSetup(t, {
    double: { omitRevocationEndpoint: true },
  });
  const { before, result } = await disconnect(setup);
  closedLocally(result);
  assert.deepEqual(result.result.release, {
    revoked: "unavailable",
    reason: "oauth.revoke.no-endpoint",
  });
  assert.equal(setup.fixture.counts.revoke, 0);
  assert.equal(await custodyEmpty(setup, before), true);
});

test("a connection that never held a sign-in has nothing to release", async (t) => {
  const setup = await accountSetup(t);
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  const result = await setup.service.disconnect(
    setup.person,
    connectionRefOf(connected),
    { expectedRevision: (connected as View).revision, scope: "local" },
  );
  closedLocally(result);
  assert.deepEqual(result.result.release, {
    revoked: "unavailable",
    reason: "oauth.revoke.no-session",
  });
  assert.equal(setup.fixture.counts.revoke, 0);
});

/** Each way the revocation request can fail, and the code that says so. */
const failures: Array<
  [
    name: string,
    arrange: (setup: AccountSetup) => Promise<void> | void,
    reason: string,
    options?: AccountSetupOptions,
  ]
> = [
  [
    "a 5xx answer",
    (setup) => setup.fixture.failRevocation(503),
    "oauth.revoke.refused",
  ],
  [
    "a 4xx answer",
    (setup) => setup.fixture.failRevocation(401),
    "oauth.revoke.refused",
  ],
  [
    "a connection dropped after the request was sent",
    (setup) => setup.fixture.failRevocation("drop"),
    "oauth.revoke.indeterminate",
  ],
  [
    "an endpoint nobody is listening on",
    (setup) => setup.fixture.stopApi(),
    "oauth.revoke.unreachable",
  ],
  [
    "an endpoint that never answers",
    (setup) => setup.fixture.failRevocation("hang"),
    "oauth.revoke.indeterminate",
    { callTimeoutMs: 400 },
  ],
];

for (const [name, arrange, reason, options] of failures)
  test(`a revocation that meets ${name} is reported and never stops the disconnect`, async (t: TestContext) => {
    const setup = await accountSetup(t, {
      double: { errorWords: CANARY },
      ...options,
    });
    const { connectionRef, done } = await connectAndChoose(setup);
    const before = await setup.record(connectionRef);
    await arrange(setup);
    const started = Date.now();
    const result = await setup.service.disconnect(setup.person, connectionRef, {
      expectedRevision: (done as View).revision,
      scope: "local",
    });
    assert.ok(Date.now() - started < 5_000, "the wait for Vercel is bounded");

    closedLocally(result);
    assert.deepEqual(result.result.release, { revoked: false, reason });
    assert.equal(await custodyEmpty(setup, before), true);
    assert.equal(
      setup.fixture.accessTokenValid(setup.fixture.issued.accessTokens[0]!),
      true,
      "Vercel did not end the token, and the result does not say it did",
    );
    assert.equal(JSON.stringify(result).includes(CANARY), false);
  });

test("an issuer that cannot be reached to find the endpoint is reported, not thrown", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef, done } = await connectAndChoose(setup);
  const before = await setup.record(connectionRef);
  await setup.fixture.stopIssuer();
  const result = await setup.service.disconnect(setup.person, connectionRef, {
    expectedRevision: (done as View).revision,
    scope: "local",
  });
  closedLocally(result);
  assert.equal(result.result.release?.revoked, false);
  assert.match(result.result.release?.reason ?? "", /^oauth\.revoke\./);
  assert.equal(await custodyEmpty(setup, before), true);
});

test("no token, no provider word and no identity is in anything the disconnect leaves behind", async (t) => {
  const printed: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const)
    t.mock.method(console, method, (...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
  const surfaces: Array<[string, unknown]> = [];
  for (const [label, arrange] of [
    ["acknowledged", () => {}],
    ["refused", (setup: AccountSetup) => setup.fixture.failRevocation(500)],
    ["dropped", (setup: AccountSetup) => setup.fixture.failRevocation("drop")],
  ] as const) {
    const setup = await accountSetup(t, { double: { errorWords: CANARY } });
    const { connectionRef, done } = await connectAndChoose(setup);
    // The control: the secrets the sweep looks for are really in custody now.
    const held = JSON.stringify(await setup.heldMaterial(connectionRef));
    assert.ok(held.includes(setup.fixture.issued.accessTokens[0]!));
    assert.ok(held.includes(setup.fixture.issued.refreshTokens[0]!));
    arrange(setup);
    const result = await setup.service.disconnect(setup.person, connectionRef, {
      expectedRevision: (done as View).revision,
      scope: "local",
    });
    const issued = setup.fixture.issued;
    const secrets = [
      ...issued.deviceCodes,
      ...issued.accessTokens,
      ...issued.refreshTokens,
      ...issued.idTokens,
      alice.email!,
      CANARY,
    ];
    assert.ok(secrets.length > 5, "the ceremony issued secrets to look for");
    surfaces.push(
      [`${label}: result`, result],
      [`${label}: record`, await setup.record(connectionRef)],
      [
        `${label}: evidence`,
        await setup.ports.evidence.list(setup.person, connectionRef),
      ],
      [`${label}: journal`, setup.journal],
      [`${label}: printed`, inspect(printed, { depth: null })],
    );
    for (const [name, value] of surfaces.slice(-5)) {
      const text = JSON.stringify(value) ?? "";
      for (const secret of secrets)
        assert.equal(text.includes(secret), false, `${name} holds a secret`);
    }
  }
});

test("a release that meets a refresh already in flight waits for it and revokes the tokens it issued", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef, done } = await connectAndChoose(setup);
  // The access token is close to lapsing, so a verify refreshes it: hold that request.
  setup.advance(59 * 60_000);
  const real = globalThis.fetch;
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (new URL(url).pathname === "/login/oauth/token") {
        reached.resolve();
        await gate.promise;
      }
      return real(input, init);
    },
  );
  const verifying = setup.service
    .verify(setup.person, connectionRef)
    .catch(() => undefined);
  await reached.promise;

  const disconnecting = setup.service.disconnect(setup.person, connectionRef, {
    expectedRevision: (done as View).revision,
    scope: "local",
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  gate.resolve();
  const result = await disconnecting;
  await verifying;

  closedLocally(result);
  assert.deepEqual(result.result.release, {
    revoked: true,
    reason: "oauth.revoke.applied",
  });
  const { accessTokens, refreshTokens } = setup.fixture.issued;
  assert.equal(accessTokens.length, 2, "the held refresh did go through");
  assert.equal(
    setup.fixture.refreshTokenUsable(refreshTokens[1]!),
    false,
    "the refresh token the rotation issued is the one revoked",
  );
  assert.equal(setup.fixture.accessTokenValid(accessTokens[1]!), false);
});
