import { startHttpFixture, type RecordedRequest } from "./http-fixture.js";

/*
 * An independent A2A agent, written from the specification rather than from
 * the adapter.
 *
 * It validates what it receives against the wire contract of the profile it
 * was asked to speak — JSON-RPC envelope, method name, parameter shape,
 * message serialization, enum spelling — and records every violation, so a
 * test fails when the adapter sends something the specification does not
 * describe, not merely when the adapter disagrees with itself. It builds its
 * responses from its own task state machine.
 *
 * Profiles (both retrieved 2026-09-18):
 *  - "1.0": https://a2a-protocol.org/latest/specification/   (A2A 1.0.0)
 *  - "0.3": https://a2a-protocol.org/v0.3.0/specification/   (A2A 0.3.0)
 */

export type A2aDoubleProfile = "1.0" | "0.3";

export type SkillScript =
  | "complete"
  | "input-required"
  | "auth-required"
  | "reject"
  | "artifact-url"
  | "artifact-bytes"
  | "message-only";

export type A2aDoubleOptions = {
  profile: A2aDoubleProfile;
  /** Value the agent requires in Authorization, e.g. "Bearer agent-token". */
  authorization?: string;
  apiKeyHeader?: { name: string; value: string };
  rpcPath?: string;
  agentName?: string;
  agentVersion?: string;
  skills?: Array<{ id: string; name: string; description?: string; tags?: string[] }>;
  /** What each skill does when a task is started for it. */
  script?: Record<string, SkillScript>;
  /** Absolute URL the "artifact-url" script points at; defaults to a private address. */
  artifactUrl?: string;
  securitySchemes?: Record<string, unknown>;
  /** Extra fields merged into the served card; used to build hostile cards. */
  cardOverrides?: Record<string, unknown>;
};

type TaskRecord = {
  id: string;
  contextId: string;
  skill: string;
  state: string;
  turns: number;
  script: SkillScript;
};

export type A2aDouble = Awaited<ReturnType<typeof startA2aAgentDouble>>;

const STATES_10 = {
  submitted: "TASK_STATE_SUBMITTED",
  working: "TASK_STATE_WORKING",
  "input-required": "TASK_STATE_INPUT_REQUIRED",
  "auth-required": "TASK_STATE_AUTH_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  failed: "TASK_STATE_FAILED",
  canceled: "TASK_STATE_CANCELED",
  rejected: "TASK_STATE_REJECTED",
} as const;

const METHODS = {
  "1.0": { send: "SendMessage", get: "GetTask", cancel: "CancelTask" },
  "0.3": { send: "message/send", get: "tasks/get", cancel: "tasks/cancel" },
} as const;

export async function startA2aAgentDouble(options: A2aDoubleOptions) {
  const profile = options.profile;
  const rpcPath = options.rpcPath ?? "/a2a/v1";
  const agentName = options.agentName ?? "Fixture Agent";
  const agentVersion = options.agentVersion ?? "2.3.1";
  const skills = options.skills ?? [
    { id: "summarize", name: "Summarize", description: "Summarizes a document." },
  ];
  const script = options.script ?? {};
  const violations: string[] = [];
  const tasks = new Map<string, TaskRecord>();
  const cardRequests: RecordedRequest[] = [];
  const rpcCalls: Array<{ method: string; params: unknown }> = [];
  let counter = 0;
  let origin = "";

  const note = (message: string) => violations.push(message);

  const state = (name: string) =>
    profile === "1.0" ? STATES_10[name as keyof typeof STATES_10] : name;

  const textPart = (text: string) =>
    profile === "1.0" ? { text } : { kind: "text", text };

  const filePart = (url: string) =>
    profile === "1.0"
      ? { url, mediaType: "application/pdf", filename: "report.pdf" }
      : {
          kind: "file",
          file: { uri: url, mimeType: "application/pdf", name: "report.pdf" },
        };

  const bytesPart = () =>
    profile === "1.0"
      ? { raw: "aGVsbG8=", mediaType: "text/plain", filename: "note.txt" }
      : {
          kind: "file",
          file: { bytes: "aGVsbG8=", mimeType: "text/plain", name: "note.txt" },
        };

  function card(): Record<string, unknown> {
    const common = {
      name: agentName,
      description: "A fixture agent used by the Ceremony A2A protocol tests.",
      version: agentVersion,
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description ?? skill.name,
        tags: skill.tags ?? ["fixture"],
      })),
      ...(options.securitySchemes
        ? { securitySchemes: options.securitySchemes }
        : {
            securitySchemes: {
              bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
            },
          }),
    };
    const shaped =
      profile === "1.0"
        ? {
            ...common,
            supportedInterfaces: [
              {
                url: `${origin}${rpcPath}`,
                protocolBinding: "JSONRPC",
                protocolVersion: "1.0",
              },
            ],
            securityRequirements: [{ bearer: [] }],
          }
        : {
            ...common,
            protocolVersion: "0.3",
            url: `${origin}${rpcPath}`,
            preferredTransport: "JSONRPC",
            security: [{ bearer: [] }],
          };
    return { ...shaped, ...(options.cardOverrides ?? {}) };
  }

  function authorized(request: RecordedRequest): boolean {
    if (options.apiKeyHeader)
      return (
        request.headers[options.apiKeyHeader.name.toLowerCase()] ===
        options.apiKeyHeader.value
      );
    if (!options.authorization) return true;
    return request.headers.authorization === options.authorization;
  }

  function taskBody(record: TaskRecord): Record<string, unknown> {
    const artifacts: unknown[] = [];
    if (record.state === "completed") {
      if (record.script === "artifact-url")
        artifacts.push({
          artifactId: `${record.id}-a1`,
          name: "Report",
          parts: [
            filePart(
              options.artifactUrl ?? "http://169.254.169.254/latest/meta-data/",
            ),
          ],
        });
      else if (record.script === "artifact-bytes")
        artifacts.push({
          artifactId: `${record.id}-a1`,
          name: "Note",
          parts: [bytesPart()],
        });
      else
        artifacts.push({
          artifactId: `${record.id}-a1`,
          name: "Summary",
          parts: [textPart("The document says three things.")],
        });
    }
    const status: Record<string, unknown> = { state: state(record.state) };
    if (record.state === "input-required")
      status.message = {
        ...(profile === "0.3" ? { kind: "message" } : {}),
        messageId: `${record.id}-ask`,
        role: profile === "1.0" ? "ROLE_AGENT" : "agent",
        parts: [textPart("Which section should I summarize?")],
      };
    if (record.state === "auth-required")
      status.message = {
        ...(profile === "0.3" ? { kind: "message" } : {}),
        messageId: `${record.id}-auth`,
        role: profile === "1.0" ? "ROLE_AGENT" : "agent",
        parts: [textPart("Authorize access to the document store to continue.")],
      };
    return {
      ...(profile === "0.3" ? { kind: "task" } : {}),
      id: record.id,
      contextId: record.contextId,
      status,
      ...(artifacts.length ? { artifacts } : {}),
    };
  }

  /** Checks a client message against the profile's serialization rules. */
  function checkMessage(message: unknown): { text: string; taskId?: string } {
    if (!message || typeof message !== "object") {
      note("message is not an object");
      return { text: "" };
    }
    const value = message as Record<string, unknown>;
    const expectedRole = profile === "1.0" ? "ROLE_USER" : "user";
    if (value.role !== expectedRole)
      note(`message.role must be ${expectedRole}, received ${String(value.role)}`);
    if (typeof value.messageId !== "string" || !value.messageId)
      note("message.messageId is required");
    if (profile === "1.0" && "kind" in value)
      note("A2A 1.0 removed the kind discriminator from messages");
    if (profile === "0.3" && value.kind !== "message")
      note("A2A 0.3 messages carry kind: 'message'");
    const parts = Array.isArray(value.parts) ? value.parts : [];
    if (!parts.length) note("message.parts must contain at least one part");
    let text = "";
    for (const part of parts) {
      const item = (part ?? {}) as Record<string, unknown>;
      if (profile === "1.0") {
        if ("kind" in item) note("A2A 1.0 parts carry no kind discriminator");
        if (typeof item.text === "string") text += item.text;
        else note("unrecognized 1.0 part");
      } else {
        if (item.kind !== "text") note("A2A 0.3 text parts carry kind: 'text'");
        else if (typeof item.text === "string") text += item.text;
      }
    }
    return {
      text,
      ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
    };
  }

  function checkConfiguration(configuration: unknown): void {
    if (configuration === undefined) return;
    if (!configuration || typeof configuration !== "object") {
      note("configuration must be an object");
      return;
    }
    const value = configuration as Record<string, unknown>;
    if (profile === "1.0") {
      if ("blocking" in value)
        note("A2A 1.0 replaced blocking with returnImmediately");
      if ("returnImmediately" in value && typeof value.returnImmediately !== "boolean")
        note("returnImmediately must be a boolean");
    } else {
      if ("returnImmediately" in value)
        note("A2A 0.3 uses blocking, not returnImmediately");
      if ("blocking" in value && typeof value.blocking !== "boolean")
        note("blocking must be a boolean");
    }
    if (
      value.acceptedOutputModes !== undefined &&
      !Array.isArray(value.acceptedOutputModes)
    )
      note("acceptedOutputModes must be an array");
  }

  const rpcError = (id: unknown, code: number, message: string) => ({
    status: 200,
    body: { jsonrpc: "2.0", id, error: { code, message } },
  });
  const rpcResult = (id: unknown, result: unknown) => ({
    status: 200,
    body: { jsonrpc: "2.0", id, result },
  });

  const fixture = await startHttpFixture((request) => {
    if (request.method === "GET" && request.url.pathname === "/.well-known/agent-card.json") {
      cardRequests.push(request);
      return { status: 200, body: card() };
    }
    if (request.method !== "POST" || request.url.pathname !== rpcPath)
      return { status: 404, body: { error: "not_found" } };
    if (!authorized(request))
      return { status: 401, body: { error: "unauthorized" } };
    if (!/application\/json/i.test(request.headers["content-type"] ?? ""))
      note("JSON-RPC requests declare content-type application/json");
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(request.body.toString("utf8")) as Record<string, unknown>;
    } catch {
      return rpcError(null, -32700, "Invalid JSON payload");
    }
    if (envelope.jsonrpc !== "2.0") note("jsonrpc must be '2.0'");
    if (envelope.id === undefined || envelope.id === null)
      note("a JSON-RPC request carries an id");
    const method = String(envelope.method ?? "");
    const params = (envelope.params ?? {}) as Record<string, unknown>;
    rpcCalls.push({ method, params });
    const expected = METHODS[profile];
    if (!Object.values(expected).includes(method as never))
      return rpcError(envelope.id, -32601, "Method not found");

    if (method === expected.send) {
      const message = checkMessage(params.message);
      checkConfiguration(params.configuration);
      if (message.taskId) {
        const existing = tasks.get(message.taskId);
        if (!existing) return rpcError(envelope.id, -32001, "Task not found");
        if (["completed", "failed", "canceled", "rejected"].includes(existing.state))
          return rpcError(envelope.id, -32004, "This operation is not supported");
        existing.turns++;
        existing.state = "completed";
        return rpcResult(
          envelope.id,
          profile === "1.0" ? { task: taskBody(existing) } : taskBody(existing),
        );
      }
      const skill = skills[0]?.id ?? "unknown";
      const chosen = script[skill] ?? "complete";
      if (chosen === "message-only") {
        const body = {
          ...(profile === "0.3" ? { kind: "message" } : {}),
          messageId: `m-${++counter}`,
          role: profile === "1.0" ? "ROLE_AGENT" : "agent",
          parts: [textPart("No task was needed.")],
        };
        return rpcResult(
          envelope.id,
          profile === "1.0" ? { message: body } : body,
        );
      }
      const record: TaskRecord = {
        id: `task-${++counter}`,
        contextId: `context-${counter}`,
        skill,
        state:
          chosen === "input-required"
            ? "input-required"
            : chosen === "auth-required"
              ? "auth-required"
              : chosen === "reject"
                ? "rejected"
                : "completed",
        turns: 1,
        script: chosen,
      };
      tasks.set(record.id, record);
      return rpcResult(
        envelope.id,
        profile === "1.0" ? { task: taskBody(record) } : taskBody(record),
      );
    }

    if (method === expected.get) {
      if (typeof params.id !== "string") return rpcError(envelope.id, -32602, "Invalid parameters");
      const record = tasks.get(params.id);
      if (!record) return rpcError(envelope.id, -32001, "Task not found");
      return rpcResult(envelope.id, taskBody(record));
    }

    if (method === expected.cancel) {
      if (typeof params.id !== "string") return rpcError(envelope.id, -32602, "Invalid parameters");
      const record = tasks.get(params.id);
      if (!record) return rpcError(envelope.id, -32001, "Task not found");
      if (["completed", "failed", "canceled", "rejected"].includes(record.state))
        return rpcError(envelope.id, -32002, "Task cannot be canceled");
      record.state = "canceled";
      return rpcResult(envelope.id, taskBody(record));
    }
    return rpcError(envelope.id, -32601, "Method not found");
  });
  origin = fixture.origin;

  return {
    origin: fixture.origin,
    rpcPath,
    agentName,
    agentVersion,
    profile,
    /** Wire-contract violations this agent observed; a passing test has none. */
    violations,
    rpcCalls,
    cardRequests,
    requests: fixture.requests,
    cardDocument: () => card(),
    cardBytes: () => new TextEncoder().encode(JSON.stringify(card())),
    task: (id: string) => tasks.get(id),
    tasks: () => [...tasks.values()],
    close: () => fixture.close(),
  };
}
