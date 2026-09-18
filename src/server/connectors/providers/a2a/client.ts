import { z } from "zod";
import { destinationUrl, type ApprovedDestination } from "../../binding.js";
import { ConnectorError, type ConnectorErrorCode } from "../../errors.js";
import {
  A2A_LIMITS,
  A2A_PROFILE_1_0,
  a2aErrorCodes,
  jsonRpcMethods,
  readTask,
  type A2aProfile,
  type A2aTaskView,
} from "./schemas.js";

/*
 * The A2A JSON-RPC client.
 *
 * One destination, one path, one profile. Every request is bounded by a
 * deadline, the caller's abort signal and a response-size ceiling; redirects
 * are refused rather than followed, because a redirect is a destination the
 * binding never approved. Upstream error text is read only to classify it and
 * never attached to a failure: an A2A error message is written by another
 * agent and may carry anything at all.
 *
 * The credential is supplied by a callback the caller opened inside custody;
 * this class never reads configuration, never caches a token and never logs a
 * header.
 */

export type A2aCredential =
  | { kind: "http-bearer"; token: string }
  | { kind: "api-key"; headerName: string; value: string }
  | { kind: "none" };

export type A2aClientOptions = {
  fetch: typeof fetch;
  destination: ApprovedDestination;
  rpcPath: string;
  profile: A2aProfile;
  credential: () => Promise<A2aCredential>;
  signal: AbortSignal;
  now: () => number;
  deadlineMs: number;
  maxResponseBytes: number;
  /** Opaque routing value from the selected interface; sent only when the card declared one. */
  tenant?: string | undefined;
};

const jsonRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string().max(4096).optional(),
});
const jsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: jsonRpcErrorSchema.optional(),
});

/** A2A error numbers mapped to bounded connector failures. */
export function a2aFailure(code: number): ConnectorError {
  const name = a2aErrorCodes[code] ?? "rejected";
  const mapping: Record<string, ConnectorErrorCode> = {
    "task-not-found": "not-found",
    "task-not-cancelable": "conflict",
    "push-notification-not-supported": "unsupported",
    "unsupported-operation": "unsupported",
    "content-type-not-supported": "invalid-request",
    "invalid-agent-response": "upstream-rejected",
    "extended-card-not-configured": "unsupported",
    "extension-support-required": "unsupported",
    "version-not-supported": "unsupported",
    "invalid-params": "invalid-request",
    "invalid-request": "invalid-request",
    "method-not-found": "unsupported",
    parse: "upstream-rejected",
    internal: "upstream-unavailable",
  };
  return new ConnectorError(mapping[name] ?? "upstream-rejected", {
    detail: `a2a.upstream.${name}`,
  });
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ConnectorError("upstream-rejected", {
        detail: "a2a.response.too-large",
      });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export type A2aSendResult =
  | { kind: "task"; task: A2aTaskView }
  /** An agent may answer without creating a task; there is then nothing to poll or cancel. */
  | { kind: "message"; parts: unknown };

export class A2aClient {
  private sequence = 0;
  constructor(private readonly options: A2aClientOptions) {}

  private async headers(): Promise<Headers> {
    const headers = new Headers({
      "content-type": "application/json",
      accept: "application/json",
    });
    const credential = await this.options.credential();
    if (credential.kind === "http-bearer")
      headers.set("authorization", `Bearer ${credential.token}`);
    else if (credential.kind === "api-key")
      headers.set(credential.headerName, credential.value);
    return headers;
  }

  /** One bounded JSON-RPC call against the pinned destination and path. */
  async call(method: string, params: unknown): Promise<unknown> {
    const url = destinationUrl(this.options.destination, this.options.rpcPath);
    const headers = await this.headers();
    const id = `${++this.sequence}`;
    const signal = AbortSignal.any([
      this.options.signal,
      AbortSignal.timeout(
        Math.min(this.options.deadlineMs, A2A_LIMITS.deadlineMs),
      ),
    ]);
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        redirect: "error",
        signal,
      });
    } catch (cause) {
      if (this.options.signal.aborted)
        throw new ConnectorError("cancelled", { cause });
      throw new ConnectorError("upstream-unavailable", {
        detail: "a2a.transport.unreachable",
        cause,
      });
    }
    const bytes = await readBounded(response, this.options.maxResponseBytes);
    if (response.status === 401 || response.status === 403)
      throw new ConnectorError("denied", { detail: "a2a.transport.rejected" });
    if (response.status === 429)
      throw new ConnectorError("rate-limited", {
        detail: "a2a.transport.rate-limited",
      });
    if (response.status >= 500)
      throw new ConnectorError("upstream-unavailable", {
        detail: "a2a.transport.server-error",
      });
    if (response.status !== 200)
      throw new ConnectorError("upstream-rejected", {
        detail: "a2a.transport.status",
      });
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new ConnectorError("upstream-rejected", {
        detail: "a2a.response.malformed",
      });
    }
    const parsed = jsonRpcResponseSchema.safeParse(payload);
    if (!parsed.success)
      throw new ConnectorError("upstream-rejected", {
        detail: "a2a.response.malformed",
      });
    if (parsed.data.error) throw a2aFailure(parsed.data.error.code);
    if (parsed.data.result === undefined)
      throw new ConnectorError("upstream-rejected", {
        detail: "a2a.response.empty",
      });
    return parsed.data.result;
  }

  /** Builds a client message in the profile's own serialization. */
  message(input: {
    messageId: string;
    text: string;
    taskId?: string | undefined;
    contextId?: string | undefined;
  }): Record<string, unknown> {
    const common = {
      messageId: input.messageId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.contextId ? { contextId: input.contextId } : {}),
    };
    return this.options.profile === A2A_PROFILE_1_0
      ? { ...common, role: "ROLE_USER", parts: [{ text: input.text }] }
      : {
          ...common,
          kind: "message",
          role: "user",
          parts: [{ kind: "text", text: input.text }],
        };
  }

  private configuration(input: {
    acceptedOutputModes: string[];
    historyLength: number;
    returnImmediately: boolean;
  }): Record<string, unknown> {
    const shared = {
      acceptedOutputModes: input.acceptedOutputModes,
      historyLength: input.historyLength,
    };
    // 1.0 renamed `blocking` to its inverse, `returnImmediately`. Sending the
    // wrong one would silently change whether the call holds the request open,
    // so each profile sends only its own field.
    return this.options.profile === A2A_PROFILE_1_0
      ? { ...shared, returnImmediately: input.returnImmediately }
      : { ...shared, blocking: !input.returnImmediately };
  }

  async sendMessage(input: {
    messageId: string;
    text: string;
    taskId?: string | undefined;
    contextId?: string | undefined;
    acceptedOutputModes: string[];
    historyLength: number;
    returnImmediately: boolean;
  }): Promise<A2aSendResult> {
    const params: Record<string, unknown> = {
      message: this.message(input),
      configuration: this.configuration(input),
      ...(this.options.tenant ? { tenant: this.options.tenant } : {}),
    };
    const result = await this.call(
      jsonRpcMethods[this.options.profile].send,
      params,
    );
    return this.readSendResult(result);
  }

  readSendResult(result: unknown): A2aSendResult {
    if (!result || typeof result !== "object")
      throw new ConnectorError("upstream-rejected", {
        detail: "a2a.response.malformed",
      });
    const value = result as Record<string, unknown>;
    if (this.options.profile === A2A_PROFILE_1_0) {
      // 1.0 wraps the one-of in a member name.
      if (value.task !== undefined)
        return {
          kind: "task",
          task: readTask(this.options.profile, value.task),
        };
      if (value.message !== undefined)
        return { kind: "message", parts: value.message };
      throw new ConnectorError("upstream-rejected", {
        detail: "a2a.response.unrecognized",
      });
    }
    if (
      value.kind === "task" ||
      (value.status !== undefined && value.id !== undefined)
    )
      return { kind: "task", task: readTask(this.options.profile, value) };
    if (value.kind === "message") return { kind: "message", parts: value };
    throw new ConnectorError("upstream-rejected", {
      detail: "a2a.response.unrecognized",
    });
  }

  async getTask(input: {
    id: string;
    historyLength: number;
  }): Promise<A2aTaskView> {
    const result = await this.call(jsonRpcMethods[this.options.profile].get, {
      id: input.id,
      historyLength: input.historyLength,
      ...(this.options.tenant ? { tenant: this.options.tenant } : {}),
    });
    return readTask(this.options.profile, result);
  }

  async cancelTask(input: { id: string }): Promise<A2aTaskView> {
    const result = await this.call(
      jsonRpcMethods[this.options.profile].cancel,
      {
        id: input.id,
        ...(this.options.tenant ? { tenant: this.options.tenant } : {}),
      },
    );
    return readTask(this.options.profile, result);
  }

  /**
   * Fetches the agent card from the approved destination's well-known path.
   * The path comes from the specification and the origin comes from the
   * binding: a card can never redirect this call to somewhere else.
   */
  async fetchCard(path: string): Promise<Uint8Array> {
    const url = destinationUrl(this.options.destination, path);
    const headers = await this.headers();
    headers.set("accept", "application/json");
    headers.delete("content-type");
    const signal = AbortSignal.any([
      this.options.signal,
      AbortSignal.timeout(
        Math.min(this.options.deadlineMs, A2A_LIMITS.deadlineMs),
      ),
    ]);
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method: "GET",
        headers,
        redirect: "error",
        signal,
      });
    } catch (cause) {
      if (this.options.signal.aborted)
        throw new ConnectorError("cancelled", { cause });
      throw new ConnectorError("upstream-unavailable", {
        detail: "a2a.card.unreachable",
        cause,
      });
    }
    if (response.status === 401 || response.status === 403)
      throw new ConnectorError("denied", { detail: "a2a.card.rejected" });
    if (response.status !== 200)
      throw new ConnectorError("upstream-rejected", {
        detail: "a2a.card.status",
      });
    return readBounded(
      response,
      Math.min(this.options.maxResponseBytes, A2A_LIMITS.cardBytes),
    );
  }
}
