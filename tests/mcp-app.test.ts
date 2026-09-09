import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  CeremonyController,
  CeremonyDatabase,
  PrivateCredentialBroker,
  registerPrivateCollector,
  type AuthAdapter,
} from "../src/server/index.js";
import { manifests } from "../examples/manifests.js";

test("MCP Apps exchanges only references; private HTTP enforces origin and one-use grants", async () => {
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  let verified = false;
  const adapter: AuthAdapter = {
    begin: async () => ({ step: "input" }),
    callback: async () => ({ step: "error" }),
    poll: async () => undefined,
    cancel() {},
    submit: async (values) => {
      verified = values.token === "sentinel-mcp-secret";
      return { step: verified ? "complete" : "error" };
    },
  };
  const controller = new CeremonyController(
    [
      {
        manifest: manifests[0]!,
        recoverable: true,
        createAdapter: () => adapter,
      },
    ],
    new Map(),
    Date.now,
    { database: db, broker: new PrivateCredentialBroker(db) },
  );
  const snapshot = controller.start("alice", "github", "api-key");
  const server = new McpServer({ name: "test-collector", version: "1" });
  const collector = registerPrivateCollector(server, controller, db, {
    brokerOrigin: "https://broker.example",
    appOrigin: "https://app.example",
    appHtml: "<!doctype html><title>Trusted test resource</title>",
    owner: () => "alice",
  });
  const client = new Client(
    { name: "test-host", version: "1" },
    {
      capabilities: {
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      },
    },
  );
  const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
  const messages: string[] = [];
  for (const wire of [clientWire, serverWire]) {
    const send = wire.send.bind(wire);
    wire.send = async (message, options) => {
      messages.push(JSON.stringify(message));
      return send(message, options);
    };
  }
  await server.connect(serverWire);
  await client.connect(clientWire);
  const tools = await client.listTools();
  assert.ok(!JSON.stringify(tools).includes('"values"'));
  const result = await client.callTool({
    name: "ceremony_collect_private",
    arguments: { instanceId: snapshot.id },
  });
  const {
    _meta: { collection },
  } = z
    .object({
      _meta: z.object({
        collection: z.object({ handle: z.string(), endpoint: z.string() }),
      }),
    })
    .parse(result);
  const input = (origin: string) =>
    new Request(collection.endpoint, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "x-ceremony-collection": collection.handle,
      },
      body: JSON.stringify({ token: "sentinel-mcp-secret" }),
    });
  assert.equal(
    (await collector.handleRequest(input("https://evil.example")))?.status,
    403,
  );
  assert.equal((await collector.handleRequest(input("null")))?.status, 403);
  const response = await collector.handleRequest(input("https://app.example"));
  assert.equal(response?.status, 200);
  const { secretRef } = z
    .object({ secretRef: z.uuid() })
    .parse(await response!.json());
  assert.equal(
    (await collector.handleRequest(input("https://app.example")))?.status,
    400,
  );
  assert.equal(verified, false);
  await client.callTool({
    name: "ceremony_bind_private",
    arguments: {
      instanceId: snapshot.id,
      revision: snapshot.revision,
      secretRef,
    },
  });
  assert.equal(verified, true);
  assert.ok(!messages.join("\n").includes("sentinel-mcp-secret"));
  assert.equal((await controller.read("alice", snapshot.id)).step, "complete");
  await client.close();
  await server.close();
  db.close();
});
