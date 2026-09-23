import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { readBoundedBytes } from "../../../src/server/connectors/registries/bounded-read.js";
import {
  createDockerMcpCatalogAdapter,
  DOCKER_CATALOG_OPERATION,
} from "../../../src/server/connectors/registries/docker/adapter.js";
import { createMcpRegistryClient } from "../../../src/server/connectors/registries/mcp/client.js";
import { readBoundedJson as readBoundedPulseMcpJson } from "../../../src/server/connectors/registries/pulsemcp/api.js";
import { readBoundedJson as readBoundedSmitheryJson } from "../../../src/server/connectors/registries/smithery/api.js";
import type { JsonValueLimits } from "../../../src/core/connectors/json-bounds.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import { buildBinding } from "../fixtures/builders.js";

/*
 * The response-size bound of every registry reader, held against a server that
 * declares no length and keeps writing.
 *
 * A ceiling applied after `await response.arrayBuffer()` passes any test that
 * only asks whether an error was thrown: the error is thrown, after the whole
 * body has been allocated. So these tests measure the thing the bound exists
 * for, from the other side of the socket — how many bytes the server was able
 * to write before the reader gave up — and they measure it twice, against a
 * body the server is willing to make four times larger. Buffering first makes
 * that number follow the body; refusing while reading does not.
 *
 * `readBoundedBytes` is one shared helper with four callers, so the streaming
 * proof is written once here against the helper and each caller gets a thin
 * check that it really routes through it and reports its own failure detail,
 * rather than four near-copies of the same server.
 */

const CHUNK = 64 * 1024;

/*
 * The counters below are only final once the server has seen its reply end.
 * The reader's cancel returns as soon as the client tears its socket down, but
 * the server learns of it later, on its own turn of the event loop, when the
 * close reaches its side of the connection. A fixed pause before reading the
 * counters only usually covers that gap, and not under load, so each check
 * waits for the reply's own `close` instead. A reader that never let go leaves
 * the server blocked on backpressure and the reply open, which the deadline
 * reports as a failure rather than a hang.
 */
async function replyEnded(server: { closed: Promise<void> }) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      server.closed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("the reply was never closed")),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A server that answers every request by writing filler until the reader stops
 * taking it, and reports how many bytes it managed to hand to the socket.
 * Backpressure is respected between chunks, so the count is what the reader
 * actually accepted plus at most one chunk in flight — never bytes merely
 * queued inside this process. `offer` is a ceiling on the server's own effort,
 * not work it performs: when the reader quits early, so does the server.
 */
async function flooding(options: {
  offer: number;
  /** A declared `content-length`; omitted answers chunked, with no length at all. */
  declare?: number;
  contentType?: string;
}) {
  let flushed = 0;
  let closedEarly = false;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const server = createServer((_request, response: ServerResponse) => {
    response.writeHead(200, {
      "content-type": options.contentType ?? "application/json",
      ...(options.declare === undefined
        ? {}
        : { "content-length": String(options.declare) }),
    });
    let stopped = false;
    const stop = () => {
      stopped = true;
    };
    response.on("error", stop);
    response.on("close", () => {
      if (!response.writableFinished) closedEarly = true;
      stop();
      markClosed();
    });
    void (async () => {
      const filler = Buffer.alloc(CHUNK, 0x78);
      while (!stopped && flushed < options.offer) {
        const accepted = response.write(filler);
        flushed += filler.byteLength;
        if (!accepted)
          await new Promise<void>((resolve) => {
            const done = () => {
              response.off("drain", done);
              response.off("close", done);
              response.off("error", done);
              resolve();
            };
            response.once("drain", done);
            response.once("close", done);
            response.once("error", done);
          });
      }
      if (stopped) response.destroy();
      else response.end();
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    url: `${origin}/`,
    flushed: () => flushed,
    /** Settles when the reply has closed, by being cut off or by finishing. */
    closed,
    /** True when the reply was cut off rather than being allowed to finish. */
    closedEarly: () => closedEarly,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const rejects = (detail: string) => (error: unknown) =>
  error instanceof ConnectorError &&
  error.code === "upstream-rejected" &&
  error.detail === detail;

const jsonLimits = (bytes: number): JsonValueLimits => ({
  depth: 24,
  nodes: 100_000,
  bytes,
  stringLength: 64 * 1024,
});

test("the shared registry reader truncates a chunked body, and what the server gets to write does not follow the body's size", async (t) => {
  const ceiling = 64 * 1024;
  const flushedPerOffer: number[] = [];
  for (const offer of [16 * 1024 * 1024, 64 * 1024 * 1024]) {
    const server = await flooding({ offer });
    t.after(() => server.close());
    const response = await fetch(server.url);
    // No `content-length` at all, which is how a registry answering chunked
    // replies: the pre-check has nothing to refuse, so the running total is the
    // only thing standing between this process and the whole body.
    assert.equal(response.headers.get("content-length"), null);
    await assert.rejects(
      readBoundedBytes(response, ceiling, "registries.test.too-large"),
      rejects("registries.test.too-large"),
    );
    await replyEnded(server);
    assert.ok(
      server.flushed() < offer / 4,
      `the server wrote ${server.flushed()} of the ${offer} bytes it stood ready to send`,
    );
    // The body was cancelled, so the server was cut off mid-reply instead of
    // being left writing into a socket nobody reads.
    assert.equal(server.closedEarly(), true);
    assert.equal(response.bodyUsed, true);
    flushedPerOffer.push(server.flushed());
  }
  // This is the whole point of enforcing the bound while the body arrives:
  // quadrupling what the server is willing to send does not change how much of
  // it this process ever sees. Buffering first would have made these two
  // numbers 16 MiB and 64 MiB. They are a few MiB rather than exactly the
  // ceiling because the HTTP client reads ahead into a buffer of its own, and
  // that read-ahead is a fixed cost, not a function of the body or the ceiling.
  const [smaller, larger] = flushedPerOffer as [number, number];
  assert.ok(
    Math.abs(larger - smaller) <= 8 * CHUNK,
    `the residue moved with the body size: ${smaller} bytes, then ${larger}`,
  );
});

test("a declared content-length over the ceiling is refused before the body is read, and the body is still released", async (t) => {
  const ceiling = 8 * 1024 * 1024;
  const server = await flooding({
    offer: 64 * 1024 * 1024,
    declare: ceiling + 1,
  });
  t.after(() => server.close());
  const response = await fetch(server.url);
  await assert.rejects(
    readBoundedBytes(response, ceiling, "registries.test.too-large"),
    rejects("registries.test.too-large"),
  );
  await replyEnded(server);
  // The refusal came from the header, so nothing near the ceiling was ever
  // read, and the body was cancelled rather than abandoned: a reader that only
  // threw would leave the server writing to an open socket.
  assert.equal(response.bodyUsed, true);
  assert.equal(server.closedEarly(), true);
  assert.ok(
    server.flushed() < ceiling,
    `the server wrote ${server.flushed()} bytes for a reply that was refused unread`,
  );
});

test("each registry reader routes through the shared bound and reports its own detail", async (t) => {
  // The three readers whose ceiling is a parameter are driven at a small one,
  // so this stays a test about the bound rather than about moving megabytes.
  const ceiling = 256 * 1024;
  const readers: Array<{
    detail: string;
    read: (server: { origin: string; url: string }) => Promise<unknown>;
  }> = [
    {
      detail: "smithery.response.too-large",
      read: async (server) =>
        readBoundedSmitheryJson(await fetch(server.url), jsonLimits(ceiling)),
    },
    {
      detail: "pulsemcp.response.too-large",
      read: async (server) =>
        readBoundedPulseMcpJson(await fetch(server.url), jsonLimits(ceiling)),
    },
    {
      detail: "registry.response.oversized",
      read: (server) =>
        createMcpRegistryClient({
          baseUrl: server.origin,
          fetch: globalThis.fetch,
          limits: { maxPageBytes: ceiling },
        }).list(),
    },
  ];
  for (const reader of readers) {
    const offer = 32 * 1024 * 1024;
    const server = await flooding({ offer });
    t.after(() => server.close());
    await assert.rejects(reader.read(server), rejects(reader.detail));
    await replyEnded(server);
    assert.ok(
      server.flushed() < offer / 4,
      `${reader.detail}: the server wrote ${server.flushed()} of ${offer} bytes`,
    );
    assert.equal(server.closedEarly(), true, reader.detail);
  }
});

test("the docker catalog reader holds its own ceiling while the document arrives", async (t) => {
  // Docker's ceiling is a module constant with no override, so this one runs at
  // the real 8 MiB. The server stands ready to send 64 MiB and is cut off on
  // the order of that ceiling, which is the whole claim; it is the one reader
  // here whose streamed volume cannot be made smaller without changing `src`.
  const ceiling = 8 * 1024 * 1024;
  const offer = 64 * 1024 * 1024;
  const server = await flooding({ offer, contentType: "application/yaml" });
  t.after(() => server.close());
  const ports = memoryPorts();
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding: buildBinding({
      adapterId: "docker-mcp-catalog",
      destinations: [
        { id: "catalog", origin: server.origin, network: "loopback-fixture" },
      ],
      operations: [
        {
          operationRef: DOCKER_CATALOG_OPERATION,
          nativeId: "catalog.yaml",
          destinationId: "catalog",
          transport: { kind: "http", method: "GET", pathTemplate: "/" },
          effect: "read",
          outputClassification: "public",
          cost: "free",
          consent: "none",
          replay: "read-only",
          targetParameters: [],
        },
      ],
      configuration: [],
      profileId: undefined,
    }),
    generation: 0,
    signal: AbortSignal.timeout(30_000),
    environment: ports.environment({ fetch: globalThis.fetch }),
  };

  await assert.rejects(
    createDockerMcpCatalogAdapter().discover!(ctx, {}),
    rejects("docker.catalog.too-large"),
  );
  await replyEnded(server);
  assert.ok(
    server.flushed() > ceiling,
    `the ceiling was never reached: only ${server.flushed()} bytes were written`,
  );
  assert.ok(
    server.flushed() < 2 * ceiling + 8 * CHUNK,
    `the server wrote ${server.flushed()} bytes, far past the ${ceiling}-byte ceiling`,
  );
  assert.equal(server.closedEarly(), true);
});
