import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ASYNCAPI_IMPORTER_ID,
  readAsyncApi,
  supportedAsyncApiVersions,
} from "../../../src/server/connectors/events/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { normalizedDefinitionSchema } from "../../../src/core/connectors/index.js";

/*
 * EVT-01. AsyncAPI is an event description, and it stays one: channels,
 * messages and operations become event descriptors, never HTTP capabilities,
 * and a transport this runtime cannot receive keeps its native name plus a
 * diagnostic that says which operation it blocks.
 */

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/asyncapi/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const options = {
  sourceRef: "source:asyncapi",
  definitionRef: "definition:asyncapi",
};
const acme = () => fixture("acme-billing-webhooks-3.1.0");
const streetlights = () => fixture("streetlights-kafka-3.0.0");
const eventOf = (
  result: Awaited<ReturnType<typeof readAsyncApi>>,
  nativeId: string,
) => {
  const found = result.definition.events.find(
    (event) => event.nativeId === nativeId,
  );
  assert.ok(found, `expected an event descriptor for ${nativeId}`);
  return found;
};
const extensionOf = (event: {
  nativeExtensions?: Record<string, unknown> | undefined;
}) =>
  (event.nativeExtensions as { asyncapi: Record<string, unknown> }).asyncapi;

test("AC-NG-07/EVT-01: AsyncAPI 3.1.0 import yields events, never HTTP capabilities", async () => {
  const result = await readAsyncApi(acme(), options);
  // The whole document is events; an operation is not an invocable capability.
  assert.deepEqual(result.definition.capabilities, []);
  assert.equal(result.definition.display.ecosystem, "asyncapi");
  assert.equal(result.definition.identity.ecosystem, "asyncapi");
  assert.equal(result.definition.importer.id, ASYNCAPI_IMPORTER_ID);
  assert.equal(result.document.version, "3.1.0");
  assert.equal(result.document.id, "urn:example:acme:billing-webhooks");
  assert.equal(result.definition.identity.nativeVersion, "2026-09-01");
  assert.equal(
    result.definition.compatibility.dimensions.invoke,
    "unsupported",
  );
  assert.equal(result.definition.compatibility.dimensions.events, "adapted");
  // Importing describes; it never enables invocation or authorization by itself.
  assert.equal(
    result.definition.compatibility.dimensions.authorize,
    "requires-configuration",
  );
  // One descriptor per (operation, message): identity is not flattened away.
  assert.deepEqual(
    result.definition.events.map((event) => event.nativeId),
    [
      "onInvoiceEvent/invoicePaid",
      "onInvoiceEvent/invoiceVoided",
      "onConnectionRevoked/connectionRevoked",
      "onLedgerEntry/entryPosted",
      "onTick/tick",
      "acknowledgeDelivery/ackDelivery",
      "onMissingChannel",
      "onExternalChannel",
    ],
  );
  assert.ok(normalizedDefinitionSchema.safeParse(result.definition).success);
});

test("EVT-01: channel address, message identity and operation action survive normalization", async () => {
  const result = await readAsyncApi(acme(), options);
  const paid = eventOf(result, "onInvoiceEvent/invoicePaid");
  const extension = extensionOf(paid) as {
    operation: string;
    action: string;
    direction: string;
    channel: {
      name: string;
      address: string;
      title: string;
      servers: string[];
    };
    message: {
      key: string;
      name: string;
      title: string;
      contentType: string;
      payloadRef: string;
      headers: string[];
    };
    protocols: string[];
    http: { method: string };
    security: { semantics: string; declared: boolean; profiles: string[] };
  };
  assert.equal(extension.operation, "onInvoiceEvent");
  assert.equal(extension.action, "receive");
  assert.equal(extension.direction, "inbound");
  assert.equal(extension.channel.name, "invoiceEvents");
  assert.equal(extension.channel.address, "/webhooks/invoices");
  assert.equal(extension.channel.title, "Invoice events");
  assert.deepEqual(extension.channel.servers, ["webhooks"]);
  assert.equal(extension.message.key, "invoicePaid");
  assert.equal(extension.message.name, "invoice.paid");
  assert.equal(extension.message.title, "Invoice paid");
  assert.equal(extension.message.contentType, "application/json");
  assert.equal(extension.message.payloadRef, "/components/schemas/Invoice");
  assert.equal(paid.messageSchemaRef, "/components/schemas/Invoice");
  assert.equal(paid.label, "Invoice paid");
  // The operation trait's HTTP binding merged into the operation.
  assert.equal(extension.http.method, "POST");
  // Security is any-of over declared profile ids, not a boolean.
  assert.equal(extension.security.semantics, "any-of");
  assert.deepEqual(extension.security.profiles, ["deliveryToken"]);
  assert.deepEqual(paid.authentication, ["deliveryToken"]);
  // A message declaring the Standard Webhooks headers is recognized as such.
  assert.equal(paid.verification, "standard-webhooks");
  // An operation that declares an empty security list is declared-anonymous,
  // which is not the same as saying nothing about security.
  const revoked = eventOf(result, "onConnectionRevoked/connectionRevoked");
  assert.deepEqual(revoked.authentication, []);
});

test("EVT-01: a channel address that is a broker topic survives, and its channel keeps its native spelling", async () => {
  const result = await readAsyncApi(acme(), options);
  const ledger = eventOf(result, "onLedgerEntry/entryPosted");
  const extension = extensionOf(ledger) as {
    channel: { name: string; address: string };
    bindings: {
      channel: Record<string, { topic?: string; partitions?: number }>;
    };
  };
  assert.equal(extension.channel.name, "ledger.entries");
  assert.equal(extension.channel.address, "acme.ledger.entries.v1");
  // The Kafka binding is preserved verbatim as inert data, never executed.
  assert.equal(
    extension.bindings.channel.kafka?.topic,
    "acme.ledger.entries.v1",
  );
  assert.equal(extension.bindings.channel.kafka?.partitions, 12);
});

test("EVT-01: only HTTP webhook receive operations claim a transport; everything else is unsupported with its native binding", async () => {
  const result = await readAsyncApi(acme(), options);
  assert.deepEqual(result.receivable, [
    "onInvoiceEvent/invoicePaid",
    "onInvoiceEvent/invoiceVoided",
    "onConnectionRevoked/connectionRevoked",
  ]);
  for (const nativeId of result.receivable) {
    const event = eventOf(result, nativeId);
    assert.equal(event.transport, "http-webhook");
    assert.equal(event.nativeTransport, undefined);
  }
  const kafka = eventOf(result, "onLedgerEntry/entryPosted");
  assert.equal(kafka.transport, "unsupported");
  assert.equal(kafka.nativeTransport, "kafka");
  const websocket = eventOf(result, "onTick/tick");
  assert.equal(websocket.transport, "unsupported");
  assert.equal(websocket.nativeTransport, "ws");
  // A send operation is outbound: Ceremony has no publisher runtime for it.
  const outbound = eventOf(result, "acknowledgeDelivery/ackDelivery");
  assert.equal(outbound.transport, "unsupported");
  assert.equal(extensionOf(outbound).direction, "outbound");
});

test("EVT-01: an unsupported transport produces a precise blocking-operation diagnostic, not silence", async () => {
  const result = await readAsyncApi(acme(), options);
  const transport = result.issues.filter(
    (issue) => issue.code === "structure.unsupported-transport",
  );
  assert.deepEqual(
    transport.map((issue) => issue.sourcePointer),
    ["/operations/onLedgerEntry", "/operations/onTick"],
  );
  for (const issue of transport) {
    assert.equal(issue.category, "structure");
    assert.equal(issue.dimension, "events");
    assert.equal(issue.disposition, "unsupported");
    // The shared contract refuses an informational issue that blocks anything,
    // so an unreceivable operation is a warning that names what it blocks.
    assert.equal(issue.severity, "warning");
    assert.equal(issue.executionImpact, "blocks-operation");
    assert.ok(issue.remediation);
  }
  assert.match(transport[0]!.message, /"kafka"/);
  assert.match(transport[1]!.message, /"ws"/);
  const direction = result.issues.filter(
    (issue) => issue.code === "structure.unsupported-direction",
  );
  assert.equal(direction.length, 1);
  assert.equal(direction[0]!.executionImpact, "blocks-operation");
  // Unrelated operations stay discoverable despite the blocked ones.
  assert.equal(result.definition.events.length, 8);
});

test("EVT-01: broker-only security schemes block authorization instead of being invented into a login", async () => {
  const result = await readAsyncApi(acme(), options);
  const kinds = new Map(
    result.definition.authentication.map((profile) => [profile.id, profile]),
  );
  assert.equal(kinds.get("deliveryToken")?.kind, "api-key");
  assert.equal(kinds.get("partnerOAuth")?.kind, "oauth-authorization-code");
  assert.equal(kinds.get("partnerOidc")?.kind, "openid-connect");
  assert.equal(kinds.get("bearerJwt")?.kind, "http-bearer");
  assert.equal(kinds.get("legacyBasic")?.kind, "http-basic");
  const scram = kinds.get("saslScram");
  assert.equal(scram?.kind, "unsupported");
  assert.equal(
    scram?.kind === "unsupported" ? scram.native : undefined,
    "scramSha256",
  );
  assert.equal(kinds.get("brokerUser")?.kind, "unsupported");
  const security = result.issues.filter(
    (issue) => issue.category === "security",
  );
  assert.equal(security.length, 2);
  for (const issue of security) {
    assert.equal(issue.severity, "blocking");
    assert.notEqual(issue.executionImpact, "none");
  }
  // OAuth endpoints are declared candidates, never approved destinations.
  const oauth = kinds.get("partnerOAuth");
  assert.equal(
    oauth?.kind === "oauth-authorization-code"
      ? oauth.tokenEndpoint
      : undefined,
    "https://auth.acme.example/token",
  );
  assert.equal(
    oauth?.kind === "oauth-authorization-code"
      ? oauth.scopeSemantics
      : undefined,
    "provider-scopes",
  );
  assert.deepEqual(
    result.definition.declaredServers.map((server) => server.url),
    [
      "https://hooks.acme.example/v1",
      "kafka://kafka.acme.example:9092",
      "wss://stream.acme.example/events",
    ],
  );
  for (const server of result.definition.declaredServers)
    assert.equal(server.status, "declared");
});

test("EVT-01: an external or missing channel reference is reported once and never fetched", async () => {
  const result = await readAsyncApi(acme(), options);
  const unresolved = result.issues.filter(
    (issue) => issue.code === "structure.unresolved-reference",
  );
  assert.deepEqual(
    unresolved.map((issue) => issue.sourcePointer),
    [
      "/operations/onMissingChannel/channel",
      "/operations/onExternalChannel/channel",
    ],
  );
  assert.match(unresolved[0]!.message, /missing/);
  assert.match(unresolved[1]!.message, /external/);
  // An operation with no resolvable channel claims no protocol at all.
  for (const nativeId of ["onMissingChannel", "onExternalChannel"]) {
    const event = eventOf(result, nativeId);
    assert.equal(event.transport, "unsupported");
    assert.equal(event.nativeTransport, undefined);
  }
  // The external URL carried a token in its query; nothing echoes it.
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("CANARY_EXTERNAL_TOKEN"), false);
  assert.equal(serialized.includes("other.example"), false);
});

test("EVT-01: AsyncAPI 3.0.0 imports through the same reader with its own version recorded", async () => {
  const result = await readAsyncApi(streetlights(), options);
  assert.equal(result.document.version, "3.0.0");
  assert.equal(result.document.title, "Streetlights Kafka API");
  assert.deepEqual(result.definition.capabilities, []);
  assert.deepEqual(result.receivable, []);
  assert.equal(
    result.definition.compatibility.dimensions.events,
    "unsupported",
  );
  const measured = eventOf(result, "receiveLightMeasurement/lightMeasured");
  assert.equal(measured.transport, "unsupported");
  assert.equal(measured.nativeTransport, "kafka");
  const extension = extensionOf(measured) as {
    channel: { address: string };
    message: { name: string; headers: string[] };
    bindings: { operation: Record<string, unknown> };
  };
  assert.equal(
    extension.channel.address,
    "smartylighting.streetlights.1.0.event.{streetlightId}.lighting.measured",
  );
  assert.equal(extension.message.name, "lightMeasured");
  // The message trait's common headers merged in.
  assert.deepEqual(extension.message.headers, ["my-app-header"]);
  // The operation trait's Kafka binding merged in and is preserved inert.
  assert.ok(extension.bindings.operation.kafka);
  // Three send operations are outbound and blocked as such.
  assert.equal(
    result.issues.filter(
      (issue) => issue.code === "structure.unsupported-direction",
    ).length,
    3,
  );
});

test("EVT-01: the provider perspective flips which action is inbound", async () => {
  const consumer = await readAsyncApi(acme(), options);
  const provider = await readAsyncApi(acme(), {
    ...options,
    perspective: "provider",
  });
  assert.equal(consumer.document.perspective, "consumer");
  assert.equal(provider.document.perspective, "provider");
  // The provider's `send` of an acknowledgement over HTTPS is inbound for it.
  assert.deepEqual(provider.receivable, ["acknowledgeDelivery/ackDelivery"]);
  assert.equal(
    provider.definition.events.find(
      (event) => event.nativeId === "onInvoiceEvent/invoicePaid",
    )?.transport,
    "unsupported",
  );
});

test("EVT-01: unsupported versions, malformed documents and hostile keys are refused within bounds", async () => {
  assert.deepEqual([...supportedAsyncApiVersions], ["3.0.0", "3.1.0"]);
  await assert.rejects(
    () => readAsyncApi({ asyncapi: "2.6.0", info: {} }, options),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "unsupported" &&
      error.detail === "asyncapi.version.unsupported",
  );
  await assert.rejects(
    () => readAsyncApi("not a document", options),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "invalid-request",
  );
  await assert.rejects(
    () => readAsyncApi({ asyncapi: "3.1.0" }, options),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "asyncapi.info.invalid",
  );
  // A prototype-polluting channel key is refused, and nothing is mutated.
  const hostile = JSON.parse(
    '{"asyncapi":"3.1.0","info":{"title":"H","version":"1"},"channels":{"__proto__":{"address":"/x"},"ok":{"address":"/ok"}},"operations":{}}',
  );
  const result = await readAsyncApi(hostile, options);
  assert.equal(({} as Record<string, unknown>).address, undefined);
  assert.ok(
    result.issues.some((issue) => issue.code === "structure.reserved-key"),
  );
  // A self-referential payload schema is preserved by reference, not expanded.
  const recursive = await readAsyncApi(acme(), options);
  assert.equal(
    eventOf(recursive, "onInvoiceEvent/invoicePaid").messageSchemaRef,
    "/components/schemas/Invoice",
  );
});

test("EVT-01: channel, message and operation counts are bounded", async () => {
  const channels: Record<string, unknown> = {};
  for (let index = 0; index < 600; index++)
    channels[`channel-${index}`] = { address: `/c/${index}`, messages: {} };
  await assert.rejects(
    () =>
      readAsyncApi(
        {
          asyncapi: "3.1.0",
          info: { title: "Big", version: "1" },
          channels,
          operations: {},
        },
        options,
      ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "asyncapi.bounds.channels",
  );
});

test("EVT-01: a reference cycle terminates instead of expanding", async () => {
  const document = {
    asyncapi: "3.1.0",
    info: { title: "Cycle", version: "1" },
    channels: { a: { $ref: "#/channels/b" }, b: { $ref: "#/channels/a" } },
    operations: {
      loop: { action: "receive", channel: { $ref: "#/channels/a" } },
    },
  };
  const result = await readAsyncApi(document, options);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.code === "structure.unresolved-reference" &&
        /cycle/.test(issue.message),
    ),
  );
  assert.equal(result.receivable.length, 0);
});
