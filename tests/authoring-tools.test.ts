import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { createAuthoringTools } from "../src/core/authoring-tools.js";
import { ConnectorDrafts } from "../src/server/connector-drafts.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import type { ActorContext } from "../src/core/operation-contracts.js";

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
  const drafts = new ConnectorDrafts(store);
  const tools = createAuthoringTools("ceremony_author", {
    fromProvider: (input) =>
      drafts.fromProvider(
        actor(),
        input.provider,
        input.openApiUrl,
        input.intent,
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
  assert.equal(drafted.draft.executable, false);
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
  const drafts = new ConnectorDrafts(store);
  const tools = createAuthoringTools("ceremony_author", {
    fromProvider: (input) =>
      drafts.fromProvider(actor(), input.provider, input.openApiUrl),
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
      body: JSON.stringify({ provider: "jira" }),
    },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.human, null);
  assert.deepEqual(body.draft.methods, ["oauth-code"]);
  assert.equal(JSON.stringify(body).includes("clientSecret"), false);
});
