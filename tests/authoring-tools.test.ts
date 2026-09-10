import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { createAuthoringTools } from "../src/core/authoring-tools.js";
import { ConnectorDrafts } from "../src/server/connector-drafts.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import { disambiguateProvider } from "../src/core/connector-authoring.js";

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
  assert.deepEqual(drafted.draft.methods, ["oauth-code"]);
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

test("authoring chat drafts from a misspelled name without a form", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  const drafts = new ConnectorDrafts(store, {
    fetch: async () => new Response("", { status: 404 }),
  });
  const reply = await drafts.chat(actor(), "create a ceremony for blusky");
  assert.equal(reply.result?.human, null);
  assert.equal(reply.result?.resolution?.resolved, "bluesky");
  assert.ok(reply.result?.draft?.methods.includes("oauth-code"));
  assert.equal(reply.result?.draft?.connectorId, "bluesky");
  assert.match(reply.messages.at(-1)!.text, /Bluesky/);
  const installed = await drafts.getInstalled(actor(), "bluesky");
  assert.equal(installed?.manifest.id, "bluesky");
  await store.close();
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

test("authored Bluesky connector is listed and can start a ceremony", async (t) => {
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
  const chat = await fetch(`${fixture.origin}/api/v1/teaching/authoring/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: "create a ceremony for blusky" }),
  });
  assert.equal(chat.status, 200);
  const drafted = await chat.json();
  assert.equal(drafted.result.draft.connectorId, "bluesky");
  assert.match(drafted.messages.at(-1).text, /\/\?connector=bluesky/);
  const capabilities = await fetch(
    `${fixture.origin}/api/v1/teaching/capabilities`,
    { headers: { cookie, origin: fixture.origin } },
  );
  assert.ok((await capabilities.json()).connectors.includes("bluesky"));
  const started = await fetch(`${fixture.origin}/api/v1/teaching/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ connectorId: "bluesky" }),
  });
  const startedBody = await started.text();
  assert.equal(started.status, 200, startedBody);
  const run = JSON.parse(startedBody);
  assert.equal(run.provider, "bluesky");
  assert.ok(Array.isArray(run.nodes) && run.nodes.length >= 1);
  assert.ok(
    run.nodes.some(
      (node: { state?: string; operationId?: string }) =>
        node.operationId === "authored.authorize-user" &&
        node.state === "awaiting-human",
    ),
  );
  assert.equal(run.identity, undefined);
  const deleted = await fetch(
    `${fixture.origin}/api/v1/teaching/authoring/delete`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        connectorId: "bluesky",
        runId: run.id,
        revision: run.revision,
      }),
    },
  );
  assert.equal(deleted.status, 200);
  const after = await fetch(`${fixture.origin}/api/v1/teaching/capabilities`, {
    headers: { cookie, origin: fixture.origin },
  });
  assert.equal((await after.json()).connectors.includes("bluesky"), false);
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
      if (url.endsWith("/.well-known/oauth-authorization-server"))
        return Response.json({
          authorization_endpoint: "https://auth.example/authorize",
          grant_types_supported: [
            "authorization_code",
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
  assert.deepEqual(result.draft?.methods.sort(), ["device", "oauth-code"]);
  assert.ok(
    result.discovery?.documents.includes(
      "/.well-known/oauth-authorization-server",
    ),
  );
  assert.equal(result.discovery?.searchUsed, false);
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
