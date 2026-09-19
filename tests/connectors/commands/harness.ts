import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import {
  canonicalDigest,
  completeDimensions,
  normalizedDigestOf,
  type NormalizedDefinition,
  type SourceRecord,
} from "../../../src/core/connectors/index.js";
import {
  ConnectorAdapterRegistry,
  type DefinitionStorePort,
  type RuntimeBinding,
  type SourceArtifactPort,
} from "../../../src/server/connectors/index.js";
import {
  ConnectorCommandService,
  connectorRequestNeedsActor,
  createConnectorHttp,
  defaultConnectorPolicy,
  type ConnectorCommandServiceOptions,
  type ConnectorEventReceiver,
  type ConnectorHttpHandler,
  type ConnectorImporter,
  type ConnectorPolicy,
} from "../../../src/server/connectors/commands/index.js";
import { SQLiteCeremonyStore } from "../../../src/server/persistence/index.js";
import { memoryPorts } from "../doubles/ports.js";
import {
  createFixtureAdapter,
  startFixtureProvider,
  type FixtureProvider,
  type FixtureProviderOptions,
} from "../doubles/fixture-adapter.js";

/*
 * One harness for every command test: a real SQLite store for the request
 * budget and delegation records, the shared in-memory ports, in-memory
 * definition and artifact ports, the real fixture adapter over a real
 * loopback provider, and the real HTTP handler with a fake host identity
 * that maps a cookie to an actor exactly as a deployment's identity adapter
 * would. Nothing in the product is replaced by a stub.
 */

/**
 * An unambiguous composite key: each part is length-prefixed rather than
 * joined on a separator, so no part can forge a boundary. A control character
 * would work too, but a literal control byte makes the file binary and
 * prettier rewrites a unicode escape back into that byte.
 */
function joinKey(...parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join("|");
}

export const ORIGIN = "https://connectors.example";
export const TENANT = "tenant-a";

export function memoryDefinitionStore(): DefinitionStorePort & {
  bindings(): RuntimeBinding[];
} {
  const sources = new Map<string, SourceRecord>();
  const definitions = new Map<string, NormalizedDefinition>();
  const bindings = new Map<string, RuntimeBinding>();
  const key = (tenantId: string, ref: string) => joinKey(tenantId, ref);
  return {
    async putSource(tenantId, source) {
      sources.set(key(tenantId, source.sourceRef), structuredClone(source));
    },
    async getSource(tenantId, sourceRef) {
      const found = sources.get(key(tenantId, sourceRef));
      return found ? structuredClone(found) : undefined;
    },
    async putDefinition(tenantId, definition) {
      definitions.set(
        key(tenantId, definition.definitionRef),
        structuredClone(definition),
      );
    },
    async getDefinition(tenantId, definitionRef) {
      const found = definitions.get(key(tenantId, definitionRef));
      return found ? structuredClone(found) : undefined;
    },
    async listDefinitions(tenantId, filter) {
      return [...definitions.entries()]
        .filter(([id]) => id.startsWith(`${tenantId.length}:${tenantId}|`))
        .map(([, value]) => structuredClone(value))
        .filter(
          (definition) =>
            !filter?.ecosystem ||
            definition.identity.ecosystem === filter.ecosystem,
        );
    },
    async putBinding(binding) {
      bindings.set(
        joinKey(binding.tenantId, binding.bindingRef, String(binding.revision)),
        structuredClone(binding),
      );
    },
    async getBinding(tenantId, bindingRef, revision) {
      const matching = [...bindings.values()]
        .filter(
          (binding) =>
            binding.tenantId === tenantId && binding.bindingRef === bindingRef,
        )
        .sort((a, b) => a.revision - b.revision);
      const found =
        revision === undefined
          ? matching.at(-1)
          : matching.find((binding) => binding.revision === revision);
      return found ? structuredClone(found) : undefined;
    },
    async listBindings(tenantId, filter) {
      return [...bindings.values()]
        .filter(
          (binding) =>
            binding.tenantId === tenantId &&
            (!filter?.definitionRef ||
              binding.definitionRef === filter.definitionRef) &&
            (!filter?.adapterId || binding.adapterId === filter.adapterId),
        )
        .map((binding) => structuredClone(binding));
    },
    bindings: () => [...bindings.values()],
  };
}

export function memoryArtifactStore(): SourceArtifactPort {
  const artifacts = new Map<
    string,
    { bytes: Uint8Array; mediaType: string; digest: string }
  >();
  return {
    async put(tenantId, bytes, meta) {
      const ref = `artifact:${randomUUID()}`;
      artifacts.set(joinKey(tenantId, ref), {
        bytes: new Uint8Array(bytes),
        mediaType: meta.mediaType,
        digest: meta.digest,
      });
      return ref;
    },
    async get(tenantId, artifactRef) {
      const found = artifacts.get(joinKey(tenantId, artifactRef));
      return found
        ? { ...found, bytes: new Uint8Array(found.bytes) }
        : undefined;
    },
    async delete(tenantId, artifactRef) {
      artifacts.delete(joinKey(tenantId, artifactRef));
    },
  };
}

/**
 * A minimal but real importer for the test document format: it parses bytes,
 * rejects anything it does not understand, and emits a normalized definition.
 * It stands in for a format swarm's importer so the command layer's import
 * path is exercised end to end without depending on another swarm.
 */
const documentSchema = z.strictObject({
  format: z.literal("fixture-connector"),
  name: z.string().max(200),
  description: z.string().max(500).default(""),
  service: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  servers: z.array(z.url()).max(8),
  operations: z
    .array(
      z.strictObject({
        nativeId: z.string().min(1).max(512),
        method: z.enum(["GET", "POST"]),
        path: z.string().regex(/^\/[^\s?#]*$/),
        effect: z.enum(["read", "write"]),
        dataClassification: z
          .enum(["public", "personal", "secret", "unknown"])
          .default("public"),
        targetParameters: z.array(z.string()).max(4).default([]),
      }),
    )
    .max(64),
});

export const fixtureImporter: ConnectorImporter = async (input) => {
  let document: z.infer<typeof documentSchema>;
  try {
    document = documentSchema.parse(
      JSON.parse(Buffer.from(input.bytes).toString("utf8")),
    );
  } catch {
    return undefined;
  }
  const identity = {
    ecosystem: "openapi",
    authorityNamespace: "",
    nativeId: `fixture/${document.service}`,
    nativeVersion: "2026-09-18",
  } as const;
  const body = {
    schemaVersion: 1 as const,
    definitionRef: "definition:pending",
    sourceRef: "source:pending",
    identity,
    importer: { id: "fixture-importer", version: "1.0.0" },
    display: {
      name: document.name,
      description: document.description,
      ecosystem: "openapi",
      service: document.service,
    },
    authentication: [
      {
        id: "oauth",
        label: "OAuth authorization code",
        kind: "oauth-authorization-code" as const,
        pkce: "S256" as const,
        scopes: ["read", "write"],
        scopeSemantics: "provider-scopes" as const,
        clientRegistration: "pre-registered" as const,
        clientAuthentication: "none" as const,
        refresh: "unknown" as const,
      },
      {
        id: "api-key",
        label: "API key",
        kind: "api-key" as const,
        placement: "header" as const,
        parameterName: "X-Api-Key",
      },
    ],
    configuration: [],
    capabilities: document.operations.map((operation) => ({
      kind: "http-operation" as const,
      nativeId: operation.nativeId,
      label: operation.nativeId,
      effect: operation.effect,
      dataClassification: operation.dataClassification,
      cost: "unknown" as const,
      authentication: ["oauth", "api-key"],
      nativeExtensions: {
        "x-ceremony-transport": {
          kind: "http",
          method: operation.method,
          pathTemplate: operation.path,
        },
        "x-ceremony-server": 1,
        "x-ceremony-targets": operation.targetParameters,
      },
    })),
    events: [],
    declaredServers: document.servers.map((url) => ({
      url,
      status: "declared" as const,
    })),
    compatibility: {
      issues: [],
      dimensions: completeDimensions({
        import: "exact",
        authorize: "requires-configuration",
        verify: "requires-configuration",
        invoke: "requires-configuration",
        export: "exact",
      }),
    },
    nativeExtensions: {},
  };
  const definition = {
    ...body,
    normalizedDigest: await normalizedDigestOf(body),
  } as NormalizedDefinition;
  return {
    source: {
      sourceRef: "source:pending",
      identity,
      format: { name: "fixture-connector", version: "1" },
      origin: input.origin,
      digest: {
        algorithm: "sha256" as const,
        value: await canonicalDigest("pending"),
      },
      byteLength: input.bytes.byteLength,
      mediaType: input.mediaType,
      capturedAt: new Date().toISOString(),
      adaptation: [],
      overlays: [],
    },
    definitions: [definition],
    issues: [],
    executableCandidates: document.operations.map(
      (operation) => operation.nativeId,
    ),
  };
};

export const FIXTURE_DOCUMENT = (origin: string) =>
  JSON.stringify({
    format: "fixture-connector",
    name: "Fixture service",
    description: "A loopback service used to exercise connector commands.",
    service: "fixture",
    servers: [origin],
    operations: [
      {
        nativeId: "listItems",
        method: "GET",
        path: "/v1/items",
        effect: "read",
        dataClassification: "public",
      },
      {
        nativeId: "createItem",
        method: "POST",
        path: "/v1/items",
        effect: "write",
        dataClassification: "personal",
      },
    ],
  });

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export async function createHarness(
  options: {
    provider?: FixtureProviderOptions;
    policy?: (base: ConnectorPolicy) => ConnectorPolicy;
    now?: () => number;
    service?: Partial<ConnectorCommandServiceOptions>;
    /** Supplied when a test exercises the event mount; absent means it answers 404. */
    receiveEvent?: ConnectorEventReceiver;
  } = {},
) {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  const provider = await startFixtureProvider(options.provider ?? {});
  const ports = memoryPorts(options.now ? { now: options.now } : {});
  const definitions = memoryDefinitionStore();
  const artifacts = memoryArtifactStore();
  const registry = new ConnectorAdapterRegistry();
  registry.register(createFixtureAdapter());
  const configurationValues = new Map<string, Map<string, string>>();
  let configurationRevision = 1;
  const base = defaultConnectorPolicy({
    store,
    loopbackFixtures: true,
    ...(options.now ? { now: options.now } : {}),
  });
  const policy = options.policy ? options.policy(base) : base;
  const service = new ConnectorCommandService({
    registry,
    ports: {
      connections: ports.connections,
      evidence: ports.evidence,
      effects: ports.effects,
      handoffs: ports.handoffs,
      credentials: ports.credentials,
      definitions,
      artifacts,
    },
    configuration: (actor) => {
      const key = joinKey(actor.tenantId, actor.subjectId);
      const values = configurationValues.get(key) ?? new Map<string, string>();
      configurationValues.set(key, values);
      return {
        read: async (name) => values.get(name),
        present: async (names) =>
          new Set(names.filter((name) => values.has(name))),
        revision: async () => `cfg:${configurationRevision}`,
      };
    },
    policy,
    // The approved fetcher: a deployment supplies createPublicAuthFetch; the
    // fixture's loopback destinations are admitted by the binding's network
    // class, which is what this harness is testing.
    fetch: (input, init) => fetch(input as RequestInfo, init),
    origin: ORIGIN,
    importers: [fixtureImporter],
    ...(options.now ? { now: options.now } : {}),
    ...options.service,
  });
  const http: ConnectorHttpHandler = createConnectorHttp(service, {
    origin: ORIGIN,
    store,
    returnPath: "/connectors",
    ...(options.receiveEvent ? { receiveEvent: options.receiveEvent } : {}),
  });

  const actors = new Map<string, ActorContext>();
  const identify = (request: Request): ActorContext | undefined => {
    const session = /(?:^|;\s*)fixture-session=([^;]+)/.exec(
      request.headers.get("cookie") ?? "",
    )?.[1];
    return session ? actors.get(decodeURIComponent(session)) : undefined;
  };

  return {
    store,
    provider,
    ports,
    definitions,
    artifacts,
    registry,
    policy,
    service,
    http,
    actors,
    /**
     * The fake host identity, as a deployment's adapter: a cookie maps to an
     * actor, and an unknown cookie is nobody. Exposed so a test that mounts the
     * real host router authenticates the same way this harness does.
     */
    identity: {
      authenticate: async (request: Request) => identify(request) ?? null,
    },
    setConfiguration(actor: ActorContext, name: string, value?: string) {
      const key = joinKey(actor.tenantId, actor.subjectId);
      const values = configurationValues.get(key) ?? new Map<string, string>();
      if (value === undefined) values.delete(name);
      else values.set(name, value);
      configurationValues.set(key, values);
      configurationRevision++;
    },
    /** Registers an actor under a session cookie the fake host identity reads. */
    register(session: string, actor: ActorContext) {
      actors.set(session, actor);
      return actor;
    },
    /** Sends a request through the real handler with host-authenticated identity. */
    async fetch(
      path: string,
      init: {
        method?: string;
        session?: string;
        body?: unknown;
        headers?: Record<string, string>;
        origin?: string | null;
      } = {},
    ): Promise<Response> {
      const method = init.method ?? (init.body === undefined ? "GET" : "POST");
      const headers = new Headers(init.headers ?? {});
      if (init.session)
        headers.set(
          "cookie",
          `fixture-session=${encodeURIComponent(init.session)}`,
        );
      if (method !== "GET" && method !== "HEAD") {
        if (!headers.has("content-type"))
          headers.set("content-type", "application/json");
        if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
      }
      const request = new Request(`${ORIGIN}${path}`, {
        method,
        headers,
        ...(method === "GET" || method === "HEAD" || init.body === undefined
          ? {}
          : { body: JSON.stringify(init.body) }),
      });
      // Exactly what a correct host does: resolve a session only for the paths
      // that need one. A provider delivery carries none, so demanding one here
      // would answer 401 before the receiver could verify a signature -- the
      // mistake this harness previously modelled.
      const needsActor = connectorRequestNeedsActor(
        new URL(request.url).pathname,
      );
      const actor = identify(request);
      if (needsActor && !actor)
        return Response.json({ error: "unauthenticated" }, { status: 401 });
      const response = await http(request, needsActor ? actor : undefined);
      return response ?? Response.json({ error: "not-found" }, { status: 404 });
    },
    async close() {
      await provider.close();
      await store.close();
    },
  };
}

export function human(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    tenantId: TENANT,
    subjectId: "subject-1",
    sessionId: "session-1",
    actorKind: "human",
    capabilities: ["executor", "author", "reviewer", "publisher"],
    ...overrides,
  };
}

export function agent(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    tenantId: TENANT,
    subjectId: "subject-1",
    sessionId: "session-1",
    actorKind: "agent",
    capabilities: ["executor"],
    delegationId: "run:delegated",
    ...overrides,
  };
}

/** Writes the delegation and budget records the teaching runtime uses, so an agent actor is live. */
export async function delegate(
  store: SQLiteCeremonyStore,
  actor: ActorContext,
  options: { stopped?: boolean } = {},
): Promise<void> {
  const runId = actor.delegationId!;
  await store.transaction(async (tx) => {
    const delegationKey = {
      tenant: "workload",
      kind: "session" as const,
      id: runId,
    };
    const existing = await tx.get(delegationKey);
    await tx.put(
      delegationKey,
      {
        actor: { ...actor, actorKind: "human" },
        runId,
        expiresAt: (await tx.now()) + 3_600_000,
        revoked: false,
      },
      existing?.revision ?? null,
    );
    const budgetKey = {
      tenant: actor.tenantId,
      kind: "budget" as const,
      id: `agent:${runId}`,
    };
    const budget = await tx.get(budgetKey);
    await tx.put(
      budgetKey,
      { stopped: options.stopped ?? false },
      budget?.revision ?? null,
    );
  });
}

/** The lifecycle a harness test most often asserts, with the provider's real flow completed. */
export async function completeOauthCallback(
  harness: Harness,
  session: string,
  presentationUrl: string,
): Promise<Response> {
  const response = await fetch(presentationUrl, { redirect: "manual" });
  const location = response.headers.get("location");
  await response.body?.cancel().catch(() => {});
  if (!location) throw new Error("provider did not redirect");
  const callback = new URL(location);
  return harness.fetch(`${callback.pathname}${callback.search}`, { session });
}

export type { FixtureProvider };
