import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";
import {
  agent,
  completeOauthCallback,
  createHarness,
  delegate,
  FIXTURE_DOCUMENT,
  handlerFetch,
  human,
  ORIGIN,
} from "./connectors/commands/harness.js";

/*
 * A client generated from the published OpenAPI description, used for real.
 *
 * tests/connectors/commands/openapi-contract.test.ts holds the description to
 * the handler with a JSON Schema validator. That proves the document is true;
 * it does not prove a generator can turn it into a client that works, which
 * is the claim docs/sdk.md makes to anyone who reads it. This test makes that
 * claim with the generator a TypeScript consumer would most likely reach for:
 *
 * 1. openapi-typescript generates types from the committed document -- not
 *    from the Zod schemas behind it -- into a gitignored directory.
 * 2. tsc type-checks a small consumer (tests/consumers/openapi-typescript)
 *    that calls the API through openapi-fetch with those types and no cast,
 *    together with a file of calls the types must refuse.
 * 3. That same consumer module then drives the real connector handler in the
 *    shared command harness: import, review, binding approval, connect, the
 *    provider's authorization, listing, invocation, and the documented 404
 *    and 403 answers.
 *
 * openapi-typescript and openapi-fetch are devDependencies: nothing in the
 * package depends on them, and a consumer is free to choose another
 * generator. `defaultNonNullable: false` is the setting docs/sdk.md tells
 * consumers to use: without it a property with a default (`confirm` on
 * invoke, `ownerKind` on connect) becomes required in the request types, so a
 * client would have to send values the server already defaults.
 */

const root = resolve(import.meta.dirname, "..");
const consumer = join(root, "tests/consumers/openapi-typescript");
const generated = join(consumer, "generated");

/**
 * What this test uses of the consumer, stated here rather than taken with
 * `typeof import(...)`: a type-level import would pull the consumer, and the
 * generated types it imports, into the repository's own `tsc --noEmit`,
 * which runs before anything has been generated. The consumer's real types
 * are checked by the tsc run inside the test.
 */
type View = {
  connectionRef: string;
  lifecycle: string;
  presentation?: { url?: string };
};
type ConsumerModule = {
  ConnectorApiError: new (
    ...args: never[]
  ) => Error & { status: number; code?: string };
  isHumanView(view: View): boolean;
  connectorClient(options: {
    baseUrl: string;
    origin: string;
    cookie: string;
    fetch: (request: Request) => Promise<Response>;
  }): {
    catalog(): Promise<unknown[]>;
    importDocument(text: string): Promise<string[]>;
    definition(ref: string): Promise<{ definition: { definitionRef: string } }>;
    approve(
      definitionRef: string,
      adapterId: string,
      approvals: Record<string, unknown>,
    ): Promise<{ bindingRef: string; status: string }>;
    bindings(): Promise<Array<{ bindingRef: string }>>;
    connect(bindingRef: string, profileId: string): Promise<View>;
    connections(lifecycle?: string): Promise<View[]>;
    connection(
      ref: string,
    ): Promise<
      | { found: true; connection: View }
      | { found: false; code: string | undefined }
    >;
    invoke(
      connectionRef: string,
      operationRef: string,
      input: Record<string, unknown>,
      commandId: string,
    ): Promise<{ state: string; effect: string }>;
  };
};

async function generate(): Promise<string> {
  const description = JSON.parse(
    readFileSync(join(root, "docs/openapi/connectors.openapi.json"), "utf8"),
  ) as Parameters<typeof openapiTS>[0];
  const source = astToString(
    await openapiTS(description, { defaultNonNullable: false }),
  );
  rmSync(generated, { recursive: true, force: true });
  mkdirSync(generated, { recursive: true });
  writeFileSync(join(generated, "connectors.d.ts"), source);
  return source;
}

const PERSON = "generated-client-human";
const ASSISTANT = "generated-client-agent";

test("OAC-01: openapi-typescript generates a client that type-checks and drives the real handler", async (t) => {
  const source = await generate();
  // Both projections are named, so a consumer can refer to either.
  assert.match(source, /HumanConnectionView: \{/);
  assert.match(source, /AgentConnectionView: \{/);
  assert.match(
    source,
    /"\/api\/v1\/connectors\/connections\/\{connectionRef\}\/invoke"/,
  );

  // The consumer and the calls it must not be able to make, through tsc.
  execFileSync(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "-p", consumer],
    {
      cwd: consumer,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    },
  );

  const harness = await createHarness();
  t.after(() => harness.close());
  harness.register(PERSON, human());
  const assistant = harness.register(ASSISTANT, agent());
  await delegate(harness.store, assistant);

  // The specifier is built at run time on purpose: a literal would pull the
  // consumer, and the types it imports from a directory that exists only
  // after generation, into the repository's own `tsc --noEmit`.
  const { connectorClient, ConnectorApiError, isHumanView } = (await import(
    pathToFileURL(join(consumer, "client.ts")).href
  )) as ConsumerModule;
  const fetch = handlerFetch(harness);
  const client = connectorClient({
    baseUrl: ORIGIN,
    origin: ORIGIN,
    cookie: `fixture-session=${PERSON}`,
    fetch,
  });

  assert.ok(Array.isArray(await client.catalog()));

  const [definitionRef] = await client.importDocument(
    FIXTURE_DOCUMENT(harness.provider.origin),
  );
  assert.ok(definitionRef);
  assert.match(definitionRef, /:/, "a reference the client has to encode");
  const review = await client.definition(definitionRef);
  assert.equal(review.definition.definitionRef, definitionRef);

  const binding = await client.approve(definitionRef, "fixture-http", {
    destinations: [harness.provider.origin],
    operations: ["listItems"],
    profileId: "oauth",
    permittedTargets: [],
  });
  assert.equal(binding.status, "approved");
  assert.ok(
    (await client.bindings()).some(
      (item) => item.bindingRef === binding.bindingRef,
    ),
  );

  const pending = await client.connect(binding.bindingRef, "oauth");
  assert.equal(pending.lifecycle, "authorization-required");
  assert.ok(isHumanView(pending), "a person gets the full projection");
  const url = pending.presentation?.url;
  assert.ok(url, "and the URL to authorize at");
  assert.deepEqual(
    (await client.connections("authorization-required")).map(
      (item) => item.connectionRef,
    ),
    [pending.connectionRef],
  );

  const callback = await completeOauthCallback(harness, PERSON, url);
  assert.equal(callback.status, 303);
  const connected = await client.connection(pending.connectionRef);
  assert.ok(connected.found);
  assert.equal(connected.connection.lifecycle, "active");

  const operationRef = harness.definitions
    .bindings()
    .find((item) => item.bindingRef === binding.bindingRef)
    ?.operations.find((item) => item.nativeId === "listItems")?.operationRef;
  assert.ok(operationRef);
  const result = await client.invoke(
    pending.connectionRef,
    operationRef,
    { project: "alpha" },
    "generated-client-read-1",
  );
  assert.equal(result.state, "complete");
  assert.equal(result.effect, "read");

  // The documented 404, narrowed by the generated error type.
  assert.deepEqual(await client.connection("connection:missing"), {
    found: false,
    code: "not-found",
  });

  // An assistant's client gets the narrower projection of the same record.
  const delegated = connectorClient({
    baseUrl: ORIGIN,
    origin: ORIGIN,
    cookie: `fixture-session=${ASSISTANT}`,
    fetch,
  });
  const seen = await delegated.connection(pending.connectionRef);
  assert.ok(seen.found);
  assert.equal(isHumanView(seen.connection), false);
  assert.equal("presentation" in seen.connection, false);

  // The Origin header the description requires is really sent: a client
  // configured with another origin is refused as a cross-site request.
  const crossSite = connectorClient({
    baseUrl: ORIGIN,
    origin: "https://elsewhere.example",
    cookie: `fixture-session=${PERSON}`,
    fetch,
  });
  await assert.rejects(
    crossSite.importDocument(FIXTURE_DOCUMENT(harness.provider.origin)),
    (error: unknown) =>
      error instanceof ConnectorApiError &&
      error.status === 403 &&
      error.code === "denied",
  );
});
