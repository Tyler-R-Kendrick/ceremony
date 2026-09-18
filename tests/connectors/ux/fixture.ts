import {
  catalogEntrySchema,
  connectionSummarySchema,
  normalizedDefinitionSchema,
  completeDimensions,
  type CatalogEntry,
  type CapabilityStatus,
  type ConnectionSummary,
  type NormalizedDefinition,
  type SupportDimension,
} from "../../../src/core/connectors/index.js";

/*
 * A loopback double of the connector command surface.
 *
 * It answers the documented route table and nothing else, so the browser code
 * under test exercises its real parsing, its real polling and its real
 * correlation checks without depending on the server implementation being
 * built alongside it. It is deliberately strict: every response is parsed with
 * the same core schema the server projects through, so a shape this double
 * invents that the contract does not allow fails here first.
 *
 * It also records every request. A test can then assert what the UI actually
 * sent — which profile, which owner kind, which interruption budget — rather
 * than that a control moved.
 */

export const NOW = Date.parse("2026-09-18T12:00:00.000Z");
const iso = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();

type Recorded = { method: string; path: string; body?: unknown };

function status(
  dimension: SupportDimension,
  overrides: Partial<CapabilityStatus> = {},
): CapabilityStatus {
  const implementation = overrides.implementation ?? "implemented";
  return {
    dimension,
    profile: "fixture-1",
    adapterVersion: "1.0.0",
    runtime: "hosted-server",
    implementation,
    configuration: "not-applicable",
    evidence: implementation === "unsupported" ? "not-tested" : "protocol-fixture",
    limitations: [],
    ...overrides,
  };
}

const connectable: SupportDimension[] = [
  "authorize",
  "verify",
  "invoke",
  "reconnect",
  "disconnect",
];

function entry(overrides: Partial<CatalogEntry>): CatalogEntry {
  return catalogEntrySchema.parse({
    id: "fixture",
    ecosystem: "openapi",
    service: "fixture",
    displayName: "Fixture",
    description: "A fixture connector.",
    support: "fixture",
    custody: ["host-owned"],
    runtimes: ["hosted-server"],
    authentication: ["api-key"],
    configuration: [],
    capabilities: connectable.map((dimension) => status(dimension)),
    evidence: "protocol-fixture",
    group: "fixture",
    ...overrides,
  });
}

/**
 * The inventory. Two routes to GitHub with different custody and different
 * evidence sit in one group and stay two rows; an unconfigured provider and a
 * described-only row are present so the badges have something real to say.
 */
export function fixtureCatalog(): CatalogEntry[] {
  const filler = Array.from({ length: 26 }, (_, index) => {
    const id = `sample-${String(index + 1).padStart(2, "0")}`;
    return entry({
      id,
      ecosystem: index % 2 ? "mcp" : "openapi",
      service: id,
      group: id,
      displayName: `Sample ${index + 1}`,
      description: `Generated inventory row ${index + 1} for paging.`,
      support: "catalog-only",
      custody: ["no-credential"],
      authentication: ["none"],
      capabilities: [status("import", { implementation: "unsupported" })],
      evidence: "not-tested",
    });
  });
  return [
    entry({
      id: "github-app",
      ecosystem: "ceremony",
      service: "github",
      group: "github",
      displayName: "GitHub (native app)",
      description:
        "Registers and installs a GitHub App, then verifies repository access.",
      support: "provider-backed",
      custody: ["host-owned"],
      runtimes: ["hosted-server"],
      authentication: ["ceremony-method", "oauth-authorization-code"],
      configuration: [
        {
          name: "GITHUB_APP_ID",
          required: true,
          classification: "public",
          present: true,
        },
      ],
      capabilities: [
        ...connectable.map((dimension) =>
          status(dimension, {
            profile: "github-app-2026",
            evidence: "browser-integration",
            configuration: "ready",
          }),
        ),
        status("revoke", { implementation: "unsupported" }),
      ],
      evidence: "browser-integration",
      definitionRef: "definition:github-app",
    }),
    entry({
      id: "github-via-broker",
      ecosystem: "nango",
      service: "github",
      group: "github",
      displayName: "GitHub (via broker)",
      description:
        "The same service reached through an external credential broker.",
      support: "fixture",
      custody: ["external-credential-broker"],
      authentication: ["external-broker"],
      capabilities: connectable
        .filter((dimension) => dimension !== "invoke")
        .map((dimension) => status(dimension, { profile: "nango-connect" })),
      evidence: "protocol-fixture",
      definitionRef: "definition:github-broker",
    }),
    entry({
      id: "petstore-api-key",
      ecosystem: "openapi",
      service: "petstore",
      group: "petstore",
      displayName: "Petstore",
      description:
        "An imported OpenAPI description with a key collected privately.",
      support: "fixture",
      custody: ["host-owned"],
      authentication: ["api-key"],
      configuration: [
        {
          name: "PETSTORE_REGION",
          required: false,
          classification: "public",
          present: false,
        },
      ],
      capabilities: connectable.map((dimension) =>
        status(dimension, { profile: "openapi-3.1" }),
      ),
      evidence: "protocol-fixture",
      definitionRef: "definition:petstore",
    }),
    entry({
      id: "vercel-connect",
      ecosystem: "vercel-connect",
      service: "vercel",
      group: "vercel",
      displayName: "Vercel Connect",
      description: "Authorized connector administration and token acquisition.",
      support: "unconfigured",
      custody: ["host-owned"],
      authentication: ["oauth-authorization-code"],
      configuration: [
        {
          name: "VERCEL_TEAM_ID",
          required: true,
          classification: "public",
          present: false,
        },
      ],
      capabilities: connectable.map((dimension) =>
        status(dimension, {
          profile: "vercel-connect-rest",
          configuration: "missing",
        }),
      ),
      evidence: "protocol-fixture",
    }),
    entry({
      id: "smithery-registry",
      ecosystem: "smithery",
      service: "smithery",
      group: "smithery",
      displayName: "Smithery catalogue",
      description: "Described here, implemented nowhere in this deployment.",
      support: "catalog-only",
      custody: ["no-credential"],
      runtimes: ["hosted-server"],
      authentication: ["none"],
      capabilities: [status("discover", { implementation: "unsupported" })],
      evidence: "not-tested",
    }),
    ...filler,
  ];
}

function definition(
  overrides: Partial<NormalizedDefinition>,
): NormalizedDefinition {
  return normalizedDefinitionSchema.parse({
    schemaVersion: 1,
    definitionRef: "definition:fixture",
    identity: {
      ecosystem: "openapi",
      authorityNamespace: "",
      nativeId: "example/fixture",
      nativeVersion: "2026-09-01",
    },
    sourceRef: "source:fixture",
    normalizedDigest: "a".repeat(64),
    importer: { id: "fixture-importer", version: "1.0.0" },
    display: {
      name: "Fixture",
      description: "A fixture description.",
      ecosystem: "openapi",
      service: "fixture",
    },
    authentication: [
      {
        id: "api-key",
        label: "API key",
        kind: "api-key",
        placement: "header",
        parameterName: "X-Api-Key",
      },
    ],
    configuration: [],
    capabilities: [],
    events: [],
    declaredServers: [
      { url: "https://api.example.test/v1", status: "declared" },
    ],
    compatibility: {
      issues: [],
      dimensions: completeDimensions({ import: "exact", export: "exact" }),
    },
    nativeExtensions: {},
    ...overrides,
  });
}

export function fixtureDefinitions(): NormalizedDefinition[] {
  return [
    definition({
      definitionRef: "definition:github-app",
      sourceRef: "source:github-app",
      identity: {
        ecosystem: "ceremony",
        authorityNamespace: "",
        nativeId: "github/app",
        nativeVersion: "1",
      },
      display: {
        name: "GitHub (native app)",
        description: "Registration, installation and verification as one flow.",
        ecosystem: "ceremony",
        service: "github",
      },
      authentication: [
        {
          id: "github-app",
          label: "GitHub App registration",
          kind: "ceremony-method",
          flowKind: "github-app",
          methodId: "github-app",
        },
        {
          id: "oauth",
          label: "OAuth authorization code",
          kind: "oauth-authorization-code",
          pkce: "S256",
          issuer: "https://github.test",
          authorizationEndpoint: "https://github.test/login/oauth/authorize",
          tokenEndpoint: "https://github.test/login/oauth/access_token",
          scopes: ["read:user", "repo"],
          scopeSemantics: "provider-scopes",
          clientRegistration: "pre-registered",
          clientAuthentication: "client_secret_basic",
          refresh: "supported",
        },
      ],
      configuration: [
        {
          name: "GITHUB_APP_ID",
          source: "host",
          classification: "public",
          required: true,
        },
      ],
      compatibility: {
        issues: [],
        dimensions: completeDimensions({
          import: "exact",
          configure: "exact",
          authorize: "exact",
          verify: "exact",
          invoke: "exact",
          reconnect: "exact",
          disconnect: "exact",
          export: "exact",
        }),
      },
    }),
    definition({
      definitionRef: "definition:petstore",
      sourceRef: "source:petstore",
      display: {
        name: "Petstore",
        description: "An imported OpenAPI 3.1 description.",
        ecosystem: "openapi",
        service: "petstore",
      },
      capabilities: [
        {
          kind: "http-operation",
          nativeId: "listProjects",
          label: "List projects",
          effect: "read",
          dataClassification: "public",
          cost: "unknown",
          authentication: ["api-key"],
        },
      ],
      compatibility: {
        issues: [],
        dimensions: completeDimensions({
          import: "exact",
          configure: "exact",
          authorize: "exact",
          verify: "exact",
          invoke: "exact",
          reconnect: "exact",
          disconnect: "exact",
        }),
      },
    }),
    definition({
      definitionRef: "definition:github-broker",
      sourceRef: "source:github-broker",
      identity: {
        ecosystem: "nango",
        authorityNamespace: "fixture-environment",
        nativeId: "github",
        nativeVersion: "2026-09-01",
      },
      display: {
        name: "GitHub (via broker)",
        description: "Reached through an external credential broker.",
        ecosystem: "nango",
        service: "github",
      },
      authentication: [
        {
          id: "broker",
          label: "External broker",
          kind: "external-broker",
          broker: "nango",
          custody: "external-credential-broker",
        },
      ],
    }),
  ];
}

/** A description whose security requirement this runtime cannot execute. */
export function blockedDefinition(): NormalizedDefinition {
  return definition({
    definitionRef: "definition:legacy-signed",
    sourceRef: "source:legacy-signed",
    identity: {
      ecosystem: "openapi",
      authorityNamespace: "",
      nativeId: "example/legacy-signed",
      nativeVersion: "2019-03-11",
    },
    display: {
      name: "Legacy signed API",
      description: "Signs every request with a scheme this runtime cannot run.",
      ecosystem: "openapi",
      service: "legacy",
    },
    authentication: [
      {
        id: "legacy",
        label: "Vendor request signing",
        kind: "unsupported",
        native: "x-vendor-hmac-v1",
      },
    ],
    compatibility: {
      issues: [
        {
          code: "openapi.security.unsupported-scheme",
          category: "security",
          sourcePointer: "/components/securitySchemes/vendorHmac",
          normalizedPointer: "/authentication/0",
          dimension: "authorize",
          disposition: "unsupported",
          severity: "blocking",
          executionImpact: "blocks-authorization",
          message:
            "The vendor request-signing scheme is not executable by this runtime.",
          remediation:
            "Bind an approved authentication profile, or keep this description for reference only.",
        },
        {
          code: "openapi.serialization.deep-object",
          category: "serialization",
          sourcePointer: "/paths/~1search/get/parameters/0",
          dimension: "invoke",
          disposition: "unsupported",
          severity: "warning",
          executionImpact: "blocks-operation",
          message: "One parameter serialization is unsupported; that operation is blocked.",
        },
        {
          code: "openapi.structure.unused-schema",
          category: "structure",
          sourcePointer: "/components/schemas/Unused",
          dimension: "import",
          disposition: "adapted",
          severity: "info",
          executionImpact: "none",
          message: "An unused schema was preserved without changes.",
        },
      ],
      dimensions: completeDimensions({
        import: "exact",
        authorize: "unsupported",
        invoke: "unsupported",
        export: "adapted",
      }),
    },
  });
}

export type FixtureOptions = {
  /** Refuse everything with 401 from this call number onward. */
  expireSessionAfter?: number;
  /** The origin presentation URLs point at; loopback in browser tests. */
  origin?: string;
  /** Reconnect refuses unless the request says the account is changing. */
  requireAccountSwitch?: boolean;
};

type ConnectionState = {
  summary: ConnectionSummary;
  approved: boolean;
  polls: number;
  secretRefs: string[];
  region?: string;
};

export type ConnectorFixture = ReturnType<typeof createConnectorFixture>;

export function createConnectorFixture(options: FixtureOptions = {}) {
  const origin = options.origin ?? "https://app.test";
  const entries = fixtureCatalog();
  const definitions = fixtureDefinitions();
  const requests: Recorded[] = [];
  const connections = new Map<string, ConnectionState>();
  const bindings = [
    {
      bindingRef: "binding:github-app",
      definitionRef: "definition:github-app",
      revision: 1,
      adapterId: "github-app",
      adapterVersion: "1.0.0",
      runtime: "hosted-server" as const,
      custody: "host-owned" as const,
      authorityInstance: "github.test",
      status: "approved" as const,
      approvedAt: iso(-86_400_000),
      policyRevision: "policy:1",
    },
    {
      bindingRef: "binding:petstore",
      definitionRef: "definition:petstore",
      revision: 1,
      adapterId: "openapi-http",
      adapterVersion: "1.0.0",
      runtime: "hosted-server" as const,
      custody: "host-owned" as const,
      authorityInstance: "api.example.test",
      status: "approved" as const,
      approvedAt: iso(-86_400_000),
      policyRevision: "policy:1",
    },
  ];
  let viewer = { capabilities: ["executor"], ownerKinds: ["user"] as string[] };
  let calls = 0;
  let sequence = 0;

  const json = (body: unknown, code = 200) =>
    new Response(JSON.stringify(body), {
      status: code,
      headers: { "content-type": "application/json" },
    });
  const fail = (code: number, error: string, message: string) =>
    json({ error, message }, code);

  const base = (
    id: string,
    binding: (typeof bindings)[number],
    overrides: Partial<ConnectionSummary> = {},
  ): ConnectionSummary =>
    connectionSummarySchema.parse({
      connectionRef: id,
      bindingRef: binding.bindingRef,
      definitionRef: binding.definitionRef,
      ecosystem: binding.adapterId === "github-app" ? "ceremony" : "openapi",
      service: binding.adapterId === "github-app" ? "github" : "petstore",
      displayName:
        binding.adapterId === "github-app" ? "GitHub (native app)" : "Petstore",
      ownerKind: "user",
      custody: "host-owned",
      runtime: "hosted-server",
      lifecycle: "human-required",
      generation: 0,
      revision: 1,
      createdAt: iso(),
      updatedAt: iso(),
      ...overrides,
    });

  const handoffFor = (state: ConnectionState, kind: "provider-browser" | "private-collector") => ({
    handoffRef: `handoff:${state.summary.connectionRef}:${state.summary.generation}`,
    kind,
    state: "issued" as const,
    presentation: kind === "provider-browser" ? ("popup" as const) : ("in-app" as const),
    expiresAt: iso(600_000),
    generation: state.summary.generation,
  });

  const presentationFor = (state: ConnectionState) =>
    state.summary.bindingRef === "binding:github-app"
      ? {
          url: `${origin}/authorize?connection=${encodeURIComponent(state.summary.connectionRef)}`,
          instructions:
            "Approve the fixture app, then come back. Returning is not by itself approval.",
        }
      : {
          instructions: "Supply the key for this fixture service.",
          fields: [
            {
              name: "region",
              label: "Region",
              type: "select",
              required: true,
              classification: "public",
              options: [
                { value: "eu", label: "Europe" },
                { value: "us", label: "United States" },
              ],
            },
            {
              name: "project",
              label: "Project",
              type: "select",
              required: true,
              classification: "public",
              dynamic: {
                operationRef: "operation:listProjects",
                dependsOn: ["region"],
              },
            },
            {
              name: "apiKey",
              label: "Petstore API key",
              type: "password",
              required: true,
              classification: "secret",
              description: "Collected privately and replaced by a reference.",
            },
          ],
        };

  const view = (state: ConnectionState) => {
    const waiting =
      state.summary.lifecycle === "human-required" ||
      state.summary.lifecycle === "authorization-required";
    return {
      ...state.summary,
      ...(waiting
        ? {
            handoff: handoffFor(
              state,
              state.summary.bindingRef === "binding:github-app"
                ? "provider-browser"
                : "private-collector",
            ),
            presentation: presentationFor(state),
          }
        : {}),
    };
  };

  const activate = (state: ConnectionState, target = "octocat") => {
    state.summary = connectionSummarySchema.parse({
      ...state.summary,
      lifecycle: "active",
      revision: state.summary.revision + 1,
      updatedAt: iso(1000),
      target: { kind: "account", id: target },
      verification: {
        kinds: ["credential-accepted", "account-identity"],
        observedAt: iso(1000),
        validUntil: iso(3_600_000),
        limitations: [
          "Read access was demonstrated; write access was not attempted.",
        ],
      },
      lastOutcome: "verify.observed",
    });
  };

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url, origin);
    const path = url.pathname.replace(/^\/api\/v1\/connectors/, "");
    let body: unknown;
    if (request.method === "POST") {
      const text = await request.text();
      body = text ? JSON.parse(text) : {};
    }
    requests.push({ method: request.method, path, ...(body ? { body } : {}) });
    calls++;
    if (
      options.expireSessionAfter !== undefined &&
      calls > options.expireSessionAfter
    )
      return fail(401, "unauthenticated", "Sign in again to continue.");

    if (path === "/catalog") return json({ entries, viewer });
    if (path === "/definitions") return json({ definitions });
    if (path.startsWith("/definitions/")) {
      const ref = decodeURIComponent(path.slice("/definitions/".length));
      const found =
        definitions.find((item) => item.definitionRef === ref) ??
        (ref === "definition:legacy-signed" ? blockedDefinition() : undefined);
      if (!found)
        return fail(404, "not-found", "That description no longer exists.");
      return json({
        definition: found,
        source: {
          identity: found.identity,
          format: { name: "openapi", version: "3.1.0" },
          origin: { kind: "upload" },
          digest: { algorithm: "sha256", value: "b".repeat(64) },
          byteLength: 2048,
          mediaType: "application/json",
          capturedAt: iso(-3600_000),
          license: { spdx: "Apache-2.0", redistributable: true },
          adaptation: [],
          overlays: [],
        },
      });
    }
    if (path === "/import" && request.method === "POST") {
      const input = body as { kind?: string; text?: string; url?: string };
      if (input.kind === "upload" && (input.text ?? "").trim() === "{}")
        return fail(400, "invalid-document", "That document could not be read.");
      const blocked = blockedDefinition();
      return json({
        sourceRef: "source:legacy-signed",
        definitions: [blocked.definitionRef],
        issues: blocked.compatibility.issues,
        executableCandidates: [],
      });
    }
    if (path === "/bindings")
      return request.method === "POST"
        ? json({ binding: bindings[0] })
        : json({ bindings });
    if (path === "/connections" && request.method === "GET")
      return json({
        connections: [...connections.values()].map((state) => state.summary),
      });
    if (path === "/connections" && request.method === "POST") {
      const input = body as {
        bindingRef?: string;
        ownerKind?: string;
        intent?: { interruption?: string; target?: { id: string } };
      };
      const binding = bindings.find(
        (item) => item.bindingRef === input.bindingRef,
      );
      if (!binding)
        return fail(403, "forbidden", "That binding is not approved for you.");
      if (input.ownerKind === "organization" && !viewer.ownerKinds.includes("organization"))
        return fail(
          403,
          "owner-policy",
          "An organization connection requires administrator policy.",
        );
      const id = `connection:${++sequence}`;
      const state: ConnectionState = {
        summary: base(id, binding),
        approved: false,
        polls: 0,
        secretRefs: [],
      };
      // "Do not interrupt" is a constraint the server honours by stopping,
      // never by finding another way in.
      if (input.intent?.interruption === "none")
        state.summary = connectionSummarySchema.parse({
          ...state.summary,
          lastOutcome: "interruption.not.permitted",
        });
      connections.set(id, state);
      return json(view(state));
    }
    const match = /^\/connections\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (match?.[1]) {
      const id = decodeURIComponent(match[1]);
      const state = connections.get(id);
      if (!state)
        return fail(404, "not-found", "That connection no longer exists.");
      const action = match[2];
      if (!action) return json(view(state));
      if (action === "poll" || action === "verify") {
        state.polls++;
        if (state.approved && state.summary.lifecycle !== "active")
          activate(state);
        return json(view(state));
      }
      if (action === "reconnect") {
        const input = body as {
          expectedRevision?: number;
          accountSwitch?: boolean;
        };
        if (input.expectedRevision !== state.summary.revision)
          return fail(
            409,
            "conflict",
            "This connection changed elsewhere. Refresh its status and try again.",
          );
        if (options.requireAccountSwitch && !input.accountSwitch)
          return fail(
            409,
            "account-switch-required",
            "The provider signed in as a different account. Confirm the account change to continue.",
          );
        state.approved = false;
        state.summary = connectionSummarySchema.parse({
          ...state.summary,
          lifecycle: "human-required",
          generation: state.summary.generation + 1,
          revision: state.summary.revision + 1,
          updatedAt: iso(2000),
        });
        return json(view(state));
      }
      if (action === "disconnect") {
        const input = body as {
          expectedRevision?: number;
          scope?: "local" | "broker" | "upstream";
        };
        if (input.expectedRevision !== state.summary.revision)
          return fail(
            409,
            "conflict",
            "This connection changed elsewhere. Refresh its status and try again.",
          );
        const scope = input.scope ?? "local";
        state.summary = connectionSummarySchema.parse({
          ...state.summary,
          lifecycle:
            scope === "upstream" ? "upstream-revoked" : "locally-disconnected",
          revision: state.summary.revision + 1,
          updatedAt: iso(3000),
          lastOutcome: "disconnect.applied",
        });
        return json({
          result: {
            local: "applied",
            broker: scope === "local" ? "not-attempted" : "unsupported",
            upstream: scope === "upstream" ? "applied" : "not-attempted",
            sharedWith: scope === "local" ? ["connection:shared-team"] : [],
          },
          connection: view(state),
        });
      }
      if (action === "invoke") {
        const input = body as { operationRef?: string; input?: unknown };
        if (input.operationRef === "operation:listProjects") {
          const region =
            (input.input as { region?: string } | undefined)?.region ?? "";
          return json({
            state: "complete",
            output: {
              options:
                region === "us"
                  ? [{ value: "us-main", label: "US main" }]
                  : [
                      { value: "eu-main", label: "EU main" },
                      { value: "eu-backup", label: "EU backup" },
                    ],
            },
            outputClassification: "public",
            effect: "read",
          });
        }
        if (state.summary.lifecycle !== "active")
          return json({
            state: "denied",
            outputClassification: "public",
            effect: "read",
            code: "connection.not.active",
          });
        return json({
          state: "complete",
          output: { repositories: ["octocat/hello-world"] },
          outputClassification: "public",
          effect: "read",
        });
      }
      if (action === "collect") {
        const values = (body as { values?: Record<string, string> }).values ?? {};
        if (!Object.keys(values).length)
          return fail(400, "invalid-request", "No private values were sent.");
        const ref = `secret:${++sequence}`;
        state.secretRefs.push(ref);
        return json({ secretRef: ref });
      }
      const input = /^handoffs\/([^/]+)\/input$/.exec(action ?? "");
      if (input) {
        const values = (body as { values?: Record<string, string> }).values ?? {};
        if (!values.secretRef)
          return fail(
            400,
            "missing-secret-reference",
            "Private values are collected separately and sent by reference.",
          );
        state.approved = true;
        activate(state, `petstore-${values.project ?? "unknown"}`);
        return json(view(state));
      }
    }
    return fail(404, "not-found", "No such connector route.");
  }

  return {
    origin,
    entries,
    definitions,
    bindings,
    requests,
    handle,
    /** A `fetch` for the client; no network, no server. */
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
      handle(new Request(new URL(String(input), origin), init))) as typeof fetch,
    /** The provider finished; the next poll may observe it. */
    approve(connectionRef?: string) {
      const state = connectionRef
        ? connections.get(connectionRef)
        : [...connections.values()].at(-1);
      if (state) state.approved = true;
      return Boolean(state);
    },
    connection(connectionRef: string) {
      return connections.get(connectionRef)?.summary;
    },
    setViewer(next: { capabilities: string[]; ownerKinds: string[] }) {
      viewer = next;
    },
    bodies() {
      return requests.map((item) => JSON.stringify(item.body ?? null)).join("\n");
    },
  };
}