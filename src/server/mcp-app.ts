import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import {
  getUiCapability,
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { CeremonyController } from "./controller.js";
import { CeremonyDatabase } from "./storage.js";

const grantSchema = z.object({
  owner: z.string(),
  instanceId: z.string(),
  revision: z.number(),
  expiresAt: z.number(),
});
export interface PrivateCollectorOptions {
  brokerOrigin: string;
  appOrigin: string;
  /** HTML containing the host-bundled mountPrivateCollector entry point. Never model-generated HTML. */
  appHtml: string;
  /** Must derive from host authentication, not tool arguments or UI visibility. */
  owner(context: ServerContext): string | Promise<string>;
  /** Authenticate the broker HTTP recipient independently of the one-use handle. Missing adapters fail closed. */
  requestOwner?(request: Request): string | null | Promise<string | null>;
}
/** Register on an authenticated MCP server; mount handleRequest on the broker HTTPS origin. */
export function registerPrivateCollector(
  server: McpServer,
  controller: CeremonyController,
  db: CeremonyDatabase,
  options: PrivateCollectorOptions,
) {
  const brokerOrigin = new URL(options.brokerOrigin).origin;
  const appOrigin = new URL(options.appOrigin).origin;
  if (
    ![brokerOrigin, appOrigin].every((origin) => origin.startsWith("https://"))
  )
    throw new Error("Private MCP collection requires stable HTTPS origins");
  const uri = "ui://ceremony/private-collector.html";
  const endpoint = `${brokerOrigin}/ceremony/private-collection`;
  registerAppResource(
    server,
    "Private credential collector",
    uri,
    {},
    async () => ({
      contents: [
        {
          uri,
          mimeType: RESOURCE_MIME_TYPE,
          text: options.appHtml,
          _meta: {
            ui: { domain: appOrigin, csp: { connectDomains: [brokerOrigin] } },
          },
        },
      ],
    }),
  );
  registerAppTool(
    server,
    "ceremony_collect_private",
    {
      description:
        "Ask the human to supply required credentials privately. Never put credentials in tool arguments or chat.",
      inputSchema: z.object({ instanceId: z.uuid() }).strict(),
      _meta: { ui: { resourceUri: uri } },
    },
    async ({ instanceId }, context) => {
      try {
        const owner = await options.owner(context);
        if (
          !owner ||
          !options.requestOwner ||
          !getUiCapability(
            server.server.getClientCapabilities(),
          )?.mimeTypes?.includes(RESOURCE_MIME_TYPE)
        )
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Private MCP Apps collection is unavailable. Continue in the authenticated ceremony webpage; never send credentials in chat.",
              },
            ],
          };
        const snapshot = await controller.read(owner, instanceId);
        if (!snapshot.actions.includes("submit"))
          throw new Error("No collection pending");
        const handle = randomUUID();
        db.put(`mcp-collection:${handle}`, {
          owner,
          instanceId,
          revision: snapshot.revision,
          expiresAt: Date.now() + 300_000,
        });
        return {
          content: [
            { type: "text", text: "Waiting for private input from the human." },
          ],
          _meta: {
            collection: {
              handle,
              endpoint,
              instanceId,
              revision: snapshot.revision,
              fields: snapshot.fields,
            },
          },
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Private collection could not start. Refresh the ceremony.",
            },
          ],
        };
      }
    },
  );
  registerAppTool(
    server,
    "ceremony_bind_private",
    {
      description:
        "Bind a one-use credential reference; this tool never accepts raw credentials.",
      inputSchema: z
        .object({
          instanceId: z.uuid(),
          revision: z.number().int().nonnegative(),
          secretRef: z.uuid(),
        })
        .strict(),
      _meta: { ui: { resourceUri: uri, visibility: ["app"] } },
    },
    async ({ instanceId, revision, secretRef }, context) => {
      try {
        const owner = await options.owner(context);
        if (!owner) throw new Error("Authentication required");
        const snapshot = await controller.act(owner, instanceId, {
          action: "submit",
          revision,
          secretRef,
        });
        return {
          content: [
            {
              type: "text",
              text:
                snapshot.step === "error"
                  ? "Credential verification failed."
                  : "Private input submitted; check ceremony status.",
            },
          ],
          isError: snapshot.step === "error",
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "The reference is invalid, expired or stale. Refresh private collection.",
            },
          ],
        };
      }
    },
  );
  return {
    async handleRequest(request: Request): Promise<Response | undefined> {
      if (new URL(request.url).href !== endpoint) return undefined;
      const origin = request.headers.get("origin");
      if (origin !== appOrigin)
        return new Response("Forbidden", { status: 403 });
      const headers = {
        "access-control-allow-origin": appOrigin,
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "content-type,x-ceremony-collection",
        "cache-control": "no-store",
        vary: "Origin",
        "content-type": "application/json",
      };
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers });
      if (
        request.method !== "POST" ||
        request.headers.get("content-type")?.split(";")[0]?.trim() !==
          "application/json"
      )
        return new Response("{}", { status: 405, headers });
      let recipient: string | null;
      try {
        recipient = (await options.requestOwner?.(request)) ?? null;
      } catch {
        return new Response("{}", { status: 403, headers });
      }
      if (typeof recipient !== "string" || !recipient)
        return new Response("{}", { status: 403, headers });
      try {
        const handle = z
          .uuid()
          .parse(request.headers.get("x-ceremony-collection"));
        const issued = db.get(`mcp-collection:${handle}`, grantSchema);
        if (
          !issued ||
          issued.owner !== recipient ||
          issued.expiresAt <= Date.now()
        )
          return new Response("{}", { status: 403, headers });
        // Bound the stream before JSON parsing; content-length is not trusted.
        const reader = request.body?.getReader();
        if (!reader) throw new Error("Missing body");
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > 64_000) {
              await reader.cancel();
              throw new Error("Oversize input");
            }
            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
        const values = z
          .record(z.string(), z.string().max(4096))
          .parse(JSON.parse(Buffer.concat(chunks).toString()));
        const secretRef = db.transaction(() => {
          const grant = db.get(`mcp-collection:${handle}`, grantSchema);
          if (
            !grant ||
            grant.owner !== recipient ||
            grant.expiresAt <= Date.now()
          )
            throw new Error("Expired collection");
          const ref = controller.collect(
            grant.owner,
            grant.instanceId,
            grant.revision,
            values,
          );
          db.delete(`mcp-collection:${handle}`);
          return ref;
        });
        return new Response(JSON.stringify({ secretRef }), { headers });
      } catch {
        return new Response(
          '{"error":"Private collection failed. Start a new collection."}',
          { status: 400, headers },
        );
      }
    },
  };
}
