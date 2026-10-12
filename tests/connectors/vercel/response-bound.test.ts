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

/*
 * The two places the Vercel provider reads a body that an outside party
 * writes without going through the OAuth transport: the key set a forwarded
 * trigger is verified with, and every document the provider-conformance
 * harness reads from the authorization server under test. Each is read under
 * the OAuth ceiling, so a server that streams without end cannot decide how
 * much the host reads. The harness talks to whatever server an operator points
 * it at, so it takes no larger bound than any other OAuth answer.
 */

const CHUNK = 64 * 1024;
const ENDLESS = 64 * 1024 * 1024;
/** One response may cross the ceiling by the chunk that crossed it, and no more. */
const SLACK = 2 * CHUNK;

/** A 200 whose body is `ENDLESS` bytes of whitespace, counting what was pulled from it. */
function endlessResponse(pulledBy: { worst: number }): Response {
  let pulled = 0;
  const chunk = new Uint8Array(CHUNK).fill(0x20);
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= ENDLESS) return controller.close();
        pulled += CHUNK;
        pulledBy.worst = Math.max(pulledBy.worst, pulled);
        controller.enqueue(chunk);
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
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
  const seen = { worst: 0 };
  const real = ctx.environment.fetch;
  const endless = {
    ...ctx,
    environment: {
      ...ctx.environment,
      fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        pathOf(input) === "/.well-known/jwks"
          ? endlessResponse(seen)
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
  assert.ok(seen.worst > 0, "the endless key set was in fact served");
  assert.ok(
    seen.worst <= MAX_RESPONSE_BYTES + SLACK,
    `pulled ${seen.worst} bytes of a key set; the ceiling is ${MAX_RESPONSE_BYTES}`,
  );
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
    const seen = { worst: 0 };
    const calls = new Map<string, number>();
    const guarded: typeof fetch = async (input, init) => {
      const path = pathOf(input);
      const nth = (calls.get(path) ?? 0) + 1;
      if (init?.method === "POST" || !init?.method) calls.set(path, nth);
      if (answersWithoutEnd(path, nth)) return endlessResponse(seen);
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
    assert.ok(seen.worst > 0, "the endless answer was in fact served");
    assert.ok(
      seen.worst <= MAX_RESPONSE_BYTES + SLACK,
      `pulled ${seen.worst} bytes of one answer; the ceiling is ${MAX_RESPONSE_BYTES}`,
    );
  });
