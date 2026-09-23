import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  compileOperations,
  createOpenApiHttpAdapter,
  isReadResult,
  readOpenApi,
} from "../../../src/server/connectors/formats/openapi/index.js";
import { createEffectJournalPort } from "../../../src/server/connectors/state/index.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import { fixtureActor } from "../doubles/ports.js";
import { sqliteFixture } from "../fixtures/state/records.js";
import {
  allStrings,
  harness,
  invokeAdapter,
  loopbackDestination,
  makeBinding,
} from "./helpers.js";

/*
 * The OpenAPI adapter against the durable effect journal (the encrypted
 * AsyncCeremonyStore the product runs on), not the in-memory double. The
 * durable journal records an outcome once: completing a completed effect with
 * a different status is `effect.already-completed`. So every distinct request
 * the adapter makes -- a repeated read, a write retried after a refusal that
 * was not applied, the retry after a credential renewal -- needs its own
 * journal entry, while a write that was applied still answers from the
 * journal instead of being sent again.
 */

const CANARY = "journal-key-Qm29xV";

const document = {
  openapi: "3.1.0",
  info: { title: "Journal", version: "1.0.0" },
  servers: [{ url: "https://journal.example.test/api" }],
  components: {
    securitySchemes: {
      key: { type: "apiKey", name: "X-Api-Key", in: "header" },
    },
  },
  security: [{ key: [] }],
  paths: {
    "/items": {
      get: {
        operationId: "listItems",
        responses: {
          "200": {
            description: "Items",
            content: {
              "application/json": {
                schema: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
      post: {
        operationId: "createItem",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
          },
        },
        responses: { "201": { description: "Created" } },
      },
    },
  },
};

async function durableSetup(
  t: TestContext,
  replies: Array<{ status: number; body?: unknown }>,
) {
  let served = 0;
  const server = await startHttpFixture(() => {
    const reply = replies[Math.min(served, replies.length - 1)]!;
    served += 1;
    return {
      status: reply.status,
      ...(reply.body === undefined
        ? {}
        : { body: reply.body as Record<string, unknown> }),
    };
  });
  t.after(() => server.close());
  const database = await sqliteFixture();
  t.after(() => database.close());
  const read = await readOpenApi(document);
  assert.ok(isReadResult(read));
  const destination = loopbackDestination(server.origin, "api");
  const compiled = compileOperations(read.definition, read, {
    destinationId: destination.id,
    destination,
  });
  const binding = makeBinding({
    destination,
    operations: compiled.operations,
    settings: {
      ...compiled.settings,
      "openapi-http-profiles": read.definition.authentication,
    },
    definition: read.definition,
  });
  const context = await harness({ binding, credential: { apiKey: CANARY } });
  const effects = createEffectJournalPort(database.store);
  const ctx = {
    ...context.ctx,
    environment: { ...context.ctx.environment, effects },
  };
  const refFor = (nativeId: string) => {
    const found = compiled.operations.find(
      (item) => item.nativeId === nativeId,
    );
    assert.ok(found, `${nativeId} compiled`);
    return found.operationRef;
  };
  return {
    adapter: createOpenApiHttpAdapter(),
    ctx,
    effects,
    refFor,
    served: () => served,
  };
}

test("a repeated read whose answer changes is journaled once per request on the durable journal", async (t) => {
  const state = await durableSetup(t, [
    { status: 200, body: ["one"] },
    { status: 401, body: { error: "unauthorized" } },
  ]);
  const request = { operationRef: state.refFor("listItems"), input: {} };
  const first = await invokeAdapter(state.adapter, state.ctx, request);
  assert.equal(first.state, "complete");
  // The same read again; the destination now refuses the key. This used to
  // reuse the first read's journal entry and fail completing it a second time.
  const second = await invokeAdapter(state.adapter, state.ctx, request);
  assert.equal(second.state, "failed");
  assert.equal(second.code, "upstream-rejected");
  assert.equal(state.served(), 2, "a read is repeated, never replayed");
  assert.ok(first.effectRef && second.effectRef);
  assert.notEqual(first.effectRef, second.effectRef);
  assert.equal(
    (await state.effects.get(fixtureActor, first.effectRef))?.status,
    "applied",
  );
  assert.equal(
    (await state.effects.get(fixtureActor, second.effectRef))?.status,
    "not-applied",
  );
  assert.deepEqual(await state.effects.listUnresolved(fixtureActor), []);
  for (const value of allStrings([first, second]))
    assert.ok(!value.includes(CANARY));
});

test("a write refused before it applied is retried as a new entry, and once applied it is answered from the journal", async (t) => {
  const state = await durableSetup(t, [
    { status: 400, body: { error: "bad" } },
    { status: 201 },
  ]);
  const request = {
    operationRef: state.refFor("createItem"),
    input: { body: { name: "Rex" } },
  };
  const refused = await invokeAdapter(state.adapter, state.ctx, request);
  assert.equal(refused.state, "failed");
  assert.equal(refused.code, "upstream-rejected");
  const applied = await invokeAdapter(state.adapter, state.ctx, request);
  assert.equal(applied.state, "complete");
  assert.notEqual(applied.effectRef, refused.effectRef);
  assert.equal(state.served(), 2);
  // The same write a third time: the journal answers, nothing is sent.
  const replayed = await invokeAdapter(state.adapter, state.ctx, request);
  assert.equal(replayed.state, "complete");
  assert.equal(replayed.effectRef, applied.effectRef);
  assert.equal(state.served(), 2, "an applied write is never sent twice");
  assert.equal(
    (await state.effects.get(fixtureActor, refused.effectRef!))?.status,
    "not-applied",
  );
  assert.equal(
    (await state.effects.get(fixtureActor, applied.effectRef!))?.status,
    "applied",
  );
});

test("a write whose outcome is unknown is reported, not retried, on the durable journal", async (t) => {
  const state = await durableSetup(t, [{ status: 503 }, { status: 201 }]);
  const request = {
    operationRef: state.refFor("createItem"),
    input: { body: { name: "Rex" } },
  };
  const unknown = await invokeAdapter(state.adapter, state.ctx, request);
  assert.equal(unknown.state, "indeterminate");
  const again = await invokeAdapter(state.adapter, state.ctx, request);
  assert.equal(again.state, "indeterminate");
  assert.equal(again.effectRef, unknown.effectRef);
  assert.equal(state.served(), 1);
});
