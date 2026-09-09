import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCeremonyClient,
  createHttpTransport,
  type CeremonySnapshot,
  type CeremonyTransport,
} from "../src/core/index.js";
import { manifests } from "../examples/manifests.js";

const manifest = manifests[1]!;
const snapshot: CeremonySnapshot = {
  id: "run",
  revision: 0,
  connectorId: manifest.id,
  connectorName: manifest.name,
  description: "",
  method: manifest.methods[0]!,
  step: "input",
  fields: manifest.methods[0]!.fields,
  actions: ["submit", "cancel"],
  expiresAt: Date.now() + 60000,
};
test("behavior: private input navigates to the host collector and submitting uses only its reference", async () => {
  const calls: unknown[] = [];
  const transport: CeremonyTransport = {
    start: async () => snapshot,
    read: async () => snapshot,
    privateInputUrl: () => "https://ceremony.example/collector",
    collect: async (...args) => {
      calls.push(args);
      return "00000000-0000-4000-8000-000000000001";
    },
    act: async (_id, action) => {
      calls.push(action);
      return {
        ...snapshot,
        step: "complete",
        fields: [],
        actions: [],
        outcome: {
          connectionRef: "opaque",
          ownership: "authenticated",
          scopes: [],
        },
      };
    },
  };
  const client = createCeremonyClient({
    manifest,
    transport,
    navigate: (url, target) => {
      calls.push({ url, target });
    },
  });
  await client.initialize();
  await client.execute({ action: "request-input" }, "webmcp");
  assert.deepEqual(calls.shift(), {
    url: "https://ceremony.example/collector",
    target: "new-tab",
  });
  await assert.rejects(
    client.execute({ action: "submit", values: { token: "secret" } }, "webmcp"),
    /private credential/,
  );
  assert.equal(calls.length, 0);
  await client.execute({ action: "submit", values: { token: "secret" } });
  assert.deepEqual(calls, [
    ["run", 0, { token: "secret" }],
    {
      action: "submit",
      revision: 0,
      values: {},
      secretRef: "00000000-0000-4000-8000-000000000001",
    },
  ]);
  client.dispose();
});
for (const step of ["redirect", "waiting", "input", "expired"] as const)
  test(`atomic: client navigation follows the ${step} state`, async () => {
    const destinations: unknown[] = [];
    const current = {
      ...snapshot,
      step,
      authorizationUrl: "https://provider.example/auth",
      verificationUri: "https://provider.example/verify",
      expiresAt: step === "expired" ? 0 : Date.now() + 60000,
    };
    const client = createCeremonyClient({
      manifest,
      transport: {
        start: async () => current,
        read: async () => current,
        act: async () => current,
      },
      navigate: (url, target) => {
        destinations.push({ url, target });
      },
    });
    await client.initialize();
    if (step === "input" || step === "expired")
      await assert.rejects(client.execute({ action: "navigate" }));
    else {
      await client.execute({ action: "navigate" });
      assert.deepEqual(destinations, [
        {
          url:
            step === "redirect"
              ? current.authorizationUrl
              : current.verificationUri,
          target: step === "redirect" ? "same-tab" : "new-tab",
        },
      ]);
    }
    client.dispose();
  });
test("atomic: HTTP transport validates responses, encodes IDs and does not expose failed collection bodies", async (t) => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  let response = Response.json(snapshot);
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return response.clone();
    },
  );
  const transport = createHttpTransport("https://ceremony.example/api");
  await transport.connect!("stripe", {});
  await transport.start("stripe", "api-key");
  await transport.read("a/b");
  await transport.act("a/b", { action: "cancel", revision: 0, values: {} });
  assert.equal(requests[2]?.url, "https://ceremony.example/api/a%2Fb");
  assert.equal(requests[3]?.url, "https://ceremony.example/api/a%2Fb/actions");
  assert.equal(requests[0]?.init?.credentials, "same-origin");
  response = Response.json({
    secretRef: "00000000-0000-4000-8000-000000000001",
  });
  assert.equal(
    await transport.collect!("a/b", 0, { token: "secret" }),
    "00000000-0000-4000-8000-000000000001",
  );
  response = Response.json(
    { error: "private-provider-secret" },
    { status: 500 },
  );
  await assert.rejects(
    transport.collect!("run", 0, {}),
    /Private credential collection failed/,
  );
  response = Response.json({}, { status: 500 });
  await assert.rejects(transport.read("run"), /Request failed/);
  response = Response.json({ error: "Denied" }, { status: 403 });
  await assert.rejects(transport.read("run"), /Denied/);
  response = Response.json({ step: "complete" });
  await assert.rejects(transport.read("run"));
});
