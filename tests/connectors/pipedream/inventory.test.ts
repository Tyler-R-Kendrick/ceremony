import assert from "node:assert/strict";
import { after, test } from "node:test";
import { catalogEntryFor } from "../../../src/server/connectors/inventory.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  bindAccount,
  makeBinding,
  makeConnection,
  makeContext,
  otherTenantActor,
  startHarness,
  type Harness,
} from "./harness.js";

/*
 * PD-01: app and connected-account inventory, the project access token, and
 * the inert import of component descriptions. Discovery reports the broker's
 * catalogue and this owner's accounts side by side without merging them, and
 * the project token is minted once, kept in custody and never shown.
 */

const open: Harness[] = [];
async function harness(options: Parameters<typeof startHarness>[0] = {}) {
  const started = await startHarness(options);
  open.push(started);
  return started;
}
after(async () => {
  for (const item of open) await item.close();
});

function discoverContext(h: Harness) {
  const binding = makeBinding({ apiOrigin: h.double.origin });
  const connection = makeConnection({
    binding,
    lifecycle: "authorization-required",
    externalIds: {
      projectId: h.double.projectId,
      environment: h.environment,
      app: "slack",
      externalUserId: h.externalUserId(),
    },
  });
  return {
    binding,
    connection,
    ctx: makeContext({ harness: h, binding, connection }),
  };
}

test("discovery lists apps by slug with their auth requirements and paginates", async () => {
  const h = await harness();
  const { ctx } = discoverContext(h);

  const first = await h.adapter.discover!(ctx, { limit: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.freshness.source, "live");
  assert.equal(first.freshness.stale, false);
  assert.ok(first.nextCursor, "a further page is offered");

  const slack = first.items[0]!;
  assert.equal(slack.identity.ecosystem, "pipedream");
  assert.equal(slack.identity.nativeId, "slack");
  assert.equal(
    slack.identity.authorityNamespace,
    `${h.double.projectId}:production`,
    "the authority is one project in one environment",
  );
  assert.equal(slack.displayName, "Slack");
  assert.notEqual(
    slack.identity.nativeId,
    slack.displayName,
    "the configured identity is the slug, not the display name",
  );
  assert.equal(slack.provenance?.authType, "oauth");
  assert.equal(slack.provenance?.proxyEnabled, "true");
  assert.equal(slack.provenance?.environment, "production");

  const second = await h.adapter.discover!(ctx, {
    limit: 2,
    cursor: first.nextCursor!,
  });
  assert.equal(second.items.length, 2);
  assert.notDeepEqual(
    second.items.map((item) => item.identity.nativeId),
    first.items.map((item) => item.identity.nativeId),
  );

  // Two apps that share a display word stay separate entries with distinct slugs.
  const all = [...first.items, ...second.items].map(
    (item) => item.identity.nativeId,
  );
  assert.ok(all.includes("slack"));
  assert.ok(all.includes("slack_bot"));

  // An app that cannot be proxied says so rather than being hidden.
  const airtable = second.items.find(
    (item) => item.identity.nativeId === "airtable_oauth",
  );
  assert.equal(airtable?.provenance?.proxyEnabled, "false");
});

test("discovery counts only this owner's accounts, in this environment", async () => {
  const h = await harness();
  const { ctx } = discoverContext(h);
  h.double.seedAccount({
    externalUserId: h.externalUserId(),
    app: "slack",
    environment: "production",
  });
  h.double.seedAccount({
    externalUserId: h.externalUserId(),
    app: "slack",
    environment: "development",
  });
  h.double.seedAccount({
    externalUserId: "someone-else",
    app: "slack",
    environment: "production",
  });
  h.double.seedAccount({
    externalUserId: h.externalUserId(otherTenantActor),
    app: "slack",
    environment: "production",
  });

  const result = await h.adapter.discover!(ctx, { scope: { app: "slack" } });
  assert.equal(result.items.length, 1);
  assert.equal(
    result.items[0]!.provenance?.connectedAccounts,
    "1",
    "other users, other tenants and the other environment do not count",
  );

  const [request] = h.double.received(
    "GET",
    `/v1/connect/${h.double.projectId}/accounts`,
  );
  assert.equal(
    request!.url.searchParams.get("external_user_id"),
    h.externalUserId(),
  );
  assert.equal(request!.headers["x-pd-environment"], "production");
});

test("an unavailable account listing is reported as unknown, never as none", async () => {
  const h = await harness();
  const { ctx } = discoverContext(h);
  h.double.seedAccount({
    externalUserId: h.externalUserId(),
    app: "slack",
    environment: "production",
  });
  h.double.faults.accountsStatus = 403;

  const result = await h.adapter.discover!(ctx, { limit: 2 });
  assert.equal(result.items.length, 2, "the catalogue is still useful");
  assert.equal(result.items[0]!.provenance?.connectedAccounts, "unknown");
  assert.equal(result.items[0]!.provenance?.healthyAccounts, undefined);
  const issue = result.issues.find(
    (item) => item.code === "pipedream.accounts.unavailable",
  );
  assert.ok(issue, "the refusal is reported rather than swallowed");
  assert.equal(issue.severity, "warning");
  assert.equal(issue.executionImpact, "none");
  assert.equal(issue.dimension, "discover");

  h.double.faults.accountsStatus = undefined;
  const recovered = await h.adapter.discover!(ctx, { limit: 2 });
  assert.equal(recovered.items[0]!.provenance?.connectedAccounts, "1");
  assert.deepEqual(recovered.issues, []);
});

test("the project access token is minted once, kept in custody and never shown", async () => {
  const h = await harness();
  const { ctx } = discoverContext(h);
  const [a, b, c] = await Promise.all([
    h.adapter.discover!(ctx, { limit: 1 }),
    h.adapter.discover!(ctx, { limit: 1 }),
    h.adapter.discover!(ctx, { limit: 1 }),
  ]);
  assert.ok(a && b && c);
  const tokenRequests = h.double.received("POST", "/v1/oauth/token");
  assert.equal(
    tokenRequests.length,
    1,
    "concurrent calls share one client-credentials grant",
  );
  assert.equal(h.double.accessTokens.size, 1);
  // Minted by the shared engine: the documented JSON body, and the grant
  // journaled like any other client-credentials request.
  assert.equal(tokenRequests[0]!.headers["content-type"], "application/json");
  assert.deepEqual(
    Object.keys(JSON.parse(tokenRequests[0]!.body.toString("utf8"))).sort(),
    ["client_id", "client_secret", "grant_type"],
  );
  const grants = h.ports.inspect
    .effects()
    .filter(
      (entry) => entry.intent.operation === "oauth.client-credentials.grant",
    );
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.outcome?.status, "applied");

  const [token] = [...h.double.accessTokens.keys()];
  const serialized = JSON.stringify([a, b, c]);
  assert.equal(serialized.includes(token!), false);
  assert.equal(serialized.includes(h.double.clientSecret), false);

  // The token lives under a workload-owned reference, not the user's.
  const refs = h.ports.inspect.credentialRefs();
  assert.equal(refs.length, 1);
  assert.equal(
    h.ports.inspect.credentialMaterial(refs[0]!)?.access_token,
    token,
  );
});

test("a rejected client credential is reported without echoing the provider", async () => {
  const h = await harness();
  const { ctx } = discoverContext(h);
  h.double.faults.rejectClientCredentials = true;
  await assert.rejects(
    h.adapter.discover!(ctx, {}),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "upstream-rejected" &&
      error.detail === "pipedream.oauth.rejected" &&
      !error.message.includes("invalid_client"),
  );
});

test("missing configuration is reported, never guessed", async () => {
  const h = await harness({ omitConfiguration: ["PIPEDREAM_CLIENT_SECRET"] });
  const { binding, connection, ctx } = discoverContext(h);
  const start = await h.adapter.authorize!(ctx, {
    ownerKind: "user",
    requestedPermissions: [],
    accountSwitch: false,
    interruption: "allowed",
  });
  assert.equal(start.kind, "configuration-required");
  if (start.kind !== "configuration-required") throw new Error("unreachable");
  assert.deepEqual(start.missing, ["PIPEDREAM_CLIENT_SECRET"]);
  assert.equal(h.double.requests.length, 0, "nothing was attempted");

  await assert.rejects(
    h.adapter.invoke!(makeContext({ harness: h, binding, connection }), {
      operationRef: "proxy.read-channel",
      commandId: "cmd-unconfigured",
      input: { query: { channel: "C1" } },
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "configuration-required",
  );
});

test("an invalid configured environment is a configuration error, not a default", async () => {
  const h = await harness();
  h.ports.configuration.set("PIPEDREAM_ENVIRONMENT", "staging");
  const { ctx } = discoverContext(h);
  await assert.rejects(
    h.adapter.discover!(ctx, {}),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "configuration-required" &&
      error.detail === "pipedream.configuration.invalid",
  );
});

test("the catalogue entry reports custody, runtime and configuration honestly", async () => {
  const h = await harness();
  const configured = catalogEntryFor(
    h.adapter,
    new Set(Object.keys(h.configuration)),
  );
  assert.equal(configured.id, "pipedream-connect");
  assert.equal(configured.ecosystem, "pipedream");
  assert.equal(configured.service, "pipedream");
  assert.equal(configured.support, "provider-backed");
  assert.deepEqual([...configured.custody].sort(), [
    "external-credential-broker",
    "external-execution-broker",
  ]);
  assert.deepEqual(configured.runtimes, ["hosted-server"]);
  assert.deepEqual(
    configured.configuration.map((item) => [item.name, item.classification]),
    [
      ["PIPEDREAM_PROJECT_ID", "public"],
      ["PIPEDREAM_ENVIRONMENT", "public"],
      ["PIPEDREAM_CLIENT_ID", "public"],
      ["PIPEDREAM_CLIENT_SECRET", "secret"],
    ],
  );
  const invoke = configured.capabilities.find(
    (status) => status.dimension === "invoke",
  );
  assert.equal(invoke?.implementation, "implemented");
  assert.equal(invoke?.configuration, "ready");
  assert.equal(invoke?.evidence, "protocol-fixture");
  const revoke = configured.capabilities.find(
    (status) => status.dimension === "revoke",
  );
  assert.equal(revoke?.implementation, "unsupported");
  assert.equal(revoke?.evidence, "not-tested");
  assert.ok(
    revoke?.limitations[0]?.includes("no endpoint"),
    "the native limitation is stated, not hidden",
  );

  const unconfigured = catalogEntryFor(h.adapter, new Set());
  assert.equal(unconfigured.support, "unconfigured");
  assert.equal(
    unconfigured.capabilities.find((status) => status.dimension === "invoke")
      ?.configuration,
    "missing",
  );
});

test("importing component descriptions produces inert capabilities", async () => {
  const h = await harness();
  const { ctx } = discoverContext(h);
  const document = JSON.stringify({
    data: h.double.components,
    page_info: { count: 4, total_count: 4 },
  });
  const outcome = await h.adapter.import!(ctx, {
    bytes: new TextEncoder().encode(document),
    mediaType: "application/json",
    origin: { kind: "provider-api" },
  });

  assert.equal(outcome.definitions.length, 1);
  const definition = outcome.definitions[0]!;
  assert.equal(definition.identity.ecosystem, "pipedream");
  assert.equal(definition.identity.nativeId, "slack");
  assert.equal(definition.capabilities.length, 4);

  const send = definition.capabilities.find(
    (capability) => capability.nativeId === "slack-send-message-to-channel",
  );
  assert.equal(send?.kind, "action");
  assert.equal(send?.dataClassification, "unknown");
  assert.equal(send?.cost, "unknown");
  assert.equal(
    send?.effect,
    "unknown",
    "an annotation is a hint, not an effect classification",
  );
  const list = definition.capabilities.find(
    (capability) => capability.nativeId === "slack-list-channels",
  );
  assert.equal(list?.effect, "read");

  const trigger = definition.capabilities.find(
    (capability) => capability.nativeId === "slack-new-message-in-channel",
  );
  assert.equal(trigger?.kind, "event");
  assert.equal(definition.events.length, 1);
  assert.equal(definition.events[0]?.transport, "http-webhook");
  assert.equal(definition.events[0]?.verification, "vendor");

  // Props travel as inert data; nothing is executed or fetched.
  const props = send?.nativeExtensions?.[
    "pipedream.configurableProps"
  ] as Array<{
    name: string;
  }>;
  assert.deepEqual(
    props.map((prop) => prop.name),
    ["slack", "channel", "text", "attachments"],
  );

  // A component this adapter cannot run is blocked precisely, not dropped.
  const stash = outcome.issues.find(
    (issue) => issue.code === "pipedream.component.stash-required",
  );
  assert.equal(stash?.executionImpact, "blocks-operation");
  assert.equal(stash?.dimension, "invoke");
  assert.ok(
    outcome.executableCandidates.includes("slack-upload-file"),
    "the description is still discoverable",
  );

  // Import registers nothing executable: no destination, no operation.
  assert.deepEqual(definition.declaredServers, []);
  assert.equal(
    definition.compatibility.dimensions.invoke,
    "requires-configuration",
  );
  assert.equal(definition.authentication[0]?.kind, "external-broker");
  assert.equal(outcome.source.digest.algorithm, "sha256");
  assert.equal(outcome.source.byteLength, document.length);
});

test("an import that is not a component document is refused within bounds", async () => {
  const h = await harness();
  const { ctx } = discoverContext(h);
  const cases: Array<[Uint8Array, string, string]> = [
    [
      new TextEncoder().encode("{not json"),
      "application/json",
      "pipedream.import.malformed",
    ],
    [
      new TextEncoder().encode(JSON.stringify({ nothing: true })),
      "application/json",
      "pipedream.import.unrecognized",
    ],
    [
      new TextEncoder().encode("key: value"),
      "text/yaml",
      "pipedream.import.media-type",
    ],
  ];
  for (const [bytes, mediaType, detail] of cases)
    await assert.rejects(
      h.adapter.import!(ctx, { bytes, mediaType, origin: { kind: "upload" } }),
      (error: unknown) =>
        error instanceof ConnectorError && error.detail === detail,
    );

  // A deeply nested document is rejected by bounds rather than by recursion.
  let nested: unknown = {};
  for (let depth = 0; depth < 200; depth++) nested = { nested };
  await assert.rejects(
    h.adapter.import!(ctx, {
      bytes: new TextEncoder().encode(
        JSON.stringify({
          data: [{ key: "a", name: "a", version: "1", nested }],
        }),
      ),
      mediaType: "application/json",
      origin: { kind: "upload" },
    }),
    (error: unknown) => error instanceof ConnectorError,
  );
});

test("a connection for a different app under the same binding is refused", async () => {
  const h = await harness();
  const binding = makeBinding({ apiOrigin: h.double.origin });
  const account = h.double.seedAccount({
    externalUserId: h.externalUserId(),
    app: "gitlab",
    environment: "production",
  });
  const connection = await bindAccount(h, makeConnection({ binding }), {
    accountId: account.id,
    externalUserId: h.externalUserId(),
    projectId: h.double.projectId,
    environment: "production",
    app: "gitlab",
  });
  await assert.rejects(
    h.adapter.verify!(makeContext({ harness: h, binding, connection })),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "pipedream.app.mismatch",
  );
});
