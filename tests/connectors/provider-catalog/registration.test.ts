import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  catalogFor,
  createConnectorRegistry,
} from "../../../src/server/connectors/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  parseProviderCatalogEntry,
  providerCatalogBindingSettings,
  providerCatalogDocument,
  type ProviderCatalogEntry,
} from "../../../src/server/connectors/formats/provider-catalog/index.js";
import {
  approve,
  catalogHarness,
  CLIENT_ID,
  CLIENT_SECRET,
  commandId,
  completeRedirect,
  startOAuthServer,
  startProviderApi,
} from "./harness.js";

/*
 * A host registers providers as data -- entries, or a Nango providers.yaml --
 * and each becomes its own connector in the directory. Registration is not
 * approval: every one of them is labelled a fixture (or catalog-only when it
 * cannot execute), and none can reach anything until a binding is reviewed.
 */

const fixture = readFileSync(
  new URL("./fixtures/providers.yaml", import.meta.url),
  "utf8",
);

test("a registered providers.yaml becomes one honestly labelled connector per provider", () => {
  const registry = createConnectorRegistry({
    providerCatalog: { nangoYaml: fixture },
  });
  const ids = registry.list().map((adapter) => adapter.id);
  assert.ok(ids.includes("catalog-http"), "the generic importer is standard");
  for (const key of [
    "acme-crm",
    "tenant-desk",
    "metrics-hub",
    "legacy-signer",
    "plain-http",
  ])
    assert.ok(ids.includes(`catalog-${key}`), key);

  const rows = catalogFor(registry, () => new Set());
  const acme = rows.find((row) => row.id === "catalog-acme-crm");
  assert.ok(acme);
  assert.equal(acme.support, "fixture");
  assert.equal(acme.displayName, "Acme CRM");
  assert.deepEqual(acme.authentication, ["oauth-authorization-code"]);
  assert.deepEqual(
    acme.configuration.map((item) => [item.name, item.present]),
    [
      ["ACME_CRM_CLIENT_ID", false],
      ["ACME_CRM_CLIENT_SECRET", false],
    ],
  );

  const signer = rows.find((row) => row.id === "catalog-legacy-signer");
  assert.ok(signer);
  assert.equal(signer.support, "catalog-only");
  const authorize = signer.capabilities.find(
    (row) => row.dimension === "authorize",
  );
  assert.equal(authorize?.implementation, "unsupported");
  assert.match(authorize?.limitations[0] ?? "", /OAuth 1\.0a/);

  // Nothing registered from data claims live or provider-backed support.
  for (const row of rows.filter((item) => item.id.startsWith("catalog-"))) {
    assert.ok(["fixture", "catalog-only"].includes(row.support), row.id);
    for (const capability of row.capabilities)
      assert.ok(
        ["not-tested", "protocol-fixture"].includes(capability.evidence),
        `${row.id}/${capability.dimension}`,
      );
  }
});

function localEntry(
  server: { origin: string },
  api: { origin: string },
): ProviderCatalogEntry {
  return parseProviderCatalogEntry(
    {
      id: "local-crm",
      displayName: "Local CRM",
      auth: {
        mode: "oauth2-authorization-code",
        authorizationUrl: `${server.origin}/authorize`,
        tokenUrl: `${server.origin}/token`,
        scopes: ["items.read"],
      },
      proxy: { baseUrl: `${api.origin}/v2` },
    },
    { allowLoopbackHttp: true },
  );
}

test("a host-registered entry connects through its pinned adapter after review", async (t) => {
  const server = await startOAuthServer(t);
  const api = await startProviderApi(t);
  const entry = localEntry(server, api);
  const registry = createConnectorRegistry({
    providerCatalog: { entries: [entry], allowLoopbackHttp: true },
  });
  const harness = await catalogHarness(t, { extra: registry });
  harness.setConfiguration(harness.actor, "LOCAL_CRM_CLIENT_ID", CLIENT_ID);
  harness.setConfiguration(
    harness.actor,
    "LOCAL_CRM_CLIENT_SECRET",
    CLIENT_SECRET,
  );

  // The draft comes from the host's own entry; a different one is refused.
  const altered = { ...entry, displayName: "Someone else's CRM" };
  const refused = await harness.service.import(harness.actor, {
    kind: "upload",
    mediaType: "application/json",
    text: providerCatalogDocument([altered]),
    adapterId: "catalog-local-crm",
  });
  assert.deepEqual(refused.definitions, []);
  assert.ok(
    refused.issues.some(
      (issue) => issue.code === "catalog.entry.differs-from-host",
    ),
  );
  const imported = await harness.service.import(harness.actor, {
    kind: "upload",
    mediaType: "application/json",
    text: providerCatalogDocument([entry]),
    adapterId: "catalog-local-crm",
  });
  assert.equal(imported.definitions.length, 1);

  // A pinned adapter needs no entry in the settings: the host's is the one.
  const approved = await approve(harness, {
    definitionRef: imported.definitions[0]!,
    destination: `${api.origin}/v2`,
    adapterId: "catalog-local-crm",
    profileId: "oauth2",
    settings: {},
  });
  const view = await harness.service.connect(harness.actor, {
    bindingRef: approved.reference.bindingRef,
    intent: { profileId: "oauth2" },
  });
  const url = (view as { presentation?: { url?: string } }).presentation?.url;
  assert.ok(url);
  const done = await completeRedirect(harness, url);
  assert.equal((done as { lifecycle: string }).lifecycle, "active");
  const result = await harness.service.invoke(
    harness.actor,
    (view as { connectionRef: string }).connectionRef,
    {
      operationRef: approved.operation("proxy.get"),
      input: { path: "/items" },
      commandId: commandId(),
    },
  );
  assert.equal(result.state, "complete");
  assert.equal(api.requests.at(-1)!.url.pathname, "/v2/items");
});

test("a pinned adapter refuses to bind a definition carrying another entry", async (t) => {
  const server = await startOAuthServer(t);
  const api = await startProviderApi(t);
  const entry = localEntry(server, api);
  // Same id, somebody else's endpoints: imported through the open adapter.
  const altered = parseProviderCatalogEntry({
    id: entry.id,
    displayName: "Someone else's CRM",
    auth: {
      mode: "oauth2-authorization-code",
      authorizationUrl: "https://crm.example/authorize",
      tokenUrl: "https://crm.example/token",
      scopes: ["items.read"],
    },
    proxy: { baseUrl: "https://crm.example/v2" },
  });
  const registry = createConnectorRegistry({
    providerCatalog: { entries: [entry], allowLoopbackHttp: true },
  });
  const harness = await catalogHarness(t, { extra: registry });
  const imported = await harness.service.import(harness.actor, {
    kind: "upload",
    mediaType: "application/json",
    text: providerCatalogDocument([altered]),
    adapterId: "catalog-http",
  });
  // The host's entry is authoritative: a definition describing another one
  // is refused at review, not bound and trusted.
  await assert.rejects(
    approve(harness, {
      definitionRef: imported.definitions[0]!,
      destination: "https://crm.example/v2",
      adapterId: "catalog-local-crm",
      profileId: "oauth2",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "catalog.binding.entry-differs",
  );
  // Nor can a reviewer hand it one through settings.
  const own = await harness.service.import(harness.actor, {
    kind: "upload",
    mediaType: "application/json",
    text: providerCatalogDocument([entry]),
    adapterId: "catalog-local-crm",
  });
  await assert.rejects(
    approve(harness, {
      definitionRef: own.definitions[0]!,
      destination: `${api.origin}/v2`,
      adapterId: "catalog-local-crm",
      profileId: "oauth2",
      settings: providerCatalogBindingSettings(altered),
    }),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "settings.reserved",
  );
});

test("a loopback entry is refused unless the host opted in", () => {
  const entry = {
    id: "local",
    displayName: "Local",
    auth: { mode: "bearer" as const },
    proxy: { baseUrl: "http://127.0.0.1:9/api" },
  };
  assert.throws(
    () => createConnectorRegistry({ providerCatalog: { entries: [entry] } }),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "catalog.url.scheme",
  );
});
