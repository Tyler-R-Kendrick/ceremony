import { z } from "zod";
import {
  bindingReferenceSchema,
  catalogEntrySchema,
  compatibilityIssueSchema,
  connectionSummarySchema,
  connectorHandoffSummarySchema,
  connectorImportResultSchema,
  definitionListEntrySchema,
  normalizedDefinitionSchema,
  refineSourceRecord,
  sourceRecordShape,
  type BindingReference,
  type CatalogEntry,
  type CompatibilityIssue,
  type ConnectionSummary,
  type ConnectorImportResult,
  type DefinitionListEntry,
} from "./contracts.js";
import {
  connectorReferenceSchema,
  encodePathSegment,
  ownerKindSchema,
  safeTextSchema,
  type OwnerKind,
} from "./identity.js";
import { presentationUrlSchema } from "./projections.js";

/*
 * The browser's view of the connector command surface, `/api/v1/connectors`.
 *
 * Every response is parsed with the core schema before a component sees it, so
 * a field the server did not project cannot be rendered by accident and a
 * malformed body is an error rather than a half-drawn screen. The client never
 * derives status from anything but a server response: a popup message, a closed
 * window or a callback query string can prompt a poll, and only the poll's
 * answer is shown. Nothing here stores a credential; secret values travel once,
 * to the private collector, and come back as an opaque reference.
 */

export const CONNECTORS_API_BASE = "/api/v1/connectors";

const noControl = /^[^\p{Cc}]*$/u;
const codeSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9]*(?:[.\-_:][a-z0-9]+){0,15}$/i);
export const catalogIdSchema = catalogEntrySchema.shape.id;

const optionSchema = z.object({
  value: z.string().max(200).regex(noControl),
  label: safeTextSchema.max(200).optional(),
});
export type FieldOption = z.infer<typeof optionSchema>;

/**
 * A field a person fills in: a handoff that needs input in the app, or the
 * input of an operation. Options may be static or fetched by invoking a
 * registered dynamic operation with the values of the fields it depends on,
 * which is the Microsoft `x-ms-dynamic-values` shape without any client-side
 * URL. A password field is secret by definition and never persists anywhere.
 */
export const fieldDescriptorSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/),
    label: safeTextSchema.min(1).max(120),
    type: z
      .enum(["text", "password", "select", "url", "email", "number"])
      .default("text"),
    required: z.boolean().default(false),
    classification: z.enum(["public", "personal", "secret"]).default("public"),
    description: safeTextSchema.optional(),
    options: z.array(optionSchema).max(200).optional(),
    dynamic: z
      .object({
        operationRef: z.string().min(1).max(200).regex(noControl),
        dependsOn: z
          .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/))
          .max(8)
          .default([]),
      })
      .optional(),
  })
  .superRefine((field, ctx) => {
    if (field.type === "password" && field.classification !== "secret")
      ctx.addIssue({ code: "custom", message: "A password field is secret" });
  });
export type FieldDescriptor = z.infer<typeof fieldDescriptorSchema>;

/** Re-validated on arrival: the server projects it for the initiating human only, and the browser trusts nothing else. */
export const connectionPresentationSchema = z.object({
  url: presentationUrlSchema.optional(),
  userCode: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[^\p{Cc}]+$/u)
    .optional(),
  instructions: z.string().max(500).regex(noControl).optional(),
  /** Proposed additive field: what an in-app handoff asks for. Absent for every other presentation. */
  fields: z.array(fieldDescriptorSchema).max(16).optional(),
});
export type ConnectionPresentation = z.infer<
  typeof connectionPresentationSchema
>;
export type ConnectionView = ConnectionSummary & {
  presentation?: ConnectionPresentation;
};

/**
 * Who is looking, as the server says. Proposed additive `viewer` field on the
 * catalog response (with `x-ceremony-capabilities` / `x-ceremony-owner-kinds`
 * headers as an equivalent); absent, nothing privileged is offered.
 */
export const connectorViewerSchema = z.object({
  capabilities: z
    .array(
      z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z][a-z0-9-]*$/),
    )
    .max(32)
    .default([]),
  ownerKinds: z.array(ownerKindSchema).max(3).default(["user"]),
});
export type ConnectorViewer = z.infer<typeof connectorViewerSchema>;
export const defaultViewer: ConnectorViewer = Object.freeze({
  capabilities: [],
  ownerKinds: ["user"],
});
/** Roles that may bind or activate an imported definition. */
export const publishingCapabilities = ["publisher", "admin"] as const;
export function canPublish(viewer: ConnectorViewer | undefined): boolean {
  return Boolean(
    viewer?.capabilities.some((capability) =>
      (publishingCapabilities as readonly string[]).includes(capability),
    ),
  );
}
export function ownerKindPermitted(
  viewer: ConnectorViewer | undefined,
  kind: OwnerKind,
): boolean {
  return (viewer ?? defaultViewer).ownerKinds.includes(kind);
}

const catalogResponseSchema = z.object({
  entries: z.array(catalogEntrySchema).max(4096),
  viewer: connectorViewerSchema.optional(),
});
const definitionsResponseSchema = z.object({
  definitions: z.array(definitionListEntrySchema).max(4096),
});
const { artifactRef: _artifactRef, ...reviewSourceShape } = sourceRecordShape;
void _artifactRef;
/** The author review projection: provenance without the protected artifact handle. */
export const reviewSourceSchema = z
  .object(reviewSourceShape)
  .superRefine(refineSourceRecord);
export const definitionReviewSchema = z.object({
  definition: normalizedDefinitionSchema,
  source: reviewSourceSchema,
});
export type DefinitionReview = z.infer<typeof definitionReviewSchema>;
const bindingsResponseSchema = z.object({
  bindings: z.array(bindingReferenceSchema).max(4096),
});
const bindingResponseSchema = z.union([
  z.object({ binding: bindingReferenceSchema }).transform((v) => v.binding),
  bindingReferenceSchema,
]);
const connectionsResponseSchema = z.object({
  connections: z.array(z.unknown()).max(4096),
});

export const disconnectScopes = ["local", "broker", "upstream"] as const;
export type DisconnectScope = (typeof disconnectScopes)[number];
export const disconnectOutcomes = [
  "applied",
  "unsupported",
  "failed",
  "not-attempted",
  "indeterminate",
] as const;
export type DisconnectOutcome = (typeof disconnectOutcomes)[number];
export const disconnectResultSchema = z.object({
  local: z.enum(disconnectOutcomes),
  broker: z.enum(disconnectOutcomes),
  upstream: z.enum(disconnectOutcomes),
  /** Other local connections sharing the affected upstream grant. */
  sharedWith: z.array(connectorReferenceSchema).max(64).optional(),
});
export type DisconnectResult = z.infer<typeof disconnectResultSchema>;

export const invokeStates = [
  "complete",
  "failed",
  "indeterminate",
  "human-required",
  "denied",
] as const;
export const invokeOutcomeSchema = z.object({
  state: z.enum(invokeStates),
  output: z.unknown().optional(),
  outputClassification: z.enum(["public", "personal", "secret"]),
  effect: z.enum(["read", "write", "unknown"]),
  code: codeSchema.optional(),
  handoff: connectorHandoffSummarySchema.optional(),
  effectRef: connectorReferenceSchema.optional(),
});
export type InvokeOutcome = z.infer<typeof invokeOutcomeSchema>;
/** What a dynamic-options operation returns; anything else is an error, not a list. */
export const dynamicOptionsSchema = z.object({
  options: z.array(optionSchema).max(500),
});
const collectResponseSchema = z.object({
  secretRef: z.string().min(8).max(200),
});

export type ImportInput =
  | { kind: "upload"; mediaType: string; text: string }
  | { kind: "url"; url: string };
export type ConnectIntent = {
  profileId?: string;
  requestedPermissions: string[];
  target?: { kind: string; id: string };
  /** Explicit human intent to replace the verified account; never inferred. */
  accountSwitch: boolean;
  /** A constraint: "none" may end in human-required, never in a bypass. */
  interruption: "allowed" | "none";
};
export type ConnectRequest = {
  bindingRef: string;
  ownerKind: OwnerKind;
  intent: ConnectIntent;
};
export type BindingRequest = {
  definitionRef: string;
  profileId?: string;
  adapterId?: string;
};

export class ConnectorClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly issues: CompatibilityIssue[];
  constructor(
    code: string,
    message: string,
    status = 0,
    issues: CompatibilityIssue[] = [],
  ) {
    super(message);
    this.name = "ConnectorClientError";
    this.code = code;
    this.status = status;
    this.issues = issues;
  }
}
export function isUnauthenticated(error: unknown): boolean {
  return (
    error instanceof ConnectorClientError && error.code === "unauthenticated"
  );
}

const errorBodySchema = z.object({
  error: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[^\p{Cc}]+$/u),
  message: z.string().max(500).regex(noControl).optional(),
  issues: z.array(compatibilityIssueSchema).max(256).optional(),
});
const defaultMessages: Record<number, [string, string]> = {
  400: ["invalid-request", "The request was not accepted."],
  401: ["unauthenticated", "Sign in again to continue."],
  403: ["forbidden", "Your account does not have permission for this action."],
  404: ["not-found", "This connection or connector no longer exists."],
  409: [
    "conflict",
    "This connection changed elsewhere. Refresh its status and try again.",
  ],
  413: ["too-large", "The document is larger than the import limit."],
  429: ["rate-limited", "Too many requests. Wait a moment and try again."],
};

export interface ConnectorClientOptions {
  base?: string;
  fetch?: typeof fetch;
  /** Whether the browser believes it is online; mutations are refused offline. */
  online?: () => boolean;
}

export interface ConnectorClient {
  readonly base: string;
  catalog(
    signal?: AbortSignal,
  ): Promise<{ entries: CatalogEntry[]; viewer: ConnectorViewer }>;
  definitions(
    signal?: AbortSignal,
  ): Promise<{ definitions: DefinitionListEntry[] }>;
  definition(ref: string, signal?: AbortSignal): Promise<DefinitionReview>;
  import(
    input: ImportInput,
    signal?: AbortSignal,
  ): Promise<ConnectorImportResult>;
  bindings(signal?: AbortSignal): Promise<{ bindings: BindingReference[] }>;
  createBinding(
    input: BindingRequest,
    signal?: AbortSignal,
  ): Promise<BindingReference>;
  connections(
    signal?: AbortSignal,
  ): Promise<{ connections: ConnectionSummary[] }>;
  connect(input: ConnectRequest, signal?: AbortSignal): Promise<ConnectionView>;
  connection(ref: string, signal?: AbortSignal): Promise<ConnectionView>;
  poll(ref: string, signal?: AbortSignal): Promise<ConnectionView>;
  verify(ref: string, signal?: AbortSignal): Promise<ConnectionView>;
  reconnect(
    ref: string,
    input: { expectedRevision: number; accountSwitch?: boolean },
    signal?: AbortSignal,
  ): Promise<ConnectionView>;
  disconnect(
    ref: string,
    input: { expectedRevision: number; scope: DisconnectScope },
    signal?: AbortSignal,
  ): Promise<{ result: DisconnectResult; connection: ConnectionView }>;
  invoke(
    ref: string,
    input: { operationRef: string; input: unknown; commandId?: string },
    signal?: AbortSignal,
  ): Promise<InvokeOutcome>;
  handoffInput(
    ref: string,
    handoffRef: string,
    values: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<ConnectionView>;
  /** Private collection: values go here once and come back as a reference. */
  collect(
    ref: string,
    values: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ secretRef: string }>;
}

/** Splits a connection response into the summary and its re-validated presentation. */
export function parseConnectionView(value: unknown): ConnectionView {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ConnectorClientError(
      "invalid-response",
      "The connector service returned an unexpected response.",
    );
  const { presentation, ...rest } = value as Record<string, unknown>;
  const summary = connectionSummarySchema.parse(rest);
  if (presentation === undefined || presentation === null) return summary;
  return {
    ...summary,
    presentation: connectionPresentationSchema.parse(presentation),
  };
}

function viewerFromHeaders(headers: Headers): ConnectorViewer | undefined {
  const capabilities = headers.get("x-ceremony-capabilities");
  const ownerKinds = headers.get("x-ceremony-owner-kinds");
  if (capabilities === null && ownerKinds === null) return undefined;
  const list = (value: string | null) =>
    value === null
      ? undefined
      : value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
  const parsed = connectorViewerSchema.safeParse({
    ...(list(capabilities) ? { capabilities: list(capabilities) } : {}),
    ...(list(ownerKinds) ? { ownerKinds: list(ownerKinds) } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

export function createConnectorClient(
  options: ConnectorClientOptions = {},
): ConnectorClient {
  const base = (options.base ?? CONNECTORS_API_BASE).replace(/\/$/, "");
  const fetchImpl: typeof fetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const online =
    options.online ??
    (() => typeof navigator === "undefined" || navigator.onLine !== false);

  async function errorFrom(response: Response): Promise<ConnectorClientError> {
    const [defaultCode, defaultMessage] = defaultMessages[response.status] ?? [
      "request-failed",
      "This action could not finish. Refresh the status and try again.",
    ];
    if (response.status === 401)
      return new ConnectorClientError(defaultCode, defaultMessage, 401);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const parsed = errorBodySchema.safeParse(body);
    if (!parsed.success)
      return new ConnectorClientError(
        defaultCode,
        defaultMessage,
        response.status,
      );
    return new ConnectorClientError(
      parsed.data.error,
      parsed.data.message || defaultMessage,
      response.status,
      parsed.data.issues ?? [],
    );
  }

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    parse: (value: unknown, headers: Headers) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    if (method === "POST" && !online())
      throw new ConnectorClientError(
        "offline",
        "You are offline. Reconnect before changing a connection; nothing is queued.",
      );
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ConnectorClientError(
        "network",
        "The connector service could not be reached. Check your connection and try again.",
      );
    }
    if (!response.ok) throw await errorFrom(response);
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ConnectorClientError(
        "invalid-response",
        "The connector service returned an unreadable response.",
        response.status,
      );
    }
    try {
      return parse(json, response.headers);
    } catch (error) {
      if (error instanceof ConnectorClientError) throw error;
      throw new ConnectorClientError(
        "invalid-response",
        "The connector service returned a response this app does not understand.",
        response.status,
      );
    }
  }
  const ref = (value: string) => encodePathSegment(value);
  const view = (value: unknown) => parseConnectionView(value);
  return {
    base,
    catalog: (signal) =>
      call(
        "GET",
        "/catalog",
        undefined,
        (value, headers) => {
          const parsed = catalogResponseSchema.parse(value);
          return {
            entries: parsed.entries,
            viewer:
              parsed.viewer ?? viewerFromHeaders(headers) ?? defaultViewer,
          };
        },
        signal,
      ),
    definitions: (signal) =>
      call(
        "GET",
        "/definitions",
        undefined,
        (value) => definitionsResponseSchema.parse(value),
        signal,
      ),
    definition: (definitionRef, signal) =>
      call(
        "GET",
        `/definitions/${ref(definitionRef)}`,
        undefined,
        (value) => definitionReviewSchema.parse(value),
        signal,
      ),
    import: (input, signal) =>
      call(
        "POST",
        "/import",
        input,
        (value) => connectorImportResultSchema.parse(value),
        signal,
      ),
    bindings: (signal) =>
      call(
        "GET",
        "/bindings",
        undefined,
        (value) => bindingsResponseSchema.parse(value),
        signal,
      ),
    createBinding: (input, signal) =>
      call(
        "POST",
        "/bindings",
        input,
        (value) => bindingResponseSchema.parse(value),
        signal,
      ),
    connections: (signal) =>
      call(
        "GET",
        "/connections",
        undefined,
        (value) => ({
          connections: connectionsResponseSchema
            .parse(value)
            .connections.map((item) => {
              const { presentation: _presentation, ...summary } =
                item as Record<string, unknown>;
              void _presentation;
              return connectionSummarySchema.parse(summary);
            }),
        }),
        signal,
      ),
    connect: (input, signal) =>
      call("POST", "/connections", input, view, signal),
    connection: (connectionRef, signal) =>
      call(
        "GET",
        `/connections/${ref(connectionRef)}`,
        undefined,
        view,
        signal,
      ),
    poll: (connectionRef, signal) =>
      call("POST", `/connections/${ref(connectionRef)}/poll`, {}, view, signal),
    verify: (connectionRef, signal) =>
      call(
        "POST",
        `/connections/${ref(connectionRef)}/verify`,
        {},
        view,
        signal,
      ),
    reconnect: (connectionRef, input, signal) =>
      call(
        "POST",
        `/connections/${ref(connectionRef)}/reconnect`,
        {
          expectedRevision: input.expectedRevision,
          accountSwitch: input.accountSwitch ?? false,
        },
        view,
        signal,
      ),
    disconnect: (connectionRef, input, signal) =>
      call(
        "POST",
        `/connections/${ref(connectionRef)}/disconnect`,
        input,
        (value) => {
          const parsed = z
            .object({ result: disconnectResultSchema, connection: z.unknown() })
            .parse(value);
          return { result: parsed.result, connection: view(parsed.connection) };
        },
        signal,
      ),
    invoke: (connectionRef, input, signal) =>
      call(
        "POST",
        `/connections/${ref(connectionRef)}/invoke`,
        {
          operationRef: input.operationRef,
          input: input.input,
          commandId: input.commandId ?? `command-${crypto.randomUUID()}`,
        },
        (value) => invokeOutcomeSchema.parse(value),
        signal,
      ),
    handoffInput: (connectionRef, handoffRef, values, signal) =>
      call(
        "POST",
        `/connections/${ref(connectionRef)}/handoffs/${ref(handoffRef)}/input`,
        { values },
        view,
        signal,
      ),
    collect: (connectionRef, values, signal) =>
      call(
        "POST",
        `/connections/${ref(connectionRef)}/collect`,
        { values },
        (value) => collectResponseSchema.parse(value),
        signal,
      ),
  };
}

/* ------------------------------------------------------------ popup messages
 * A window that a handoff opened may tell the opener it is done. The message
 * is a prompt to poll and nothing more; it is honoured only when it comes from
 * this origin, from the exact window this page opened, and names the
 * connection (and, when it says which, the handoff) that is pending.
 */

export const HANDOFF_MESSAGE_TYPE = "ceremony:connector-handoff";
export const handoffMessageSchema = z.strictObject({
  type: z.literal(HANDOFF_MESSAGE_TYPE),
  connectionRef: connectorReferenceSchema,
  handoffRef: connectorReferenceSchema.optional(),
  outcome: codeSchema.optional(),
});
export type HandoffMessage = z.infer<typeof handoffMessageSchema>;

export function isTrustedHandoffMessage(
  event: { origin: string; source: unknown; data: unknown },
  expected: {
    origin: string;
    source: unknown;
    connectionRef: string;
    handoffRef?: string;
  },
): boolean {
  if (!expected.source || event.source !== expected.source) return false;
  if (!event.origin || event.origin !== expected.origin) return false;
  const parsed = handoffMessageSchema.safeParse(event.data);
  if (!parsed.success) return false;
  if (parsed.data.connectionRef !== expected.connectionRef) return false;
  if (
    parsed.data.handoffRef !== undefined &&
    expected.handoffRef !== undefined &&
    parsed.data.handoffRef !== expected.handoffRef
  )
    return false;
  return true;
}

/* ------------------------------------------------------------ callback return
 * The server's callback route sends the browser back to the app with
 * `?connector=…&connection=…&outcome=…`. The query names what to reopen; the
 * outcome is a hint for copy. Status is read from the server afterwards.
 */

export type ConnectorReturn = {
  connector?: string;
  connection?: string;
  outcome?: string;
};
export function readConnectorReturn(search: string): ConnectorReturn {
  const params = new URLSearchParams(search);
  const result: ConnectorReturn = {};
  const connector = catalogIdSchema.safeParse(params.get("connector"));
  if (connector.success) result.connector = connector.data;
  const connection = connectorReferenceSchema.safeParse(
    params.get("connection"),
  );
  if (connection.success) result.connection = connection.data;
  const outcome = codeSchema.safeParse(params.get("outcome"));
  if (outcome.success) result.outcome = outcome.data;
  return result;
}

export type RelayWindow = {
  opener: unknown;
  location: { origin: string; search: string };
  close(): void;
};
/**
 * When the callback lands in a window this app opened, hand the return to the
 * opener and close. Only a same-origin opener is told anything, and the opener
 * still verifies the window, the origin and the correlation before it polls.
 */
export function relayHandoffReturn(win: RelayWindow): boolean {
  const opener = win.opener as
    | {
        closed?: boolean;
        location: { origin: string };
        postMessage: Window["postMessage"];
      }
    | null
    | undefined;
  if (!opener || typeof opener !== "object" || opener.closed) return false;
  const back = readConnectorReturn(win.location.search);
  if (!back.connection) return false;
  let openerOrigin: string;
  try {
    openerOrigin = opener.location.origin;
  } catch {
    return false;
  }
  if (openerOrigin !== win.location.origin) return false;
  const message: HandoffMessage = {
    type: HANDOFF_MESSAGE_TYPE,
    connectionRef: back.connection,
    ...(back.outcome ? { outcome: back.outcome } : {}),
  };
  opener.postMessage(message, win.location.origin);
  win.close();
  return true;
}

/* ------------------------------------------------------------ review helpers
 * Diagnostics are shown blocking first, grouped by category, and always as
 * code, pointer and message; a raw source fragment never enters the page.
 */

const severityRank = { blocking: 0, warning: 1, info: 2 } as const;

export function sortIssues(
  issues: readonly CompatibilityIssue[],
): CompatibilityIssue[] {
  return [...issues].sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      a.category.localeCompare(b.category) ||
      a.code.localeCompare(b.code),
  );
}

export function groupIssues(issues: readonly CompatibilityIssue[]): Array<{
  category: CompatibilityIssue["category"];
  blocking: number;
  issues: CompatibilityIssue[];
}> {
  const groups = new Map<
    CompatibilityIssue["category"],
    {
      category: CompatibilityIssue["category"];
      blocking: number;
      issues: CompatibilityIssue[];
    }
  >();
  for (const issue of sortIssues(issues)) {
    const group = groups.get(issue.category) ?? {
      category: issue.category,
      blocking: 0,
      issues: [],
    };
    if (issue.severity === "blocking") group.blocking++;
    group.issues.push(issue);
    groups.set(issue.category, group);
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.blocking > 0) - Number(a.blocking > 0) ||
      b.blocking - a.blocking ||
      a.category.localeCompare(b.category),
  );
}

/** Issues that stop a connection before it is attempted (AC-UX-03). */
export function connectBlockers(
  issues: readonly CompatibilityIssue[],
): CompatibilityIssue[] {
  return sortIssues(
    issues.filter(
      (issue) =>
        issue.severity === "blocking" &&
        (issue.executionImpact === "blocks-authorization" ||
          issue.executionImpact === "blocks-definition"),
    ),
  );
}
