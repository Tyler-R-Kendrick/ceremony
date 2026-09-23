import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { createAuthoringTools } from "../src/core/authoring-tools.js";
import { ConnectorDrafts } from "../src/server/connector-drafts.js";
import {
  installedDiscovery,
  saveAuthoredAccount,
} from "../src/server/authored-operations.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import { disambiguateProvider } from "../src/core/connector-authoring.js";
import { metadataDocumentClientId } from "../src/server/authored-oauth.js";

function actor(): ActorContext {
  return {
    tenantId: "tenant",
    subjectId: "author",
    sessionId: "session",
    actorKind: "agent",
    capabilities: ["author"],
  };
}

test("authoring tools draft a provider ceremony without human intervention", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  const drafts = new ConnectorDrafts(store, {
    fetch: async () => new Response("", { status: 404 }),
  });
  const tools = createAuthoringTools("ceremony_author", {
    fromProvider: (input) =>
      drafts.fromProvider(
        actor(),
        input.provider,
        input.openApiUrl,
        input.intent,
        input.origin,
      ),
    compose: (input) =>
      drafts.compose(actor(), input.draftId, input.revision, input.childIds),
    read: (id) => drafts.read(actor(), id),
  });
  const drafted = (await tools[0]!.execute({ provider: "jira" })) as {
    ok: boolean;
    human: null;
    draft: { id: string; methods: string[]; executable: boolean };
  };
  assert.equal(drafted.ok, true);
  assert.equal(drafted.human, null);
  assert.deepEqual(drafted.draft.methods, [
    "oauth-code",
    "account-registration",
  ]);
  assert.equal(drafted.draft.executable, true);
  assert.equal(JSON.stringify(drafted).includes("clientSecret"), false);
  const complete = (await tools[0]!.execute({
    provider: "jira",
    intent: "complete",
  })) as { human: { mode: string; reason: string } | null };
  assert.equal(complete.human?.mode, "elicit");
  assert.equal(complete.human?.reason, "openapi-url");
  const run = (await tools[0]!.execute({
    provider: "jira",
    intent: "run",
  })) as { human: { mode: string; reason: string } | null };
  assert.equal(run.human?.mode, "a2h-authorize");
  assert.equal(run.human?.reason, "owner-setup");
  const secret = (await tools[0]!.execute({
    provider: "stripe",
    intent: "run",
  })) as { human: { mode: string } | null };
  assert.equal(secret.human?.mode, "private-collector");
  await store.close();
});

test("authoring tools compose selected ceremonies without executing a provider", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  const drafts = new ConnectorDrafts(store, {
    fetch: async () => new Response("", { status: 404 }),
  });
  const tools = createAuthoringTools("ceremony_author", {
    fromProvider: (input) =>
      drafts.fromProvider(
        actor(),
        input.provider,
        input.openApiUrl,
        input.intent,
        input.origin,
      ),
    compose: (input) =>
      drafts.compose(actor(), input.draftId, input.revision, input.childIds),
    read: (id) => drafts.read(actor(), id),
  });
  const drafted = (await tools[0]!.execute({ provider: "github" })) as {
    draft: { id: string; revision: number; methods: string[] };
  };
  const composed = (await tools[1]!.execute({
    draftId: drafted.draft.id,
    revision: drafted.draft.revision,
    childIds: ["method-1", "method-2"],
  })) as { ok: boolean; human: null; draft: { methods: string[] } };
  assert.equal(composed.ok, true);
  assert.equal(composed.human, null);
  assert.ok(composed.draft.methods.length > drafted.draft.methods.length);
  await store.close();
});

test("authoring chat drafts an unknown provider without a form", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  const drafts = new ConnectorDrafts(store, {
    fetch: async () => new Response("", { status: 404 }),
  });
  const reply = await drafts.chat(actor(), "create a ceremony for acme");
  assert.equal(reply.result?.human, null);
  assert.equal(reply.result?.resolution?.resolved, "acme");
  assert.ok(reply.result?.draft?.methods.includes("oauth-code"));
  assert.equal(reply.result?.draft?.connectorId, "acme");
  assert.match(reply.messages.at(-1)!.text, /acme/i);
  const installed = await drafts.getInstalled(actor(), "acme");
  assert.equal(installed?.manifest.id, "acme");
  assert.equal(
    (await drafts.listManifests(actor())).some((item) => item.id === "acme"),
    true,
  );
  await store.close();
});

test("chat reuses its conversation for local deletion and rejects secrets before discovery", async (t) => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  let requests = 0;
  const drafts = new ConnectorDrafts(store, {
    fetch: async () => {
      requests++;
      return new Response("", { status: 404 });
    },
  });
  const created = await drafts.chat(actor(), "acme");
  assert.equal(
    (await drafts.getInstalled(actor(), "acme"))?.manifest.id,
    "acme",
  );
  const before = requests;
  const removed = await drafts.chat(actor(), "delete", created.conversationId);
  assert.equal(removed.conversationId, created.conversationId);
  assert.match(
    removed.messages.at(-1)!.text,
    /Deleted the local acme connection/,
  );
  assert.equal(await drafts.getInstalled(actor(), "acme"), undefined);
  assert.equal(requests, before);
  const missing = await drafts.chat(
    actor(),
    "remove acme",
    created.conversationId,
  );
  assert.match(missing.messages.at(-1)!.text, /No local connection/);
  assert.equal(requests, before);
  const rejected = await drafts.chat(
    actor(),
    "Bearer fixture-private-chat",
    created.conversationId,
  );
  assert.equal(rejected.conversationId, created.conversationId);
  assert.equal(rejected.messages[0]?.text, "(rejected)");
  assert.equal(
    JSON.stringify(rejected).includes("fixture-private-chat"),
    false,
  );
  assert.equal(requests, before);
  assert.equal(rejected.result, undefined);
});

test("mounted authoring HTTP drafts a provider without a human collector", async (t) => {
  const { teachingGitHubFixture } =
    await import("./fixtures/teaching-github.js");
  const fixture = await teachingGitHubFixture(4491);
  t.after(() => fixture.close());
  const cookie = fixture.sessionCookie("http-author");
  const response = await fetch(
    `${fixture.origin}/api/v1/teaching/authoring/from-provider`,
    {
      method: "POST",
      headers: {
        cookie,
        origin: fixture.origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ provider: "gith" }),
    },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.human?.reason, "provider-name");
  assert.equal(body.human?.mode, "elicit");
  assert.ok(body.resolution.alternatives.includes("github"));
  assert.equal(body.draft, undefined);
});

test("mounted authoring, execution and human discovery never escape the provider fixture", async (t) => {
  const { teachingGitHubFixture } =
    await import("./fixtures/teaching-github.js");
  const transport = globalThis.fetch;
  let externalRequests = 0;
  t.mock.method(
    globalThis,
    "fetch",
    (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "127.0.0.1") return transport(input, init);
      externalRequests++;
      return Promise.resolve(new Response("", { status: 404 }));
    },
  );
  const fixture = await teachingGitHubFixture(4490);
  t.after(() => fixture.close());
  const cookie = fixture.sessionCookie("offline-author");
  const headers = {
    cookie,
    origin: fixture.origin,
    "content-type": "application/json",
  };
  for (const connectorId of ["bluesky", "offline-provider"]) {
    const chat = await fetch(
      `${fixture.origin}/api/v1/teaching/authoring/chat`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          message: `create a ceremony for ${connectorId}`,
        }),
      },
    );
    assert.equal(chat.status, 200);
    await chat.arrayBuffer();
    const started = await fetch(`${fixture.origin}/api/v1/teaching/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ connectorId }),
    });
    assert.equal(started.status, 200);
    const run = await started.json();
    const human = await fetch(
      `${fixture.origin}/api/v1/teaching/${connectorId}/${run.id}/human`,
      {
        headers: { cookie },
        redirect: "manual",
      },
    );
    assert.ok([200, 302, 303].includes(human.status));
    await human.arrayBuffer();
  }
  assert.equal(externalRequests, 0);
});

test("authored connectors from any provider name are listed and can start", async (t) => {
  const { teachingGitHubFixture } =
    await import("./fixtures/teaching-github.js");
  const fixture = await teachingGitHubFixture(4492);
  t.after(() => fixture.close());
  const cookie = fixture.sessionCookie("http-author");
  const headers = {
    cookie,
    origin: fixture.origin,
    "content-type": "application/json",
  };
  for (const [message, connectorId] of [
    ["create a ceremony for blusky", "bluesky"],
    ["create a ceremony for acme", "acme"],
  ] as const) {
    const chat = await fetch(
      `${fixture.origin}/api/v1/teaching/authoring/chat`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ message }),
      },
    );
    assert.equal(chat.status, 200);
    const drafted = await chat.json();
    assert.equal(
      drafted.result.draft.connectorId,
      connectorId,
      JSON.stringify(drafted),
    );
    assert.match(
      drafted.messages.at(-1).text,
      new RegExp(`/\\?connector=${connectorId}`),
    );
    const capabilities = await fetch(
      `${fixture.origin}/api/v1/teaching/capabilities`,
      { headers: { cookie, origin: fixture.origin } },
    );
    const caps = await capabilities.json();
    assert.ok(caps.connectors.includes(connectorId), JSON.stringify(caps));
    const started = await fetch(`${fixture.origin}/api/v1/teaching/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ connectorId }),
    });
    const startedBody = await started.text();
    assert.equal(started.status, 200, startedBody);
    const run = JSON.parse(startedBody);
    assert.equal(run.provider, connectorId);
    assert.ok(Array.isArray(run.nodes) && run.nodes.length >= 1);
    assert.ok(
      run.nodes.some(
        (node: { state?: string; operationId?: string }) =>
          (node.operationId === "authored.prepare-app" ||
            node.operationId === "authored.authorize-user" ||
            node.operationId === "authored.collect-credential") &&
          node.state === "awaiting-human",
      ),
    );
    assert.equal(run.identity, undefined);
    const collector = await fetch(
      `${fixture.origin}/api/v1/teaching/${connectorId}/${run.id}/human`,
      {
        headers: { cookie, origin: fixture.origin },
        redirect: "manual",
      },
    );
    const html = await collector.text();
    assert.ok(
      [200, 302, 303].includes(collector.status),
      `${collector.status} ${html.slice(0, 400)}`,
    );
    assert.equal(
      /Public provider origin|Access token|OAuth client ID/i.test(html),
      false,
      html,
    );
    const deleted = await fetch(
      `${fixture.origin}/api/v1/teaching/authoring/delete`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          connectorId,
          runId: run.id,
          revision: run.revision,
        }),
      },
    );
    assert.equal(deleted.status, 200);
    const after = await fetch(
      `${fixture.origin}/api/v1/teaching/capabilities`,
      {
        headers: { cookie, origin: fixture.origin },
      },
    );
    assert.equal((await after.json()).connectors.includes(connectorId), false);
  }
});

test("chat reports discovery progress while it works", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  const progress: string[] = [];
  const drafts = new ConnectorDrafts(store, {
    fetch: async () => new Response("", { status: 404 }),
  });
  await drafts.chat(actor(), "acme", undefined, (text) => progress.push(text));
  assert.ok(
    progress.some((line) => /Assumed origins|Trying |Generating /.test(line)),
    JSON.stringify(progress),
  );
  await store.close();
});

test("high-confidence misspellings resolve without elicitation", () => {
  const github = disambiguateProvider("githb");
  assert.equal(github.resolved, "github");
  assert.equal(github.confidence, "high");
  const jira = disambiguateProvider("Jira Cloud");
  assert.equal(jira.resolved, "jira");
  assert.equal(jira.confidence, "high");
  const bluesky = disambiguateProvider("create a ceremony for blusky");
  assert.equal(bluesky.resolved, "bluesky");
  assert.equal(bluesky.confidence, "high");
});

test("discovery crawl maps well-known OAuth metadata onto generic families", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  const seen: string[] = [];
  const drafts = new ConnectorDrafts(store, {
    allowLoopbackHttp: true,
    fetch: async (input) => {
      const url = String(input);
      seen.push(url);
      if (
        url.startsWith("http://127.0.0.1:4179/") &&
        url.endsWith("/.well-known/oauth-authorization-server")
      )
        return Response.json({
          authorization_endpoint: "https://auth.example/authorize",
          token_endpoint: "https://auth.example/token",
          userinfo_endpoint: "https://auth.example/userinfo",
          grant_types_supported: [
            "authorization_code",
            "password",
            "urn:ietf:params:oauth:grant-type:device_code",
          ],
          device_authorization_endpoint: "https://auth.example/device",
        });
      return new Response("", { status: 404 });
    },
  });
  const result = await drafts.fromProvider(
    actor(),
    "unknown-saas",
    undefined,
    "draft",
    "http://127.0.0.1:4179",
  );
  assert.equal(result.ok, true);
  assert.equal(result.human, null);
  assert.deepEqual(result.draft?.methods.sort(), [
    "account-registration",
    "device",
    "form",
    "oauth-code",
  ]);
  assert.equal(
    (await drafts.listManifests(actor())).some(
      (item) => item.id === "unknown-saas",
    ),
    true,
  );
  assert.ok(
    result.discovery?.documents.includes(
      "/.well-known/oauth-authorization-server",
    ),
  );
  assert.equal(result.discovery?.searchUsed, false);
  const installed = await drafts.getInstalled(actor(), "unknown-saas");
  assert.ok(installed);
  assert.ok(seen.every((url) => !url.includes("client_secret")));
  await store.close();
});

test("search fallback is used only after well-known documents are missing", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  let searched = 0;
  const drafts = new ConnectorDrafts(store, {
    allowLoopbackHttp: true,
    fetch: async (input) => {
      if (String(input).startsWith("http://127.0.0.1:4180"))
        return new Response("", { status: 404 });
      if (String(input).endsWith("/auth.md"))
        return new Response("anonymous claim profile", {
          status: 200,
          headers: { "content-type": "text/markdown" },
        });
      return new Response("", { status: 404 });
    },
    search: async () => {
      searched++;
      return [{ title: "Vendor auth.md", url: "https://vendor.example/docs" }];
    },
  });
  const result = await drafts.fromProvider(
    actor(),
    "unknown-saas",
    undefined,
    "draft",
    "http://127.0.0.1:4180",
  );
  assert.equal(searched, 1);
  assert.equal(result.discovery?.searchUsed, true);
  assert.deepEqual(result.draft?.methods, ["authmd-anonymous"]);
  assert.equal(result.human, null);
  await store.close();
});

test("brand names infer auth hosts without collecting secrets", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  const seen: string[] = [];
  const drafts = new ConnectorDrafts(store, {
    fetch: async (input) => {
      const url = String(input);
      seen.push(url);
      if (url === "https://auth.x.ai/.well-known/openid-configuration")
        return Response.json({
          authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
          token_endpoint: "https://auth.x.ai/oauth2/token",
          userinfo_endpoint: "https://auth.x.ai/oauth2/userinfo",
          device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
          grant_types_supported: ["authorization_code"],
        });
      return new Response("", { status: 404 });
    },
  });
  const result = await drafts.fromProvider(actor(), "xai");
  assert.equal(result.ok, true);
  assert.equal(result.human, null);
  assert.equal(result.discovery?.origin, "https://auth.x.ai");
  assert.equal(result.discovery?.assumed, true);
  assert.ok(result.discovery?.candidates?.includes("https://auth.x.ai"));
  assert.ok(result.draft?.methods.includes("oauth-code"));
  assert.ok(result.draft?.methods.includes("device"));
  assert.ok(result.draft?.methods.includes("account-registration"));
  const discovered = await installedDiscovery(store, actor(), "xai");
  assert.equal(discovered?.clientId, "b1a00492-073a-47ea-816f-4c329264a828");
  assert.equal(
    discovered?.deviceAuthorizationEndpoint,
    "https://auth.x.ai/oauth2/device/code",
  );
  assert.ok(
    seen.includes("https://auth.x.ai/.well-known/openid-configuration"),
  );
  assert.ok(seen.every((url) => !url.includes("client_secret")));
  await store.close();
});

test("discovery keeps a provider-owned authorization server over an unrelated storefront", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  const drafts = new ConnectorDrafts(store, {
    fetch: async (input) => {
      const url = String(input);
      if (url === "https://bluesky.com/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: "https://shopify.com/authentication/1849819183",
          authorization_endpoint:
            "https://shopify.com/authentication/1849819183/oauth/authorize",
          token_endpoint:
            "https://shopify.com/authentication/1849819183/oauth/token",
          token_endpoint_auth_methods_supported: [
            "client_secret_basic",
            "client_secret_post",
          ],
          grant_types_supported: ["authorization_code"],
        });
      if (url === "https://bsky.social/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: "https://bsky.social",
          authorization_endpoint: "https://bsky.social/oauth/authorize",
          token_endpoint: "https://bsky.social/oauth/token",
          pushed_authorization_request_endpoint:
            "https://bsky.social/oauth/par",
          require_pushed_authorization_requests: true,
          client_id_metadata_document_supported: true,
          dpop_signing_alg_values_supported: ["ES256"],
          grant_types_supported: ["authorization_code"],
          scopes_supported: ["atproto", "transition:generic"],
        });
      return new Response("", { status: 404 });
    },
  });
  const result = await drafts.fromProvider(actor(), "bluesky");
  assert.equal(result.discovery?.origin, "https://bsky.social");
  assert.equal(result.discovery?.assumed, true);
  assert.ok(
    result.draft?.methods.includes("oauth-code"),
    JSON.stringify(result.draft?.methods),
  );
  const discovered = await installedDiscovery(store, actor(), "bluesky");
  assert.equal(discovered?.clientIdMetadataDocumentSupported, true);
  assert.equal(
    discovered?.authorizationEndpoint,
    "https://bsky.social/oauth/authorize",
  );
  await store.close();
});

test("signing in to bluesky uses the isolated browser instead of dumping the person on the provider", async (t) => {
  const { teachingGitHubFixture } =
    await import("./fixtures/teaching-github.js");
  const fixture = await teachingGitHubFixture(4493, {
    browser: {
      complete: async () => ({ status: "credentials" }),
    },
  });
  t.after(() => fixture.close());
  const cookie = fixture.sessionCookie("http-author");
  const headers = {
    cookie,
    origin: fixture.origin,
    "content-type": "application/json",
  };
  const chat = await fetch(`${fixture.origin}/api/v1/teaching/authoring/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: "create a ceremony for bluesky" }),
  });
  assert.equal(chat.status, 200);
  const drafted = await chat.json();
  assert.equal(drafted.result.draft.connectorId, "bluesky");
  const started = await fetch(`${fixture.origin}/api/v1/teaching/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ connectorId: "bluesky" }),
  });
  const run = await started.json();
  assert.equal(started.status, 200);
  assert.ok(
    run.nodes.some(
      (node: { operationId?: string; state?: string }) =>
        node.operationId === "authored.authorize-user" &&
        node.state === "awaiting-human",
    ),
    JSON.stringify(run.nodes),
  );
  const collector = await fetch(
    `${fixture.origin}/api/v1/teaching/bluesky/${run.id}/human`,
    { headers: { cookie, origin: fixture.origin }, redirect: "manual" },
  );
  const html = await collector.text();
  assert.ok([200, 302, 303].includes(collector.status), html.slice(0, 400));
  assert.equal(/name="password"/i.test(html), false, html);
  assert.equal(/Isolated browser needs the/i.test(html), false, html);
  assert.equal(/bsky\.social\/oauth\/authorize/i.test(html), false, html);
});

test("ceremony runs stream isolated-browser progress over events", async (t) => {
  const { teachingGitHubFixture } =
    await import("./fixtures/teaching-github.js");
  const fixture = await teachingGitHubFixture(4494, {
    browser: {
      complete: async (input) => {
        input.onEvent?.("Trying https://bsky.social/oauth/authorize");
        input.onEvent?.(
          "Isolated browser stopped: an existing provider session is required",
        );
        return { status: "blocked" as const, reason: "session" };
      },
    },
  });
  t.after(() => fixture.close());
  const cookie = fixture.sessionCookie("http-author");
  const headers = {
    cookie,
    origin: fixture.origin,
    "content-type": "application/json",
  };
  const chat = await fetch(`${fixture.origin}/api/v1/teaching/authoring/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: "create a ceremony for bluesky" }),
  });
  assert.equal(chat.status, 200);
  const started = await fetch(`${fixture.origin}/api/v1/teaching/runs`, {
    method: "POST",
    headers: { ...headers, accept: "text/event-stream" },
    body: JSON.stringify({ connectorId: "bluesky" }),
  });
  assert.equal(started.status, 200);
  assert.match(started.headers.get("content-type") ?? "", /text\/event-stream/);
  const body = await started.text();
  assert.ok(body.includes("event: progress"), body.slice(0, 400));
  assert.ok(
    body.includes("Trying https://bsky.social/oauth/authorize"),
    body.slice(0, 400),
  );
  assert.ok(body.includes("event: done"), body.slice(-400));
});

test("generic HTTP registration accepts the selected email without an agent inbox while GitHub still requires a handle", async (t) => {
  const { teachingGitHubFixture } =
    await import("./fixtures/teaching-github.js");
  let captured:
    | import("../src/server/browser-executor.js").AuthorizationBrowserInput
    | undefined;
  const fixture = await teachingGitHubFixture(4499, {
    browser: {
      complete: async (input) => {
        captured = input;
        return {
          status: "blocked",
          reason: "verification",
          sessionPending: true,
        };
      },
    },
  });
  t.after(() => fixture.close());
  const cookie = fixture.sessionCookie("email-author");
  const owner = await fixture.runtime.identity.authenticate(
    new Request(fixture.origin, { headers: { cookie } }),
  );
  assert.ok(owner);
  const drafts = new ConnectorDrafts(fixture.store, {
    fetch: async (input) =>
      String(input).endsWith("/.well-known/oauth-authorization-server")
        ? Response.json({
            issuer: "https://email-fixture.example",
            authorization_endpoint: "https://email-fixture.example/authorize",
            token_endpoint: "https://email-fixture.example/token",
            userinfo_endpoint: "https://email-fixture.example/userinfo",
          })
        : new Response("", { status: 404 }),
  });
  await drafts.fromProvider(
    owner,
    "email-fixture",
    undefined,
    "draft",
    "https://email-fixture.example",
  );
  for (const [sessionCookie, visible] of [
    [cookie, true],
    [fixture.sessionCookie("other-author"), false],
  ] as const) {
    const config = await fetch(`${fixture.origin}/api/config`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(config.status, 200);
    assert.equal(
      (await config.json()).liveManifests.some(
        (manifest: { id: string }) => manifest.id === "email-fixture",
      ),
      visible,
    );
  }
  const start = (connectorId: string, account: string) =>
    fetch(`${fixture.origin}/api/v1/teaching/runs`, {
      method: "POST",
      headers: {
        cookie,
        origin: fixture.origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        connectorId,
        ceremony: "account-registration",
        account,
      }),
    });
  for (const [connector, account] of [
    ["email-fixture", "bad@"],
    ["email-fixture", "a b"],
    ["email-fixture", "a\u0000b"],
    ["email-fixture", "a".repeat(255)],
    ["github", "chosen@example.test"],
  ]) {
    assert.equal((await start(connector!, account!)).status, 400);
    assert.equal(captured, undefined);
  }
  const response = await start("email-fixture", "chosen@example.test");
  assert.equal(response.status, 200);
  const run = await response.json();
  assert.equal(captured?.preferredUsername, "chosen@example.test");
  assert.equal(captured?.generateAccount, true);
  assert.equal(run.human?.account, "chosen@example.test");
  assert.equal(run.human?.reason, "verification");
  assert.equal(run.identity, undefined);
  assert.ok(captured?.vault);
  for (const [account, matches] of [
    [{ username: "other", email: "other@example.test" }, false],
    [{ username: "generated", email: "chosen@example.test" }, true],
    [{ username: "chosen@example.test" }, true],
    [{ username: "Chosen@example.test" }, false],
  ] as const) {
    const saved = { ...account, password: "synthetic-vault-password" };
    await saveAuthoredAccount(fixture.store, owner, "email-fixture", saved);
    assert.deepEqual(await captured.vault.get(), matches ? saved : undefined);
  }
});

test("account registration without an agent inbox reports the prerequisite instead of hanging", async (t) => {
  const { teachingGitHubFixture } =
    await import("./fixtures/teaching-github.js");
  let browserCalls = 0;
  const fixture = await teachingGitHubFixture(4495, {
    browser: {
      complete: async () => {
        browserCalls += 1;
        return { status: "blocked" as const, reason: "session" };
      },
    },
  });
  t.after(() => fixture.close());
  const cookie = fixture.sessionCookie("http-author");
  const headers = {
    cookie,
    origin: fixture.origin,
    "content-type": "application/json",
  };
  const chat = await fetch(`${fixture.origin}/api/v1/teaching/authoring/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: "create a ceremony for bluesky" }),
  });
  assert.equal(chat.status, 200);
  const started = await fetch(`${fixture.origin}/api/v1/teaching/runs`, {
    method: "POST",
    headers: { ...headers, accept: "text/event-stream" },
    body: JSON.stringify({
      connectorId: "bluesky",
      ceremony: "account-registration",
      account: "fixture-new-account",
    }),
  });
  assert.equal(started.status, 200);
  const body = await started.text();
  assert.ok(body.includes('"reason":"inbox"'), body.slice(0, 600));
  assert.equal(browserCalls, 0);
});

test("oauth without a stored account chains registration through the agent inbox first", async (t) => {
  const { teachingGitHubFixture } =
    await import("./fixtures/teaching-github.js");
  let captured: { generateAccount?: boolean; startUrls?: string[] } | undefined;
  const fixture = await teachingGitHubFixture(4496, {
    browser: {
      complete: async (input) => {
        captured = input;
        return { status: "blocked" as const, reason: "session" };
      },
    },
    inbox: {
      provision: async () => "agent-1@inbox.test",
      latest: async () => undefined,
    },
  });
  t.after(() => fixture.close());
  const cookie = fixture.sessionCookie("http-author");
  const headers = {
    cookie,
    origin: fixture.origin,
    "content-type": "application/json",
  };
  const chat = await fetch(`${fixture.origin}/api/v1/teaching/authoring/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: "create a ceremony for bluesky" }),
  });
  assert.equal(chat.status, 200);
  const started = await fetch(`${fixture.origin}/api/v1/teaching/runs`, {
    method: "POST",
    headers: { ...headers, accept: "text/event-stream" },
    body: JSON.stringify({ connectorId: "bluesky", ceremony: "oauth-code" }),
  });
  assert.equal(started.status, 200);
  const body = await started.text();
  assert.ok(
    body.includes("No stored account; registering one with the agent inbox"),
    body.slice(0, 600),
  );
  assert.ok(captured);
});

test("an authored GitHub ceremony forks existing accounts to sign-in and available handles to registration", async (t) => {
  const { teachingGitHubFixture } =
    await import("./fixtures/teaching-github.js");
  let captured:
    { preferredUsername?: string; generateAccount?: boolean } | undefined;
  const fixture = await teachingGitHubFixture(4497, {
    browser: {
      complete: async (input) => {
        captured = input;
        if (input.credentials?.password)
          return { status: "credentials" as const, accountStored: true };
        return {
          status: "blocked" as const,
          reason:
            input.preferredUsername === "taken-twice"
              ? "email-in-use"
              : input.generateAccount
                ? "challenge"
                : "no-form",
        };
      },
    },
    inbox: {
      provision: async () => "agent-1@inbox.test",
      latest: async () => undefined,
    },
  });
  t.after(() => fixture.close());
  const cookie = fixture.sessionCookie("http-author");
  const headers = {
    cookie,
    origin: fixture.origin,
    "content-type": "application/json",
  };
  const chat = await fetch(`${fixture.origin}/api/v1/teaching/authoring/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: "create a ceremony for github" }),
  });
  assert.equal(chat.status, 200);
  const otherCookie = fixture.sessionCookie("other-user");
  const foreign = await fetch(`${fixture.origin}/api/v1/teaching/runs`, {
    method: "POST",
    headers: { ...headers, cookie: otherCookie },
    body: JSON.stringify({ connectorId: "github" }),
  });
  const foreignRun = await foreign.json();
  assert.equal(foreign.status, 200, JSON.stringify(foreignRun));
  assert.equal(foreignRun.nodes[0]?.operationId, "github.prepare-app");

  const builtInStart = await fetch(`${fixture.origin}/api/v1/teaching/runs`, {
    method: "POST",
    headers: { ...headers, cookie: otherCookie },
    body: JSON.stringify({ connectorId: "github", account: "fixture-owner" }),
  });
  const builtInRun = await builtInStart.json();
  assert.equal(builtInStart.status, 200, JSON.stringify(builtInRun));
  assert.equal(builtInRun.nodes[0].operationId, "authored.register-account");
  const signIn = await fetch(
    `${fixture.origin}/api/v1/teaching/github/${encodeURIComponent(builtInRun.id)}/human`,
    {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: otherCookie,
        origin: fixture.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        username: "fixture-owner",
        password: "fixture-password",
      }),
    },
  );
  assert.equal(signIn.status, 303, await signIn.text());
  const afterSignIn = await fetch(
    `${fixture.origin}/api/v1/teaching/runs/${encodeURIComponent(builtInRun.id)}`,
    { headers: { cookie: otherCookie } },
  );
  const afterSignInRun = await afterSignIn.json();
  assert.equal(
    afterSignInRun.nodes[0].verified,
    true,
    JSON.stringify(afterSignInRun),
  );
  assert.equal(afterSignInRun.nodes[1].operationId, "github.prepare-app");
  assert.equal(afterSignInRun.nodes[1].state, "awaiting-human");
  const repeated = await fetch(`${fixture.origin}/api/v1/teaching/runs`, {
    method: "POST",
    headers: { ...headers, cookie: otherCookie },
    body: JSON.stringify({ connectorId: "github", account: "fixture-owner" }),
  });
  assert.equal((await repeated.json()).id, builtInRun.id);

  const started = await fetch(`${fixture.origin}/api/v1/teaching/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      connectorId: "github",
      account: "fixture-owner",
    }),
  });
  const run = await started.json();
  assert.equal(started.status, 200, JSON.stringify(run));
  assert.equal(captured?.preferredUsername, "fixture-owner");
  assert.equal(captured?.generateAccount, undefined);
  assert.equal(run.human?.reason, "session");
  assert.ok(
    run.nodes.some(
      (node: { operationId?: string }) =>
        node.operationId === "authored.register-account",
    ),
    JSON.stringify(run.nodes),
  );
  assert.ok(
    run.nodes.some(
      (node: { operationId?: string }) =>
        node.operationId === "authored.prepare-app",
    ),
    JSON.stringify(run.nodes),
  );

  const registration = await fetch(`${fixture.origin}/api/v1/teaching/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      connectorId: "github",
      ceremony: "account-registration",
      account: "new-fixture-user",
    }),
  });
  const registrationRun = await registration.json();
  assert.equal(registration.status, 200, JSON.stringify(registrationRun));
  assert.equal(captured?.preferredUsername, "new-fixture-user");
  assert.equal(captured?.generateAccount, true);
  assert.equal(registrationRun.human?.reason, "challenge");
  assert.deepEqual(registrationRun.human?.fields, ["captcha-or-mfa"]);

  const collision = await fetch(`${fixture.origin}/api/v1/teaching/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      connectorId: "github",
      ceremony: "account-registration",
      account: "taken-twice",
    }),
  });
  const collisionRun = await collision.json();
  assert.equal(collision.status, 200, JSON.stringify(collisionRun));
  assert.equal(collisionRun.human?.reason, "email-in-use");
  assert.deepEqual(collisionRun.human?.fields, ["account"]);
  const humanUrl = `${fixture.origin}/api/v1/teaching/github/${encodeURIComponent(collisionRun.id)}/human`;
  const human = await fetch(humanUrl, { headers: { cookie } });
  assert.match(await human.text(), /Choose another GitHub account name/);
  const retry = await fetch(humanUrl, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      origin: fixture.origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ username: "fallback-name" }),
  });
  assert.equal(retry.status, 303, await retry.text());
  assert.equal(captured?.preferredUsername, "fallback-name");
});

test("loopback public clients use the localhost client_id carve-out", () => {
  const clientId = metadataDocumentClientId(
    "http://127.0.0.1:4173",
    "http://127.0.0.1:4173/api/v1/teaching/bluesky/run/human",
    "atproto transition:generic",
    "bluesky",
    "run-1",
  );
  assert.equal(clientId.startsWith("http://localhost?"), true);
  assert.equal(clientId.includes("http://localhost/?"), false);
  const params = new URL(clientId).searchParams;
  assert.equal(
    params.get("redirect_uri"),
    "http://127.0.0.1:4173/api/v1/teaching/bluesky/run/human",
  );
  assert.equal(params.get("scope"), "atproto transition:generic");
});

test("compound provider names discover client-metadata OAuth without a human form", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  const drafts = new ConnectorDrafts(store, {
    fetch: async (input) => {
      const url = String(input);
      if (url === "https://bsky.social/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: "https://bsky.social",
          authorization_endpoint: "https://bsky.social/oauth/authorize",
          token_endpoint: "https://bsky.social/oauth/token",
          pushed_authorization_request_endpoint:
            "https://bsky.social/oauth/par",
          require_pushed_authorization_requests: true,
          client_id_metadata_document_supported: true,
          dpop_signing_alg_values_supported: ["ES256"],
          grant_types_supported: ["authorization_code"],
          scopes_supported: ["atproto", "transition:generic"],
        });
      return new Response("", { status: 404 });
    },
  });
  const named = await drafts.fromProvider(actor(), "bluesky");
  assert.equal(named.discovery?.origin, "https://bsky.social");
  const result = await drafts.fromProvider(actor(), "bluesky social");
  assert.equal(result.ok, true);
  assert.equal(result.human, null);
  assert.equal(result.discovery?.origin, "https://bsky.social");
  const discovered = await installedDiscovery(store, actor(), "bluesky");
  assert.equal(discovered?.clientIdMetadataDocumentSupported, true);
  assert.equal(
    discovered?.pushedAuthorizationRequestEndpoint,
    "https://bsky.social/oauth/par",
  );
  await store.close();
});

/**
 * Discovery reports more than the tool result declares (userinfo, revocation,
 * PKCE methods). The tool result is a positive allowlist, so those are left
 * out of what a model reads — but leaving them out must not turn a successful
 * draft into a refusal, which is what a strict parse of the whole report did.
 */
test("the authoring tool narrows a rich discovery report instead of refusing it", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  try {
    const drafts = new ConnectorDrafts(store, {
      allowLoopbackHttp: true,
      fetch: async (input) =>
        String(input).startsWith("http://127.0.0.1:4179/") &&
        String(input).endsWith("/.well-known/oauth-authorization-server")
          ? Response.json({
              authorization_endpoint: "https://auth.example/authorize",
              token_endpoint: "https://auth.example/token",
              userinfo_endpoint: "https://auth.example/userinfo",
              revocation_endpoint: "https://auth.example/revoke",
              code_challenge_methods_supported: ["S256"],
              grant_types_supported: ["authorization_code"],
            })
          : new Response("", { status: 404 }),
    });
    const [fromProvider] = createAuthoringTools("ceremony_author", {
      fromProvider: (input) =>
        drafts.fromProvider(
          actor(),
          input.provider,
          input.openApiUrl,
          input.intent,
          input.origin,
        ),
      compose: (input) =>
        drafts.compose(actor(), input.draftId, input.revision, input.childIds),
      read: (id) => drafts.read(actor(), id),
    });
    const result = (await fromProvider!.execute({
      provider: "rich-saas",
      origin: "http://127.0.0.1:4179",
    })) as {
      ok: boolean;
      error?: string;
      discovery?: Record<string, unknown>;
    };
    assert.equal(result.error, undefined);
    assert.equal(result.ok, true);
    assert.equal(result.discovery?.tokenEndpoint, "https://auth.example/token");
    for (const undeclared of [
      "userinfoEndpoint",
      "revocationEndpoint",
      "codeChallengeMethods",
    ])
      assert.equal(undeclared in (result.discovery ?? {}), false, undeclared);
  } finally {
    await store.close();
  }
});

/**
 * The installed record is keyed by connector id across the whole tenant, while
 * reads are scoped to the author who installed it. Overwriting another
 * author's record would silently take their connector away from them: they
 * would stop seeing it, and the second author's definition would stand in its
 * place. A second author is refused instead, and the first keeps theirs.
 */
test("a second author cannot overwrite a connector another author installed", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  try {
    const drafts = new ConnectorDrafts(store, {
      fetch: async () => new Response("", { status: 404 }),
    });
    const first = actor();
    const second: ActorContext = { ...first, subjectId: "another-author" };
    await drafts.fromProvider(first, "jira");
    const before = await drafts.getInstalled(first, "jira");
    assert.ok(before);
    await assert.rejects(drafts.fromProvider(second, "jira"), /denied/);
    assert.deepEqual(await drafts.getInstalled(first, "jira"), before);
    assert.equal(await drafts.getInstalled(second, "jira"), undefined);
    assert.deepEqual(
      (await drafts.listManifests(first)).map((item) => item.id),
      ["jira"],
    );
    // The owner may still redraft their own connector, from any session.
    await drafts.fromProvider({ ...first, sessionId: "later" }, "jira");
    assert.ok(await drafts.getInstalled(first, "jira"));
  } finally {
    await store.close();
  }
});
