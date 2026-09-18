import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/*
 * The service worker is not this swarm's file, and the point of this test is
 * that it stays that way. A connection's status is authorization state: it has
 * to come from the server on every read, so the static shell must not be able
 * to answer for it — not from a cache, not from a fallback, not by accident.
 */

const workerPath = fileURLToPath(
  new URL("../../../examples/web/public/sw.js", import.meta.url),
);

test("the static shell never answers for a connector route", async () => {
  const worker = await readFile(workerPath, "utf8");
  assert.doesNotMatch(worker, /connector/i);
  assert.doesNotMatch(worker, /\/api\//);

  // What it does cache is a fixed list of static files, and its navigation
  // fallback is the offline page for the app shell only.
  const cached = /const STATIC = \[([^\]]*)\]/.exec(worker);
  assert.ok(cached, "the worker no longer declares a static list");
  assert.deepEqual(
    cached[1]!
      .split(",")
      .map((entry) => entry.trim().replace(/^"|"$/g, ""))
      .filter(Boolean),
    ["/offline.html", "/icon.svg", "/manifest.webmanifest"],
  );
  assert.match(worker, /request\.method !== "GET"/);
  assert.match(
    worker,
    /Never intercept broker, callbacks, streams, environment, provider pages, or authenticated APIs/,
  );
});

/**
 * The same claim from the other side: the connector client asks for a fresh
 * read every time, so even an HTTP cache cannot hold a stale status.
 */
test("every connector request is made without a cache", async () => {
  const client = await readFile(
    fileURLToPath(
      new URL("../../../src/core/connectors/client.ts", import.meta.url),
    ),
    "utf8",
  );
  assert.match(client, /cache: "no-store"/);
  assert.match(client, /credentials: "same-origin"/);
});
