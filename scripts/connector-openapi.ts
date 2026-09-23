import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format } from "prettier";
import { z } from "zod";
import {
  bindingReferenceSchema,
  catalogEntrySchema,
  connectionLifecycleSchema,
  connectionSummarySchema,
  connectorImportResultSchema,
  connectorReferenceSchema,
  credentialCustodySchema,
  definitionListEntrySchema,
  ecosystemSchema,
  handoffKindSchema,
  handoffStateSchema,
} from "../src/core/connectors/index.js";
import {
  definitionReviewSchema,
  disconnectResultSchema,
  invokeStates,
} from "../src/core/connectors/client.js";
import {
  administrativeInputSchema,
  bindingApprovalSchema,
  configureInputSchema,
  connectInputSchema,
  disconnectInputSchema,
  handoffInputSchema,
  importInputSchema,
  invokeInputSchema,
  reconnectInputSchema,
} from "../src/server/connectors/commands/inputs.js";
import {
  CONNECTOR_HTTP_PREFIX,
  type AgentConnectionView,
  type ConnectorCommandService,
  type DefinitionListEntry,
  type HumanConnectionView,
  type InvokeResponse,
} from "../src/server/connectors/commands/index.js";
import {
  ConnectorError,
  connectorErrorCodes,
  type ConnectorErrorCode,
} from "../src/server/connectors/errors.js";

/*
 * Generates the OpenAPI 3.1 description of the connector command surface,
 * `/api/v1/connectors/*`, from the same Zod schemas the handler parses with.
 *
 * Request bodies are the command inputs the service validates (read in
 * "input" mode, so a defaulted field is optional, as it is on the wire).
 * Response bodies are the core contracts the projections parse through, read
 * in "output" mode. The few responses that are TypeScript types rather than
 * schemas in the service are declared here once, and each is pinned to the
 * service's own type below so `tsc` fails when the two stop agreeing.
 *
 * The route table is written out rather than discovered: the handler matches
 * paths with regular expressions, which cannot be enumerated. The contract
 * test (tests/connectors/commands/openapi-contract.test.ts) closes that gap
 * from the other side -- it drives every operation described here through the
 * real handler and fails when one is not exercised or does not conform.
 *
 * `--check` regenerates in memory and fails on drift, like the connector
 * support matrix, so the published description cannot quietly disagree with
 * the code. Nothing here performs network access.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
export const OPENAPI_PATH = join(root, "docs/openapi/connectors.openapi.json");

// --------------------------------------------------------------- responses
//
// Declared here because the service returns TypeScript types for them, not
// parsed schemas. Each is strict: the handler returns a positive projection,
// so a field the description does not name is a field that should not leave.

/** What the service's `presentation` carries; only ever for the initiating human. */
const humanPresentationSchema = z.strictObject({
  url: z.url().optional(),
  userCode: z.string().min(1).max(64).optional(),
  instructions: z.string().max(500).optional(),
});

const humanConnectionViewSchema = z
  .strictObject({
    ...connectionSummarySchema.shape,
    presentation: humanPresentationSchema.optional(),
  })
  .meta({
    description:
      "A connection as a person (or the system) sees it. `presentation` is present only for the initiating human while a handoff is pending.",
  });

const agentConnectionViewSchema = z
  .strictObject({
    connectionRef: connectorReferenceSchema,
    bindingRef: connectorReferenceSchema,
    ecosystem: ecosystemSchema,
    service: connectionSummarySchema.shape.service,
    lifecycle: connectionLifecycleSchema,
    generation: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    custody: credentialCustodySchema,
    verified: z.boolean(),
    targetKind: z.string().optional(),
    handoff: z
      .strictObject({ kind: handoffKindSchema, state: handoffStateSchema })
      .optional(),
  })
  .meta({
    description:
      "A connection as an assistant sees it: correlation identifiers and lifecycle, nothing it could navigate to, paste, or use to select an account.",
  });

const connectionViewSchema = z
  .union([humanConnectionViewSchema, agentConnectionViewSchema])
  .meta({
    description:
      "The projection is chosen by the caller's actor kind, never by the request.",
  });

const invokeResponseSchema = z.strictObject({
  state: z.enum(invokeStates),
  effect: z.enum(["read", "write", "unknown"]),
  outputClassification: z.enum(["public", "personal", "secret"]),
  output: z.unknown().optional().meta({
    description:
      "The operation's output, when this actor may see it. Absent, with `outputWithheld: true`, when policy withholds it.",
  }),
  outputWithheld: z.literal(true).optional(),
  code: z.string().optional(),
  effectRef: connectorReferenceSchema.optional(),
  replayed: z.literal(true).optional().meta({
    description:
      "A repeated `commandId` returned the journaled outcome; no second effect occurred.",
  }),
  handoff: z
    .strictObject({ kind: handoffKindSchema, state: handoffStateSchema })
    .optional(),
  presentation: humanPresentationSchema.optional(),
  agentOutputConsent: z.literal("personal").optional(),
});

const disconnectResponseSchema = z.strictObject({
  result: disconnectResultSchema.strict(),
  connection: connectionViewSchema,
});

const revocationRequestResponseSchema = z.strictObject({
  connectionRef: connectorReferenceSchema,
  revocation: z.literal("pending-approval"),
  requestedAt: z.iso.datetime({ offset: true }),
});

const configureResponseSchema = z.strictObject({
  names: z.array(z.string()),
  revision: z.string(),
});

/*
 * Compile-time agreement with the service: each schema declared here names
 * exactly the keys the service's own type does, so a field added to a
 * projection without being added here is a type error rather than a silently
 * undocumented field. Values are checked where they can be -- at run time, by
 * the contract test driving the real handler.
 */
type SameKeys<Service, Schema> = [keyof Service] extends [keyof Schema]
  ? [keyof Schema] extends [keyof Service]
    ? true
    : false
  : false;
const agreement: [
  SameKeys<HumanConnectionView, z.output<typeof humanConnectionViewSchema>>,
  SameKeys<AgentConnectionView, z.output<typeof agentConnectionViewSchema>>,
  SameKeys<DefinitionListEntry, z.output<typeof definitionListEntrySchema>>,
  SameKeys<InvokeResponse, z.output<typeof invokeResponseSchema>>,
  SameKeys<
    Awaited<ReturnType<ConnectorCommandService["requestRevocation"]>>,
    z.output<typeof revocationRequestResponseSchema>
  >,
  SameKeys<
    Awaited<ReturnType<ConnectorCommandService["configure"]>>,
    z.output<typeof configureResponseSchema>
  >,
] = [true, true, true, true, true, true];
void agreement;

// ------------------------------------------------------------------ errors

/** Every status a `ConnectorError` maps to, with the codes that produce it. */
function errorStatuses(): Map<number, ConnectorErrorCode[]> {
  const byStatus = new Map<number, ConnectorErrorCode[]>();
  for (const code of connectorErrorCodes) {
    const status = new ConnectorError(code).status;
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return new Map([...byStatus].sort(([a], [b]) => a - b));
}

const errorBodySchema = z
  .strictObject({
    error: z.enum(connectorErrorCodes),
    message: z.string().max(500).optional().meta({
      description:
        "A fixed, human-readable sentence for the code; never provider text. Always present when the connector handler answers; a host's own authentication layer may answer 401 with `error` alone.",
    }),
    detail: z
      .string()
      .max(120)
      .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,11}$/)
      .optional()
      .meta({
        description:
          'A bounded, non-secret refinement such as "revision.stale" or "revoke.admin-only".',
      }),
  })
  .meta({
    description:
      "Every failure is a sanitized code with a status. Provider bodies, exception messages and stack traces never leave the server.",
  });

/** The webhook receiver's own vocabulary, plus the handler's when no receiver is mounted. */
const eventRejectionSchema = z.strictObject({
  error: z.enum([
    "method",
    "unknown",
    "too-large",
    "unsupported-media-type",
    "unavailable",
    "retired",
    "malformed",
    "unverified",
    "unidentified",
    "not-found",
    "invalid-request",
  ]),
  message: z.string().max(500).optional(),
});
const eventAcknowledgementSchema = z.strictObject({
  status: z.enum(["accepted", "duplicate", "ignored"]),
});

// -------------------------------------------------------------- components

const requestSchemas = {
  ImportRequest: importInputSchema,
  BindingApprovalRequest: bindingApprovalSchema,
  ConfigureRequest: configureInputSchema,
  ConnectRequest: connectInputSchema,
  ReconnectRequest: reconnectInputSchema,
  DisconnectRequest: disconnectInputSchema,
  InvokeRequest: invokeInputSchema,
  AdministrativeRequest: administrativeInputSchema,
  HandoffInputRequest: handoffInputSchema,
  EmptyRequest: z.strictObject({}),
} as const;

const responseSchemas = {
  CatalogResponse: z.strictObject({ entries: z.array(catalogEntrySchema) }),
  DefinitionListResponse: z.strictObject({
    definitions: z.array(definitionListEntrySchema),
  }),
  DefinitionReview: definitionReviewSchema,
  ImportResult: connectorImportResultSchema,
  BindingReference: bindingReferenceSchema,
  BindingListResponse: z.strictObject({
    bindings: z.array(bindingReferenceSchema),
  }),
  ConfigureResponse: configureResponseSchema,
  // Each projection is its own component, so `ConnectionView` is an `anyOf`
  // of two `$ref`s rather than two inline objects. Generators name inline
  // union branches positionally, and openapi-python-client 0.29 gives both
  // branches' inline `handoff` the same model name, rejects the clash, and
  // then drops both branch models -- which leaves every connection route in
  // the generated package importing a module that does not exist.
  HumanConnectionView: humanConnectionViewSchema,
  AgentConnectionView: agentConnectionViewSchema,
  ConnectionView: connectionViewSchema,
  ConnectionListResponse: z.strictObject({
    connections: z.array(connectionViewSchema),
  }),
  InvokeResponse: invokeResponseSchema,
  DisconnectResponse: disconnectResponseSchema,
  RevocationRequestResponse: revocationRequestResponseSchema,
  DeleteResponse: z.strictObject({ deleted: z.literal(true) }),
  ErrorBody: errorBodySchema,
  EventAcknowledgement: eventAcknowledgementSchema,
  EventRejection: eventRejectionSchema,
} as const;

type JsonSchema = Record<string, unknown>;

/**
 * One registry per direction, so a component is emitted once and referenced
 * by `$ref`. The per-schema `$schema` and `$id` are dropped: OpenAPI 3.1
 * documents are already JSON Schema 2020-12, and an `$id` that is a fragment
 * is not a valid identifier in that dialect.
 */
function components(
  schemas: Record<string, z.ZodType>,
  io: "input" | "output",
): Record<string, JsonSchema> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(schemas))
    registry.add(schema, { id });
  const generated = z.toJSONSchema(registry, {
    target: "draft-2020-12",
    io,
    // A preprocess guard (bounded JSON) has no JSON Schema form; the value
    // it guards is still described by the schema it pipes into.
    unrepresentable: "any",
    uri: (id) => `#/components/schemas/${id}`,
  });
  return Object.fromEntries(
    Object.entries(generated.schemas).map(([id, schema]) => {
      const { $schema: _schema, $id: _id, ...rest } = schema as JsonSchema;
      void _schema;
      void _id;
      return [id, rest];
    }),
  );
}

// ------------------------------------------------------------------ routes

type Operation = {
  method: "get" | "post";
  path: string;
  operationId: string;
  tag: string;
  summary: string;
  description?: string;
  /** Capabilities any one of which admits the caller (`admin` always does). */
  capabilities: string[];
  /** Refused with 403 `denied` for any actor that is not an authenticated human. */
  humanOnly?: true;
  /** Inputs only a human may supply; an assistant sending them is refused. */
  humanOnlyInputs?: string[];
  request?: keyof typeof requestSchemas;
  success: { status: number; schema: keyof typeof responseSchemas };
};

const connection = "/connections/{connectionRef}";
const empty = "EmptyRequest" as const;
const view = { status: 200, schema: "ConnectionView" } as const;

const operations: Operation[] = [
  {
    method: "get",
    path: "/catalog",
    operationId: "listCatalog",
    tag: "catalog",
    summary: "List the connector directory for this caller",
    capabilities: ["executor"],
    success: { status: 200, schema: "CatalogResponse" },
  },
  {
    method: "get",
    path: "/definitions",
    operationId: "listDefinitions",
    tag: "definitions",
    summary: "List imported connector definitions with issue counts",
    capabilities: ["author", "reviewer"],
    success: { status: 200, schema: "DefinitionListResponse" },
  },
  {
    method: "get",
    path: "/definitions/{definitionRef}",
    operationId: "getDefinition",
    tag: "definitions",
    summary: "Review one normalized definition and its provenance",
    description:
      "The author review projection. The protected raw artifact handle never leaves the server.",
    capabilities: ["author", "reviewer"],
    success: { status: 200, schema: "DefinitionReview" },
  },
  {
    method: "post",
    path: "/import",
    operationId: "importDefinition",
    tag: "definitions",
    summary: "Import a connector description (upload or URL)",
    description:
      "Import registers nothing executable: it produces definitions and the candidates a reviewer may later bind. The body ceiling is larger than other routes' to admit a full description.",
    capabilities: ["author"],
    request: "ImportRequest",
    success: { status: 200, schema: "ImportResult" },
  },
  {
    method: "get",
    path: "/bindings",
    operationId: "listBindings",
    tag: "bindings",
    summary: "List reviewed runtime bindings",
    capabilities: ["executor"],
    success: { status: 200, schema: "BindingListResponse" },
  },
  {
    method: "post",
    path: "/bindings",
    operationId: "approveBinding",
    tag: "bindings",
    summary: "Approve a definition into a runtime binding (review step)",
    description:
      "A reviewer's explicit decisions: destinations, operations, custody and settings. Letting an assistant read personal output, and pinning an OAuth issuer policy, are a person's decisions only.",
    capabilities: ["reviewer", "publisher"],
    humanOnlyInputs: [
      "approvals.agentOutputConsent",
      "approvals.oauth",
      "approvals.oauthProfiles",
    ],
    request: "BindingApprovalRequest",
    success: { status: 201, schema: "BindingReference" },
  },
  {
    method: "post",
    path: "/configure",
    operationId: "configure",
    tag: "catalog",
    summary: "Commit private configuration collected out of band",
    description:
      "Takes a one-use reference from the private collection path; configuration values never travel in this JSON. Answers 501 `unsupported` where the host has no configuration writer.",
    capabilities: ["executor"],
    humanOnly: true,
    request: "ConfigureRequest",
    success: { status: 200, schema: "ConfigureResponse" },
  },
  {
    method: "get",
    path: "/connections",
    operationId: "listConnections",
    tag: "connections",
    summary: "List this caller's connections",
    capabilities: ["executor"],
    success: { status: 200, schema: "ConnectionListResponse" },
  },
  {
    method: "post",
    path: "/connections",
    operationId: "connect",
    tag: "connections",
    summary: "Start a connection under an approved binding",
    description:
      "Usually answers with a pending lifecycle and, for the initiating human, a `presentation` to continue with. An account switch is refused here; it is a reconnect.",
    capabilities: ["executor"],
    request: "ConnectRequest",
    success: { status: 201, schema: "ConnectionView" },
  },
  {
    method: "get",
    path: connection,
    operationId: "getConnection",
    tag: "connections",
    summary: "Read one connection's status",
    capabilities: ["executor"],
    success: view,
  },
  {
    method: "post",
    path: `${connection}/poll`,
    operationId: "pollConnection",
    tag: "connections",
    summary: "Advance a pending authorization that completes by polling",
    capabilities: ["executor"],
    request: empty,
    success: view,
  },
  {
    method: "post",
    path: `${connection}/verify`,
    operationId: "verifyConnection",
    tag: "connections",
    summary: "Refresh verification evidence for an existing grant",
    capabilities: ["executor"],
    request: empty,
    success: view,
  },
  {
    method: "post",
    path: `${connection}/cancel`,
    operationId: "cancelConnection",
    tag: "connections",
    summary: "Cancel a pending authorization or handoff",
    capabilities: ["executor"],
    request: empty,
    success: view,
  },
  {
    method: "post",
    path: `${connection}/reconnect`,
    operationId: "reconnectConnection",
    tag: "connections",
    summary: "Start a new authorization under the current binding revision",
    description:
      "The old grant stays until the new one is verified. Replacing the verified account (`accountSwitch: true`) is a person's decision only.",
    capabilities: ["executor"],
    humanOnlyInputs: ["accountSwitch"],
    request: "ReconnectRequest",
    success: view,
  },
  {
    method: "post",
    path: `${connection}/disconnect`,
    operationId: "disconnectConnection",
    tag: "connections",
    summary: "Disconnect locally, at the broker, or upstream",
    description:
      "A local unlink attempts nothing upstream. Broker and upstream scopes are a person's decision only.",
    capabilities: ["executor"],
    humanOnlyInputs: ["scope (broker, upstream)"],
    request: "DisconnectRequest",
    success: { status: 200, schema: "DisconnectResponse" },
  },
  {
    method: "post",
    path: `${connection}/invoke`,
    operationId: "invokeOperation",
    tag: "connections",
    summary: "Invoke an approved operation with this connection's credential",
    description:
      "A write, or any operation the binding marks for consent, answers `state: human-required` until an authenticated human repeats it with `confirm: true`; `confirm` is ignored for any other actor kind. A repeated `commandId` replays the journaled outcome.",
    capabilities: ["executor"],
    humanOnlyInputs: ["confirm"],
    request: "InvokeRequest",
    success: { status: 200, schema: "InvokeResponse" },
  },
  {
    method: "post",
    path: `${connection}/revoke-request`,
    operationId: "requestRevocation",
    tag: "revocation",
    summary: "Ask an administrator to revoke this connection",
    description:
      "Only queues the request; revoking stays an administrator's human-only action.",
    capabilities: ["executor"],
    request: empty,
    success: { status: 200, schema: "RevocationRequestResponse" },
  },
  {
    method: "post",
    path: `${connection}/revoke-decline`,
    operationId: "declineRevocation",
    tag: "revocation",
    summary: "Decline a pending revocation request",
    description:
      "Approving the request is `revoke` and declining it is its counterpart: both are an administrator's action, under the same host policy, on an open connection.",
    capabilities: ["admin"],
    humanOnly: true,
    request: "AdministrativeRequest",
    success: view,
  },
  {
    method: "post",
    path: `${connection}/revoke`,
    operationId: "revokeConnection",
    tag: "revocation",
    summary: "Revoke the upstream grant (approves a revocation request)",
    capabilities: ["admin"],
    humanOnly: true,
    request: "AdministrativeRequest",
    success: { status: 200, schema: "DisconnectResponse" },
  },
  {
    method: "post",
    path: `${connection}/delete`,
    operationId: "deleteConnection",
    tag: "revocation",
    summary: "Purge a disconnected connection's local record",
    description: "Never an upstream effect; the connection must be closed.",
    capabilities: ["admin"],
    humanOnly: true,
    request: "AdministrativeRequest",
    success: { status: 200, schema: "DeleteResponse" },
  },
  {
    method: "post",
    path: `${connection}/handoffs/{handoffRef}/input`,
    operationId: "provideHandoffInput",
    tag: "handoffs",
    summary: "Submit the private input a handoff asks for",
    description:
      "The submitted values (an API key, for example) are held in credential custody and never appear in any response.",
    capabilities: ["executor"],
    humanOnly: true,
    request: "HandoffInputRequest",
    success: view,
  },
];

// -------------------------------------------------------------- the document

const reference = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });

const pathParameters: Record<string, JsonSchema> = {
  connectionRef: {
    name: "connectionRef",
    in: "path",
    required: true,
    description:
      "A connection reference. References may contain `/` and `:`, so percent-encode the segment.",
    schema: { type: "string", maxLength: 200 },
  },
  definitionRef: {
    name: "definitionRef",
    in: "path",
    required: true,
    description: "A definition reference, percent-encoded.",
    schema: { type: "string", maxLength: 200 },
  },
  handoffRef: {
    name: "handoffRef",
    in: "path",
    required: true,
    description: "A handoff reference, percent-encoded.",
    schema: { type: "string", maxLength: 200 },
  },
};

function parametersFor(path: string, method: string) {
  const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
  const parameters: unknown[] = names.map((name) => ({
    $ref: `#/components/parameters/${name}`,
  }));
  if (method === "post")
    parameters.push({ $ref: "#/components/parameters/Origin" });
  return parameters;
}

function errorResponses(): Record<string, unknown> {
  return Object.fromEntries(
    [...errorStatuses().keys()].map((status) => [
      String(status),
      { $ref: `#/components/responses/Error${status}` },
    ]),
  );
}

function operationObject(operation: Operation) {
  const notes = [
    operation.description,
    operation.capabilities.length
      ? `Requires one of these capabilities: ${operation.capabilities.map((c) => `\`${c}\``).join(", ")}${operation.capabilities.includes("admin") ? "" : " (or `admin`)"}.`
      : "Requires no capability beyond owning the connection.",
    operation.humanOnly
      ? "**Human-only.** Any actor that is not an authenticated human (an assistant, a delegated agent, the system) is refused with 403 `denied`."
      : undefined,
    operation.humanOnlyInputs
      ? `**Human-only inputs:** ${operation.humanOnlyInputs.map((input) => `\`${input}\``).join(", ")}. An assistant that sends them is refused (or, for \`confirm\`, the flag is ignored).`
      : undefined,
  ].filter(Boolean);
  return {
    operationId: operation.operationId,
    tags: [operation.tag],
    summary: operation.summary,
    description: notes.join("\n\n"),
    "x-ceremony-capabilities": operation.capabilities,
    ...(operation.humanOnly ? { "x-ceremony-human-only": true } : {}),
    ...(operation.humanOnlyInputs
      ? { "x-ceremony-human-only-inputs": operation.humanOnlyInputs }
      : {}),
    parameters: [
      ...parametersFor(operation.path, operation.method),
      ...(operation.operationId === "listConnections"
        ? [
            {
              name: "ecosystem",
              in: "query",
              required: false,
              schema: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
            },
            {
              name: "bindingRef",
              in: "query",
              required: false,
              schema: { type: "string", maxLength: 200 },
            },
            {
              name: "lifecycle",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: [...connectionLifecycleSchema.options],
              },
            },
          ]
        : []),
    ],
    ...(operation.request
      ? {
          requestBody: {
            required: true,
            content: json(reference(operation.request)),
          },
        }
      : {}),
    responses: {
      [String(operation.success.status)]: {
        description: operation.success.status === 201 ? "Created." : "Success.",
        content: json(reference(operation.success.schema)),
      },
      ...errorResponses(),
    },
  };
}

const callbackOperation = {
  operationId: "providerCallback",
  tags: ["callback"],
  summary: "Provider authorization return (top-level navigation)",
  description: [
    "Where a provider sends the person's browser after authorization. It is a navigation, not an API call: it always answers 303 to the deployment's own return path, with `connection` and `outcome` (a lifecycle or an error code) and sometimes `detail` in the query string. The query this route receives is the provider's (`state`, `code`, `error`, ...) and is correlated by `state` against the session that started the flow.",
    "**Human-only.** Any actor that is not an authenticated human is refused, and the refusal is reported in the redirect's `outcome`.",
  ].join("\n\n"),
  "x-ceremony-capabilities": ["executor"],
  "x-ceremony-human-only": true,
  parameters: [
    {
      name: "state",
      in: "query",
      required: true,
      description: "Opaque correlation value issued when the flow started.",
      schema: { type: "string" },
    },
  ],
  responses: {
    "303": {
      description:
        "Always a redirect to the deployment's return path on its own origin; never to a location taken from input.",
      headers: {
        Location: { required: true, schema: { type: "string", format: "uri" } },
      },
    },
    ...errorResponses(),
  },
};

function eventOperation(operationId: string, withSubscription: boolean) {
  return {
    operationId,
    tags: ["events"],
    summary: withSubscription
      ? "Receive a provider delivery for one subscription"
      : "Receive a provider delivery for an authority",
    description:
      "Provider deliveries only. No session and no Origin check: the receiver authenticates each delivery by verifying a signature over the raw body with the subscription's own signing secret. A deployment that has not enabled events answers 404.",
    security: [],
    parameters: [
      {
        name: "authority",
        in: "path",
        required: true,
        schema: {
          type: "string",
          pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$",
        },
      },
      ...(withSubscription
        ? [
            {
              name: "subscriptionId",
              in: "path",
              required: true,
              schema: {
                type: "string",
                pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,199}$",
              },
            },
          ]
        : []),
    ],
    requestBody: {
      required: true,
      description:
        "The provider's signed delivery, verbatim. Its schema is the provider's; signature headers are verified before the body is parsed.",
      content: { "application/json": { schema: {} } },
    },
    responses: {
      "200": {
        description: "Accepted, or a duplicate of an accepted delivery.",
        content: json(reference("EventAcknowledgement")),
      },
      "202": {
        description: "Verified but not routed to anything; ignored.",
        content: json(reference("EventAcknowledgement")),
      },
      ...Object.fromEntries(
        [400, 401, 404, 405, 410, 413, 415, 503].map((status) => [
          String(status),
          {
            description: "Rejected.",
            content: json(reference("EventRejection")),
          },
        ]),
      ),
    },
  };
}

const description = `The connector command surface of a Ceremony deployment: import connector descriptions, review them into runtime bindings, connect, invoke approved operations, and disconnect or revoke.

**Generated.** \`npm run openapi:generate\` writes this file from the Zod schemas the handler validates with; \`npm run openapi:check\` fails when it is stale. Do not edit it by hand.

## Authentication

The hosted deployment authenticates these routes with its **session cookie**, established by the OIDC sign-in (\`POST /api/auth/login\`, then the issuer, then \`/api/auth/callback\`). They do **not** accept bearer tokens: an OAuth access token is accepted only by the MCP endpoint (\`/mcp\`), which exposes a narrower set of connector tools. A host embedding the handler (\`createConnectorRuntime(...).http\`) brings its own identity adapter and may authenticate differently; the handler itself reads no token or cookie and is handed the authenticated actor.

Every \`POST\` is a same-origin mutation: it must carry an \`Origin\` header equal to the deployment's origin and \`Content-Type: application/json\`, and its body is size-bounded. All routes share a per-subject request budget (429 \`rate-limited\`). The provider event routes are the exception: they take no session and authenticate each delivery by signature.

## Human-only routes and inputs

Operations marked \`x-ceremony-human-only: true\` refuse any actor that is not an authenticated human with 403 \`denied\`, whatever capabilities it holds. \`x-ceremony-human-only-inputs\` names inputs within an otherwise shared operation that only a person may supply. Assistants and delegated agents also see a narrower projection of every connection (see \`ConnectionView\`).

## Errors

Every failure is \`{ "error": <code>, "message": <fixed sentence>, "detail"?: <bounded refinement> }\`. The code is the whole public story: provider bodies and exception text never leave the server. The code-to-status mapping is fixed; see the \`Error<status>\` responses. A method a route does not support answers 405 \`invalid-request\` with an \`Allow\` header.`;

export function connectorOpenApi(): JsonSchema {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const path = `${CONNECTOR_HTTP_PREFIX}${operation.path}`;
    paths[path] = {
      ...paths[path],
      [operation.method]: operationObject(operation),
    };
  }
  paths[`${CONNECTOR_HTTP_PREFIX}/callback`] = { get: callbackOperation };
  paths[`${CONNECTOR_HTTP_PREFIX}/events/{authority}`] = {
    post: eventOperation("receiveAuthorityEvent", false),
  };
  paths[`${CONNECTOR_HTTP_PREFIX}/events/{authority}/{subscriptionId}`] = {
    post: eventOperation("receiveSubscriptionEvent", true),
  };
  const sorted = Object.fromEntries(
    Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)),
  );

  const errorResponseComponents = Object.fromEntries(
    [...errorStatuses()].map(([status, codes]) => [
      `Error${status}`,
      {
        description: `Codes answered with ${status}: ${codes.map((code) => `\`${code}\``).join(", ")}.`,
        content: json({
          allOf: [
            reference("ErrorBody"),
            {
              type: "object",
              properties: { error: { type: "string", enum: codes } },
            },
          ],
        }),
      },
    ]),
  );

  return {
    openapi: "3.1.0",
    info: {
      title: "Ceremony connector API",
      version: "1",
      summary: "Connector import, review, connection and invocation.",
      description,
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [
      {
        url: "{origin}",
        description: "A Ceremony deployment's exact origin.",
        variables: {
          origin: {
            default: "https://ceremony.example",
            description: "The deployment origin, scheme and host only.",
          },
        },
      },
    ],
    security: [{ sessionCookie: [] }],
    tags: [
      { name: "catalog", description: "The connector directory." },
      {
        name: "definitions",
        description: "Imported, non-executable connector descriptions.",
      },
      {
        name: "bindings",
        description: "Reviewed, server-side runtime bindings.",
      },
      { name: "connections", description: "Connections and invocation." },
      {
        name: "handoffs",
        description: "Private input a person supplies during a connection.",
      },
      {
        name: "revocation",
        description: "Revocation requests and administrative actions.",
      },
      { name: "callback", description: "Provider authorization return." },
      { name: "events", description: "Signed provider deliveries." },
    ],
    paths: sorted,
    components: {
      securitySchemes: {
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "__Host-ceremony_session",
          description:
            "The hosted deployment's session cookie, set by its OIDC sign-in. HttpOnly, SameSite=Lax, Secure; named `ceremony_session` under the local development profile. Bearer tokens are not accepted on these routes.",
        },
      },
      parameters: {
        ...pathParameters,
        Origin: {
          name: "Origin",
          in: "header",
          required: true,
          description:
            "Must equal the deployment's exact origin; a browser sends it automatically. A cross-site request is refused with 403 `denied`.",
          schema: { type: "string", format: "uri" },
        },
      },
      responses: errorResponseComponents,
      schemas: {
        ...components(requestSchemas, "input"),
        ...components(responseSchemas, "output"),
      },
    },
  };
}

/** The document as committed: Prettier-formatted JSON, so format:check agrees. */
export async function generate(): Promise<{ path: string; content: string }> {
  return {
    path: OPENAPI_PATH,
    content: await format(JSON.stringify(connectorOpenApi()), {
      parser: "json",
      filepath: OPENAPI_PATH,
    }),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const check = process.argv.includes("--check");
  const file = await generate();
  const name = relative(root, file.path);
  if (check) {
    const current = existsSync(file.path)
      ? readFileSync(file.path, "utf8")
      : "";
    if (current !== file.content) {
      console.error(
        `drift: ${name} does not match the generated content; run: npm run openapi:generate`,
      );
      process.exitCode = 1;
    } else console.log(`${name} is up to date`);
  } else {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
    console.log(`wrote ${name} (${file.content.length} bytes)`);
  }
}
