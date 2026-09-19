import assert from "node:assert/strict";
import test from "node:test";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import { hostedHttp } from "../../../src/server/hosted/http.js";
import { connectorRequestNeedsActor } from "../../../src/server/connectors/commands/index.js";
import type {
  ConnectorAction,
  ConnectorPolicy,
  PolicySubject,
} from "../../../src/server/connectors/commands/index.js";
import {
  completeOauthCallback,
  createHarness,
  FIXTURE_DOCUMENT,
  human,
  ORIGIN,
  TENANT,
  type Harness,
} from "../commands/harness.js";

/*
 * SEC-03/SEC-04 against the command service and its HTTP route table. Two
 * claims are attacked directly rather than taken on trust: that host policy is
 * consulted again at every effect boundary, and that the provider callback
 * route, which deliberately sits outside the same-origin check because it is
 * a top-level provider navigation, is nevertheless bound to the human who
 * started the flow.
 */

const SESSION = "human-session";

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** Wraps a policy so every consultation is recorded and one action can be denied. */
function watched(base: ConnectorPolicy, deny?: ConnectorAction) {
  const seen: Array<{
    action: ConnectorAction;
    subject: PolicySubject["kind"];
  }> = [];
  const policy: ConnectorPolicy = {
    ...base,
    authorize: async (actor, subject, action) => {
      seen.push({ action, subject: subject.kind });
      if (action === deny) return false;
      return base.authorize(actor, subject, action);
    },
  };
  return { policy, seen };
}

async function connected(
  harness: Harness,
  actor: ActorContext = human(),
  session = SESSION,
) {
  harness.register(session, actor);
  const imported = await body(
    await harness.fetch("/api/v1/connectors/import", {
      body: {
        kind: "upload",
        mediaType: "application/json",
        text: FIXTURE_DOCUMENT(harness.provider.origin),
      },
      session,
    }),
  );
  const definitionRef = (imported.definitions as string[])[0]!;
  const binding = await body(
    await harness.fetch("/api/v1/connectors/bindings", {
      body: {
        definitionRef,
        adapterId: "fixture-http",
        approvals: {
          destinations: [harness.provider.origin],
          operations: ["listItems"],
          profileId: "oauth",
        },
      },
      session,
    }),
  );
  const bindingRef = binding.bindingRef as string;
  const started = await body(
    await harness.fetch("/api/v1/connectors/connections", {
      body: {
        bindingRef,
        intent: { profileId: "oauth", requestedPermissions: ["read"] },
      },
      session,
    }),
  );
  return {
    definitionRef,
    bindingRef,
    connectionRef: started.connectionRef as string,
    presentation: started.presentation as { url: string },
  };
}

test("host policy is consulted again at every boundary, with a server-side subject", async (t) => {
  const watcher: { seen: ReturnType<typeof watched>["seen"] } = { seen: [] };
  const harness = await createHarness({
    policy: (base) => {
      const w = watched(base);
      watcher.seen = w.seen;
      return w.policy;
    },
  });
  t.after(() => harness.close());
  const flow = await connected(harness);
  await harness.fetch("/api/v1/connectors/catalog", { session: SESSION });
  const callback = await completeOauthCallback(
    harness,
    SESSION,
    flow.presentation.url,
  );
  assert.equal(callback.status, 303);
  await harness.fetch(
    `/api/v1/connectors/connections/${flow.connectionRef}/verify`,
    { body: {}, session: SESSION },
  );
  const actions = new Set(watcher.seen.map((item) => item.action));
  for (const required of [
    "catalog",
    "import",
    "approve",
    "connect",
    "callback",
    "verify",
  ] as const)
    assert.ok(
      actions.has(required),
      `${required} was never authorized: ${[...actions].join(",")}`,
    );
  // Every connection-scoped consultation carries the server's record, never
  // a client-named subject.
  assert.ok(
    watcher.seen
      .filter((item) => ["callback", "verify"].includes(item.action))
      .every((item) => item.subject === "connection"),
    JSON.stringify(watcher.seen),
  );
});

test("denying one action blocks exactly that boundary, after the others succeeded", async (t) => {
  // The callback is the interesting one: the flow is already authorized, the
  // provider has already redirected, and the last recheck still refuses.
  const harness = await createHarness({
    policy: (base) => watched(base, "callback").policy,
  });
  t.after(() => harness.close());
  const flow = await connected(harness);
  const callback = await completeOauthCallback(
    harness,
    SESSION,
    flow.presentation.url,
  );
  assert.equal(callback.status, 303);
  const outcome = new URL(callback.headers.get("location")!);
  assert.equal(outcome.origin, ORIGIN, "the return is always on this origin");
  assert.equal(outcome.searchParams.get("outcome"), "denied");
  const status = await body(
    await harness.fetch(
      `/api/v1/connectors/connections/${flow.connectionRef}`,
      { session: SESSION },
    ),
  );
  assert.notEqual(status.lifecycle, "active");

  // And a denial at invoke blocks use even on a connection that reached
  // active under an allowing policy.
  const second = await createHarness({
    policy: (base) => watched(base, "invoke").policy,
  });
  t.after(() => second.close());
  const live = await connected(second);
  await completeOauthCallback(second, SESSION, live.presentation.url);
  const binding = second.definitions
    .bindings()
    .filter((item) => item.bindingRef === live.bindingRef)
    .sort((a, b) => a.revision - b.revision)
    .at(-1)!;
  const operationRef = binding.operations.find(
    (item) => item.nativeId === "listItems",
  )!.operationRef;
  const denied = await second.fetch(
    `/api/v1/connectors/connections/${live.connectionRef}/invoke`,
    { body: { operationRef, input: {} }, session: SESSION },
  );
  assert.equal(denied.status >= 400, true, await denied.text());
});

test("a policy hook that throws denies rather than opening the boundary", async (t) => {
  const harness = await createHarness({
    policy: (base) => ({
      ...base,
      authorize: (actor, subject, action) => {
        if (action === "import") throw new Error("hook exploded");
        return base.authorize(actor, subject, action);
      },
    }),
  });
  t.after(() => harness.close());
  harness.register(SESSION, human());
  const response = await harness.fetch("/api/v1/connectors/import", {
    body: {
      kind: "upload",
      mediaType: "application/json",
      text: FIXTURE_DOCUMENT(harness.provider.origin),
    },
    session: SESSION,
  });
  const failure = await body(response);
  assert.equal(response.status, 403, JSON.stringify(failure));
  assert.equal(failure.error, "denied");
  assert.ok(
    !JSON.stringify(failure).includes("exploded"),
    "a hook's own message never reaches the caller",
  );
});

test("the callback route is a provider navigation, and still belongs to one human", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const owner = human();
  const flow = await connected(harness, owner);
  const response = await fetch(flow.presentation.url, { redirect: "manual" });
  const location = response.headers.get("location")!;
  await response.body?.cancel().catch(() => {});
  const callback = new URL(location);
  const path = `${callback.pathname}${callback.search}`;

  // Another subject in the same tenant cannot spend the callback, and neither
  // can another session of the same subject: a cross-site navigation that
  // lands in the wrong browser changes nothing.
  harness.register("other-subject", human({ subjectId: "subject-2" }));
  harness.register("other-session", human({ sessionId: "session-2" }));
  for (const session of ["other-subject", "other-session"]) {
    const attempt = await harness.fetch(path, { session });
    assert.equal(attempt.status, 303, session);
    const to = new URL(attempt.headers.get("location")!);
    assert.equal(to.origin, ORIGIN);
    assert.notEqual(to.searchParams.get("outcome"), "active", session);
    assert.equal(to.searchParams.get("connection"), null, session);
  }
  // Another tenant does not even find the handoff.
  harness.register("other-tenant", human({ tenantId: "tenant-b" }));
  const foreign = await harness.fetch(path, { session: "other-tenant" });
  assert.equal(
    new URL(foreign.headers.get("location")!).searchParams.get("outcome"),
    "not-found",
  );

  // The provider's own query cannot choose where the person lands: an
  // attacker-supplied return target is ignored entirely.
  const withRedirect = `${path}&return_to=${encodeURIComponent("https://evil.example/")}&redirect_uri=https%3A%2F%2Fevil.example%2F`;
  const landed = await harness.fetch(withRedirect, { session: SESSION });
  assert.equal(landed.status, 303);
  const target = new URL(landed.headers.get("location")!);
  assert.equal(target.origin, ORIGIN);
  assert.equal(target.pathname, "/connectors");
  assert.equal(target.searchParams.get("outcome"), "active");

  // The route is GET-only: a cross-site form POST is not an alternative way in.
  const posted = await harness.fetch("/api/v1/connectors/callback", {
    method: "POST",
    body: {},
    session: SESSION,
  });
  assert.equal(posted.status, 405);
  assert.equal(posted.headers.get("allow"), "GET");
  // A callback with no state, or two, is refused before any lookup.
  for (const query of ["", "?state=", "?state=a&state=b"]) {
    const bad = await harness.fetch(`/api/v1/connectors/callback${query}`, {
      session: SESSION,
    });
    assert.equal(bad.status, 303, query);
    assert.equal(
      new URL(bad.headers.get("location")!).searchParams.get("outcome"),
      "invalid-request",
      query,
    );
  }
});

test("mutating routes keep the same-origin, content-type and size boundary", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const flow = await connected(harness);
  const mutations: Array<[string, unknown]> = [
    [
      "/api/v1/connectors/import",
      { kind: "upload", mediaType: "application/json", text: "{}" },
    ],
    ["/api/v1/connectors/configure", {}],
    ["/api/v1/connectors/connections", { bindingRef: flow.bindingRef }],
    [`/api/v1/connectors/connections/${flow.connectionRef}/verify`, {}],
  ];
  for (const [path, payload] of mutations) {
    const crossOrigin = await harness.fetch(path, {
      body: payload,
      session: SESSION,
      origin: "https://evil.example",
    });
    assert.equal(crossOrigin.status, 403, `${path} cross-origin`);
    const noOrigin = await harness.fetch(path, {
      body: payload,
      session: SESSION,
      origin: null,
    });
    assert.equal(noOrigin.status, 403, `${path} no origin`);
    const wrongType = await harness.fetch(path, {
      body: payload,
      session: SESSION,
      headers: { "content-type": "text/plain" },
    });
    assert.equal(wrongType.status >= 400, true, `${path} content-type`);
  }
  // A GET carries no body and therefore no origin requirement, but it is
  // still confined to this origin's path space and this actor's records.
  const unknownRoute = await harness.fetch("/api/v1/connectors/nope", {
    session: SESSION,
  });
  assert.equal(unknownRoute.status, 404);
});

test("another principal's references are not found, never merely denied", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const flow = await connected(harness);
  for (const [session, actor] of [
    ["other-subject", human({ subjectId: "subject-2" })],
    ["other-tenant", human({ tenantId: "tenant-b" })],
  ] as const) {
    harness.register(session, actor);
    const status = await harness.fetch(
      `/api/v1/connectors/connections/${flow.connectionRef}`,
      { session },
    );
    assert.equal(status.status, 404, `${session} connection`);
    // A definition is a tenant asset, so a second subject of the same tenant
    // may read it; another tenant may not, and must not learn it exists.
    const definition = await harness.fetch(
      `/api/v1/connectors/definitions/${encodeURIComponent(flow.definitionRef)}`,
      { session },
    );
    assert.equal(
      definition.status,
      actor.tenantId === TENANT ? 200 : 404,
      `${session} definition`,
    );
    const list = await body(
      await harness.fetch("/api/v1/connectors/connections", { session }),
    );
    assert.deepEqual(list.connections, [], `${session} list`);
  }
  // A path segment cannot be smuggled through encoding.
  for (const suffix of ["..%2F..%2Fbindings", "%2e%2e", "a%00b"]) {
    const response = await harness.fetch(
      `/api/v1/connectors/connections/${suffix}`,
      { session: SESSION },
    );
    assert.equal(response.status >= 400, true, suffix);
  }
  assert.equal(TENANT, "tenant-a");
});

test("the event mount point authenticates by signature and reaches nothing else", async (t) => {
  const deliveries: Array<{ authority: string; hasSession: boolean }> = [];
  const harness = await createHarness();
  t.after(() => harness.close());
  const { createConnectorEventsHttp } =
    await import("../../../src/server/connectors/commands/http.js");
  const events = createConnectorEventsHttp({
    receiveEvent: async ({ authority, request }) => {
      deliveries.push({
        authority,
        hasSession: request.headers.has("cookie"),
      });
      // A receiver authenticates the delivery itself; an unsigned one is
      // refused with a sanitized acknowledgement.
      return request.headers.get("x-signature") === "good"
        ? Response.json({ received: true })
        : Response.json({ error: "denied" }, { status: 401 });
    },
  });
  const post = (path: string, headers: Record<string, string> = {}) =>
    events(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      }),
    );
  // No session, no Origin header: a provider delivery is not a browser
  // request, and it is still accepted only when the signature checks out.
  const unsigned = await post("/api/v1/connectors/events/nango");
  assert.equal(unsigned?.status, 401);
  const signed = await post("/api/v1/connectors/events/nango", {
    "x-signature": "good",
  });
  assert.equal(signed?.status, 200);
  assert.equal(signed?.headers.get("cache-control"), "no-store");
  assert.deepEqual(
    deliveries.map((item) => item.authority),
    ["nango", "nango"],
  );
  // The mount point owns exactly one shape of path. Anything else is not a
  // second door into the command routes.
  for (const path of [
    "/api/v1/connectors/events/nango/extra",
    "/api/v1/connectors/events/",
    "/api/v1/connectors/connections",
    "/api/v1/connectors/events/../connections",
    "/api/v1/connectors/events/%2e%2e/connections",
  ])
    assert.equal(await post(path), undefined, path);
  // A GET is not a delivery.
  const got = await events(
    new Request(`${ORIGIN}/api/v1/connectors/events/nango`),
  );
  assert.equal(got?.status, 405);
  // An authority name outside the allowed shape is a 404, not a lookup.
  const odd = await post("/api/v1/connectors/events/..%2Fadmin");
  assert.equal(odd?.status, 404);
  assert.equal(deliveries.length, 2, "no extra delivery reached the receiver");
});

test("SEC-03: the hosted mount resolves a session only where the route needs one, so signed deliveries reach the receiver", async () => {
  const deliveries: Array<{ authority: string; body: string }> = [];
  const harness = await createHarness({
    receiveEvent: async ({ authority, request }) => {
      // The receiver reads the raw bytes: that is what verifying a signature
      // over the body requires, and anything that reparsed it on the way
      // through would break verification rather than fail it.
      deliveries.push({ authority, body: await request.text() });
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    // The real host router with the real connector handler mounted. The
    // teaching runtime's other members are absent deliberately: a connector
    // path reads `identity` and nothing else before delegating, and it is that
    // delegation under test, not teaching.
    const runtime = {
      origin: ORIGIN,
      identity: harness.identity,
      store: harness.store,
      connectors: [],
    } as unknown as Parameters<typeof hostedHttp>[1];
    const host = (path: string, init: RequestInit = {}) =>
      hostedHttp(
        new Request(`${ORIGIN}${path}`, init),
        runtime,
        async () => {},
        undefined,
        undefined,
        harness.http,
      );

    // A provider carries no session. Before this was fixed the host demanded
    // one, so every delivery was answered 401 and the receiver never ran --
    // the whole event surface was unreachable behind the host.
    const payload = JSON.stringify({ id: "evt-1", type: "ping" });
    const delivery = await host("/api/v1/connectors/events/nango", {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": "good" },
      body: payload,
    });
    assert.equal(delivery.status, 202);
    assert.deepEqual(deliveries, [{ authority: "nango", body: payload }]);

    // Every other route still needs one, and refuses before reaching a service.
    const anonymous = await host("/api/v1/connectors/connections", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: "{}",
    });
    assert.equal(anonymous.status, 401);

    // And an authenticated caller still gets through the same mount.
    harness.register("boundary-session", human());
    const authenticated = await host("/api/v1/connectors/connections", {
      headers: { cookie: "fixture-session=boundary-session" },
    });
    assert.equal(authenticated.status, 200);
    assert.deepEqual(await body(authenticated), { connections: [] });

    assert.equal(
      deliveries.length,
      1,
      "no extra delivery reached the receiver",
    );
  } finally {
    await harness.close();
  }
});

test("SEC-03: only the event routes are exempt from the session the host resolves", () => {
  // A prefix boundary, not a substring one: `/eventsx` is a command route that
  // must keep its session, and the bare `/events` is not a delivery path.
  for (const path of [
    "/api/v1/connectors/events/nango",
    "/api/v1/connectors/events/nango/extra",
    "/api/v1/connectors/events/",
  ])
    assert.equal(connectorRequestNeedsActor(path), false, path);
  for (const path of [
    "/api/v1/connectors/events",
    "/api/v1/connectors/eventsx",
    "/api/v1/connectors/events-admin/nango",
    "/api/v1/connectors/connections",
    "/api/v1/connectors/import",
    "/api/v1/connectors/callback",
  ])
    assert.equal(connectorRequestNeedsActor(path), true, path);
});
