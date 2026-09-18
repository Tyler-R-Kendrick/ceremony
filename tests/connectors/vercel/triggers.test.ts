import { test } from "node:test";
import assert from "node:assert/strict";
import { createVercelConnectAdapter } from "../../../src/server/connectors/providers/vercel/index.js";
import type { VercelForwardedEvent } from "../../../src/server/connectors/providers/vercel/index.js";
import type { VercelSettings } from "../../../src/server/connectors/providers/vercel/index.js";
import {
  startVercelConnect,
  startVercelOidcIssuer,
} from "../doubles/vercel-connect.js";
import { buildBinding, buildConnection, harness } from "./harness.js";

/*
 * AC-VC-07: a Vercel-forwarded trigger with a forged or missing credential is
 * rejected, and a header that merely asserts the original provider signature
 * was checked proves nothing.
 *
 * What Connect actually attaches to a forwarded event is a Vercel OIDC bearer
 * token (Connect Chat SDK page; `@vercel/connect` 2.3.0
 * `createConnectWebhookVerifier`, which calls `@vercel/oidc`
 * `verifyVercelOidcToken`). That authenticates the forwarder and the calling
 * project, not the body bytes, so the envelope records the hop and says so.
 */

const TEAM = "team_fixture";
const PROJECT = "prj_main";
const CONNECTOR = "slack/acme-slack";

async function scenario(
  options: {
    triggers?: VercelSettings["triggers"];
    environments?: string[];
    projects?: string[];
  } = {},
) {
  const connect = await startVercelConnect({
    teamId: TEAM,
    connectors: [{ uid: CONNECTOR, projects: { [PROJECT]: ["production"] } }],
    credentials: [
      { token: "vma_management_token", kind: "management", teamId: TEAM },
      {
        token: "oidc_workload_token",
        kind: "workload",
        teamId: TEAM,
        projectId: PROJECT,
        environment: "production",
      },
    ],
  });
  const issuer = await startVercelOidcIssuer({ teamSlug: "acme" });
  const settings: VercelSettings = {
    project: { id: PROJECT, environment: "production" },
    profiles: {
      app: {
        connector: CONNECTOR,
        subject: { type: "app" },
        installation: { mode: "installation-free" },
        scopes: ["chat:write"],
      },
    },
    defaultProfile: "app",
    returnPath: "/connectors/vercel/return",
    triggers:
      options.triggers === undefined
        ? {
            destinations: [{ projectId: PROJECT, path: "/api/connect/slack" }],
            audience: "https://vercel.com/acme",
          }
        : options.triggers,
  };
  const h = harness();
  h.ports.configuration.set("VERCEL_TEAM_ID", TEAM);
  h.ports.configuration.set("VERCEL_TEAM_SLUG", "acme");
  h.ports.configuration.set(
    "VERCEL_CONNECT_WORKLOAD_TOKEN",
    "oidc_workload_token",
  );
  const binding = buildBinding({
    apiOrigin: connect.origin,
    oidcOrigin: issuer.origin,
    teamId: TEAM,
    settings,
    connectors: [CONNECTOR],
    projects: options.projects ?? [PROJECT],
    environments: options.environments ?? ["production"],
  });
  const connection = buildConnection({
    binding,
    ownerKind: "workload",
    lifecycle: "active",
  });
  return {
    connect,
    issuer,
    h,
    binding,
    connection,
    ctx: h.context({ binding, connection }),
    close: async () => {
      await connect.close();
      await issuer.close();
    },
  };
}

const body = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

const delivery = (
  token: string | undefined,
  payload: unknown,
  extra: Record<string, string> = {},
) => ({
  headers: new Headers({
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  }),
  body: body(payload),
  receivedAt: Date.now(),
});

const event = { type: "event_callback", event: { type: "app_mention" } };

test("a Vercel-forwarded trigger is accepted and recorded as a forwarder hop", async (t) => {
  const s = await scenario();
  t.after(s.close);
  const adapter = createVercelConnectAdapter();
  const token = await s.issuer.mint({
    ownerId: TEAM,
    projectId: PROJECT,
    environment: "production",
  });
  const verified = (await adapter.events!.verify(
    s.ctx,
    delivery(token, event, { "x-vercel-id": "iad1::abc123" }),
  )) as VercelForwardedEvent | undefined;
  assert.ok(verified, "a token from the published key is accepted");
  assert.equal(verified.verification.method, "forwarder-signature");
  assert.equal(verified.verification.keyId, s.issuer.keyId);
  assert.equal(verified.authority, `vercel-connect:${TEAM}:${PROJECT}:production`);
  assert.equal(verified.providerEventType, "event_callback");
  assert.equal(verified.eventId, "vercel:iad1::abc123");
  assert.equal(verified.payloadClassification, "personal");
  assert.deepEqual(verified.payload, event);
  assert.equal(verified.forwarderHops.length, 1);
  const [hop] = verified.forwarderHops;
  assert.equal(hop!.forwarder, "vercel-connect");
  assert.equal(hop!.method, "oidc-bearer");
  assert.equal(hop!.issuer, "https://oidc.vercel.com/acme");
  assert.equal(
    hop!.bodyBound,
    false,
    "the OIDC bearer authenticates the forwarder, not these bytes",
  );
  assert.equal(
    verified.connectionRef,
    s.connection.connectionRef,
    "the event is attributed to the connection that owns the binding",
  );
});

test("a forged, unsigned or alien token is rejected", async (t) => {
  const s = await scenario();
  t.after(s.close);
  const adapter = createVercelConnectAdapter();

  assert.equal(
    await adapter.events!.verify(s.ctx, delivery(undefined, event)),
    undefined,
    "no credential, no event",
  );
  const forged = await s.issuer.mint({
    ownerId: TEAM,
    projectId: PROJECT,
    environment: "production",
    signWith: "unpublished",
  });
  assert.equal(
    await adapter.events!.verify(s.ctx, delivery(forged, event)),
    undefined,
    "a token signed with a key Vercel never published is not a token",
  );
  const alienIssuer = await s.issuer.mint({
    ownerId: TEAM,
    projectId: PROJECT,
    environment: "production",
    issuer: "https://oidc.vercel.com.attacker.example",
  });
  assert.equal(
    await adapter.events!.verify(s.ctx, delivery(alienIssuer, event)),
    undefined,
    "an issuer that merely starts with the right text is a different issuer",
  );
  const expired = await s.issuer.mint({
    ownerId: TEAM,
    projectId: PROJECT,
    environment: "production",
    expiresInSeconds: 1,
    now: Date.now() - 600_000,
  });
  assert.equal(
    await adapter.events!.verify(s.ctx, delivery(expired, event)),
    undefined,
    "freshness comes from the token's own expiry",
  );
  const wrongAudience = await s.issuer.mint({
    ownerId: TEAM,
    projectId: PROJECT,
    environment: "production",
    audience: "https://vercel.com/someone-else",
  });
  assert.equal(
    await adapter.events!.verify(s.ctx, delivery(wrongAudience, event)),
    undefined,
  );
});

test("a header asserting the provider signature was verified is not a signature", async (t) => {
  const s = await scenario();
  t.after(s.close);
  const adapter = createVercelConnectAdapter();
  const asserted = {
    "x-vercel-signature-verified": "true",
    "x-slack-signature": "v0=deadbeef",
    "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
    "x-vercel-connect-verified": "slack",
  };
  assert.equal(
    await adapter.events!.verify(s.ctx, delivery(undefined, event, asserted)),
    undefined,
    "claims in headers do not authenticate a delivery",
  );
  const forged = await s.issuer.mint({
    ownerId: TEAM,
    projectId: PROJECT,
    environment: "production",
    signWith: "unpublished",
  });
  assert.equal(
    await adapter.events!.verify(s.ctx, delivery(forged, event, asserted)),
    undefined,
    "nor do they rescue a forged credential",
  );
});

test("a token for another team, project or environment is not this connection's event", async (t) => {
  const s = await scenario();
  t.after(s.close);
  const adapter = createVercelConnectAdapter();
  for (const claims of [
    { ownerId: "team_other", projectId: PROJECT, environment: "production" },
    { ownerId: TEAM, projectId: "prj_elsewhere", environment: "production" },
    { ownerId: TEAM, projectId: PROJECT, environment: "preview" },
  ]) {
    const token = await s.issuer.mint(claims);
    assert.equal(
      await adapter.events!.verify(s.ctx, delivery(token, event)),
      undefined,
      `${JSON.stringify(claims)} must not be accepted`,
    );
  }
});

test("an event is only accepted for a registered trigger destination", async (t) => {
  const withoutTriggers = await scenario({ triggers: undefined });
  t.after(withoutTriggers.close);
  const adapter = createVercelConnectAdapter();
  const token = await withoutTriggers.issuer.mint({
    ownerId: TEAM,
    projectId: PROJECT,
    environment: "production",
  });
  assert.ok(await adapter.events!.verify(withoutTriggers.ctx, delivery(token, event)));

  const elsewhere = await scenario({
    triggers: {
      destinations: [{ projectId: "prj_elsewhere", path: "/api/x" }],
      audience: "https://vercel.com/acme",
    },
    projects: [PROJECT, "prj_elsewhere"],
  });
  t.after(elsewhere.close);
  const other = await elsewhere.issuer.mint({
    ownerId: TEAM,
    projectId: PROJECT,
    environment: "production",
  });
  assert.equal(
    await adapter.events!.verify(elsewhere.ctx, delivery(other, event)),
    undefined,
    "a project with no registered destination receives no forwarded events",
  );
});

test("triggers are unavailable when the binding declares none", async (t) => {
  const s = await scenario({ triggers: undefined });
  t.after(s.close);
  const adapter = createVercelConnectAdapter();
  const token = await s.issuer.mint({
    ownerId: TEAM,
    projectId: PROJECT,
    environment: "production",
  });
  // scenario(undefined) keeps the default destinations, so remove them here.
  const bare = buildBinding({
    apiOrigin: s.connect.origin,
    oidcOrigin: s.issuer.origin,
    teamId: TEAM,
    settings: {
      project: { id: PROJECT, environment: "production" },
      profiles: {
        app: {
          connector: CONNECTOR,
          subject: { type: "app" },
          installation: { mode: "installation-free" },
          scopes: ["chat:write"],
        },
      },
      defaultProfile: "app",
      returnPath: "/connectors/vercel/return",
    },
    connectors: [CONNECTOR],
    projects: [PROJECT],
    environments: ["production"],
  });
  const ctx = s.h.context({
    binding: bare,
    connection: buildConnection({ binding: bare, ownerKind: "workload" }),
  });
  assert.equal(
    await adapter.events!.verify(ctx, delivery(token, event)),
    undefined,
    "a binding that registered no destination accepts no forwarded event",
  );
});

test("an oversized or malformed body is refused rather than parsed", async (t) => {
  const s = await scenario();
  t.after(s.close);
  const adapter = createVercelConnectAdapter();
  const token = await s.issuer.mint({
    ownerId: TEAM,
    projectId: PROJECT,
    environment: "production",
  });
  assert.equal(
    await adapter.events!.verify(s.ctx, {
      headers: new Headers({
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      }),
      body: new TextEncoder().encode("{not json"),
      receivedAt: Date.now(),
    }),
    undefined,
  );
  const deep = { value: "x".repeat(200) };
  let nested: unknown = deep;
  for (let index = 0; index < 40; index++) nested = { nested };
  assert.equal(
    await adapter.events!.verify(s.ctx, delivery(token, nested)),
    undefined,
    "a payload past the shared JSON bounds is not an event",
  );
});
