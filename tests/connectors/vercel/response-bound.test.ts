import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { MAX_RESPONSE_BYTES } from "../../../src/server/connectors/auth/index.js";
import {
  assessConnectProviderConformance,
  createVercelConnectAdapter,
  type VercelSettings,
} from "../../../src/server/connectors/providers/vercel/index.js";
import { oidcIdpFixture } from "../../fixtures/oidc-idp.js";
import {
  startVercelConnect,
  startVercelOidcIssuer,
} from "../doubles/vercel-connect.js";
import { buildBinding, buildConnection, harness } from "./harness.js";
import {
  assertReadUnder,
  endlessResponse,
  type Pulled,
  type Sites,
} from "../doubles/endless-body.js";

/*
 * The two places the Vercel provider reads a body that an outside party
 * writes without going through the OAuth transport: the key set a forwarded
 * trigger is verified with, and every document the provider-conformance
 * harness reads from the authorization server under test. Each is read under
 * the OAuth ceiling, so a server that streams without end cannot decide how
 * much the host reads. The harness talks to whatever server an operator points
 * it at, so it takes no larger bound than any other OAuth answer.
 */

const KEY_SET: Sites = [
  "src/server/connectors/providers/vercel/events.ts#fetchJwks",
];
const CONFORMANCE: Sites = [
  "src/server/connectors/providers/vercel/provider-conformance.ts#readJson",
];

/** An answer without end, for the bounded `sites` it is served to; each one is kept so the worst can be read. */
function endlessAnswer(served: Pulled[], sites: Sites): Response {
  const seen: Pulled = { pulled: 0 };
  served.push(seen);
  return endlessResponse(seen, sites);
}

/** The most one answer was read, and that it stayed within the ceiling. */
function assertWorst(served: Pulled[], what: string) {
  assertReadUnder(
    assert,
    { pulled: Math.max(0, ...served.map((seen) => seen.pulled)) },
    MAX_RESPONSE_BYTES,
    what,
  );
}

const pathOf = (input: Parameters<typeof fetch>[0]) =>
  new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  ).pathname;

test("an endless key set is cut off at the ceiling and verifies nothing", async (t: TestContext) => {
  const connect = await startVercelConnect({
    teamId: "team_fixture",
    connectors: [
      { uid: "slack/acme-slack", projects: { prj_main: ["production"] } },
    ],
    credentials: [],
  });
  const issuer = await startVercelOidcIssuer({ teamSlug: "acme" });
  t.after(async () => {
    await connect.close();
    await issuer.close();
  });
  const settings: VercelSettings = {
    project: { id: "prj_main", environment: "production" },
    profiles: {
      app: {
        connector: "slack/acme-slack",
        subject: { type: "app" },
        installation: { mode: "installation-free" },
        scopes: ["chat:write"],
      },
    },
    defaultProfile: "app",
    returnPath: "/connectors/vercel/return",
    triggers: {
      destinations: [{ projectId: "prj_main", path: "/api/connect/slack" }],
      audience: "https://vercel.com/acme",
    },
  };
  const h = harness();
  h.ports.configuration.set("VERCEL_TEAM_ID", "team_fixture");
  h.ports.configuration.set("VERCEL_TEAM_SLUG", "acme");
  const binding = buildBinding({
    apiOrigin: connect.origin,
    oidcOrigin: issuer.origin,
    teamId: "team_fixture",
    settings,
    connectors: ["slack/acme-slack"],
    projects: ["prj_main"],
    environments: ["production"],
  });
  const ctx = h.context({
    binding,
    connection: buildConnection({
      binding,
      ownerKind: "workload",
      lifecycle: "active",
    }),
  });
  const served: Pulled[] = [];
  const real = ctx.environment.fetch;
  const endless = {
    ...ctx,
    environment: {
      ...ctx.environment,
      fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        pathOf(input) === "/.well-known/jwks"
          ? endlessAnswer(served, KEY_SET)
          : real(input, init),
    },
  };
  const token = await issuer.mint({
    ownerId: "team_fixture",
    projectId: "prj_main",
    environment: "production",
  });

  const verified = await createVercelConnectAdapter().events!.verify(endless, {
    headers: new Headers({
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    }),
    body: new TextEncoder().encode(JSON.stringify({ type: "event_callback" })),
    receivedAt: Date.now(),
  });

  assert.equal(verified, undefined);
  assertWorst(served, "a key set");
});

/** Drives the consent leg over real HTTP and returns the callback the harness reads, never follows. */
function consentDriver(
  idp: Awaited<ReturnType<typeof oidcIdpFixture>>,
  guarded: typeof fetch,
) {
  return async (url: URL) => {
    const page = await guarded(url, { redirect: "manual" });
    const html = await page.text();
    const session = /action="\/session\?s=([^"]+)"/.exec(html)?.[1];
    assert.ok(session, "the authorization page starts a session");
    const signedIn = await guarded(`${idp.origin}/session?s=${session}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        [idp.markup.identifierName]: "person",
        [idp.markup.passwordName]: "correct horse battery staple",
      }).toString(),
      redirect: "manual",
    });
    const token = /name="s" value="([^"]+)"/.exec(await signedIn.text())?.[1];
    assert.ok(token, "sign-in reaches the consent screen");
    const granted = await guarded(`${idp.origin}/consent`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ s: token }).toString(),
      redirect: "manual",
    });
    return new URL(granted.headers.get("location")!);
  };
}

/** Which request of the walk is answered without end. */
const sites: Array<
  [name: string, endless: (path: string, nth: number) => boolean]
> = [
  [
    "a discovery document",
    (path) =>
      path === "/.well-known/openid-configuration" ||
      path === "/.well-known/oauth-authorization-server",
  ],
  [
    "the protected-resource metadata",
    (path) => path.startsWith("/.well-known/oauth-protected-resource"),
  ],
  ["a registration answer", (path) => path === "/dcr"],
  [
    "the code exchange's token answer",
    (path, nth) => path === "/token" && nth === 1,
  ],
  [
    "the refresh grant's token answer",
    (path, nth) => path === "/token" && nth === 2,
  ],
];

for (const [name, answersWithoutEnd] of sites)
  test(`${name} that never ends is cut off at the ceiling, and the assessment still finishes`, async (t: TestContext) => {
    const idp = await oidcIdpFixture({ seed: 7 });
    t.after(idp.close);
    idp.accounts.set("person@example.test", {
      email: "person@example.test",
      handle: "person",
      password: "correct horse battery staple",
      verified: true,
    });
    const served: Pulled[] = [];
    const calls = new Map<string, number>();
    const guarded: typeof fetch = async (input, init) => {
      const path = pathOf(input);
      const nth = (calls.get(path) ?? 0) + 1;
      if (init?.method === "POST" || !init?.method) calls.set(path, nth);
      if (answersWithoutEnd(path, nth))
        return endlessAnswer(served, CONFORMANCE);
      return fetch(input, init);
    };
    // The consent leg must not count against the token endpoint's tally.
    const direct: typeof fetch = (input, init) => fetch(input, init);

    const report = await assessConnectProviderConformance({
      serverUrl: idp.origin,
      fetch: guarded,
      exercise: {
        scope: "openid profile",
        authorize: consentDriver(idp, direct),
      },
    });

    assert.ok(report.findings.length > 0, "the assessment finished");
    assertWorst(served, "one answer");
  });
