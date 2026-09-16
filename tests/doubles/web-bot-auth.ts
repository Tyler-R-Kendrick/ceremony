import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import type { SignatureKey } from "../../src/core/web-bot-auth.js";

/**
 * Test-only helpers around the shipped Web Bot Auth module.
 *
 * Signing and verification live in `src/core/web-bot-auth.ts`, because they are
 * the product: an agent that can prove which bot it is without an account is
 * the whole point. What stays here is the scaffolding a test needs and a
 * product never should — a throwaway directory server, and a key the directory
 * deliberately does not publish.
 */
export * from "../../src/core/web-bot-auth.js";

/**
 * The agent's published key directory. A real one belongs to whoever operates
 * the bot, not to the site being visited, so it is a separate origin here too.
 */
export async function startSignatureDirectory(
  keys: readonly SignatureKey[],
  options: { status?: number } = {},
): Promise<{ origin: string; reads(): number; close(): Promise<void> }> {
  let reads = 0;
  const server: Server = createServer((request, response) => {
    if (
      request.url !== "/.well-known/http-message-signatures-directory" ||
      request.method !== "GET"
    ) {
      response.writeHead(404).end();
      return;
    }
    reads += 1;
    response.writeHead(options.status ?? 200, {
      "content-type": "application/http-message-signatures-directory+json",
    });
    response.end(JSON.stringify({ keys: keys.map((key) => key.jwk) }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  let shut = false;
  return {
    origin: `http://127.0.0.1:${port}`,
    reads: () => reads,
    close: async () => {
      if (shut) return;
      shut = true;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** Present only so a caller can sign with a key the directory never lists. */
export function unpublishedKey(): KeyObject {
  return generateKeyPairSync("ed25519").privateKey;
}
