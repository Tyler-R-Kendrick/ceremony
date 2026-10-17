import assert from "node:assert/strict";
import test from "node:test";
import {
  compileOperations,
  createOpenApiHttpAdapter,
  isReadResult,
  readOpenApi,
} from "../../../src/server/connectors/formats/openapi/index.js";
import {
  TRICKLE_BYTES,
  TRICKLE_MS,
  timed,
  trickleFetch,
  trickled,
} from "../doubles/trickle-body.js";
import {
  harness,
  invokeAdapter,
  loopbackDestination,
  makeBinding,
} from "./helpers.js";

/*
 * One deadline for a request's headers and its whole body, for the generic
 * OpenAPI adapter too. Its request timer used to be cleared as soon as the
 * headers arrived and the body then read with no signal, so an answer that
 * trickled a byte at a time held the call for as long as it trickled (a size
 * ceiling does not help: a byte every 50 ms stays under any ceiling for
 * days). With a 300 ms request timeout against a 10 s trickle the call must
 * end near 300 ms with the body cancelled; a write the deadline cut is
 * journalled as unknown, as a write whose answer never came always is.
 */

const DEADLINE_MS = 300;
/** Far above the deadline and far below the trickle's own 10 s. */
const CUT_WITHIN_MS = 5_000;

const document = {
  openapi: "3.1.0",
  info: { title: "Deadline", version: "1.0.0" },
  servers: [{ url: "https://deadline.example.test/api" }],
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        responses: {
          "200": {
            description: "Pets",
            content: {
              "application/json": {
                schema: { type: "array", items: { type: "object" } },
              },
            },
          },
        },
      },
      post: {
        operationId: "createPet",
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

async function trickling(options: { signal?: AbortSignal } = {}) {
  const read = await readOpenApi(document);
  assert.ok(isReadResult(read));
  const destination = loopbackDestination("http://127.0.0.1:9", "api");
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
  const seen = trickled();
  const run = await harness({
    binding,
    fetch: trickleFetch(seen),
    ...options,
  });
  const refFor = (nativeId: string) =>
    compiled.operations.find((item) => item.nativeId === nativeId)!
      .operationRef;
  return { seen, run, refFor };
}

function assertCut(
  outcome: { ms: number; error: unknown },
  seen: ReturnType<typeof trickled>,
  what: string,
) {
  assert.equal(
    outcome.error,
    undefined,
    `${what}: the call answers rather than throws`,
  );
  assert.ok(seen.sent > 0, `${what}: the body was in fact trickling`);
  assert.ok(seen.cancelled && !seen.ended, `${what}: the body was cancelled`);
  assert.ok(
    outcome.ms < CUT_WITHIN_MS,
    `${what}: took ${Math.round(outcome.ms)} ms; the timeout is ${DEADLINE_MS} ms and the body runs ${TRICKLE_BYTES * TRICKLE_MS} ms`,
  );
}

test("OpenAPI: a read whose answer trickles past the request timeout is cut at it, and fails", async () => {
  const { seen, run, refFor } = await trickling();
  const adapter = createOpenApiHttpAdapter({ requestTimeoutMs: DEADLINE_MS });
  let state: string | undefined;
  let code: string | undefined;
  const outcome = await timed(async () => {
    const result = await invokeAdapter(adapter, run.ctx, {
      operationRef: refFor("listPets"),
      input: {},
    });
    state = result.state;
    code = result.code;
  });
  assertCut(outcome, seen, "read");
  assert.equal(state, "failed");
  assert.equal(code, "upstream-unavailable");
});

test("OpenAPI: a write whose answer trickles past the request timeout is cut at it and journalled as unknown", async () => {
  const { seen, run, refFor } = await trickling();
  const adapter = createOpenApiHttpAdapter({ requestTimeoutMs: DEADLINE_MS });
  let state: string | undefined;
  const outcome = await timed(async () => {
    const result = await invokeAdapter(adapter, run.ctx, {
      operationRef: refFor("createPet"),
      input: { body: { name: "Rex" } },
    });
    state = result.state;
  });
  assertCut(outcome, seen, "write");
  assert.equal(state, "indeterminate");
  assert.deepEqual(
    run.ports.inspect.effects().map((entry) => entry.outcome?.status),
    ["indeterminate"],
    "the cut write is in the journal as unknown, not as applied or not applied",
  );
});

test("OpenAPI: a caller that goes away mid-body ends the read", async () => {
  const caller = new AbortController();
  const { seen, run, refFor } = await trickling({ signal: caller.signal });
  const adapter = createOpenApiHttpAdapter({ requestTimeoutMs: 60_000 });
  setTimeout(() => caller.abort(), DEADLINE_MS);
  const outcome = await timed(() =>
    invokeAdapter(adapter, run.ctx, {
      operationRef: refFor("listPets"),
      input: {},
    }),
  );
  assertCut(outcome, seen, "cancelled");
});
