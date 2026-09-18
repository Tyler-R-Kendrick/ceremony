import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFINITION_LIMITS,
  EXTENSION_LIMITS,
  JSON_VALUE_LIMITS,
  bindingReferenceSchema,
  canTransitionLifecycle,
  capabilityStatusSchema,
  catalogEntrySchema,
  compatibilityIssueSchema,
  completeDimensions,
  connectionLifecycles,
  connectionSummarySchema,
  lifecycleTransitions,
  measureJsonValue,
  nativeExtensionsSchema,
  normalizedDefinitionSchema,
  parseNormalizedDefinition,
  sourceRecordSchema,
  verificationClaimSchema,
  type CompatibilityIssue,
  type ConnectionLifecycle,
} from "../../../src/core/connectors/index.js";
import {
  AT,
  HEX,
  HEX_2,
  LATER,
  buildBindingReference,
  buildCapability,
  buildCapabilityStatus,
  buildCatalogEntry,
  buildClaim,
  buildCompatibilityIssue,
  buildConnectionSummary,
  buildDefinition,
  buildHandoffSummary,
  buildProfile,
  buildSourceRecord,
} from "../fixtures/builders.js";

const control = (code: number) => String.fromCharCode(code);
const messages = (result: { success: boolean; error?: { issues: Array<{ message: string }> } }) =>
  result.success ? [] : result.error!.issues.map((issue) => issue.message);
const rejects = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown, label: string) =>
  assert.equal(schema.safeParse(value).success, false, label);

test("CON-05-01: severity, disposition and execution impact agree; security is never talked down", () => {
  const issue = (
    overrides: Partial<CompatibilityIssue>,
  ): Record<string, unknown> => ({
    ...buildCompatibilityIssue(),
    ...overrides,
  });
  const valid: Array<Partial<CompatibilityIssue>> = [
    { category: "security", disposition: "unsupported", severity: "blocking", executionImpact: "blocks-authorization" },
    { category: "security", disposition: "rejected", severity: "blocking", executionImpact: "blocks-operation" },
    { category: "security", disposition: "requires-configuration", severity: "warning", executionImpact: "blocks-authorization" },
    { category: "security", disposition: "requires-configuration", severity: "blocking", executionImpact: "blocks-authorization" },
    { category: "security", disposition: "native-extension", severity: "warning", executionImpact: "none" },
    { category: "security", disposition: "exact", severity: "info", executionImpact: "none" },
    { category: "security", disposition: "adapted", severity: "warning", executionImpact: "none" },
    { category: "structure", disposition: "unsupported", severity: "warning", executionImpact: "none" },
    { category: "structure", disposition: "unsupported", severity: "blocking", executionImpact: "blocks-definition" },
    { category: "structure", disposition: "rejected", severity: "warning", executionImpact: "blocks-operation" },
    { category: "serialization", disposition: "unsupported", severity: "blocking", executionImpact: "blocks-operation" },
  ];
  for (const change of valid)
    assert.equal(
      compatibilityIssueSchema.safeParse(issue(change)).success,
      true,
      JSON.stringify(change),
    );
  const invalid: Array<[Partial<CompatibilityIssue>, string]> = [
    [{ category: "security", disposition: "unsupported", severity: "warning", executionImpact: "blocks-authorization" }, "Unsupported security requirements are blocking"],
    [{ category: "security", disposition: "unsupported", severity: "info", executionImpact: "none" }, "Unsupported security requirements are blocking"],
    [{ category: "security", disposition: "rejected", severity: "warning", executionImpact: "blocks-operation" }, "Unsupported security requirements are blocking"],
    [{ category: "security", disposition: "requires-configuration", severity: "info", executionImpact: "none" }, "An unmapped security requirement is never informational"],
    [{ category: "security", disposition: "requires-configuration", severity: "warning", executionImpact: "none" }, "An unconfigured security requirement names what it blocks"],
    [{ category: "security", disposition: "native-extension", severity: "info", executionImpact: "none" }, "An unmapped security requirement is never informational"],
    [{ category: "structure", disposition: "unsupported", severity: "blocking", executionImpact: "none" }, "A blocking issue must name what it blocks"],
    [{ category: "structure", disposition: "unsupported", severity: "info", executionImpact: "blocks-operation" }, "An informational issue blocks nothing"],
    [{ category: "structure", disposition: "unsupported", severity: "warning", executionImpact: "blocks-definition" }, "Blocking the definition is a blocking severity"],
    [{ category: "structure", disposition: "exact", severity: "blocking", executionImpact: "blocks-operation" }, "A mapped construct cannot also be blocking"],
    [{ category: "structure", disposition: "adapted", severity: "blocking", executionImpact: "blocks-operation" }, "A mapped construct cannot also be blocking"],
    [{ category: "structure", disposition: "rejected", severity: "info", executionImpact: "none" }, "A rejected construct is never informational"],
  ];
  for (const [change, message] of invalid) {
    const result = compatibilityIssueSchema.safeParse(issue(change));
    assert.equal(result.success, false, JSON.stringify(change));
    assert.ok(messages(result).includes(message), `${JSON.stringify(change)} -> ${messages(result)}`);
  }
  for (const change of [
    { code: "Bad.Code" },
    { code: "openapi..double" },
    { message: "" },
    { message: `leak${control(0)}` },
    { sourcePointer: "x".repeat(1025) },
    { secret: "CANARY_SECRET_9f3" },
    { severity: "fatal" },
    { executionImpact: "blocks-everything" },
  ])
    rejects(compatibilityIssueSchema, issue(change as Partial<CompatibilityIssue>), JSON.stringify(change));
});

test("CON-01-CS: capability statuses keep implementation, configuration and evidence honest", () => {
  const status = (overrides: Record<string, unknown>) => ({ ...buildCapabilityStatus(), ...overrides });
  assert.ok(capabilityStatusSchema.safeParse(status({ implementation: "unsupported", evidence: "not-tested" })).success);
  assert.ok(capabilityStatusSchema.safeParse(status({ configuration: "missing", evidence: "browser-integration" })).success);
  assert.ok(capabilityStatusSchema.safeParse(status({ configuration: "ready", evidence: "live-authorized", evidenceRef: "evidence:live-1" })).success);
  assert.ok(capabilityStatusSchema.safeParse(status({ configuration: "not-applicable", evidence: "deployed-authorized" })).success);
  assert.equal(capabilityStatusSchema.parse(status({ adapterVersion: "2026-07-28" })).adapterVersion, "2026-07-28");
  const invalid: Array<[Record<string, unknown>, string]> = [
    [{ implementation: "unsupported", evidence: "unit" }, "An unsupported dimension has no passing evidence"],
    [{ evidence: "not-tested", evidenceRef: "evidence:1" }, "Evidence reference requires an evidence level"],
    [{ configuration: "missing", evidence: "live-authorized" }, "Live evidence requires the configuration it was measured with"],
    [{ configuration: "missing", evidence: "deployed-authorized" }, "Live evidence requires the configuration it was measured with"],
  ];
  for (const [change, message] of invalid) {
    const result = capabilityStatusSchema.safeParse(status(change));
    assert.equal(result.success, false, JSON.stringify(change));
    assert.ok(messages(result).includes(message), messages(result).join("|"));
  }
  for (const change of [
    { limitations: Array.from({ length: 33 }, () => "limit") },
    { profile: `openapi${control(0)}` },
    { profile: "" },
    { evidence: "vendor-certified" },
    { verified: true },
  ])
    rejects(capabilityStatusSchema, status(change), JSON.stringify(change));
});

test("CON-03-01: a claim needs an issuer, a target and a verifier; a source cannot declare itself verified", () => {
  const claim = buildClaim();
  assert.deepEqual(verificationClaimSchema.parse(claim), claim);
  for (const missing of ["issuer", "target", "verifierVersion", "evidenceRef", "observedAt", "policyRevision", "bindingRevision", "kind"]) {
    const { [missing as keyof typeof claim]: _dropped, ...rest } = claim;
    void _dropped;
    rejects(verificationClaimSchema, rest, `missing ${missing}`);
  }
  for (const change of [
    { verified: true },
    { trusted: true },
    { issuer: "source" },
    { issuer: "model" },
    { kind: "verified" },
    { target: { kind: "account", id: "octocat", secret: "CANARY_SECRET_9f3" } },
    { target: { kind: "Account", id: "octocat" } },
    { target: { kind: "account", id: "__proto__" } },
    { policyRevision: `p${control(0)}` },
    { permissions: { ...claim.permissions, inferred: ["admin"] } },
    { permissions: { ...claim.permissions, granted: ["admin"] } },
    { permissions: { ...claim.permissions, requested: ["x".repeat(201)] } },
    { permissions: { ...claim.permissions, semantics: "unlimited" } },
  ])
    rejects(verificationClaimSchema, { ...claim, ...change }, JSON.stringify(change));
});

test("CON-03-02: requested, reported and observed permissions stay distinct and empty means unknown", () => {
  const parsed = verificationClaimSchema.parse(
    buildClaim({
      kind: "permission-observed",
      permissions: {
        requested: ["repo", "read:user"],
        reported: ["repo", "read:user", "admin:org"],
        observed: ["repo"],
        semantics: "provider-scopes",
      },
    }),
  );
  assert.deepEqual(parsed.permissions, {
    requested: ["repo", "read:user"],
    reported: ["repo", "read:user", "admin:org"],
    observed: ["repo"],
    semantics: "provider-scopes",
  });
  const unknownScopes = verificationClaimSchema.parse(
    buildClaim({ permissions: { requested: [], reported: [], observed: [], semantics: "unknown" } }),
  );
  assert.deepEqual(unknownScopes.permissions?.observed, []);
  const observedNothing = verificationClaimSchema.safeParse(
    buildClaim({ kind: "permission-observed", permissions: { requested: ["repo"], reported: ["repo"], observed: [], semantics: "provider-scopes" } }),
  );
  assert.equal(observedNothing.success, false);
  assert.ok(messages(observedNothing).includes("An observed-permission claim lists the permissions it observed"));
  const { permissions: _permissions, ...withoutPermissions } = buildClaim();
  void _permissions;
  rejects(verificationClaimSchema, { ...withoutPermissions, kind: "permission-observed" }, "permission-observed without permissions");
  assert.ok(verificationClaimSchema.safeParse({ ...withoutPermissions, kind: "credential-accepted" }).success);
});

test("CON-03-03: issuers observe what they can observe; host policy asserts ownership only", () => {
  const combos: Array<[string, string, boolean]> = [
    ["host-policy", "ownership-claimed", true],
    ["host-policy", "credential-accepted", false],
    ["host-policy", "permission-observed", false],
    ["provider", "account-identity", true],
    ["provider", "credential-accepted", true],
    ["external-broker", "credential-accepted", true],
    ["external-broker", "resource-access", true],
    ["ceremony-verifier", "permission-observed", true],
  ];
  for (const [issuer, kind, expected] of combos) {
    const claim = buildClaim({
      issuer: issuer as "provider",
      kind: kind as "account-identity",
      permissions: { requested: [], reported: [], observed: ["repo"], semantics: "operations" },
    });
    assert.equal(verificationClaimSchema.safeParse(claim).success, expected, `${issuer} ${kind}`);
  }
});

test("CON-03-04: validity compares instants, not strings, so offsets cannot fake a window", () => {
  assert.ok(
    verificationClaimSchema.safeParse(
      buildClaim({ observedAt: "2026-09-18T02:00:00+02:00", validUntil: "2026-09-18T00:30:00Z" }),
    ).success,
  );
  for (const [observedAt, validUntil] of [
    [AT, AT],
    [LATER, AT],
    ["2026-09-18T00:00:00Z", "2026-09-18T01:00:00+02:00"],
  ])
    rejects(verificationClaimSchema, buildClaim({ observedAt, validUntil }), `${observedAt} -> ${validUntil}`);
});

test("CON-01-CN: connection summaries carry no credentials and keep target, handoff and time consistent", () => {
  const summary = buildConnectionSummary();
  assert.deepEqual(connectionSummarySchema.parse(summary), summary);
  assert.ok(connectionSummarySchema.safeParse(buildConnectionSummary({ service: "" })).success);
  assert.ok(connectionSummarySchema.safeParse({ ...summary, handoff: buildHandoffSummary({ generation: 0 }) }).success);
  const { verification: _verification, target: _target, ...unverified } = summary;
  void _verification;
  void _target;
  assert.ok(connectionSummarySchema.safeParse({ ...unverified, lifecycle: "authorization-required" }).success);
  const invalid: Array<[Record<string, unknown>, string]> = [
    [{ createdAt: LATER, updatedAt: AT }, "A connection is updated after it is created"],
    [{ ...unverified, target: summary.target }, "A verified target requires verification evidence"],
    [{ verification: { ...summary.verification, validUntil: AT } }, "Verification validity ends after it was observed"],
    [{ generation: 1, handoff: buildHandoffSummary({ generation: 0 }) }, "A handoff belongs to the current connection generation"],
  ];
  for (const [change, message] of invalid) {
    const result = connectionSummarySchema.safeParse({ ...summary, ...change });
    assert.equal(result.success, false, message);
    assert.ok(messages(result).includes(message), messages(result).join("|"));
  }
  for (const change of [
    { service: "GitHub" },
    { lastOutcome: "Provider said: invalid_grant" },
    { credentialRef: "cred:1" },
    { accessToken: "ghp_CANARYTOKEN4b2" },
    { externalIds: { connectionId: "abc" } },
    { handoff: { ...buildHandoffSummary(), url: "https://example.invalid/continue" } },
    { lifecycle: "connected" },
  ])
    rejects(connectionSummarySchema, { ...summary, ...change }, JSON.stringify(change));
});

test("CON-01-LC: lifecycle transitions enter active only through verification or reconciliation", () => {
  assert.equal(connectionLifecycles.length, 11);
  assert.deepEqual(Object.keys(lifecycleTransitions).sort(), [...connectionLifecycles].sort());
  for (const [from, targets] of Object.entries(lifecycleTransitions))
    for (const to of targets) {
      assert.ok((connectionLifecycles as readonly string[]).includes(to), `${from} -> ${to}`);
      assert.notEqual(from, to);
    }
  const intoActive = connectionLifecycles.filter((from) => from !== "active" && canTransitionLifecycle(from, "active"));
  assert.deepEqual(intoActive.sort(), ["degraded", "indeterminate", "verifying"]);
  for (const from of connectionLifecycles) {
    assert.ok(canTransitionLifecycle(from, from), `${from} self`);
    if (from !== "locally-disconnected")
      assert.ok(canTransitionLifecycle(from, "locally-disconnected"), `${from} -> local disconnect`);
  }
  for (const from of ["authorization-required", "human-required", "reconnect-required", "expired", "locally-disconnected", "upstream-revoked", "configuration-required"] as ConnectionLifecycle[])
    assert.equal(canTransitionLifecycle(from, "active"), false, `${from} -> active`);
  assert.equal(canTransitionLifecycle("locally-disconnected", "verifying"), false);
});

test("CON-01-CE: catalog entries cannot outrank their evidence, hide missing configuration or fake implementation", () => {
  const entry = buildCatalogEntry();
  assert.deepEqual(catalogEntrySchema.parse(entry), entry);
  const missingConfiguration = entry.configuration.map((item) => ({ ...item, present: false }));
  assert.ok(catalogEntrySchema.safeParse({ ...entry, support: "unconfigured", configuration: missingConfiguration }).success);
  assert.ok(catalogEntrySchema.safeParse({ ...entry, support: "provider-backed" }).success);
  assert.ok(catalogEntrySchema.safeParse({ ...entry, support: "provider-backed", evidence: "live-authorized", capabilities: [buildCapabilityStatus({ evidence: "live-authorized", configuration: "ready" })] }).success);
  assert.ok(catalogEntrySchema.safeParse({ ...entry, support: "catalog-only", evidence: "not-tested", capabilities: [buildCapabilityStatus({ implementation: "unsupported", evidence: "not-tested" })] }).success);
  assert.ok(catalogEntrySchema.safeParse({ ...entry, capabilities: [buildCapabilityStatus(), buildCapabilityStatus({ profile: "openapi-3.0" })] }).success);
  const invalid: Array<[Record<string, unknown>, string]> = [
    [{ evidence: "local-integration" }, "Entry evidence cannot exceed its strongest measured dimension"],
    [{ capabilities: [], evidence: "unit" }, "Entry evidence cannot exceed its strongest measured dimension"],
    [{ support: "provider-backed", configuration: missingConfiguration }, "A provider-backed entry lacking required configuration is unconfigured"],
    [{ support: "unconfigured" }, "An unconfigured entry lacks some required configuration"],
    [{ support: "fixture", evidence: "live-authorized", capabilities: [buildCapabilityStatus({ evidence: "live-authorized" })] }, "Fixture and catalog entries carry no live evidence"],
    [{ support: "catalog-only", evidence: "not-tested", capabilities: [buildCapabilityStatus({ evidence: "not-tested" })] }, "A catalog-only entry implements nothing"],
    [{ custody: ["host-owned", "host-owned"] }, "Duplicate custody entry"],
    [{ runtimes: ["hosted-server", "hosted-server"] }, "Duplicate runtime entry"],
    [{ authentication: ["none", "none"] }, "Duplicate authentication entry"],
    [{ configuration: [entry.configuration[0], entry.configuration[0]] }, "Duplicate configuration entry"],
    [{ capabilities: [buildCapabilityStatus(), buildCapabilityStatus()] }, "Duplicate capability entry"],
  ];
  for (const [change, message] of invalid) {
    const result = catalogEntrySchema.safeParse({ ...entry, ...change });
    assert.equal(result.success, false, message);
    assert.ok(messages(result).includes(message), messages(result).join("|"));
  }
  for (const change of [
    { configuration: [{ ...entry.configuration[0], value: "CANARY_CONFIG_VALUE_5e6" }] },
    { destination: "https://api.example" },
    { id: "OpenAPI" },
    { support: "certified" },
  ])
    rejects(catalogEntrySchema, { ...entry, ...change }, JSON.stringify(change));
});

test("CON-01-BR: binding references expose identity, revision and custody, never the binding internals", () => {
  const reference = buildBindingReference();
  assert.deepEqual(bindingReferenceSchema.parse(reference), reference);
  for (const change of [
    { destinations: [] },
    { operations: [] },
    { settings: {} },
    { status: "active" },
    { adapterId: "OpenAPI" },
    { policyRevision: `p${control(0)}` },
    { authorityInstance: `x${control(1)}` },
  ])
    rejects(bindingReferenceSchema, { ...reference, ...change }, JSON.stringify(change));
});

test("CON-01-SR: source records keep provenance chains honest and locations free of credentials", () => {
  const source = buildSourceRecord();
  assert.deepEqual(sourceRecordSchema.parse(source), source);
  const step = (inputDigest: string, outputDigest: string) => ({ step: "overlay", version: "1.1.0", inputDigest, outputDigest });
  assert.ok(sourceRecordSchema.safeParse({ ...source, adaptation: [step(HEX, HEX_2), step(HEX_2, HEX)] }).success);
  const broken = sourceRecordSchema.safeParse({ ...source, adaptation: [step(HEX, HEX_2), step(HEX, HEX_2)] });
  assert.equal(broken.success, false);
  assert.ok(messages(broken).includes("Adaptation steps form a digest chain"));
  assert.ok(sourceRecordSchema.safeParse({ ...source, origin: { kind: "upload" } }).success);
  for (const change of [
    { origin: { kind: "url" } },
    { origin: { kind: "url", location: "https://user:CANARY_PASS_7c1@example.invalid/openapi.json" } },
    { origin: { kind: "url", location: "https://example.invalid/openapi.json?token=CANARY_SECRET_9f3" } },
    { origin: { kind: "url", location: "https://example.invalid/openapi.json#frag" } },
    { origin: { kind: "url", location: "file:///etc/passwd" } },
    { origin: { kind: "url", location: "ftp://example.invalid/openapi.json" } },
    { byteLength: 64 * 1024 * 1024 + 1 },
    { mediaType: "text/plain; charset=utf-8" },
    { license: { spdx: `MIT${control(0)}`, redistributable: true } },
    { overlays: Array.from({ length: 9 }, () => ({ sourceRef: "overlay:1", digest: HEX })) },
    { bytes: "..." },
  ])
    rejects(sourceRecordSchema, { ...source, ...change }, JSON.stringify(change));
});

test("CON-01-DF: definitions state every dimension, resolve capabilities exactly and carry no executable fields", () => {
  const definition = buildDefinition();
  assert.deepEqual(normalizedDefinitionSchema.parse(definition), definition);
  const partial = normalizedDefinitionSchema.safeParse({ ...definition, compatibility: { issues: [], dimensions: { import: "exact" } } });
  assert.equal(partial.success, false);
  assert.ok(normalizedDefinitionSchema.safeParse({ ...definition, compatibility: { issues: [], dimensions: completeDimensions({}) } }).success);
  rejects(normalizedDefinitionSchema, { ...definition, compatibility: { issues: [], dimensions: { ...completeDimensions({}), execute: "exact" } } }, "unknown dimension");
  const second = buildCapability({ nativeId: "listPets", kind: "mcp-tool" });
  assert.ok(normalizedDefinitionSchema.safeParse({ ...definition, capabilities: [definition.capabilities[0], second] }).success);
  const invalid: Array<[Record<string, unknown>, string]> = [
    [{ authentication: [buildProfile("oauth-authorization-code"), buildProfile("none", { id: "oauth-authorization-code" })] }, "Duplicate authentication id"],
    [{ capabilities: [buildCapability({ authentication: ["missing"] })] }, "Capability references an unknown authentication profile"],
    [{ configuration: [definition.configuration[0], definition.configuration[0]] }, "Duplicate configuration name"],
    [{ capabilities: [definition.capabilities[0], buildCapability()] }, "Duplicate capability identity"],
    [{ events: [{ nativeId: "created", transport: "http-webhook", verification: "unknown" }, { nativeId: "created", transport: "unsupported", nativeTransport: "kafka", verification: "none" }] }, "Duplicate event identity"],
  ];
  for (const [change, message] of invalid) {
    const result = normalizedDefinitionSchema.safeParse({ ...definition, ...change });
    assert.equal(result.success, false, message);
    assert.ok(messages(result).includes(message), messages(result).join("|"));
  }
  assert.ok(normalizedDefinitionSchema.safeParse({ ...definition, declaredServers: [{ url: "https://{region}.api.example/v1", status: "declared" }] }).success);
  assert.ok(normalizedDefinitionSchema.safeParse({ ...definition, authentication: [buildProfile("oauth-authorization-code", { issuer: "http://127.0.0.1:8080" })] }).success);
  for (const change of [
    { declaredServers: [{ url: "https://files.example.invalid/doc?X-Amz-Signature=CANARY_SIG_8e5", status: "declared" }] },
    { declaredServers: [{ url: "https://user:CANARY_PASS_7c1@example.invalid/path", status: "declared" }] },
    { declaredServers: [{ url: "https://api.example/v1#frag", status: "declared" }] },
    { declaredServers: [{ url: "https://api.example/v1", status: "approved" }] },
    { authentication: [buildProfile("oauth-authorization-code", { tokenEndpoint: "https://auth.example/token?key=CANARY_SECRET_9f3" })] },
    { authentication: [buildProfile("oauth-authorization-code", { issuer: "https://auth.example/#frag" })] },
    { authentication: [buildProfile("oauth-authorization-code", { authorizationEndpoint: "http://auth.example/authorize" })] },
    { authentication: [buildProfile("oauth-authorization-code", { clientSecret: "CANARY_SECRET_9f3" })] },
    { authentication: [buildProfile("api-key", { value: "CANARY_SECRET_9f3" })] },
    { authentication: [buildProfile("http-bearer", { token: "ghp_CANARYTOKEN4b2" })] },
    { authentication: [buildProfile("none", { reason: "trusted" })] },
    { display: { ...definition.display, service: "GitHub" } },
    { binding: { destinations: ["https://api.example"] } },
    { approved: true },
    { credentials: {} },
    { schemaVersion: 2 },
  ])
    rejects(normalizedDefinitionSchema, { ...definition, ...change }, JSON.stringify(change));
});

test("CON-01-LM: every list limit in DEFINITION_LIMITS is enforced at the boundary", () => {
  const definition = buildDefinition();
  const noneProfile = (index: number) => buildProfile("none", { id: `p${index}` });
  const cases: Array<[string, (count: number) => Record<string, unknown>]> = [
    ["capabilities", (count) => ({ capabilities: Array.from({ length: count }, (_, index) => buildCapability({ nativeId: `op${index}`, authentication: [] })) })],
    ["events", (count) => ({ events: Array.from({ length: count }, (_, index) => ({ nativeId: `event${index}`, transport: "http-webhook", verification: "unknown" })) })],
    ["authentication", (count) => ({ authentication: Array.from({ length: count }, (_, index) => noneProfile(index)), capabilities: [] })],
    ["configuration", (count) => ({ configuration: Array.from({ length: count }, (_, index) => ({ name: `NAME_${index}`, source: "host", classification: "public", required: false })) })],
    ["issues", (count) => ({ compatibility: { ...definition.compatibility, issues: Array.from({ length: count }, () => buildCompatibilityIssue({ category: "structure", disposition: "unsupported", severity: "warning", executionImpact: "none" })) } })],
    ["declaredServers", (count) => ({ declaredServers: Array.from({ length: count }, (_, index) => ({ url: `https://api${index}.example/v1`, status: "declared" })) })],
  ];
  for (const [name, build] of cases) {
    const limit = DEFINITION_LIMITS[name as keyof typeof DEFINITION_LIMITS];
    assert.ok(normalizedDefinitionSchema.safeParse({ ...definition, ...build(limit) }).success, `${name} at ${limit}`);
    rejects(normalizedDefinitionSchema, { ...definition, ...build(limit + 1) }, `${name} at ${limit + 1}`);
  }
  const json = JSON.stringify(definition);
  const exact = json + " ".repeat(DEFINITION_LIMITS.bytes - Buffer.byteLength(json));
  assert.equal(parseNormalizedDefinition(exact).definitionRef, definition.definitionRef);
  assert.throws(() => parseNormalizedDefinition(exact + " "), /import limit/);
  assert.throws(() => parseNormalizedDefinition("{"));
});

test("CON-01-EX: native extensions are bounded inert JSON and refuse reserved keys at any depth", () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"x-ok":1}');
  const rejected = nativeExtensionsSchema.safeParse(hostile);
  assert.equal(rejected.success, false);
  assert.ok(messages(rejected).includes("JSON value exceeds bounds: reserved-key"));
  for (const value of [
    JSON.parse('{"x-a":{"nested":{"__proto__":{"polluted":true}}}}'),
    JSON.parse('{"constructor":{"prototype":{}}}'),
    JSON.parse('{"prototype":1}'),
    JSON.parse('{"x-a":[{"constructor":1}]}'),
  ])
    rejects(nativeExtensionsSchema, value, JSON.stringify(value));
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const nest = (depth: number): unknown => (depth === 0 ? 1 : { level: nest(depth - 1) });
  assert.ok(nativeExtensionsSchema.safeParse({ "x-deep": nest(EXTENSION_LIMITS.depth - 2) }).success);
  rejects(nativeExtensionsSchema, { "x-deep": nest(EXTENSION_LIMITS.depth - 1) }, "depth");
  assert.ok(nativeExtensionsSchema.safeParse(Object.fromEntries(Array.from({ length: EXTENSION_LIMITS.keys }, (_, index) => [`x-${index}`, index]))).success);
  rejects(nativeExtensionsSchema, Object.fromEntries(Array.from({ length: EXTENSION_LIMITS.keys + 1 }, (_, index) => [`x-${index}`, index])), "keys");
  rejects(nativeExtensionsSchema, { "x-many": Array.from({ length: EXTENSION_LIMITS.nodes }, () => 0) }, "nodes");
  rejects(nativeExtensionsSchema, { "x-long": "x".repeat(EXTENSION_LIMITS.stringLength + 1) }, "string");
  rejects(nativeExtensionsSchema, { "x-big": Array.from({ length: 20 }, () => "x".repeat(8000)) }, "bytes");
  for (const value of [{ "x-fn": () => 1 }, { "x-undefined": undefined }, { "x-nan": Number.NaN }, { "x-date": new Date() }, { "x-map": new Map() }, { "x-bigint": 1n }])
    rejects(nativeExtensionsSchema, value, Object.keys(value)[0]!);
  const measured = measureJsonValue({ a: [1, "two", null], b: { c: true } });
  assert.deepEqual(measured, { ok: true, measure: { depth: 3, nodes: 8, bytes: 38 } });
  assert.equal(JSON_VALUE_LIMITS.depth, 16);
  const big = (chars: number) => buildCapability({ nativeExtensions: { "x-blob": "y".repeat(chars) } });
  const capabilities = (count: number) => Array.from({ length: count }, (_, index) => ({ ...big(120_000), nativeId: `op${index}` }));
  const definition = buildDefinition();
  assert.ok(normalizedDefinitionSchema.safeParse({ ...definition, capabilities: capabilities(8) }).success);
  const overBudget = normalizedDefinitionSchema.safeParse({ ...definition, capabilities: capabilities(9) });
  assert.equal(overBudget.success, false);
  assert.ok(messages(overBudget).includes("Native extensions exceed the definition budget"));
});
