import type { AdapterCallContext } from "../../adapter.js";

/*
 * The seam to the MCP client. Smithery's managed connection is an external
 * execution broker: the credential stays inside Smithery and Ceremony speaks
 * MCP to the namespace endpoint with a short-lived scoped token. The client
 * itself belongs to the MCP swarm (`src/server/connectors/mcp/client.ts`);
 * this port is the narrow structural view this adapter depends on, so the two
 * can be wired together without either owning the other. The destination is
 * always supplied by the caller here — it comes from the runtime binding, and
 * never from a tool argument, a catalog field or a broker response.
 */

export type McpBearer = {
  /** Runs `work` with the token; the value exists only inside the callback. */
  use<T>(work: (token: string) => Promise<T>): Promise<T>;
};

export type McpToolOutcome =
  | {
      kind: "complete";
      payload: { content: unknown[]; structuredContent?: unknown; isError: boolean };
    }
  | { kind: "input-required" }
  | { kind: "authorization-required" }
  | { kind: "failed"; code: string; applied: "no" | "unknown" }
  | { kind: "indeterminate"; code: string };

export interface McpClientPort {
  callTool(request: {
    name: string;
    arguments: Record<string, unknown>;
    effect: "read" | "write" | "unknown";
    signal?: AbortSignal;
  }): Promise<McpToolOutcome>;
  close?(): void;
}

export type McpClientFactory = (options: {
  /** Exact endpoint from the binding: origin and path, nothing caller-supplied. */
  endpoint: URL;
  bearer: McpBearer;
  fetch: typeof fetch;
  ctx: AdapterCallContext;
}) => McpClientPort;
