import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createHttpInbox,
  verificationFromMessage,
  type ProgrammableInbox,
} from "../../src/server/authored-inbox.js";
import type { ProviderDouble } from "../../tests/doubles/auth-provider/server.js";

/**
 * The agent inbox for a demo, served over HTTP in the shape Ceremony's
 * production adapter speaks.
 *
 * There is no SMTP here. The self-hosted test provider "sends" mail by writing
 * to its own outbox; this service exposes that outbox through the catch-all
 * inbox contract `createHttpInbox` consumes (`POST /addresses`,
 * `GET /messages?to&since`). The agent therefore provisions an address and
 * reads its verification mail through the same adapter and the same
 * `verificationFromMessage` extraction a real deployment uses — only the mail
 * transport is substituted, and the demo says so on screen.
 *
 * Every code and link this service hands out is reported through `protect`,
 * so the recorder can prove none of them reached a caption or a card.
 */
export type AgentInbox = {
  inbox: ProgrammableInbox;
  /** Poll the inbox for the newest verification code sent to `address`. */
  readCode(address: string, since: number): Promise<string | undefined>;
  close(): Promise<void>;
};

export async function startAgentInbox(
  provider: ProviderDouble,
  protect: (value: string) => void,
): Promise<AgentInbox> {
  const issued = new Set<string>();
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://inbox.invalid");
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "POST" && url.pathname === "/addresses") {
      const address = `agent-${randomBytes(4).toString("hex")}@inbox.ceremony.test`;
      issued.add(address);
      return reply(200, { address });
    }
    if (request.method === "GET" && url.pathname === "/messages") {
      const to = url.searchParams.get("to") ?? "";
      const since = Number(url.searchParams.get("since") ?? 0);
      // An inbox only holds mail for the addresses it issued.
      if (!issued.has(to)) return reply(200, { messages: [] });
      const messages = provider.mailbox
        .messages()
        .filter((message) => message.to === to && message.at >= since)
        .map((message) => {
          protect(message.code);
          protect(message.link);
          return {
            to: message.to,
            subject: message.subject,
            text: `Your confirmation code is ${message.code}.\n\nOr confirm at ${message.link}`,
            at: message.at,
          };
        });
      return reply(200, { messages });
    }
    reply(404, {});
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  const inbox = createHttpInbox({ baseUrl: `http://127.0.0.1:${port}` });
  return {
    inbox,
    async readCode(address, since) {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const message = await inbox.latest(address, since);
        const code = message ? verificationFromMessage(message)?.code : "";
        if (code) return code;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return undefined;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
