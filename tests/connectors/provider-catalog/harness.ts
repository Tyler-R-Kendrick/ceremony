import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import { ConnectorAdapterRegistry } from "../../../src/server/connectors/index.js";
import type { ConnectorPolicy } from "../../../src/server/connectors/commands/index.js";
import { createCatalogHttpAdapter } from "../../../src/server/connectors/formats/provider-catalog/index.js";
import {
  createHarness,
  human,
  ORIGIN,
  TENANT,
  type Harness,
} from "../commands/harness.js";
import {
  startAuthorizationServer,
  type AuthorizationServerDouble,
  type AuthorizationServerOptions,
} from "../doubles/authorization-server.js";
import { startHttpFixture } from "../doubles/http-fixture.js";

/*
 * End-to-end scaffolding for the catalog adapter: the real command service
 * over the command harness's store and ports, the shared OAuth fixture
 * authorization server, and a loopback API that records what it received.
 * The catalog document is written in Nango's providers format with loopback
 * URLs, imported through the service like any upload, and bound through the
 * service's own review. Nothing here writes a protocol message the adapter
 * then reads back as its own.
 */

export const CALLBACK = `${ORIGIN}/api/v1/connectors/callback`;
export const CLIENT_ID = "catalog-client";
export const CLIENT_SECRET = "catalog-secret-value";

export type Clock = { now(): number; advance(ms: number): void };

export function clock(start = Date.parse("2026-09-23T12:00:00.000Z")): Clock {
  let value = start;
  return {
    now: () => value,
    advance(ms) {
      value += ms;
    },
  };
}

/** A loopback provider API: bearer/basic/key checks, an echo and a failing route. */
export async function startProviderApi(
  t: TestContext,
  options: {
    accept?: (headers: Record<string, string>, url: URL) => boolean;
  } = {},
) {
  const accept =
    options.accept ??
    ((headers) => (headers["authorization"] ?? "").startsWith("Bearer "));
  const api = await startHttpFixture((request) => {
    const path = request.url.pathname;
    if (!accept(request.headers, request.url))
      return { status: 401, body: { error: "unauthorized" } };
    if (path.endsWith("/me")) return { status: 200, body: { id: "acct-1" } };
    if (path.endsWith("/items"))
      return {
        status: 200,
        body: { items: [{ id: "item-1" }], query: request.url.search },
      };
    if (path.endsWith("/echo"))
      // A careless provider that quotes the request back, credential and all.
      return {
        status: 200,
        body: {
          authorization: request.headers["authorization"] ?? null,
          apiKey: request.headers["x-api-key"] ?? null,
          query: request.url.search,
        },
      };
    if (path.endsWith("/fail"))
      return {
        status: 500,
        body: { error: `bad ${request.headers["authorization"] ?? ""}` },
      };
    if (path.endsWith("/text"))
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: "plain body",
      };
    return { status: 404, body: { error: "not_found" } };
  });
  t.after(() => api.close());
  return api;
}

export async function startOAuthServer(
  t: TestContext,
  options: AuthorizationServerOptions = {},
): Promise<AuthorizationServerDouble> {
  const server = await startAuthorizationServer({
    redirectUris: [CALLBACK],
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    scopes: ["items.read", "items.write"],
    ...options,
  });
  t.after(() => server.close());
  return server;
}

export async function catalogHarness(
  t: TestContext,
  options: {
    clock?: Clock;
    extra?: ConnectorAdapterRegistry;
    policy?: (base: ConnectorPolicy) => ConnectorPolicy;
  } = {},
): Promise<Harness & { actor: ActorContext; clock: Clock }> {
  const time = options.clock ?? clock();
  const registry = options.extra ?? new ConnectorAdapterRegistry();
  if (!registry.get("catalog-http"))
    registry.register(createCatalogHttpAdapter({ allowLoopbackHttp: true }));
  const harness = await createHarness({
    now: time.now,
    service: { registry },
    ...(options.policy ? { policy: options.policy } : {}),
  });
  t.after(() => harness.close());
  return Object.assign(harness, { actor: human(), clock: time });
}

/** Imports a providers document through the service and returns the definitions it made. */
export async function importDocument(
  harness: Harness & { actor: ActorContext },
  document: unknown,
  adapterId = "catalog-http",
) {
  const result = await harness.service.import(harness.actor, {
    kind: "upload",
    mediaType: "application/json",
    text: JSON.stringify(document),
    adapterId,
  });
  const definitions = await Promise.all(
    result.definitions.map(async (ref) => {
      const definition = await harness.definitions.getDefinition(TENANT, ref);
      assert.ok(definition);
      return definition;
    }),
  );
  return { result, definitions };
}

/** Approves a binding through the service's review; the entry comes from the definition, never the reviewer. */
export async function approve(
  harness: Harness & { actor: ActorContext },
  input: {
    definitionRef: string;
    destination: string;
    operations?: unknown[];
    profileId?: string;
    adapterId?: string;
    settings?: Record<string, unknown>;
    configuration?: string[];
    actor?: ActorContext;
  },
) {
  const definition = await harness.definitions.getDefinition(
    TENANT,
    input.definitionRef,
  );
  assert.ok(definition);
  const reference = await harness.service.approveBinding(
    input.actor ?? harness.actor,
    {
      definitionRef: input.definitionRef,
      adapterId: input.adapterId ?? "catalog-http",
      approvals: {
        destinations: [input.destination],
        operations: input.operations ?? [
          { nativeId: "proxy.get", outputClassification: "public" },
        ],
        ...(input.profileId ? { profileId: input.profileId } : {}),
        settings: input.settings ?? {},
        ...(input.configuration ? { configuration: input.configuration } : {}),
      },
    },
  );
  const binding = harness.definitions
    .bindings()
    .filter((item) => item.bindingRef === reference.bindingRef)
    .sort((a, b) => a.revision - b.revision)
    .at(-1)!;
  const operation = (nativeId: string) => {
    const found = binding.operations.find((item) => item.nativeId === nativeId);
    assert.ok(found, `approved ${nativeId}`);
    return found.operationRef;
  };
  return { reference, binding, operation };
}

/** Drives the provider's own consent redirect and lands it on the service's callback. */
export async function completeRedirect(
  harness: Harness & { actor: ActorContext },
  presentationUrl: string,
) {
  const response = await fetch(presentationUrl, { redirect: "manual" });
  const location = response.headers.get("location");
  await response.body?.cancel().catch(() => {});
  assert.ok(location, "the provider redirected back");
  return harness.service.callback(harness.actor, new URL(location));
}

export function commandId(): string {
  return `cmd-${randomBytes(6).toString("hex")}`;
}
