import {
  browserModelContext,
  type CeremonyModelContext,
  type CeremonyTool,
} from "../../../core/webmcp.js";
import { agentIntentInputs, type AgentIntentName } from "./intents.js";

/*
 * AG-04: connector capabilities on the browser's native WebMCP surface.
 *
 * Three things this file is careful about.
 *
 * Feature detection is the existing one. `browserModelContext()` already
 * looks for `document.modelContext` and falls back to the older
 * `navigator.modelContext`; this module calls it rather than repeating it, so
 * the two surfaces cannot drift apart. When neither exists the answer is
 * "unavailable" and nothing is installed: no shim on `document`, no stub on
 * `navigator`, no queue pretending to be a model context. The application's
 * ordinary controls are the whole experience in that browser, and they were
 * never the fallback — they are the product.
 *
 * Tool ownership is explicit. A mount registers exactly the names it declared,
 * remembers them, and unmounts by aborting its own AbortSignal, which is how
 * the specification says a page withdraws a tool. It never touches a name it
 * did not register, and a second mount of the same prefix while the first is
 * live is refused rather than allowed to shadow it.
 *
 * Authority is the server's. A WebMCP tool here is a thin call into the same
 * authenticated dispatcher the application's own buttons use. Nothing in a
 * tool description, an annotation, an input schema or an agent's message
 * decides what may happen: `readOnlyHint` is a hint to the caller, not a
 * permission, and the dispatcher neither reads it nor forwards it.
 *
 * Nothing here asks for cross-origin exposure. The draft lets a page share
 * tools with other origins in its tree through `exposedTo`; this module never
 * passes it, so a mount cannot be read as a claim to drive an iframe.
 *
 * WebMCP source: Draft Community Group Report, 17 September 2026,
 * https://webmachinelearning.github.io/webmcp/ (retrieved 2026-09-18).
 */

export type WebmcpApi = "document" | "navigator";

export type WebmcpAvailability =
  | { available: true; api: WebmcpApi; context: CeremonyModelContext }
  | { available: false; reason: "no-native-model-context" };

/**
 * Whether this browser exposes a native model context, and which spelling of
 * it. The check never creates one: an absent API stays absent.
 */
export function detectConnectorWebmcp(): WebmcpAvailability {
  const context = browserModelContext();
  if (!context) return { available: false, reason: "no-native-model-context" };
  const fromDocument =
    typeof document !== "undefined" &&
    (document as Document & { modelContext?: CeremonyModelContext })
      .modelContext === context;
  return {
    available: true,
    api: fromDocument ? "document" : "navigator",
    context,
  };
}

export type ConnectorDispatchRequest = {
  intent: AgentIntentName;
  input: Record<string, unknown>;
  signal: AbortSignal;
};

/**
 * The authenticated dispatcher. In the application this performs the same
 * authenticated request the drawer's own controls perform; it is passed in so
 * that this module holds no transport, no origin and no credential.
 */
export type ConnectorDispatch = (
  request: ConnectorDispatchRequest,
) => Promise<unknown>;

type JsonSchema = Record<string, unknown>;

const stringProperty = (description?: string): JsonSchema => ({
  type: "string",
  minLength: 1,
  maxLength: 200,
  ...(description ? { description } : {}),
});

/**
 * Hand-written JSON Schemas, one per intent, matching the Zod shapes the
 * server validates against. They are written out rather than generated so
 * that a change to either one is visible in review; the server's Zod schema
 * remains the only thing that decides whether an argument is acceptable.
 */
const intentSchemas: Readonly<Record<AgentIntentName, JsonSchema>> =
  Object.freeze({
    list: { type: "object", additionalProperties: false, properties: {}, required: [] },
    inspect: {
      type: "object",
      additionalProperties: false,
      properties: { definitionRef: stringProperty("An imported connector description.") },
      required: ["definitionRef"],
    },
    status: {
      type: "object",
      additionalProperties: false,
      properties: { connectionRef: stringProperty("One of this person's connections.") },
      required: ["connectionRef"],
    },
    connect: {
      type: "object",
      additionalProperties: false,
      properties: {
        bindingRef: stringProperty("An approved binding from the connector catalog."),
        accountSwitch: {
          type: "boolean",
          description:
            "Only when a person has said they want to change the connected account.",
        },
        interruption: { type: "string", enum: ["allowed", "none"] },
      },
      required: ["bindingRef"],
    },
    operations: {
      type: "object",
      additionalProperties: false,
      properties: { connectionRef: stringProperty() },
      required: ["connectionRef"],
    },
    reconnect: {
      type: "object",
      additionalProperties: false,
      properties: {
        connectionRef: stringProperty(),
        expectedRevision: { type: "integer", minimum: 1 },
        accountSwitch: { type: "boolean" },
        interruption: { type: "string", enum: ["allowed", "none"] },
      },
      required: ["connectionRef", "expectedRevision"],
    },
    disconnect: {
      type: "object",
      additionalProperties: false,
      properties: {
        connectionRef: stringProperty(),
        expectedRevision: { type: "integer", minimum: 1 },
      },
      required: ["connectionRef", "expectedRevision"],
    },
  });

const readOnlyIntents = new Set<AgentIntentName>([
  "list",
  "inspect",
  "status",
  "operations",
]);

const intentDescriptions: Readonly<Record<AgentIntentName, string>> =
  Object.freeze({
    list: "List this person's connections and whether each one is usable. Returns no credentials, links or account names.",
    inspect:
      "Describe one imported connector: identity, declared credential kinds, advertised capabilities and what is blocked.",
    status:
      "Read one connection's state, including whether a person is being waited on.",
    connect:
      "Start connecting with one approved binding. If a person must take part, the application shows them where to go; this returns no link and no code.",
    operations:
      "List the operations the host approved for one connection, with their effect, cost and consent policy.",
    reconnect:
      "Re-establish an expired or broken connection. Changing account needs a person to say so.",
    disconnect:
      "Disconnect locally. Nothing upstream is deleted and no granted access is revoked.",
  });

export type ConnectorWebmcpOptions = {
  prefix?: string;
  /** Intents to expose; the default is all of them. */
  intents?: readonly AgentIntentName[];
};

const failure = Object.freeze({
  ok: false as const,
  error:
    "That connector action could not run. Read the connection state before retrying.",
});

/**
 * Builds the tool definitions. They have the same shape as the ceremony tools
 * the browser already registers, so one registration path serves both.
 */
export function createConnectorWebmcpTools(
  dispatch: ConnectorDispatch,
  options: ConnectorWebmcpOptions = {},
): CeremonyTool[] {
  const prefix = options.prefix ?? "ceremony_connector";
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(prefix))
    throw new Error("Invalid WebMCP tool prefix");
  const intents =
    options.intents ?? (Object.keys(intentSchemas) as AgentIntentName[]);
  return intents.map((intent): CeremonyTool => {
    const readOnly = readOnlyIntents.has(intent);
    return {
      name: `${prefix}_${intent}`,
      description: intentDescriptions[intent],
      inputSchema: intentSchemas[intent],
      annotations: {
        // Hints, and only hints. The server re-decides every one of these.
        readOnlyHint: readOnly,
        consequentialHint: !readOnly,
        untrustedContentHint: true,
      },
      execute: async (input, executeOptions) => {
        const signal = executeOptions?.signal ?? new AbortController().signal;
        try {
          if (
            input !== undefined &&
            (typeof input !== "object" ||
              input === null ||
              Array.isArray(input) ||
              Object.hasOwn(input, "intent") ||
              Object.hasOwn(input, "actor") ||
              Object.hasOwn(input, "tenantId") ||
              Object.hasOwn(input, "subjectId"))
          )
            throw new Error("Invalid input");
          // Parsed here so a malformed call fails in the page rather than
          // travelling; the server parses it again and is the authority.
          const parsed = agentIntentInputs[intent].parse(
            input ?? {},
          ) as Record<string, unknown>;
          const result = await dispatch({ intent, input: parsed, signal });
          return { ok: true, ...(result as object) };
        } catch {
          // Never reflect a server message, a provider message or an
          // exception string back to a model.
          return { ...failure };
        }
      },
    };
  });
}

/** Names this module currently owns in the page; a second mount cannot shadow them. */
const ownedNames = new Set<string>();

export type ConnectorWebmcpMount = {
  available: boolean;
  api?: WebmcpApi;
  /** Exactly the tool names this mount registered. */
  registered: string[];
  /** Deliberately never requested: this page makes no claim to drive another origin. */
  crossOriginExposure: "not-requested";
  owns(name: string): boolean;
  unmount(): void;
};

/**
 * Registers the connector tools on the native model context, if the browser
 * has one. Returns an unmount that withdraws exactly these tools by aborting
 * the signal they were registered with, which is how the draft says a page
 * takes a tool back.
 */
export async function mountConnectorWebmcpTools(
  tools: readonly CeremonyTool[],
  options: {
    signal?: AbortSignal;
    availability?: WebmcpAvailability;
  } = {},
): Promise<ConnectorWebmcpMount> {
  const availability = options.availability ?? detectConnectorWebmcp();
  const names = tools.map((tool) => tool.name);
  if (new Set(names).size !== names.length)
    throw new Error("Duplicate WebMCP tool name");
  const idle: ConnectorWebmcpMount = {
    available: false,
    registered: [],
    crossOriginExposure: "not-requested",
    owns: () => false,
    unmount: () => {},
  };
  if (!availability.available) return idle;
  for (const name of names)
    if (ownedNames.has(name)) throw new Error("WebMCP tool already mounted");
  const controller = new AbortController();
  const outer = options.signal;
  if (outer?.aborted) return idle;
  const forward = () => controller.abort();
  outer?.addEventListener("abort", forward, { once: true });
  const registered: string[] = [];
  const release = () => {
    for (const name of registered) ownedNames.delete(name);
    registered.length = 0;
  };
  controller.signal.addEventListener("abort", release, { once: true });
  for (const tool of tools) {
    if (controller.signal.aborted) break;
    ownedNames.add(tool.name);
    try {
      // Only `signal`. No `exposedTo`: cross-origin exposure is not requested.
      await availability.context.registerTool(tool, {
        signal: controller.signal,
      });
      registered.push(tool.name);
    } catch (error) {
      ownedNames.delete(tool.name);
      controller.abort();
      outer?.removeEventListener("abort", forward);
      throw error;
    }
  }
  return {
    available: true,
    api: availability.api,
    registered: [...registered],
    crossOriginExposure: "not-requested",
    owns: (name) => registered.includes(name),
    unmount: () => {
      outer?.removeEventListener("abort", forward);
      controller.abort();
    },
  };
}

/** Test and diagnostic helper: the names this module believes it owns. */
export function ownedConnectorToolNames(): string[] {
  return [...ownedNames];
}
