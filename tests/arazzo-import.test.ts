import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { createTeachingRuntime } from "../src/server/teaching-runtime.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import { createCeremonyMcpHandler } from "../src/server/mcp.js";
import { teachingHttp } from "../src/server/teaching-http.js";
import { teachingRefusals } from "../src/server/mcp-teaching.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import { startHttpFixture } from "./connectors/doubles/http-fixture.js";
import {
  storeCatalog,
  storeRegistry,
  storeRunContext,
} from "./connectors/fixtures/arazzo/host.js";
import {
  storeWorkflow101,
  unsupportedFeatures101,
} from "./connectors/fixtures/arazzo/documents.js";

/*
 * Arazzo end to end: an agent imports a description over MCP (or the
 * application over HTTP) into a recipe draft; a person reviews and publishes
 * it; the published recipe runs through the command service with the
 * workflow's success criteria and retry enforced. The provider is a loopback
 * fixture and the host catalog is the reviewed one the format tests use.
 */

const tenantId = "tenant-arazzo";
const actorWith = (
  subjectId: string,
  capabilities: ActorContext["capabilities"],
): ActorContext => ({
  tenantId,
  subjectId,
  sessionId: `session-${subjectId}`,
  actorKind: "human",
  capabilities,
});
const author = actorWith("author", ["author"]);
const executor = actorWith("author", ["executor"]);
const person = actorWith("person", ["reviewer", "publisher"]);
const byToken = (token: string): ActorContext | null =>
  ({ author, executor, person })[token] ?? null;

async function fixture(t: TestContext, catalog = true) {
  let verified = "false";
  const server = await startHttpFixture(async (request) => {
    if (request.url.pathname === "/prepare")
      return { body: { setup: "setup-1" } };
    if (request.url.pathname === "/verify")
      return {
        headers: { "x-verified": verified },
        body: { account: "acct_1", token: "tok_synthetic_secret" },
      };
    return undefined;
  });
  t.after(() => server.close());
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "key",
    keys: { key: randomBytes(32) },
  });
  t.after(() => store.close());
  const { registry, calls } = storeRegistry({ origin: server.origin });
  const runtime = createTeachingRuntime({
    store,
    registry,
    identity: { authenticate: async () => author },
    origin: storeRunContext.origin,
    connections: new Map([
      [
        "store",
        {
          definition: {
            schemaVersion: 1,
            id: "store-connect",
            title: "Store",
            description: "",
            inputs: {},
            invocations: [
              {
                id: "prepare",
                use: {
                  kind: "operation",
                  id: "store.prepare",
                  version: "1.0.0",
                },
                dependsOn: [],
                bindings: { region: { from: "literal", value: "eu" } },
              },
            ],
            outputs: {},
          },
          outputContract: "account",
          revalidateOperation: "store.verify",
        },
      ],
    ]),
    context: async () => storeRunContext,
    authorize: async (who, run) => who.subjectId === run.subjectId,
    ...(catalog ? { arazzoCatalog: async () => storeCatalog(tenantId) } : {}),
  });
  const endpoint = "https://app.example/mcp";
  const mcp = createCeremonyMcpHandler(runtime, {
    resourceUrl: endpoint,
    issuer: "https://issuer.example",
    authenticate: (token) => byToken(token),
  });
  const post = (token: string, body: unknown) =>
    mcp.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      }),
    );
  async function rpc<T>(token: string, method: string, params: unknown) {
    await post(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    const text = await (await post(token, {
      jsonrpc: "2.0",
      id: 7,
      method,
      params,
    }))!.text();
    const payload = text.trimStart().startsWith("{")
      ? text
      : text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .at(-1)!;
    return (JSON.parse(payload) as { result: T }).result;
  }
  const tools = async (token: string) =>
    (
      await rpc<{ tools: Array<{ name: string }> }>(token, "tools/list", {})
    ).tools.map((tool) => tool.name);
  const invoke = async (
    token: string,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const result = await rpc<{
      isError?: boolean;
      content: Array<{ text: string }>;
    }>(token, "tools/call", { name, arguments: args });
    return {
      isError: result.isError === true,
      text: result.content[0]!.text,
      value: () => JSON.parse(result.content[0]!.text) as Record<string, any>,
    };
  };
  const drafts = () =>
    store.transaction((tx) => tx.list(tenantId, "draft", 100));
  return {
    server,
    store,
    runtime,
    calls,
    tools,
    invoke,
    drafts,
    setVerified: (value: string) => {
      verified = value;
    },
  };
}

test("Arazzo import is offered to authors only where the host has a reviewed catalog", async (t) => {
  const offered = await fixture(t);
  assert.ok((await offered.tools("author")).includes("ceremony_arazzo_import"));
  assert.ok(
    !(await offered.tools("executor")).includes("ceremony_arazzo_import"),
  );
  const absent = await fixture(t, false);
  assert.ok(!(await absent.tools("author")).includes("ceremony_arazzo_import"));
  // The route is absent too, not present-and-refusing.
  const response = await teachingHttp(
    new Request("https://app.example/api/v1/teaching/drafts/arazzo", {
      method: "POST",
      headers: {
        origin: storeRunContext.origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        document: JSON.stringify(storeWorkflow101()),
        workflowId: "connect-store",
      }),
    }),
    absent.runtime,
  );
  assert.equal(response.status, 404);
});

test("an agent imports an Arazzo workflow as a draft that runs, with its criteria enforced, only once a person publishes it", async (t) => {
  const f = await fixture(t);
  const document = storeWorkflow101();
  const verify = (
    (document.workflows as Record<string, unknown>[])[0]!.steps as Record<
      string,
      unknown
    >[]
  )[1]!;
  (verify.onFailure as Record<string, unknown>[])[0]!.retryAfter = 0;

  const imported = await f.invoke("author", "ceremony_arazzo_import", {
    document: JSON.stringify(document),
    workflowId: "connect-store",
  });
  assert.equal(imported.isError, false, imported.text);
  const result = imported.value();
  assert.equal(result.status, "drafted");
  const draft = result.draft;
  assert.equal(draft.author, "author");
  assert.deepEqual(draft.diagnostics, []);
  assert.deepEqual(
    draft.definition.invocations.map(
      (node: { id: string; outcome?: unknown }) => [
        node.id,
        Boolean(node.outcome),
      ],
    ),
    [
      ["prepare", true],
      ["verify", true],
    ],
  );
  assert.deepEqual(f.calls, [], "importing performs no effect");

  // A draft is never executable.
  const early = await f.invoke("executor", "ceremony_recipe_execute", {
    connectorId: "store",
    id: draft.definition.id,
    version: "1.0.1",
    digest: draft.digest,
    inputs: { region: "eu" },
  });
  assert.equal(early.isError, true);
  assert.equal(early.text, teachingRefusals.fallback);

  // A person reviews and publishes; no tool does this.
  await f.runtime.recipes.review(
    person,
    draft.id,
    draft.revision,
    draft.digest,
  );
  const published = await f.runtime.recipes.publish(
    person,
    draft.id,
    draft.revision,
    draft.digest,
  );
  const executed = await f.invoke("executor", "ceremony_recipe_execute", {
    connectorId: "store",
    id: draft.definition.id,
    version: published.version,
    digest: published.digest,
    inputs: { region: "eu" },
  });
  assert.equal(executed.isError, false, executed.text);
  let run = executed.value().run;
  const advance = async (nodeId: string, commandId: string) => {
    const result = await f.invoke("executor", "ceremony_advance", {
      runId: run.id,
      nodeId,
      revision: run.revision,
      commandId,
    });
    assert.equal(result.isError, false, result.text);
    run = result.value();
    return run.nodes.find((node: { id: string }) => node.id === nodeId);
  };
  assert.equal((await advance("prepare", "c1")).state, "complete");
  // `$response.header.X-Verified == 'true'` does not hold yet: the step fails
  // and its declared retry is still available.
  const missed = await advance("verify", "c2");
  assert.equal(missed.state, "failed");
  assert.equal(missed.retry.attempts, 1);
  f.setVerified("true");
  assert.equal((await advance("verify", "c3")).state, "complete");
  assert.equal(run.status, "complete");
  assert.deepEqual(f.calls, ["store.prepare", "store.verify", "store.verify"]);
  assert.doesNotMatch(JSON.stringify(run), /tok_synthetic_secret/);
});

test("a workflow outside the executable profile is reported with its pointers and yields no draft", async (t) => {
  const f = await fixture(t);
  const blocked = await f.invoke("author", "ceremony_arazzo_import", {
    document: JSON.stringify(unsupportedFeatures101()),
    workflowId: "unsupported",
  });
  assert.equal(blocked.isError, false, blocked.text);
  const result = blocked.value();
  assert.equal(result.status, "blocked");
  assert.equal(result.draft, undefined);
  assert.ok(
    result.issues.some(
      (issue: { code: string; pointer: string; severity: string }) =>
        issue.code === "arazzo.criteria.type-unsupported" &&
        issue.severity === "blocking" &&
        issue.pointer.startsWith("/workflows/0/steps/0/successCriteria/0"),
    ),
  );
  assert.equal((await f.drafts()).length, 0);

  // Not JSON at all is an invalid request, not a crash.
  const garbage = await f.invoke("author", "ceremony_arazzo_import", {
    document: "arazzo: 1.0.1",
    workflowId: "unsupported",
  });
  assert.equal(garbage.isError, true);
  assert.equal((await f.drafts()).length, 0);
});

test("the HTTP route drafts the same way, under the caller's authorship", async (t) => {
  const f = await fixture(t);
  const response = await teachingHttp(
    new Request("https://app.example/api/v1/teaching/drafts/arazzo", {
      method: "POST",
      headers: {
        origin: storeRunContext.origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        document: JSON.stringify(storeWorkflow101()),
        workflowId: "connect-store",
        recipeId: "store-from-arazzo",
      }),
    }),
    f.runtime,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "drafted");
  assert.equal(body.draft.definition.id, "store-from-arazzo");
  assert.equal(body.draft.author, "author");
  assert.equal((await f.drafts()).length, 1);
});
