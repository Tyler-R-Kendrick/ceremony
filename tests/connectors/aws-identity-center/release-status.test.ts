import assert from "node:assert/strict";
import test from "node:test";
import { awsSetup, connectAndChoose } from "./harness.js";

/*
 * What the portal's HTTP status means for a Logout, in the words a person
 * reads: 2xx ended the sign-in session; 401 is the portal saying the session is
 * unknown, lapsed or already logged out, which is nothing left to end; 429 and
 * 5xx are the portal not processing the request, so whether the session ended
 * is unknown; any other 4xx is a refusal.
 */

type View = { lifecycle: string; revision: number };
const CODE = "aws-identity-center.release";

const cases: Array<
  [
    status: number,
    release: { revoked: boolean | "unavailable"; reason: string },
    upstream: string,
  ]
> = [
  [
    401,
    { revoked: "unavailable", reason: `${CODE}.session-gone` },
    "not-attempted",
  ],
  [403, { revoked: false, reason: `${CODE}.refused` }, "failed"],
  [400, { revoked: false, reason: `${CODE}.refused` }, "failed"],
  [429, { revoked: false, reason: `${CODE}.indeterminate` }, "indeterminate"],
  [503, { revoked: false, reason: `${CODE}.indeterminate` }, "indeterminate"],
  [500, { revoked: false, reason: `${CODE}.indeterminate` }, "indeterminate"],
];

for (const [status, release, upstream] of cases)
  for (const scope of ["local", "upstream"] as const)
    test(`a Logout answered ${status} is reported for the ${scope} scope as ${scope === "local" ? release.reason : `upstream ${upstream}`}`, async (t) => {
      const setup = await awsSetup(t);
      const { connectionRef, done } = await connectAndChoose(setup);
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
            ? new Response(null, { status })
            : real(input, init);
        },
      );

      const result = await setup.service.disconnect(
        setup.person,
        connectionRef,
        { expectedRevision: (done as View).revision, scope },
      );

      assert.equal(result.result.local, "applied");
      if (scope === "local") assert.deepEqual(result.result.release, release);
      else assert.equal(result.result.upstream, upstream);
    });
