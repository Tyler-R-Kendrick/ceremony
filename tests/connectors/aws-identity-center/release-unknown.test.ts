import assert from "node:assert/strict";
import test from "node:test";
import { awsSetup, connectAndChoose, type AwsSetup } from "./harness.js";

/*
 * A Logout that was sent and did not come back as an answer (a timeout, an
 * abort, a body over the ceiling or of the wrong shape) is unknown, not
 * "unreachable": the portal's `release.unreachable` means nothing was
 * listening and nothing was sent. The disconnect closes either way.
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

/** Replaces what Logout answers; every other request goes to the double. */
function answerLogoutWith(
  t: import("node:test").TestContext,
  answer: (init: RequestInit | undefined) => Promise<Response>,
) {
  const real = globalThis.fetch;
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
      return new URL(url).pathname === "/logout"
        ? answer(init)
        : real(input, init);
    },
  );
}

for (const [name, answer, options] of [
  [
    "never answers",
    (init: RequestInit | undefined) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        ),
      ),
    { callTimeoutMs: 400 },
  ],
  [
    "answers with a body larger than the bound",
    async () => new Response(new Uint8Array(1_100_000), { status: 200 }),
    {},
  ],
  [
    "answers with a body it should not have",
    async () => new Response('{"unexpected":true}', { status: 200 }),
    {},
  ],
] as const)
  test(`a Logout that ${name} is reported as sent and unknown`, async (t) => {
    const setup = await awsSetup(t, options);
    const { connectionRef, done } = await connectAndChoose(setup);
    answerLogoutWith(t, answer);
    const started = Date.now();
    const result = await setup.service.disconnect(setup.person, connectionRef, {
      expectedRevision: (done as View).revision,
      scope: "local",
    });
    assert.ok(Date.now() - started < 5_000);
    closedLocally(result);
    assert.deepEqual(result.result.release, {
      revoked: false,
      reason: `${CODE}.indeterminate`,
    });
    assert.equal(await custodyEmpty(setup, connectionRef), true);
  });
