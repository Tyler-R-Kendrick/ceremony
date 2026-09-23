import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import {
  agent,
  createHarness,
  delegate,
  FIXTURE_DOCUMENT,
  human,
  ORIGIN,
  type Harness,
} from "./harness.js";

/*
 * The published OpenAPI description, held to what the handler actually does.
 *
 * docs/openapi/connectors.openapi.json is generated from the handler's own
 * Zod schemas, so it cannot disagree with them about a field's type. What it
 * can get wrong is everything around them: a route it forgot, a status code it
 * never mentions, a projection it describes with the wrong shape, a request it
 * says is valid that the server refuses. So this test reads the committed
 * document -- not the generator -- and drives the real handler through the
 * shared harness, with every request checked against the description before
 * it is sent and every response checked after it comes back.
 *
 * Every operation the description names must be exercised, and every one
 * except the provider event routes must succeed at least once: a documented
 * route nobody can reach is as much a contract defect as an undocumented one.
 * The event routes are exercised through the "no receiver" answer, which is
 * what this harness mounts; signed delivery is covered by the events suite.
 */

type Json = Record<string, unknown>;
const document = JSON.parse(
  readFileSync(
    new URL("../../../docs/openapi/connectors.openapi.json", import.meta.url),
    "utf8",
  ),
) as {
  paths: Record<string, Record<string, Json>>;
  components: { parameters: Record<string, Json> };
};

const ajv = new Ajv2020({ strict: false, allErrors: true });
// The three formats the description uses, each at least as strict as Zod's.
ajv.addFormat("uri", (value: string) => URL.canParse(value));
ajv.addFormat("uuid", /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
ajv.addFormat(
  "date-time",
  (value: string) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) && !Number.isNaN(Date.parse(value)),
);
ajv.addSchema(document, "openapi");

const escape = (part: string) => part.replace(/~/g, "~0").replace(/\//g, "~1");
function at(pointer: string): Json | undefined {
  let node: unknown = document;
  for (const part of pointer.split("/").slice(1))
    node = (node as Json | undefined)?.[
      part.replace(/~1/g, "/").replace(/~0/g, "~")
    ];
  return node as Json | undefined;
}
function validator(pointer: string): ValidateFunction {
  const validate = ajv.getSchema(`openapi#${pointer}`);
  assert.ok(validate, `no schema at ${pointer}`);
  return validate;
}
function conform(pointer: string, value: unknown, what: string) {
  const validate = validator(pointer);
  assert.ok(
    validate(value),
    `${what} does not match the description: ${ajv.errorsText(validate.errors)}`,
  );
}

type Route = {
  method: string;
  pattern: RegExp;
  names: string[];
  pointer: string;
  operationId: string;
};
const routes: Route[] = Object.entries(document.paths).flatMap(
  ([template, item]) =>
    Object.entries(item).map(([method, operation]) => ({
      method: method.toUpperCase(),
      names: [...template.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!),
      pattern: new RegExp(
        `^${template.replace(/\{[^}]+\}/g, "([^/]+)").replace(/\./g, "\\.")}$`,
      ),
      pointer: `/paths/${escape(template)}/${method}`,
      operationId: operation.operationId as string,
    })),
);

const exercised = new Map<string, Set<number>>();

/** The description's schema pointer for a documented response, or null when it has no body. */
function responsePointer(route: Route, status: number): string | null {
  let pointer = `${route.pointer}/responses/${status}`;
  let node = at(pointer);
  assert.ok(
    node,
    `${route.operationId} answered ${status}, which the description does not document`,
  );
  if (typeof node.$ref === "string") {
    pointer = node.$ref.slice(1);
    node = at(pointer)!;
  }
  return node.content ? `${pointer}/content/application~1json/schema` : null;
}

/**
 * One exchange, held to the description on both sides. The request is
 * checked before it is sent (a request the description calls valid must be
 * one the test would expect to work), and the response after.
 */
async function exchange(
  harness: Harness,
  method: "GET" | "POST",
  path: string,
  init: { session?: string; body?: unknown; origin?: string | null } = {},
): Promise<{ status: number; body: Json; response: Response }> {
  const url = new URL(path, ORIGIN);
  const route = routes.find(
    (item) => item.method === method && item.pattern.test(url.pathname),
  );
  assert.ok(route, `${method} ${url.pathname} is not in the description`);
  const operation = at(route.pointer)!;
  const values = route.pattern.exec(url.pathname)!.slice(1);
  route.names.forEach((name, index) => {
    const parameter = document.components.parameters[name];
    const pointer = parameter
      ? `/components/parameters/${name}/schema`
      : `${route.pointer}/parameters/${(operation.parameters as Json[]).findIndex((item) => item.name === name)}/schema`;
    conform(pointer, decodeURIComponent(values[index]!), `path ${name}`);
  });
  if (operation.requestBody)
    conform(
      `${route.pointer}/requestBody/content/application~1json/schema`,
      init.body,
      `${route.operationId} request`,
    );
  const response = await harness.fetch(`${url.pathname}${url.search}`, {
    method,
    ...(init.session ? { session: init.session } : {}),
    ...(init.body === undefined ? {} : { body: init.body }),
    ...(init.origin === undefined ? {} : { origin: init.origin }),
  });
  const statuses = exercised.get(route.operationId) ?? new Set<number>();
  statuses.add(response.status);
  exercised.set(route.operationId, statuses);
  const pointer = responsePointer(route, response.status);
  const text = await response.text();
  const body = (text ? JSON.parse(text) : {}) as Json;
  if (pointer)
    conform(pointer, body, `${route.operationId} ${response.status} response`);
  return { status: response.status, body, response };
}

const SESSION = "contract-human";
const ADMIN = "contract-admin";
const AGENT = "contract-agent";

function operationRef(harness: Harness, bindingRef: string, nativeId: string) {
  const binding = harness.definitions
    .bindings()
    .filter((item) => item.bindingRef === bindingRef)
    .sort((a, b) => a.revision - b.revision)
    .at(-1);
  const operation = binding?.operations.find(
    (item) => item.nativeId === nativeId,
  );
  assert.ok(operation, `no approved operation ${nativeId}`);
  return operation.operationRef;
}

const connectionPath = (ref: string) =>
  `/api/v1/connectors/connections/${encodeURIComponent(ref)}`;

async function bind(
  harness: Harness,
  profileId: "oauth" | "api-key",
): Promise<{ definitionRef: string; bindingRef: string }> {
  const imported = await exchange(
    harness,
    "POST",
    "/api/v1/connectors/import",
    {
      session: SESSION,
      body: {
        kind: "upload",
        mediaType: "application/json",
        text: FIXTURE_DOCUMENT(harness.provider.origin),
      },
    },
  );
  assert.equal(imported.status, 200);
  const definitionRef = (imported.body.definitions as string[])[0]!;
  const binding = await exchange(
    harness,
    "POST",
    "/api/v1/connectors/bindings",
    {
      session: SESSION,
      body: {
        definitionRef,
        adapterId: "fixture-http",
        approvals: {
          destinations: [harness.provider.origin],
          operations: ["listItems", { nativeId: "createItem" }],
          profileId,
          permittedTargets: [{ kind: "account", id: "acct-primary" }],
        },
      },
    },
  );
  assert.equal(binding.status, 201);
  return { definitionRef, bindingRef: binding.body.bindingRef as string };
}

/** An open connection with the same profile and target is answered again, so a target tells two apart. */
async function connect(
  harness: Harness,
  bindingRef: string,
  profileId = "oauth",
  target?: { kind: string; id: string },
) {
  const connected = await exchange(
    harness,
    "POST",
    "/api/v1/connectors/connections",
    {
      session: SESSION,
      body: {
        bindingRef,
        intent: {
          profileId,
          requestedPermissions: ["read", "write"],
          ...(target ? { target } : {}),
        },
      },
    },
  );
  assert.equal(connected.status, 201);
  return connected.body;
}

/** Completes the fixture provider's authorization and returns through the documented callback. */
async function authorize(harness: Harness, presentationUrl: string) {
  const provider = await fetch(presentationUrl, { redirect: "manual" });
  await provider.body?.cancel().catch(() => {});
  const location = new URL(provider.headers.get("location")!);
  const callback = await exchange(
    harness,
    "GET",
    `${location.pathname}${location.search}`,
    { session: SESSION },
  );
  assert.equal(callback.status, 303);
  assert.ok(
    callback.response.headers.get("location")?.startsWith(`${ORIGIN}/`),
    "the documented Location header is on the deployment's own origin",
  );
}

async function revision(harness: Harness, ref: string, session = SESSION) {
  const status = await exchange(harness, "GET", connectionPath(ref), {
    session,
  });
  assert.equal(status.status, 200);
  return status.body.revision as number;
}

test("every documented connector route conforms to the OpenAPI description", async (t) => {
  const configured = new Map<string, Record<string, string>>([
    ["6f1c1b1e-2a8c-4c55-9a51-4f1f2b0c9d10", { FIXTURE_REGION: "eu" }],
  ]);
  const harness = await createHarness({
    service: {
      configure: {
        consume: async (_actor, secretRef) => {
          const values = configured.get(secretRef);
          configured.delete(secretRef);
          return values;
        },
        write: async () => ({ revision: "cfg:contract" }),
      },
    },
  });
  t.after(() => harness.close());
  const person = harness.register(SESSION, human());
  harness.register(
    ADMIN,
    human({ subjectId: "subject-1", capabilities: ["executor", "admin"] }),
  );
  const assistant: ActorContext = harness.register(AGENT, agent());
  await delegate(harness.store, assistant);
  void person;

  // Directory, import and review.
  const catalog = await exchange(harness, "GET", "/api/v1/connectors/catalog", {
    session: SESSION,
  });
  assert.equal(catalog.status, 200);
  const { definitionRef, bindingRef } = await bind(harness, "oauth");
  assert.equal(
    (
      await exchange(harness, "GET", "/api/v1/connectors/definitions", {
        session: SESSION,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await exchange(
        harness,
        "GET",
        `/api/v1/connectors/definitions/${encodeURIComponent(definitionRef)}`,
        { session: SESSION },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await exchange(harness, "GET", "/api/v1/connectors/bindings", {
        session: SESSION,
      })
    ).status,
    200,
  );
  const configure = await exchange(
    harness,
    "POST",
    "/api/v1/connectors/configure",
    {
      session: SESSION,
      body: { secretRef: "6f1c1b1e-2a8c-4c55-9a51-4f1f2b0c9d10" },
    },
  );
  assert.equal(configure.status, 200);
  assert.deepEqual(configure.body.names, ["FIXTURE_REGION"]);

  // A connection that is polled and then cancelled.
  const abandoned = await connect(harness, bindingRef, "oauth", {
    kind: "account",
    id: "acct-primary",
  });
  const abandonedRef = abandoned.connectionRef as string;
  assert.equal(
    (
      await exchange(harness, "POST", `${connectionPath(abandonedRef)}/poll`, {
        session: SESSION,
        body: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await exchange(
        harness,
        "POST",
        `${connectionPath(abandonedRef)}/cancel`,
        { session: SESSION, body: {} },
      )
    ).status,
    200,
  );

  // A connection that completes, is used, and is revoked and deleted.
  const pending = await connect(harness, bindingRef);
  const ref = pending.connectionRef as string;
  const listed = await exchange(
    harness,
    "GET",
    "/api/v1/connectors/connections?lifecycle=authorization-required",
    { session: SESSION },
  );
  assert.equal(listed.status, 200);
  await authorize(harness, (pending.presentation as { url: string }).url);
  assert.equal(
    (
      await exchange(harness, "POST", `${connectionPath(ref)}/verify`, {
        session: SESSION,
        body: {},
      })
    ).status,
    200,
  );
  const read = await exchange(
    harness,
    "POST",
    `${connectionPath(ref)}/invoke`,
    {
      session: SESSION,
      body: {
        operationRef: operationRef(harness, bindingRef, "listItems"),
        input: { project: "alpha" },
        commandId: "contract-read-1",
      },
    },
  );
  assert.equal(read.body.state, "complete");
  const write = await exchange(
    harness,
    "POST",
    `${connectionPath(ref)}/invoke`,
    {
      session: SESSION,
      body: {
        operationRef: operationRef(harness, bindingRef, "createItem"),
        input: { name: "contract" },
        commandId: "contract-write-1",
      },
    },
  );
  assert.equal(write.body.state, "human-required");

  // What an assistant sees, and what it is refused.
  const seen = await exchange(harness, "GET", connectionPath(ref), {
    session: AGENT,
  });
  assert.equal(seen.status, 200);
  assert.equal(seen.body.verified, true, "the assistant projection was served");
  assert.equal(seen.body.displayName, undefined);
  const refused = await exchange(
    harness,
    "POST",
    `${connectionPath(ref)}/revoke-decline`,
    { session: AGENT, body: { expectedRevision: seen.body.revision } },
  );
  assert.equal(refused.status, 403, "a human-only route refuses an assistant");
  assert.equal(refused.body.error, "denied");

  // Revocation: requested, declined, requested again, approved by revoking.
  assert.equal(
    (
      await exchange(harness, "POST", `${connectionPath(ref)}/revoke-request`, {
        session: AGENT,
        body: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await exchange(harness, "POST", `${connectionPath(ref)}/revoke-decline`, {
        session: SESSION,
        body: { expectedRevision: await revision(harness, ref) },
      })
    ).status,
    200,
  );
  const revoked = await exchange(
    harness,
    "POST",
    `${connectionPath(ref)}/revoke`,
    {
      session: ADMIN,
      body: { expectedRevision: await revision(harness, ref, ADMIN) },
    },
  );
  assert.equal(revoked.status, 200);
  const deleted = await exchange(
    harness,
    "POST",
    `${connectionPath(ref)}/delete`,
    {
      session: ADMIN,
      body: {
        expectedRevision: (revoked.body.connection as Json).revision,
      },
    },
  );
  assert.deepEqual(deleted.body, { deleted: true });
  assert.equal(
    (await exchange(harness, "GET", connectionPath(ref), { session: SESSION }))
      .status,
    404,
  );

  // Reconnect and disconnect.
  const second = await connect(harness, bindingRef);
  const secondRef = second.connectionRef as string;
  await authorize(harness, (second.presentation as { url: string }).url);
  assert.equal(
    (
      await exchange(
        harness,
        "POST",
        `${connectionPath(secondRef)}/reconnect`,
        {
          session: SESSION,
          body: { expectedRevision: await revision(harness, secondRef) },
        },
      )
    ).status,
    200,
  );
  const disconnected = await exchange(
    harness,
    "POST",
    `${connectionPath(secondRef)}/disconnect`,
    {
      session: SESSION,
      body: { expectedRevision: await revision(harness, secondRef) },
    },
  );
  assert.equal(disconnected.status, 200);

  // The private input handoff.
  const keyed = await bind(harness, "api-key");
  const collecting = await connect(harness, keyed.bindingRef, "api-key");
  const handoff = collecting.handoff as { handoffRef: string };
  const completed = await exchange(
    harness,
    "POST",
    `${connectionPath(collecting.connectionRef as string)}/handoffs/${encodeURIComponent(handoff.handoffRef)}/input`,
    { session: SESSION, body: { values: { apiKey: "fixture-api-key" } } },
  );
  assert.equal(completed.status, 200);
  assert.ok(!JSON.stringify(completed.body).includes("fixture-api-key"));

  // Documented failures.
  const unauthenticated = await exchange(
    harness,
    "GET",
    "/api/v1/connectors/catalog",
  );
  assert.equal(unauthenticated.status, 401);
  const crossSite = await exchange(
    harness,
    "POST",
    "/api/v1/connectors/import",
    {
      session: SESSION,
      origin: "https://elsewhere.example",
      body: { kind: "url", url: "https://elsewhere.example/openapi.json" },
    },
  );
  assert.equal(crossSite.status, 403);
  for (const events of [
    "/api/v1/connectors/events/fixture",
    "/api/v1/connectors/events/fixture/subscription-1",
  ]) {
    const answer = await exchange(harness, "POST", events, { body: {} });
    assert.equal(answer.status, 404, "no receiver is mounted in this harness");
  }

  const missing = routes
    .map((route) => route.operationId)
    .filter((operationId) => !exercised.has(operationId));
  assert.deepEqual(missing, [], "every documented operation is exercised");
  const neverSucceeded = [...exercised]
    .filter(
      ([operationId, statuses]) =>
        !operationId.startsWith("receive") &&
        ![...statuses].some((status) => status >= 200 && status < 400),
    )
    .map(([operationId]) => operationId);
  assert.deepEqual(neverSucceeded, [], "every non-event operation succeeds");
});

test("the description and the handler refuse the same malformed request", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  harness.register(SESSION, human());
  const { bindingRef } = await bind(harness, "oauth");
  // A forged tenant in a body is exactly what the inputs refuse by name.
  const forged = {
    bindingRef,
    tenantId: "tenant-b",
    intent: { requestedPermissions: [] },
  };
  const validate = validator(
    "/paths/~1api~1v1~1connectors~1connections/post/requestBody/content/application~1json/schema",
  );
  assert.equal(validate(forged), false, "the description rejects it");
  const response = await harness.fetch("/api/v1/connectors/connections", {
    session: SESSION,
    body: forged,
  });
  assert.equal(response.status, 400, "and so does the handler");
  const body = (await response.json()) as Json;
  conform(
    `/components/responses/Error400/content/application~1json/schema`,
    body,
    "the refusal",
  );
  assert.equal(body.error, "invalid-request");
});

test("the response schemas are not vacuous", () => {
  const view = validator("/components/schemas/ConnectionView");
  assert.equal(view({}), false);
  assert.equal(
    view({
      connectionRef: "connection:1",
      bindingRef: "binding:1",
      ecosystem: "openapi",
      service: "fixture",
      lifecycle: "not-a-lifecycle",
      generation: 0,
      revision: 1,
      custody: "host-owned",
      verified: false,
    }),
    false,
    "an unknown lifecycle is refused",
  );
  const error = validator("/components/schemas/ErrorBody");
  assert.equal(error({ error: "stack-trace", message: "boom" }), false);
  assert.equal(
    error({ error: "denied", message: "x", providerBody: "raw" }),
    false,
    "an error body carries nothing but its code, message and detail",
  );
});
