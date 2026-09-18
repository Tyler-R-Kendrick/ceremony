import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type { RuntimeBinding } from "../../../src/server/connectors/binding.js";
import type { ConnectionRecord } from "../../../src/server/connectors/ports.js";
import {
  EVENTS_PREFIX,
  bindAccount,
  defaultSettings,
  makeBinding,
  makeConnection,
  makeContext,
  startHarness,
  type Harness,
} from "./harness.js";

/*
 * PD-04: triggers and their deliveries. A deploy is bound to the host owner's
 * derived external user and to an approved destination; deploying the same
 * thing twice does not produce two triggers; and a delivery is an event only
 * when it carries the documented signature over the body that arrived.
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

async function connected(
  h: Harness,
  binding = makeBinding({ apiOrigin: h.double.origin }),
): Promise<{ binding: RuntimeBinding; connection: ConnectionRecord }> {
  const account = h.double.seedAccount({
    externalUserId: h.externalUserId(),
    app: "slack",
    environment: h.environment,
  });
  const connection = await bindAccount(h, makeConnection({ binding }), {
    accountId: account.id,
    externalUserId: h.externalUserId(),
    projectId: h.double.projectId,
    environment: h.environment,
    app: "slack",
  });
  return { binding, connection };
}

const deployRequest = (commandId: string, conversations = ["C123"]) => ({
  operationRef: "trigger.deploy",
  commandId,
  input: { props: { conversations } },
});

test("a deployed trigger names an approved destination and the derived external user", async () => {
  const h = await harness();
  const { binding, connection } = await connected(h);
  const result = await h.adapter.invoke!(
    makeContext({ harness: h, binding, connection }),
    deployRequest("cmd-deploy-1"),
  );

  assert.equal(result.state, "complete");
  assert.equal(h.double.deployCalls.length, 1);
  const call = h.double.deployCalls[0]!;
  assert.equal(call.id, "slack-new-message-in-channel");
  assert.equal(call.externalUserId, h.externalUserId());
  assert.equal(call.environment, "production");
  assert.deepEqual(call.configuredProps.slack, {
    authProvisionId: connection.externalIds.accountId,
  });
  assert.deepEqual(call.configuredProps.conversations, ["C123"]);

  // The delivery URL is on the binding's approved events destination.
  const delivery = new URL(call.webhookUrl!);
  assert.equal(delivery.origin, "https://app.example");
  assert.equal(delivery.pathname.startsWith(`${EVENTS_PREFIX}/`), true);

  const output = result.output as {
    trigger: { id: string; active: boolean };
    delivery: { url: string; signingKeyRef?: string };
  };
  assert.match(output.trigger.id, /^dc_/);
  assert.equal(output.trigger.active, true);
  assert.ok(output.delivery.signingKeyRef, "the signing key went to custody");
  const material = h.ports.inspect.credentialMaterial(
    output.delivery.signingKeyRef!,
  );
  assert.equal(
    material?.signingKey,
    h.double.triggers.get(output.trigger.id)!.webhook_signing_key,
  );
  assert.equal(
    JSON.stringify(result).includes(material!.signingKey!),
    false,
    "the signing key itself never appears in a result",
  );
});

test("deploying the same trigger twice does not create a second trigger", async () => {
  const h = await harness();
  const { binding, connection } = await connected(h);
  const ctx = () => makeContext({ harness: h, binding, connection });

  const first = await h.adapter.invoke!(ctx(), deployRequest("cmd-a"));
  // A different command id is still the same intent: same owner, same
  // component, same configuration, same destination.
  const second = await h.adapter.invoke!(ctx(), deployRequest("cmd-b"));

  assert.equal(first.state, "complete");
  assert.equal(second.state, "complete");
  assert.equal(second.code, "pipedream.trigger.already-deployed");
  assert.equal(h.double.deployCalls.length, 1, "the broker was asked once");
  assert.equal(h.double.triggers.size, 1);
  assert.equal(
    (first.output as { trigger: { id: string } }).trigger.id,
    (second.output as { trigger: { id: string } }).trigger.id,
  );

  // A different configuration is a different trigger.
  const third = await h.adapter.invoke!(
    ctx(),
    deployRequest("cmd-c", ["C999"]),
  );
  assert.equal(third.state, "complete");
  assert.equal(h.double.deployCalls.length, 2);
  assert.equal(h.double.triggers.size, 2);
});

test("a deploy whose response is lost is reconciled instead of deployed again", async () => {
  const h = await harness({ adapter: { timeouts: { write: 60 } } });
  const { binding, connection } = await connected(h);
  const ctx = () => makeContext({ harness: h, binding, connection });
  h.double.faults.deployDelayMs = 400;

  const lost = await h.adapter.invoke!(ctx(), deployRequest("cmd-lost"));
  assert.equal(lost.state, "indeterminate");
  assert.equal(lost.code, "pipedream.trigger.indeterminate");
  assert.equal(
    h.double.triggers.size,
    1,
    "the broker did create the trigger before the response was lost",
  );

  h.double.faults.deployDelayMs = 0;
  const reconciled = await h.adapter.invoke!(ctx(), deployRequest("cmd-lost"));
  assert.equal(reconciled.state, "complete");
  assert.equal(reconciled.code, "pipedream.trigger.reconciled");
  assert.equal(h.double.deployCalls.length, 1, "no second deploy was sent");
  assert.equal(h.double.triggers.size, 1);
  const journal = h.ports.inspect
    .effects()
    .filter((entry) => entry.intent.operation === "pipedream.trigger.deploy");
  assert.equal(journal.length, 1);
  assert.equal(journal[0]!.outcome?.status, "reconciled");
});

test("a binding without an approved webhook destination cannot deploy", async () => {
  const h = await harness();
  const settings = defaultSettings("slack");
  const operations = settings.operations as Record<string, unknown>;
  const binding = makeBinding({
    apiOrigin: h.double.origin,
    settings: {
      ...settings,
      operations: {
        ...operations,
        "trigger.deploy": {
          appProp: "slack",
          props: ["conversations"],
          webhookDestinationId: "not-approved",
          webhookPath: EVENTS_PREFIX,
        },
      },
    },
  });
  const { connection } = await connected(h, binding);
  await assert.rejects(
    h.adapter.invoke!(
      makeContext({ harness: h, binding, connection }),
      deployRequest("cmd-bad-destination"),
    ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "network-policy" &&
      error.detail === "pipedream.trigger.destination-unapproved",
  );
  assert.equal(h.double.deployCalls.length, 0);
});

test("a caller cannot supply a webhook url or an unlisted prop", async () => {
  const h = await harness();
  const { binding, connection } = await connected(h);
  for (const input of [
    { props: { conversations: ["C1"] }, webhook_url: "https://evil.example/x" },
    { props: { conversations: ["C1"], webhook_url: "https://evil.example/x" } },
  ])
    await assert.rejects(
      h.adapter.invoke!(makeContext({ harness: h, binding, connection }), {
        operationRef: "trigger.deploy",
        commandId: "cmd-evil-hook",
        input,
      }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "invalid-request",
    );
  assert.equal(h.double.deployCalls.length, 0);
});

test("listing and deleting triggers stay inside this owner's external user", async () => {
  const h = await harness();
  const { binding, connection } = await connected(h);
  const ctx = () => makeContext({ harness: h, binding, connection });
  const deployed = await h.adapter.invoke!(ctx(), deployRequest("cmd-list-1"));
  const triggerId = (deployed.output as { trigger: { id: string } }).trigger.id;

  // Another host owner's trigger at the same broker, same environment.
  const foreign = h.double.seedAccount({
    externalUserId: "someone-else",
    app: "slack",
    environment: "production",
  });
  void foreign;
  h.double.triggers.set("dc_foreign", {
    ...h.double.triggers.get(triggerId)!,
    id: "dc_foreign",
    external_user_id: "someone-else",
  });

  const listed = await h.adapter.invoke!(ctx(), {
    operationRef: "trigger.list",
    commandId: "cmd-list-2",
    input: {},
  });
  assert.equal(listed.state, "complete");
  const triggers = (listed.output as { triggers: Array<{ id: string }> })
    .triggers;
  assert.deepEqual(
    triggers.map((trigger) => trigger.id),
    [triggerId],
  );

  // Deleting the other owner's trigger is simply not possible.
  const missing = await h.adapter.invoke!(ctx(), {
    operationRef: "trigger.delete",
    commandId: "cmd-del-1",
    input: { triggerId: "dc_foreign" },
  });
  assert.equal(missing.state, "failed");
  assert.equal(missing.code, "pipedream.trigger.not-found");
  assert.equal(h.double.triggers.has("dc_foreign"), true);

  const removed = await h.adapter.invoke!(ctx(), {
    operationRef: "trigger.delete",
    commandId: "cmd-del-2",
    input: { triggerId },
  });
  assert.equal(removed.state, "complete");
  assert.equal(h.double.triggers.has(triggerId), false);
});

test("a delivery is an event only when it carries the documented signature", async () => {
  const h = await harness();
  const { binding, connection } = await connected(h);
  const deployed = await h.adapter.invoke!(
    makeContext({ harness: h, binding, connection }),
    deployRequest("cmd-sign"),
  );
  const output = deployed.output as {
    trigger: { id: string };
    delivery: { signingKeyRef: string };
  };
  const signingKey = h.double.triggers.get(output.trigger.id)!
    .webhook_signing_key!;
  // The command layer records the reference on the connection.
  const receiving = {
    ...connection,
    state: {
      pipedreamTriggerKeys: { [output.trigger.id]: output.delivery.signingKeyRef },
    },
  };
  const ctx = () => makeContext({ harness: h, binding, connection: receiving });
  const body = JSON.stringify({ event: { text: "hello" }, ts: "1700000000.1" });
  const signed = h.double.signDelivery(signingKey, body);
  const bytes = new TextEncoder().encode(body);

  const verified = await h.adapter.events!.verify(ctx(), {
    headers: new Headers({ "x-pd-signature": signed.header }),
    body: bytes,
    receivedAt: Date.now(),
  });
  assert.ok(verified, "a correctly signed delivery is an event");
  assert.equal(verified.verification.method, "vendor-signature");
  assert.equal(verified.providerEventType, "pipedream.trigger.event");
  assert.equal(verified.connectionRef, connection.connectionRef);
  assert.equal(verified.payloadClassification, "personal");
  assert.deepEqual(verified.payload, JSON.parse(body));

  // The same signature over a different body is not a signature for it.
  const tampered = await h.adapter.events!.verify(ctx(), {
    headers: new Headers({ "x-pd-signature": signed.header }),
    body: new TextEncoder().encode(body.replace("hello", "goodbye")),
    receivedAt: Date.now(),
  });
  assert.equal(tampered, undefined);

  // A signature from another key, an absent header and a stale timestamp.
  const wrongKey = h.double.signDelivery("whsk_attacker", body);
  assert.equal(
    await h.adapter.events!.verify(ctx(), {
      headers: new Headers({ "x-pd-signature": wrongKey.header }),
      body: bytes,
      receivedAt: Date.now(),
    }),
    undefined,
  );
  assert.equal(
    await h.adapter.events!.verify(ctx(), {
      headers: new Headers({}),
      body: bytes,
      receivedAt: Date.now(),
    }),
    undefined,
  );
  const old = h.double.signDelivery(
    signingKey,
    body,
    Math.floor(Date.now() / 1000) - 4000,
  );
  assert.equal(
    await h.adapter.events!.verify(ctx(), {
      headers: new Headers({ "x-pd-signature": old.header }),
      body: bytes,
      receivedAt: Date.now(),
    }),
    undefined,
  );

  // A connection that holds no signing key cannot verify anything.
  assert.equal(
    await h.adapter.events!.verify(
      makeContext({ harness: h, binding, connection }),
      {
        headers: new Headers({ "x-pd-signature": signed.header }),
        body: bytes,
        receivedAt: Date.now(),
      },
    ),
    undefined,
  );
});

test("an unsigned connection webhook is never an event", async () => {
  const h = await harness();
  const { binding, connection } = await connected(h);
  const account = h.double.seedAccount({
    externalUserId: h.externalUserId(),
    app: "slack",
    environment: "production",
  });
  // Build a real connect token so the payload is the documented shape.
  const response = await fetch(
    `${h.double.origin}/v1/connect/${h.double.projectId}/tokens`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pd-environment": "production",
        authorization: `Bearer ${await mintToken(h)}`,
      },
      body: JSON.stringify({ external_user_id: h.externalUserId() }),
    },
  );
  const { token } = (await response.json()) as { token: string };
  const payload = JSON.stringify(
    h.double.connectionWebhookPayload(token, account),
  );

  const verified = await h.adapter.events!.verify(
    makeContext({ harness: h, binding, connection }),
    {
      headers: new Headers({ "content-type": "application/json" }),
      body: new TextEncoder().encode(payload),
      receivedAt: Date.now(),
    },
  );
  assert.equal(
    verified,
    undefined,
    "Pipedream documents no signature for connection webhooks, so they are refused",
  );
});

async function mintToken(h: Harness): Promise<string> {
  const response = await fetch(`${h.double.origin}/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: h.double.clientId,
      client_secret: h.double.clientSecret,
    }),
  });
  return ((await response.json()) as { access_token: string }).access_token;
}

test("disconnect separates a local unlink from deleting anything at the broker", async () => {
  const h = await harness();
  const { binding, connection } = await connected(h);
  const deployed = await h.adapter.invoke!(
    makeContext({ harness: h, binding, connection }),
    deployRequest("cmd-disc"),
  );
  const triggerId = (deployed.output as { trigger: { id: string } }).trigger.id;
  const withTrigger = {
    ...connection,
    state: { pipedreamTriggers: { primary: triggerId } },
  };

  const local = await h.adapter.disconnect!(
    makeContext({ harness: h, binding, connection: withTrigger }),
    "local",
  );
  assert.deepEqual(local, {
    local: "applied",
    broker: "not-attempted",
    upstream: "not-attempted",
  });
  assert.equal(h.double.accounts.size, 1, "a local unlink deletes nothing");
  assert.equal(h.double.triggers.size, 1);

  const upstream = await h.adapter.disconnect!(
    makeContext({ harness: h, binding, connection: withTrigger }),
    "upstream",
  );
  assert.equal(upstream.upstream, "unsupported");
  assert.equal(h.double.accounts.size, 1);

  const broker = await h.adapter.disconnect!(
    makeContext({ harness: h, binding, connection: withTrigger }),
    "broker",
  );
  assert.equal(broker.broker, "applied");
  assert.equal(broker.upstream, "not-attempted");
  assert.equal(h.double.triggers.size, 0);
  assert.equal(h.double.accounts.size, 0);

  const revoked = await h.adapter.revoke!(
    makeContext({ harness: h, binding, connection: withTrigger }),
  );
  assert.deepEqual(revoked, {
    local: "not-attempted",
    broker: "not-attempted",
    upstream: "unsupported",
  });
});
