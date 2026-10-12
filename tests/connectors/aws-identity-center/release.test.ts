import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import {
  awsSetup,
  connectAndChoose,
  connectionRefOf,
  userCodeOf,
  type AwsSetup,
} from "./harness.js";

/*
 * A disconnect that was not asked to go to AWS still ends the sign-in session
 * at the portal (`Logout`), best effort: the result says whether the portal
 * acknowledged (`release`: revoked true, false or "unavailable", and a stable
 * code), and nothing the portal does or fails to do stops the disconnect. The
 * Logout reference says role sessions already issued continue until their own
 * expiry and speaks of no refresh token, so `revoked: true` is a statement
 * about the sign-in session only, and these tests hold the result to that.
 */

type View = { lifecycle: string; revision: number };
type Disconnected = Awaited<ReturnType<AwsSetup["service"]["disconnect"]>>;
const CODE = "aws-identity-center.release";

async function custodyEmpty(setup: AwsSetup, connectionRef: string) {
  const record = await setup.record(connectionRef);
  const scope = {
    tenantId: record.tenantId,
    ownerKind: record.ownerKind,
    ownerId: record.ownerId,
    connectionRef: record.connectionRef,
    bindingRef: record.bindingRef,
    custody: record.custody,
  };
  return (
    (await setup.ports.credentials.describe(scope, record.credentialRef!)) ===
    undefined
  );
}

const closedLocally = (result: Disconnected) => {
  assert.equal(result.result.local, "applied");
  assert.equal(result.result.upstream, "not-attempted");
  assert.equal((result.connection as View).lifecycle, "locally-disconnected");
};

async function disconnectActive(setup: AwsSetup) {
  const { connectionRef, done } = await connectAndChoose(setup);
  const role = setup.fixture.issued.roleCredentials[0]!;
  const result = await setup.service.disconnect(setup.person, connectionRef, {
    expectedRevision: (done as View).revision,
    scope: "local",
  });
  return { connectionRef, role, result };
}

test("a local disconnect ends the portal session, says so, and does not claim to end role sessions or the refresh token", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef, role, result } = await disconnectActive(setup);

  closedLocally(result);
  assert.deepEqual(result.result.release, {
    revoked: true,
    reason: `${CODE}.session-ended`,
  });
  assert.equal(setup.fixture.counts.logout, 1);
  const after = await fetch(
    `${setup.fixture.portalOrigin}/assignment/accounts`,
    {
      headers: {
        "x-amz-sso_bearer_token": setup.fixture.issued.accessTokens[0]!,
      },
    },
  );
  assert.equal(after.status, 401, "the sign-in session is over");
  assert.equal(
    setup.fixture.roleSessionValid(role.accessKeyId),
    true,
    "role sessions already issued continue; the result never says otherwise",
  );
  assert.equal(JSON.stringify(result.result).includes("role"), false);
  assert.equal(await custodyEmpty(setup, connectionRef), true);
});

test("an upstream disconnect still reports its Logout as the upstream outcome, once", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef, done } = await connectAndChoose(setup);
  const result = await setup.service.disconnect(setup.person, connectionRef, {
    expectedRevision: (done as View).revision,
    scope: "upstream",
  });
  assert.equal(result.result.upstream, "applied");
  assert.equal(result.result.release, undefined);
  assert.equal(setup.fixture.counts.logout, 1);
});

/** Each way the portal can fail, and the code that says so. */
const failures: Array<
  [
    name: string,
    arrange: (setup: AwsSetup) => Promise<void> | void,
    reason: string,
  ]
> = [
  ["a 5xx answer", (setup) => setup.fixture.failPortal(503), `${CODE}.refused`],
  [
    "a session that already lapsed",
    (setup) =>
      setup.fixture.expireAccessToken(setup.fixture.issued.accessTokens[0]!),
    `${CODE}.refused`,
  ],
  [
    "a portal nobody is listening on",
    async (setup) => {
      await setup.fixture.stopPortal();
    },
    `${CODE}.unreachable`,
  ],
];

for (const [name, arrange, reason] of failures)
  test(`a Logout that meets ${name} is reported and never stops the disconnect`, async (t) => {
    const setup = await awsSetup(t, {
      double: { errorWords: "CANARY_AWS_77ac" },
    });
    const { connectionRef, done } = await connectAndChoose(setup);
    await arrange(setup);
    const result = await setup.service.disconnect(setup.person, connectionRef, {
      expectedRevision: (done as View).revision,
      scope: "local",
    });
    closedLocally(result);
    assert.deepEqual(result.result.release, { revoked: false, reason });
    assert.equal(await custodyEmpty(setup, connectionRef), true);
    assert.equal(JSON.stringify(result).includes("CANARY_AWS_77ac"), false);
  });

test("a sign-in that was never approved holds no session to end", async (t) => {
  const setup = await awsSetup(t);
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  const connectionRef = connectionRefOf(connected);
  assert.ok(userCodeOf(connected));
  const result = await setup.service.disconnect(setup.person, connectionRef, {
    expectedRevision: (connected as View).revision,
    scope: "local",
  });
  closedLocally(result);
  assert.deepEqual(result.result.release, {
    revoked: "unavailable",
    reason: `${CODE}.no-session`,
  });
  assert.equal(setup.fixture.counts.logout, 0);
});

test("no token, role credential or provider word is in anything the disconnect leaves behind", async (t) => {
  const printed: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const)
    t.mock.method(console, method, (...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
  const CANARY = "CANARY_AWS_WORDS_9c2e";
  for (const [label, arrange] of [
    ["acknowledged", () => {}],
    ["refused", (setup: AwsSetup) => setup.fixture.failPortal(500)],
  ] as const) {
    const setup = await awsSetup(t, { double: { errorWords: CANARY } });
    const { connectionRef, done } = await connectAndChoose(setup);
    const held = JSON.stringify(await setup.heldMaterial(connectionRef));
    const issued = setup.fixture.issued;
    // The control: what the sweep looks for is really in custody now.
    assert.ok(held.includes(issued.accessTokens[0]!));
    assert.ok(held.includes(issued.roleCredentials[0]!.secretAccessKey));
    arrange(setup);
    const result = await setup.service.disconnect(setup.person, connectionRef, {
      expectedRevision: (done as View).revision,
      scope: "local",
    });
    const secrets = [
      ...issued.accessTokens,
      ...issued.refreshTokens,
      ...issued.clientSecrets,
      ...issued.roleCredentials.flatMap((role) => [
        role.secretAccessKey,
        role.sessionToken,
      ]),
      CANARY,
    ];
    assert.ok(secrets.length > 5, "the ceremony issued secrets to look for");
    for (const [name, value] of [
      [`${label}: result`, result],
      [`${label}: record`, await setup.record(connectionRef)],
      [
        `${label}: evidence`,
        await setup.ports.evidence.list(setup.person, connectionRef),
      ],
      [`${label}: journal`, setup.journal],
      [`${label}: printed`, inspect(printed, { depth: null })],
    ] as const) {
      const text = JSON.stringify(value) ?? "";
      for (const secret of secrets)
        assert.equal(text.includes(secret), false, `${name} holds a secret`);
    }
  }
});
