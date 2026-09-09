import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { SignJWT, jwtVerify } from "jose";
import { Client } from "@modelcontextprotocol/client";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  CeremonyController,
  CeremonyDatabase,
  PrivateCredentialBroker,
  registerPrivateCollector,
} from "../../src/server/index.js";
import { manifests } from "../../examples/manifests.js";
import { readBody } from "../../examples/http.js";

test("AC-19 AC-20: legacy MCP collection requires the authenticated HTTP recipient, not a handle or unsigned owner", async (t) => {
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  t.after(() => db.close());
  let effects = 0;
  const controller = new CeremonyController(
    [
      {
        manifest: manifests[0]!,
        recoverable: true,
        createAdapter: () => ({
          begin: async () => ({ step: "input" }),
          callback: async () => ({ step: "error" }),
          poll: async () => undefined,
          cancel() {},
          submit: async () => {
            effects++;
            return { step: "complete" };
          },
        }),
      },
    ],
    new Map(),
    Date.now,
    { database: db, broker: new PrivateCredentialBroker(db) },
  );
  const run = controller.start("alice", "github", "api-key");
  const mcp = new McpServer({ name: "recipient-test", version: "1" });
  const key = randomBytes(32);
  const base = {
    brokerOrigin: "https://broker.example",
    appOrigin: "https://app.example",
    appHtml: "<!doctype html><title>Trusted collector</title>",
    owner: () => "alice",
  };
  const collector = registerPrivateCollector(mcp, controller, db, {
    ...base,
    requestOwner: async (request) => {
      const cookie = request.headers
        .get("cookie")
        ?.match(/(?:^|;\s*)mcp_session=([^;]+)/)?.[1];
      if (!cookie) return null;
      const { payload } = await jwtVerify(cookie, key, {
        issuer: "https://broker.example",
        audience: "mcp-collector",
      });
      return payload.sub ?? null;
    },
  });
  const missingServer = new McpServer({ name: "missing-auth", version: "1" });
  const missing = registerPrivateCollector(missingServer, controller, db, base);
  let active = collector;
  const http = createServer(async (request, response) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers))
        if (typeof value === "string") headers.set(name, value);
      const body =
        request.method === "POST" ? await readBody(request) : undefined;
      const result = await active.handleRequest(
        new Request(`https://broker.example${request.url}`, {
          method: request.method ?? "GET",
          headers,
          ...(body === undefined ? {} : { body }),
        }),
      );
      response.writeHead(
        result?.status ?? 404,
        result ? Object.fromEntries(result.headers) : {},
      );
      response.end(result ? await result.text() : "");
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture unavailable");
  const client = new Client(
    { name: "host", version: "1" },
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
  for (const transport of [clientWire, serverWire]) {
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      messages.push(JSON.stringify(message));
      return send(message, options);
    };
  }
  await mcp.connect(serverWire);
  await client.connect(clientWire);
  const missingClient = new Client(
    { name: "missing-adapter-host", version: "1" },
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
  const [missingClientWire, missingServerWire] =
    InMemoryTransport.createLinkedPair();
  await missingServer.connect(missingServerWire);
  await missingClient.connect(missingClientWire);
  const unavailable = await missingClient.callTool({
    name: "ceremony_collect_private",
    arguments: { instanceId: run.id },
  });
  assert.equal(unavailable.isError, true);
  assert.equal(Object.hasOwn(unavailable, "_meta"), false);
  t.after(async () => {
    await client.close();
    await mcp.close();
    await missingClient.close();
    await missingServer.close();
  });
  const result = await client.callTool({
    name: "ceremony_collect_private",
    arguments: { instanceId: run.id },
  });
  const { handle } = z
    .object({ _meta: z.object({ collection: z.object({ handle: z.uuid() }) }) })
    .parse(result)._meta.collection;
  const session = async (subject: string, signingKey = key) =>
    new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("https://broker.example")
      .setAudience("mcp-collector")
      .setSubject(subject)
      .setExpirationTime("5m")
      .sign(signingKey);
  const post = (cookie?: string) =>
    fetch(`http://127.0.0.1:${address.port}/ceremony/private-collection`, {
      method: "POST",
      headers: {
        origin: "https://app.example",
        "content-type": "application/json",
        "x-ceremony-collection": handle,
        "x-owner": "alice",
        ...(cookie ? { cookie: `mcp_session=${cookie}` } : {}),
      },
      body: JSON.stringify({ token: "synthetic-private-mcp-input" }),
    });
  const aliceSession = await session("alice");
  const headers = {
    origin: "https://app.example",
    "content-type": "application/json",
    "x-ceremony-collection": handle,
    cookie: `mcp_session=${aliceSession}`,
  };
  const endpoint = "https://broker.example/ceremony/private-collection";
  assert.equal(
    await collector.handleRequest(new Request("https://broker.example/other")),
    undefined,
  );
  assert.equal(
    (
      await collector.handleRequest(
        new Request(endpoint, { method: "OPTIONS", headers }),
      )
    )?.status,
    204,
  );
  assert.equal(
    (await collector.handleRequest(new Request(endpoint, { headers })))?.status,
    405,
  );
  assert.equal(
    (
      await collector.handleRequest(
        new Request(endpoint, {
          method: "POST",
          headers: { ...headers, "content-type": "application/jsonx" },
          body: "{}",
        }),
      )
    )?.status,
    405,
  );
  assert.equal(
    (
      await collector.handleRequest(
        new Request(endpoint, {
          method: "POST",
          headers: { ...headers, "x-ceremony-collection": "invalid" },
          body: "{}",
        }),
      )
    )?.status,
    400,
  );
  assert.equal(
    (
      await collector.handleRequest(
        new Request(endpoint, { method: "POST", headers }),
      )
    )?.status,
    400,
  );
  for (const body of [
    "{",
    JSON.stringify({ wrong: "field" }),
    JSON.stringify({ token: "x".repeat(65000) }),
  ])
    assert.equal(
      (
        await collector.handleRequest(
          new Request(endpoint, { method: "POST", headers, body }),
        )
      )?.status,
      400,
    );
  const expired = {
    owner: "alice",
    instanceId: run.id,
    revision: run.revision,
    expiresAt: Date.now() - 1,
  };
  db.put(`mcp-collection:${handle}`, expired);
  assert.equal((await post(aliceSession)).status, 403);
  db.put(`mcp-collection:${handle}`, {
    ...expired,
    expiresAt: Date.now() + 300000,
  });
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(control) {
        db.put(`mcp-collection:${handle}`, {
          ...expired,
          owner: "bob",
          expiresAt: Date.now() + 300000,
        });
        control.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ token: "synthetic-private-mcp-input" }),
          ),
        );
        control.close();
      },
    },
    { highWaterMark: 0 },
  );
  const init = { method: "POST", headers, body: stream, duplex: "half" };
  assert.equal(
    (await collector.handleRequest(new Request(endpoint, init)))?.status,
    400,
  );
  db.put(`mcp-collection:${handle}`, {
    ...expired,
    expiresAt: Date.now() + 300000,
  });
  const refused = await client.callTool({
    name: "ceremony_bind_private",
    arguments: {
      instanceId: run.id,
      revision: run.revision,
      secretRef: crypto.randomUUID(),
    },
  });
  assert.equal(refused.isError, true);
  assert.equal((await post()).status, 403);
  assert.equal((await post(await session("bob"))).status, 403);
  assert.equal(
    (await post(await session("alice", randomBytes(32)))).status,
    403,
  );
  active = missing;
  assert.equal((await post(await session("alice"))).status, 403);
  active = collector;
  assert.equal(effects, 0);
  const collected = await post(await session("alice"));
  assert.equal(collected.status, 200);
  assert.equal(
    collected.headers.get("access-control-allow-credentials"),
    "true",
  );
  const { secretRef } = z
    .object({ secretRef: z.uuid() })
    .parse(await collected.json());
  assert.equal((await post(await session("alice"))).status, 403);
  await client.callTool({
    name: "ceremony_bind_private",
    arguments: { instanceId: run.id, revision: run.revision, secretRef },
  });
  assert.equal(effects, 1);
  assert.equal(
    messages.some((message) => message.includes("synthetic-private-mcp-input")),
    false,
  );
});
