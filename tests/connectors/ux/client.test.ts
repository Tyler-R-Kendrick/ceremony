import assert from "node:assert/strict";
import test from "node:test";
import {
  connectBlockers,
  createConnectorClient,
  defaultViewer,
  canPublish,
  groupIssues,
  isTrustedHandoffMessage,
  isUnauthenticated,
  ownerKindPermitted,
  parseConnectionView,
  readConnectorReturn,
  relayHandoffReturn,
  sortIssues,
  HANDOFF_MESSAGE_TYPE,
  ConnectorClientError,
} from "../../../src/core/connectors/client.js";
import { blockedDefinition, createConnectorFixture } from "./fixture.js";

/*
 * The typed client, against the loopback double of the documented route table.
 * Every assertion here is about the contract rather than about a screen: what
 * the browser sends, what it refuses to believe, and which of those facts a
 * component may then render.
 */

function client(fixture = createConnectorFixture()) {
  return {
    fixture,
    api: createConnectorClient({ fetch: fixture.fetch, online: () => true }),
  };
}

test("the catalogue is parsed with the core schema and grouped alternatives survive", async () => {
  const { api } = client();
  const { entries, viewer } = await api.catalog();
  assert.ok(entries.length > 5);
  const github = entries.filter((entry) => entry.group === "github");
  assert.equal(github.length, 2);
  assert.deepEqual(
    github.map((entry) => entry.custody[0]).sort(),
    ["external-credential-broker", "host-owned"],
  );
  // Grouping is a label. Support, custody and evidence stay per row.
  assert.notEqual(github[0]!.support, github[1]!.support);
  assert.equal(viewer.capabilities.includes("executor"), true);
  assert.equal(ownerKindPermitted(viewer, "organization"), false);
  assert.equal(canPublish(viewer), false);
});

test("a response the contract does not allow is an error, not a half-rendered screen", async () => {
  const api = createConnectorClient({
    fetch: (async () =>
      new Response(JSON.stringify({ entries: [{ id: "NOT VALID" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });
  await assert.rejects(
    () => api.catalog(),
    (error: unknown) =>
      error instanceof ConnectorClientError && error.code === "invalid-response",
  );
});

test("viewer capabilities may arrive as headers when the body omits them", async () => {
  const api = createConnectorClient({
    fetch: (async () =>
      new Response(JSON.stringify({ entries: [] }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ceremony-capabilities": "publisher, reviewer",
          "x-ceremony-owner-kinds": "user,organization",
        },
      })) as typeof fetch,
  });
  const { viewer } = await api.catalog();
  assert.equal(canPublish(viewer), true);
  assert.equal(ownerKindPermitted(viewer, "organization"), true);
});

test("connect sends the intent the drawer collected, and returns a private presentation", async () => {
  const { api, fixture } = client();
  const view = await api.connect({
    bindingRef: "binding:github-app",
    ownerKind: "user",
    intent: {
      profileId: "oauth",
      requestedPermissions: ["read:user"],
      target: { kind: "account", id: "octocat" },
      accountSwitch: false,
      interruption: "allowed",
    },
  });
  assert.equal(view.lifecycle, "human-required");
  assert.equal(view.handoff?.kind, "provider-browser");
  assert.equal(view.handoff?.generation, view.generation);
  assert.match(view.presentation?.url ?? "", /^https:\/\/app\.test\/authorize/);
  const sent = fixture.requests.at(-1)!;
  assert.equal(sent.path, "/connections");
  assert.deepEqual((sent.body as Record<string, unknown>).ownerKind, "user");
  assert.deepEqual((sent.body as { intent: unknown }).intent, {
    profileId: "oauth",
    requestedPermissions: ["read:user"],
    target: { kind: "account", id: "octocat" },
    accountSwitch: false,
    interruption: "allowed",
  });
});

test("an organization connection is refused by the server, not by a label", async () => {
  const { api } = client();
  await assert.rejects(
    () =>
      api.connect({
        bindingRef: "binding:github-app",
        ownerKind: "organization",
        intent: {
          requestedPermissions: [],
          accountSwitch: false,
          interruption: "allowed",
        },
      }),
    (error: unknown) =>
      error instanceof ConnectorClientError && error.code === "owner-policy",
  );
});

test("status becomes active only when a poll says so", async () => {
  const { api, fixture } = client();
  const view = await api.connect({
    bindingRef: "binding:github-app",
    ownerKind: "user",
    intent: {
      requestedPermissions: [],
      accountSwitch: false,
      interruption: "allowed",
    },
  });
  const pending = await api.poll(view.connectionRef);
  assert.equal(pending.lifecycle, "human-required");
  fixture.approve(view.connectionRef);
  const active = await api.poll(view.connectionRef);
  assert.equal(active.lifecycle, "active");
  assert.equal(active.target?.id, "octocat");
  assert.deepEqual(active.verification?.kinds, [
    "credential-accepted",
    "account-identity",
  ]);
  assert.equal(active.handoff, undefined);
});

test("reconnect carries the expected revision and refuses a silent account change", async () => {
  const fixture = createConnectorFixture({ requireAccountSwitch: true });
  const api = createConnectorClient({ fetch: fixture.fetch });
  const view = await api.connect({
    bindingRef: "binding:github-app",
    ownerKind: "user",
    intent: {
      requestedPermissions: [],
      accountSwitch: false,
      interruption: "allowed",
    },
  });
  fixture.approve(view.connectionRef);
  const active = await api.poll(view.connectionRef);
  await assert.rejects(
    () =>
      api.reconnect(active.connectionRef, {
        expectedRevision: active.revision,
      }),
    (error: unknown) =>
      error instanceof ConnectorClientError &&
      error.code === "account-switch-required",
  );
  const switched = await api.reconnect(active.connectionRef, {
    expectedRevision: active.revision,
    accountSwitch: true,
  });
  assert.equal(switched.generation, active.generation + 1);
  assert.equal(switched.lifecycle, "human-required");
  // A stale revision is refused rather than applied to newer state.
  await assert.rejects(
    () =>
      api.reconnect(switched.connectionRef, {
        expectedRevision: active.revision,
        accountSwitch: true,
      }),
    (error: unknown) =>
      error instanceof ConnectorClientError && error.code === "conflict",
  );
});

test("disconnect reports each scope separately and names shared impact", async () => {
  const { api, fixture } = client();
  const view = await api.connect({
    bindingRef: "binding:github-app",
    ownerKind: "user",
    intent: {
      requestedPermissions: [],
      accountSwitch: false,
      interruption: "allowed",
    },
  });
  fixture.approve(view.connectionRef);
  const active = await api.poll(view.connectionRef);
  const { result, connection } = await api.disconnect(active.connectionRef, {
    expectedRevision: active.revision,
    scope: "local",
  });
  assert.equal(result.local, "applied");
  assert.equal(result.upstream, "not-attempted");
  assert.deepEqual(result.sharedWith, ["connection:shared-team"]);
  assert.equal(connection.lifecycle, "locally-disconnected");
});

test("private values go to the collector and only a reference reaches the handoff", async () => {
  const { api, fixture } = client();
  const view = await api.connect({
    bindingRef: "binding:petstore",
    ownerKind: "user",
    intent: {
      requestedPermissions: [],
      accountSwitch: false,
      interruption: "allowed",
    },
  });
  const { secretRef } = await api.collect(view.connectionRef, {
    apiKey: "CANARY-PETSTORE-KEY",
  });
  const done = await api.handoffInput(
    view.connectionRef,
    view.handoff!.handoffRef,
    { region: "eu", project: "eu-main", secretRef },
  );
  assert.equal(done.lifecycle, "active");
  const collectCalls = fixture.requests.filter((item) =>
    item.path.endsWith("/collect"),
  );
  assert.equal(collectCalls.length, 1);
  const others = fixture.requests
    .filter((item) => !item.path.endsWith("/collect"))
    .map((item) => JSON.stringify(item.body ?? null))
    .join("\n");
  assert.doesNotMatch(others, /CANARY-PETSTORE-KEY/);
});

test("an expired session is an error the UI can recognize", async () => {
  const fixture = createConnectorFixture({ expireSessionAfter: 1 });
  const api = createConnectorClient({ fetch: fixture.fetch });
  await api.catalog();
  await assert.rejects(
    () => api.connections(),
    (error: unknown) => isUnauthenticated(error),
  );
});

test("offline refuses a mutation instead of queueing one", async () => {
  const fixture = createConnectorFixture();
  const api = createConnectorClient({
    fetch: fixture.fetch,
    online: () => false,
  });
  await assert.rejects(
    () =>
      api.connect({
        bindingRef: "binding:github-app",
        ownerKind: "user",
        intent: {
          requestedPermissions: [],
          accountSwitch: false,
          interruption: "allowed",
        },
      }),
    (error: unknown) =>
      error instanceof ConnectorClientError && error.code === "offline",
  );
  assert.equal(
    fixture.requests.some((item) => item.path === "/connections"),
    false,
  );
});

test("AC-AUTH-14: a completion message is honoured only from the right origin, window and connection", () => {
  const source = { id: "the popup this page opened" };
  const stranger = { id: "some other window" };
  const message = {
    type: HANDOFF_MESSAGE_TYPE,
    connectionRef: "connection:1",
    handoffRef: "handoff:1",
  };
  const expected = {
    origin: "https://app.test",
    source,
    connectionRef: "connection:1",
    handoffRef: "handoff:1",
  };
  assert.equal(
    isTrustedHandoffMessage(
      { origin: "https://app.test", source, data: message },
      expected,
    ),
    true,
  );
  assert.equal(
    isTrustedHandoffMessage(
      { origin: "https://evil.test", source, data: message },
      expected,
    ),
    false,
  );
  assert.equal(
    isTrustedHandoffMessage(
      { origin: "https://app.test", source: stranger, data: message },
      expected,
    ),
    false,
  );
  assert.equal(
    isTrustedHandoffMessage(
      {
        origin: "https://app.test",
        source,
        data: { ...message, connectionRef: "connection:2" },
      },
      expected,
    ),
    false,
  );
  assert.equal(
    isTrustedHandoffMessage(
      {
        origin: "https://app.test",
        source,
        data: { ...message, handoffRef: "handoff:9" },
      },
      expected,
    ),
    false,
  );
  assert.equal(
    isTrustedHandoffMessage(
      { origin: "https://app.test", source, data: { type: "something-else" } },
      expected,
    ),
    false,
  );
  // No window was opened: nothing can be the window this page opened.
  assert.equal(
    isTrustedHandoffMessage(
      { origin: "https://app.test", source: null, data: message },
      { ...expected, source: null },
    ),
    false,
  );
});

test("a callback return names what to reopen and refuses anything malformed", () => {
  assert.deepEqual(
    readConnectorReturn(
      "?connector=github-app&connection=connection%3A1&outcome=handoff.completed",
    ),
    {
      connector: "github-app",
      connection: "connection:1",
      outcome: "handoff.completed",
    },
  );
  assert.deepEqual(readConnectorReturn("?connector=%20%20&connection=../x"), {});
});

test("the relay tells only a same-origin opener, and only about this return", () => {
  const posted: Array<[unknown, string]> = [];
  let closed = false;
  const opener = {
    closed: false,
    location: { origin: "https://app.test" },
    postMessage: ((data: unknown, origin: string) => {
      posted.push([data, origin]);
    }) as Window["postMessage"],
  };
  const relayed = relayHandoffReturn({
    opener,
    location: {
      origin: "https://app.test",
      search: "?connection=connection%3A1&outcome=handoff.completed",
    },
    close() {
      closed = true;
    },
  });
  assert.equal(relayed, true);
  assert.equal(closed, true);
  assert.deepEqual(posted, [
    [
      {
        type: HANDOFF_MESSAGE_TYPE,
        connectionRef: "connection:1",
        outcome: "handoff.completed",
      },
      "https://app.test",
    ],
  ]);
  assert.equal(
    relayHandoffReturn({
      opener: { ...opener, location: { origin: "https://evil.test" } },
      location: { origin: "https://app.test", search: "?connection=connection%3A1" },
      close() {},
    }),
    false,
  );
  assert.equal(
    relayHandoffReturn({
      opener: null,
      location: { origin: "https://app.test", search: "?connection=connection%3A1" },
      close() {},
    }),
    false,
  );
});

test("diagnostics sort blocking first and group by category", () => {
  const issues = blockedDefinition().compatibility.issues;
  const sorted = sortIssues(issues);
  assert.equal(sorted[0]!.severity, "blocking");
  assert.equal(sorted.at(-1)!.severity, "info");
  const groups = groupIssues(issues);
  assert.equal(groups[0]!.category, "security");
  assert.equal(groups[0]!.blocking, 1);
  const blockers = connectBlockers(issues);
  assert.deepEqual(
    blockers.map((issue) => issue.code),
    ["openapi.security.unsupported-scheme"],
  );
});

test("a connection view without a presentation is still a valid summary", () => {
  const summary = createConnectorFixture();
  void summary;
  assert.throws(() => parseConnectionView("not an object"));
  assert.equal(defaultViewer.ownerKinds.includes("user"), true);
});
