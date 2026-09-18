import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  controlBaseUrlForDestination,
  controlRegionForDestination,
  createAgentCoreControlClient,
} from "../../../src/server/connectors/providers/aws-agentcore/index.js";
import { startAgentCoreControlDouble } from "../doubles/aws-agentcore.js";
import { GATEWAY_ID, MANAGEMENT_IDENTITY } from "./support.js";

/*
 * The control client against an independent double that verifies every
 * signature itself. A test that passes here means the signature AWS would
 * verify is the signature this client produced, not that the client agrees
 * with itself.
 */

const region = "us-east-1";

const gateways = [
  { gatewayId: GATEWAY_ID, name: "OrdersGateway", accountId: "123456789012" },
  {
    gatewayId: "second-fixture-gw-f6e5d4c3b2",
    name: "SecondGateway",
    accountId: "123456789012",
  },
  {
    gatewayId: "third-fixture-gw-0102030405",
    name: "ThirdGateway",
    accountId: "123456789012",
  },
];

async function withDouble<T>(
  options: Parameters<typeof startAgentCoreControlDouble>[0],
  work: (
    double: Awaited<ReturnType<typeof startAgentCoreControlDouble>>,
  ) => Promise<T>,
): Promise<T> {
  const double = await startAgentCoreControlDouble(options);
  try {
    return await work(double);
  } finally {
    await double.close();
  }
}

function clientFor(
  origin: string,
  credentials: () => Promise<
    { accessKeyId: string; secretAccessKey: string } | undefined
  >,
) {
  return createAgentCoreControlClient({
    baseUrl: origin,
    region,
    signingService: "bedrock-agentcore",
    fetch: globalThis.fetch,
    now: Date.now,
    credentials,
  });
}

test("lists gateways page by page over signed, read-only GET requests", async () => {
  await withDouble(
    { identities: [MANAGEMENT_IDENTITY], region, gateways, pageSize: 2 },
    async (double) => {
      const client = clientFor(double.origin, async () => MANAGEMENT_IDENTITY);
      const first = await client.listGateways({ maxResults: 2 });
      assert.equal(first.gateways.length, 2);
      assert.ok(first.nextToken, "a truncated listing returns a next token");
      const second = await client.listGateways({
        maxResults: 2,
        nextToken: first.nextToken!,
      });
      assert.deepEqual(
        [...first.gateways, ...second.gateways].map((item) => item.gatewayId),
        gateways.map((item) => item.gatewayId),
      );
      assert.equal(second.nextToken, undefined);
      assert.deepEqual(
        [...new Set(double.requests.map((request) => request.method))],
        ["GET"],
        "the control client can only read",
      );
      assert.deepEqual(
        double.requests.map((request) => request.url.pathname),
        ["/gateways/", "/gateways/"],
      );
      for (const request of double.requests)
        assert.match(
          request.headers["authorization"] ?? "",
          /^AWS4-HMAC-SHA256 Credential=/,
        );
    },
  );
});

test("reads one gateway and one target with the documented request lines", async () => {
  await withDouble(
    {
      identities: [MANAGEMENT_IDENTITY],
      region,
      gateways,
      targets: {
        [GATEWAY_ID]: [
          { targetId: "AbCdEf1234", name: "OrdersApi" },
          { targetId: "ZyXwVu9876", name: "Lambda1" },
        ],
      },
    },
    async (double) => {
      const client = clientFor(double.origin, async () => MANAGEMENT_IDENTITY);
      const gateway = await client.getGateway(GATEWAY_ID);
      assert.equal(gateway.gatewayId, GATEWAY_ID);
      assert.match(gateway.gatewayArn, /^arn:aws:bedrock-agentcore:/);
      const targets = await client.listGatewayTargets(GATEWAY_ID, {});
      assert.deepEqual(
        targets.targets.map((target) => target.name),
        ["OrdersApi", "Lambda1"],
      );
      const target = await client.getGatewayTarget(GATEWAY_ID, "AbCdEf1234");
      assert.equal(target.name, "OrdersApi");
      assert.deepEqual(
        double.requests.map((request) => request.url.pathname),
        [
          `/gateways/${GATEWAY_ID}/`,
          `/gateways/${GATEWAY_ID}/targets/`,
          `/gateways/${GATEWAY_ID}/targets/AbCdEf1234/`,
        ],
      );
    },
  );
});

test("absent management credentials are configuration-required, never a request", async () => {
  await withDouble(
    { identities: [MANAGEMENT_IDENTITY], region, gateways },
    async (double) => {
      const client = clientFor(double.origin, async () => undefined);
      await assert.rejects(
        client.listGateways({}),
        (error: unknown) =>
          error instanceof ConnectorError &&
          error.code === "configuration-required" &&
          error.detail === "agentcore.management-credentials.missing",
      );
      assert.equal(
        double.requests.length,
        0,
        "nothing reaches AWS without a credential",
      );
    },
  );
});

test("a wrong secret is rejected by the independent verifier and reported as denied", async () => {
  await withDouble(
    { identities: [MANAGEMENT_IDENTITY], region, gateways },
    async (double) => {
      const client = clientFor(double.origin, async () => ({
        accessKeyId: MANAGEMENT_IDENTITY.accessKeyId,
        secretAccessKey: "not-the-secret",
      }));
      await assert.rejects(
        client.listGateways({}),
        (error: unknown) =>
          error instanceof ConnectorError &&
          error.code === "denied" &&
          error.detail === "agentcore.credentials.rejected",
      );
    },
  );
});

test("expired workload credentials map to expired, not to a retryable failure", async () => {
  await withDouble(
    {
      identities: [{ ...MANAGEMENT_IDENTITY, expired: true }],
      region,
      gateways,
    },
    async (double) => {
      const client = clientFor(double.origin, async () => MANAGEMENT_IDENTITY);
      await assert.rejects(
        client.listGateways({}),
        (error: unknown) =>
          error instanceof ConnectorError &&
          error.code === "expired" &&
          error.detail === "agentcore.credentials.expired",
      );
    },
  );
});

test("a target permission failure stays denied and names nothing from the provider", async () => {
  await withDouble(
    {
      identities: [MANAGEMENT_IDENTITY],
      region,
      gateways,
      targets: { [GATEWAY_ID]: [{ targetId: "AbCdEf1234", name: "OrdersApi" }] },
      denied: [GATEWAY_ID],
    },
    async (double) => {
      const client = clientFor(double.origin, async () => MANAGEMENT_IDENTITY);
      await assert.rejects(
        client.getGateway(GATEWAY_ID),
        (error: unknown) =>
          error instanceof ConnectorError &&
          error.code === "denied" &&
          error.detail === "agentcore.access-denied" &&
          !error.message.includes("fixture rejection"),
      );
    },
  );
});

test("throttling and missing resources keep their own codes", async () => {
  await withDouble(
    { identities: [MANAGEMENT_IDENTITY], region, gateways, throttleFirst: true },
    async (double) => {
      const client = clientFor(double.origin, async () => MANAGEMENT_IDENTITY);
      await assert.rejects(
        client.listGateways({}),
        (error: unknown) =>
          error instanceof ConnectorError && error.code === "rate-limited",
      );
      await assert.rejects(
        client.getGateway("missing-fixture-gw-1234567890"),
        (error: unknown) =>
          error instanceof ConnectorError && error.code === "not-found",
      );
    },
  );
});

test("a caller-shaped gateway or target identifier that is not documented never reaches the wire", async () => {
  await withDouble(
    { identities: [MANAGEMENT_IDENTITY], region, gateways },
    async (double) => {
      const client = clientFor(double.origin, async () => MANAGEMENT_IDENTITY);
      for (const attempt of [
        () => client.getGateway("../../admin"),
        () => client.getGateway("UPPER-CASE-gw-1234567890"),
        () => client.getGatewayTarget(GATEWAY_ID, "not-a-target-id"),
      ])
        await assert.rejects(
          attempt(),
          (error: unknown) =>
            error instanceof ConnectorError &&
            error.code === "invalid-request",
        );
      assert.equal(double.requests.length, 0);
    },
  );
});

test("a region the destination contradicts is a confusion, not a preference", () => {
  const destination = {
    id: "control",
    origin: "https://bedrock-agentcore-control.us-east-1.amazonaws.com",
    network: "public" as const,
  };
  assert.equal(controlRegionForDestination(destination, "us-east-1"), "us-east-1");
  assert.throws(
    () => controlRegionForDestination(destination, "eu-west-1"),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "agentcore.region.mismatch",
  );
  assert.equal(
    controlBaseUrlForDestination({
      ...destination,
      pathPrefix: "/gateways",
    }),
    "https://bedrock-agentcore-control.us-east-1.amazonaws.com/gateways",
  );
});
