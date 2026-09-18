import assert from "node:assert/strict";
import test from "node:test";
import { createDaprAppRoutes } from "../../../src/server/connectors/providers/dapr/app-routes.js";

/*
 * INT-DAPR-01..06. The one property worth attacking: the route decides which
 * component a delivery reaches, and nothing a request carries can change it.
 * Dapr's app leg is authenticated by a single shared bearer token across
 * every binding, so if a request could name its own component, the token for
 * the least valuable binding would open the most valuable one.
 */

const ORIGIN = "https://app.example";

function routes(received: { component: string; body: string }[]) {
  return createDaprAppRoutes({
    routes: [
      { segment: "orders-topic", component: "orders-topic" },
      // A published segment that is not the component name: the mapping is
      // what matters, and this proves the handler uses it rather than the
      // segment text.
      { segment: "inbound", component: "payments-queue" },
    ],
    async receive({ component, request }) {
      received.push({ component, body: await request.text() });
      return Response.json({ accepted: true });
    },
  });
}

const post = (path: string, body = "{}") =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });

test("INT-DAPR-01: the startup probe accepts an approved route and declines others", async () => {
  const handle = routes([]);
  const approved = await handle(
    new Request(`${ORIGIN}/dapr/input/orders-topic`, { method: "OPTIONS" }),
  );
  assert.equal(approved?.status, 200);

  // Dapr reads 404 as "this app does not subscribe", so an unapproved
  // binding is declined before any delivery exists.
  const declined = await handle(
    new Request(`${ORIGIN}/dapr/input/not-approved`, { method: "OPTIONS" }),
  );
  assert.equal(declined?.status, 404);
});

test("INT-DAPR-02: the route, not the request, names the component", async () => {
  const received: { component: string; body: string }[] = [];
  const handle = routes(received);
  // Everything an attacker can write says "orders-topic"; the route says
  // "payments-queue", and the route is what the receiver is told.
  const request = new Request(`${ORIGIN}/dapr/input/inbound`, {
    method: "POST",
    body: JSON.stringify({
      component: "orders-topic",
      bindingName: "orders-topic",
    }),
    headers: {
      "content-type": "application/json",
      "dapr-component": "orders-topic",
      "x-dapr-binding": "orders-topic",
    },
  });
  const response = await handle(request);
  assert.equal(response?.status, 200);
  assert.deepEqual(
    received.map((item) => item.component),
    ["payments-queue"],
  );
});

test("INT-DAPR-03: a segment is matched literally, never decoded into a name", async () => {
  const received: { component: string; body: string }[] = [];
  const handle = routes(received);
  for (const path of [
    "/dapr/input/orders%2Dtopic",
    "/dapr/input/ORDERS-TOPIC",
    "/dapr/input/orders-topic%00",
    "/dapr/input/orders-topic.",
  ]) {
    const response = await handle(post(path));
    assert.equal(response?.status, 404, path);
  }
  assert.deepEqual(received, [], "no delivery reached a receiver");
});

test("INT-DAPR-04: only one segment is served, so no path reaches past the table", async () => {
  const received: { component: string; body: string }[] = [];
  const handle = routes(received);
  for (const path of [
    "/dapr/input/orders-topic/extra",
    "/dapr/input/",
    "/dapr/input",
  ]) {
    const response = await handle(post(path));
    assert.notEqual(response?.status, 200, path);
  }
  assert.deepEqual(received, []);

  // A dot segment is not a bypass and is not treated as one. The URL parser
  // resolves it before any matching happens, so this path *is* the approved
  // route by the time the table is consulted, exactly as it would be at any
  // HTTP server in front of this one. What matters is that it reaches the
  // route it resolves to and never a different one.
  const resolved = await handle(post("/dapr/input/inbound/../orders-topic"));
  assert.equal(resolved?.status, 200);
  assert.deepEqual(
    received.map((item) => item.component),
    ["orders-topic"],
  );
  // A request outside the mount is not this handler's, and it says so rather
  // than answering for it.
  assert.equal(
    await handle(post("/api/v1/connectors/events/dapr/x")),
    undefined,
  );
});

test("INT-DAPR-05: a method the sidecar does not use is refused, not guessed at", async () => {
  const received: { component: string; body: string }[] = [];
  const handle = routes(received);
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    const response = await handle(
      new Request(`${ORIGIN}/dapr/input/orders-topic`, { method }),
    );
    assert.equal(response?.status, 405, method);
    assert.equal(response?.headers.get("allow"), "OPTIONS, POST");
  }
  assert.deepEqual(received, []);
});

test("INT-DAPR-06: the table is fixed at construction and refuses an ambiguous one", () => {
  const receive = () => Response.json({});
  assert.throws(() =>
    createDaprAppRoutes({
      routes: [
        { segment: "a", component: "one" },
        { segment: "a", component: "two" },
      ],
      receive,
    }),
  );
  // A segment carrying structure is refused rather than escaped: it would
  // make the mount's shape depend on a configured string.
  for (const segment of ["a/b", "..", "", "a?b", "a#b"])
    assert.throws(
      () =>
        createDaprAppRoutes({ routes: [{ segment, component: "c" }], receive }),
      `segment ${JSON.stringify(segment)} must be refused`,
    );
});
