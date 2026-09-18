import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  OFFICIAL_MCP_REGISTRY_SOURCE,
  SERVER_JSON_SCHEMA_URL,
  createMcpRegistryClient,
  exportServerJson,
  importServerJson,
  publishServerJson,
  serverJsonExportSchema,
  type ImplementationEvidence,
  type PublicationRequest,
} from "../../../src/server/connectors/registries/mcp/index.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import { startMcpRegistryDouble } from "../doubles/mcp-registry.js";
import { assertMatchesPinnedServerDetail, loadServer, mcpBinding } from "./support.js";

/*
 * REG-05 / AC-MCP-09: export only for a real approved hosted MCP binding with
 * served-endpoint evidence; never packages, never a browser-only runtime,
 * never without explicit publication authorization; publication only to the
 * local double.
 */

const provenance = { sourceRef: "src:mcp-registry:test", origin: { kind: "registry" as const, location: "https://registry.example.com" } };
const evidence: ImplementationEvidence = {
  servedEndpoints: [
    { url: "https://mcp.example.com/mcp", transport: "streamable-http", runtime: "hosted-server", evidence: "local-integration", observedAt: "2026-09-18T00:00:00Z" },
  ],
};
const publication: PublicationRequest = {
  authorized: true,
  name: "com.example/ceremony-mcp",
  target: { sourceId: "registry-fixture", network: "public" },
};

async function definition() {
  return (await importServerJson(loadServer("hybrid"), provenance)).definition;
}

test("exports a schema-valid server.json describing only the served hosted endpoint", async () => {
  const def = await definition();
  const result = exportServerJson({ definition: def, binding: mcpBinding(def.definitionRef), implementationEvidence: evidence, publication, now: () => Date.parse("2026-09-18T12:00:00Z") });
  assert.equal(result.mediaType, "application/json");
  assert.equal(result.document.$schema, SERVER_JSON_SCHEMA_URL);
  assert.equal(result.document.name, "com.example/ceremony-mcp");
  assert.equal(result.document.version, "1.5.0");
  assert.deepEqual(result.document.remotes, [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }]);
  assert.deepEqual(result.endpoints, ["https://mcp.example.com/mcp"]);
  assert.ok(!("packages" in result.document), "packages never run here are never exported");
  assert.ok(result.losses.some((loss) => loss.code === "executable-code.package-omitted"));
  const parsed = JSON.parse(new TextDecoder().decode(result.bytes)) as Record<string, unknown>;
  assert.deepEqual(parsed, result.document);
  assertMatchesPinnedServerDetail(parsed);
  serverJsonExportSchema.parse(parsed);
  const meta = (parsed["_meta"] as Record<string, Record<string, unknown>>)["io.modelcontextprotocol.registry/publisher-provided"]!;
  assert.deepEqual(meta["ceremony"], { exporter: "mcp-registry-server-json/1.0.0", normalizedDigest: def.normalizedDigest, bindingRevision: 3, exportedAt: "2026-09-18T12:00:00.000Z" });
  const text = JSON.stringify(parsed);
  assert.doesNotMatch(text, /X-API-Key|anonymous\.modelcontextprotocol\.io|binding:|tenant-a|src:mcp-registry/, "no imported remotes, binding refs, tenant or source references");
  const withHeaders = exportServerJson({
    definition: def,
    binding: mcpBinding(def.definitionRef),
    implementationEvidence: evidence,
    publication: { ...publication, version: "2.0.0-rc.1", title: "Ceremony MCP", description: "Hosted Ceremony MCP endpoint", headers: [{ name: "X-Ceremony-Tenant", isRequired: true, isSecret: false }] },
  });
  assert.equal(withHeaders.document.version, "2.0.0-rc.1");
  assert.deepEqual(withHeaders.document.remotes[0]!.headers, [{ name: "X-Ceremony-Tenant", isRequired: true, isSecret: false }]);
});

test("refuses browser-only connectors, non-MCP bindings, unserved or unverified endpoints and unapproved bindings", async () => {
  const def = await definition();
  const attempt = (input: Partial<Parameters<typeof exportServerJson>[0]>) =>
    () => exportServerJson({ definition: def, binding: mcpBinding(def.definitionRef), implementationEvidence: evidence, publication, ...input });
  const refused = (detail: string) => (error: unknown) => {
    assert.ok(error instanceof ConnectorError, String(error));
    assert.equal(error.detail, detail);
    return true;
  };
  assert.throws(attempt({ binding: mcpBinding(def.definitionRef, { runtime: "browser" }) }), refused("export.browser-only"));
  assert.throws(
    attempt({ implementationEvidence: { servedEndpoints: [{ ...evidence.servedEndpoints[0]!, runtime: "browser" }] } }),
    refused("export.browser-only"),
  );
  assert.throws(attempt({ binding: mcpBinding(def.definitionRef, { httpOnly: true }) }), refused("export.binding-not-mcp"));
  assert.throws(
    attempt({ implementationEvidence: { servedEndpoints: [{ ...evidence.servedEndpoints[0]!, url: "https://elsewhere.example.com/mcp" }] } }),
    refused("export.endpoint-not-served"),
  );
  assert.throws(attempt({ implementationEvidence: { servedEndpoints: [] } }), refused("export.endpoint-not-served"));
  assert.throws(
    attempt({ implementationEvidence: { servedEndpoints: [{ ...evidence.servedEndpoints[0]!, evidence: "unit" }] } }),
    refused("export.endpoint-unverified"),
  );
  assert.throws(attempt({ binding: mcpBinding(def.definitionRef, { status: "suspended" }) }), refused("export.binding-not-approved"));
  assert.throws(attempt({ binding: mcpBinding("def:mcp-registry:other") }), refused("export.binding-definition-mismatch"));
  assert.throws(attempt({ publication: { ...publication, authorized: false } }), refused("export.publication-unauthorized"));
  assert.throws(attempt({ publication: { ...publication, version: "^1.0.0" } }));
  assert.throws(attempt({ publication: { ...publication, name: "no-namespace" } }));
  assert.throws(attempt({ binding: mcpBinding(def.definitionRef, { pathPrefix: "/other" }) }), refused("export.endpoint-not-served"));
  const prefixed = exportServerJson({ definition: def, binding: mcpBinding(def.definitionRef, { pathPrefix: "/mcp" }), implementationEvidence: evidence, publication });
  assert.equal(prefixed.document.remotes[0]!.url, "https://mcp.example.com/mcp");
});

test("a private or loopback endpoint may only be described for a fixture or approved-private target", async () => {
  const def = await definition();
  const loopback: ImplementationEvidence = {
    servedEndpoints: [{ url: "http://127.0.0.1:4545/mcp", transport: "streamable-http", runtime: "hosted-server", evidence: "local-integration", observedAt: "2026-09-18T00:00:00Z" }],
  };
  const binding = mcpBinding(def.definitionRef, { origin: "http://127.0.0.1:4545", network: "loopback-fixture" });
  assert.throws(
    () => exportServerJson({ definition: def, binding, implementationEvidence: loopback, publication }),
    (error: unknown) => error instanceof ConnectorError && error.detail === "export.private-endpoint",
  );
  const fixture = exportServerJson({ definition: def, binding, implementationEvidence: loopback, publication: { ...publication, target: { sourceId: "registry-fixture", network: "loopback-fixture" } } });
  assert.equal(fixture.document.remotes[0]!.url, "http://127.0.0.1:4545/mcp");
  const intranet: ImplementationEvidence = {
    servedEndpoints: [{ url: "https://mcp.corp.internal/mcp", transport: "sse", runtime: "hosted-server", evidence: "deployed-authorized", observedAt: "2026-09-18T00:00:00Z" }],
  };
  const intranetBinding = mcpBinding(def.definitionRef, { origin: "https://mcp.corp.internal", network: "approved-private" });
  assert.throws(() => exportServerJson({ definition: def, binding: intranetBinding, implementationEvidence: intranet, publication }), (error: unknown) => error instanceof ConnectorError && error.detail === "export.private-endpoint");
  const approved = exportServerJson({ definition: def, binding: intranetBinding, implementationEvidence: intranet, publication: { ...publication, target: { sourceId: "corp-registry", network: "approved-private" } } });
  assert.equal(approved.document.remotes[0]!.type, "sse");
});

test("publishes only to the local double, with a privately read token and a journaled effect", async () => {
  const def = await definition();
  const exported = exportServerJson({ definition: def, binding: mcpBinding(def.definitionRef), implementationEvidence: evidence, publication });
  const double = await startMcpRegistryDouble({ publishTokens: ["local-publish-token-3"] });
  const ports = memoryPorts();
  ports.configuration.set("MCP_REGISTRY_PUBLISH_TOKEN", "local-publish-token-3");
  try {
    const client = createMcpRegistryClient({
      baseUrl: double.origin,
      fetch: globalThis.fetch,
      allowPublication: true,
      bearer: () => ports.configuration.read("MCP_REGISTRY_PUBLISH_TOKEN"),
    });
    await assert.rejects(publishServerJson({ client, document: exported.document, publication: { authorized: false } }), (error: unknown) => error instanceof ConnectorError && error.detail === "export.publication-unauthorized");
    await assert.rejects(publishServerJson({ client, document: exported.document, publication: { authorized: true }, effects: ports.effects }), (error: unknown) => error instanceof ConnectorError && error.code === "unauthenticated");
    const published = await publishServerJson({ client, document: exported.document, publication: { authorized: true }, effects: ports.effects, actor: fixtureActor });
    assert.equal(published.entry.identity.nativeId, "com.example/ceremony-mcp");
    assert.equal(published.entry.official?.isLatest, true);
    assert.ok(published.effectRef);
    const request = double.received("POST", "/v0.1/publish")[0]!;
    assert.equal(request.headers.authorization, "Bearer local-publish-token-3");
    assert.deepEqual(JSON.parse(request.body.toString("utf8")), exported.document);
    assert.doesNotMatch(JSON.stringify(published), /local-publish-token-3/);
    assert.equal(ports.inspect.effects()[0]!.outcome?.status, "applied");
    await assert.rejects(publishServerJson({ client, document: exported.document, publication: { authorized: true }, effects: ports.effects, actor: fixtureActor }), (error: unknown) => error instanceof ConnectorError && error.detail === "export.publish.repeated");
    assert.equal(double.received("POST", "/v0.1/publish").length, 1, "a repeated effect does not publish twice");
    let officialCalls = 0;
    const official = createMcpRegistryClient({
      baseUrl: OFFICIAL_MCP_REGISTRY_SOURCE.baseUrl,
      fetch: async () => {
        officialCalls++;
        throw new Error("never");
      },
      bearer: async () => "would-be-a-real-token",
    });
    await assert.rejects(publishServerJson({ client: official, document: exported.document, publication: { authorized: true } }), (error: unknown) => error instanceof ConnectorError && error.detail === "registry.publication.disabled");
    assert.equal(officialCalls, 0);
    ports.configuration.set("MCP_REGISTRY_PUBLISH_TOKEN", undefined);
    await assert.rejects(publishServerJson({ client, document: { ...exported.document, version: "9.9.9" }, publication: { authorized: true } }), (error: unknown) => error instanceof ConnectorError && error.detail === "registry.authorization.missing");
  } finally {
    await double.close();
  }
});
