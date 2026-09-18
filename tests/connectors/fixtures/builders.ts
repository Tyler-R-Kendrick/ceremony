import {
  CEREMONY_CONNECTOR_PROFILE,
  bindingReferenceSchema,
  capabilityStatusSchema,
  catalogEntrySchema,
  compatibilityIssueSchema,
  completeDimensions,
  connectionSummarySchema,
  connectorAuditEventSchema,
  connectorEnvelopeSchema,
  connectorHandoffSummarySchema,
  nativeCapabilitySchema,
  normalizedDefinitionSchema,
  normalizedDigestOf,
  sourceRecordSchema,
  verificationClaimSchema,
  type AuthenticationProfile,
  type BindingReference,
  type CapabilityStatus,
  type CatalogEntry,
  type CompatibilityIssue,
  type ConnectionSummary,
  type ConnectorAuditEvent,
  type ConnectorEnvelope,
  type ConnectorHandoffSummary,
  type ConnectorSourceIdentity,
  type NativeCapability,
  type NormalizedDefinition,
  type PortableDefinition,
  type PortableSource,
  type SourceRecord,
  type VerificationClaim,
} from "../../../src/core/connectors/index.js";
import {
  runtimeBindingSchema,
  type RuntimeBinding,
} from "../../../src/server/connectors/binding.js";

/*
 * Valid-by-default fixtures for every connector contract. Each builder parses
 * its result, so a fixture can never drift from the runtime schema, and every
 * field can be overridden to build the negative case a test needs. Identities
 * deliberately contain a slash and an opaque date version: upstream spelling
 * is preserved, never slugged.
 */

export const AT = "2026-09-18T00:00:00.000Z";
export const LATER = "2026-09-18T01:00:00.000Z";
export const HEX = "0123456789abcdef".repeat(4);
export const HEX_2 = "fedcba9876543210".repeat(4);

/** Values that must never appear in an unauthorized projection. */
export const canaries = Object.freeze({
  secret: "CANARY_SECRET_9f3",
  token: "ghp_CANARYTOKEN4b2",
  userinfoUrl: "https://user:CANARY_PASS_7c1@example.invalid/path",
  signedUrl: "https://files.example.invalid/doc?X-Amz-Signature=CANARY_SIG_8e5",
  artifactRef: "artifact:CANARY-ARTIFACT-2d8",
  configValue: "CANARY_CONFIG_VALUE_5e6",
  providerMessage: "invalid_grant: CANARY_PROVIDER_MSG_1a9",
  email: "canary-person-3f4@example.invalid",
});
export const canaryValues: readonly string[] = Object.values(canaries);

export function buildIdentity(
  overrides: Partial<ConnectorSourceIdentity> = {},
): ConnectorSourceIdentity {
  return {
    ecosystem: "openapi",
    authorityNamespace: "",
    nativeId: "example/petstore",
    nativeVersion: "2026-09-01",
    ...overrides,
  };
}

export function buildProfile(
  kind: AuthenticationProfile["kind"] = "oauth-authorization-code",
  overrides: Record<string, unknown> = {},
): AuthenticationProfile {
  const base = { id: kind, label: `${kind} profile` };
  const byKind: Record<
    AuthenticationProfile["kind"],
    Record<string, unknown>
  > = {
    "oauth-authorization-code": {
      pkce: "S256",
      issuer: "https://auth.example",
      authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token",
      scopes: ["read:pets"],
      scopeSemantics: "provider-scopes",
      clientRegistration: "pre-registered",
      clientAuthentication: "client_secret_basic",
      refresh: "supported",
    },
    "oauth-client-credentials": {
      tokenEndpoint: "https://auth.example/token",
      scopes: [],
      clientAuthentication: "client_secret_post",
    },
    "oauth-device": {
      deviceAuthorizationEndpoint: "https://auth.example/device",
      tokenEndpoint: "https://auth.example/token",
      scopes: ["read:pets"],
    },
    "api-key": { placement: "header", parameterName: "X-Api-Key" },
    "http-basic": {},
    "http-bearer": { format: "JWT" },
    "openid-connect": { issuer: "https://issuer.example", scopes: ["openid"] },
    "mutual-tls": {},
    signature: { scheme: "hmac-sha256" },
    "external-broker": {
      broker: "nango",
      custody: "external-credential-broker",
    },
    none: { reason: "public" },
    "ceremony-method": { flowKind: "oauth-code", methodId: "oauth" },
    unsupported: { native: "x-custom-scheme" },
  };
  return {
    ...base,
    kind,
    ...byKind[kind],
    ...overrides,
  } as AuthenticationProfile;
}

export function buildCapability(
  overrides: Partial<NativeCapability> = {},
): NativeCapability {
  return nativeCapabilitySchema.parse({
    kind: "http-operation",
    nativeId: "listPets",
    label: "List pets",
    summary: "Lists every pet in the store.",
    effect: "read",
    dataClassification: "public",
    cost: "unknown",
    authentication: ["oauth-authorization-code"],
    ...overrides,
  });
}

export function buildDefinition(
  overrides: Partial<NormalizedDefinition> = {},
): NormalizedDefinition {
  return normalizedDefinitionSchema.parse({
    schemaVersion: 1,
    definitionRef: "definition:petstore",
    identity: buildIdentity(),
    sourceRef: "source:petstore",
    normalizedDigest: HEX,
    importer: { id: "openapi-importer", version: "1.0.0" },
    display: {
      name: "Petstore",
      description: "A sample pet store description.",
      ecosystem: "openapi",
      service: "petstore",
    },
    authentication: [buildProfile("oauth-authorization-code")],
    configuration: [
      {
        name: "PETSTORE_CLIENT_ID",
        source: "host",
        classification: "public",
        required: true,
      },
    ],
    capabilities: [buildCapability()],
    events: [],
    declaredServers: [
      { url: "https://api.petstore.example/v1", status: "declared" },
    ],
    compatibility: {
      issues: [],
      dimensions: completeDimensions({
        import: "exact",
        configure: "exact",
        authorize: "requires-configuration",
        verify: "requires-configuration",
        invoke: "requires-configuration",
        export: "exact",
      }),
    },
    nativeExtensions: {},
    ...overrides,
  });
}

/** A public API: an explicit `none` profile and anonymous capabilities, nothing fabricated. */
export function buildPublicDefinition(
  overrides: Partial<NormalizedDefinition> = {},
): NormalizedDefinition {
  return buildDefinition({
    definitionRef: "definition:public-data",
    sourceRef: "source:public-data",
    identity: buildIdentity({ nativeId: "example/public-data" }),
    display: {
      name: "Public data",
      description: "Reads public data without any credential.",
      ecosystem: "openapi",
      service: "public-data",
    },
    authentication: [buildProfile("none")],
    configuration: [],
    capabilities: [
      buildCapability({
        nativeId: "listRecords",
        label: "List records",
        authentication: [],
      }),
    ],
    ...overrides,
  });
}

/** Strips persistence references; the shape an envelope or export carries. */
export function portableDefinition(
  definition: NormalizedDefinition,
): PortableDefinition {
  const {
    definitionRef: _definitionRef,
    sourceRef: _sourceRef,
    ...portable
  } = definition;
  void _definitionRef;
  void _sourceRef;
  return portable;
}

/** The same definition with its real canonical digest. */
export async function withNormalizedDigest<
  T extends NormalizedDefinition | PortableDefinition,
>(definition: T): Promise<T> {
  return {
    ...definition,
    normalizedDigest: await normalizedDigestOf(definition),
  };
}

export function buildSourceRecord(
  overrides: Partial<SourceRecord> = {},
): SourceRecord {
  return sourceRecordSchema.parse({
    sourceRef: "source:petstore",
    identity: buildIdentity(),
    format: {
      name: "openapi",
      version: "3.1.0",
      dialect: "https://spec.openapis.org/oas/3.1/dialect/base",
    },
    origin: {
      kind: "url",
      location: "https://api.petstore.example/openapi.json",
    },
    digest: { algorithm: "sha256", value: HEX },
    byteLength: 4096,
    mediaType: "application/json",
    capturedAt: AT,
    license: { spdx: "Apache-2.0", redistributable: true },
    artifactRef: "artifact:petstore",
    adaptation: [],
    overlays: [],
    ...overrides,
  });
}

export function portableSource(source: SourceRecord): PortableSource {
  const {
    sourceRef: _sourceRef,
    artifactRef: _artifactRef,
    ...portable
  } = source;
  void _sourceRef;
  void _artifactRef;
  return portable;
}

export function buildEnvelope(
  overrides: Partial<ConnectorEnvelope> = {},
): ConnectorEnvelope {
  return connectorEnvelopeSchema.parse({
    format: "ceremony-connector",
    version: 2,
    profile: {
      id: CEREMONY_CONNECTOR_PROFILE,
      producer: { id: "ceremony-tests", version: "1.0.0" },
    },
    definition: portableDefinition(buildDefinition()),
    sources: [portableSource(buildSourceRecord())],
    ...overrides,
  });
}

export function buildCapabilityStatus(
  overrides: Partial<CapabilityStatus> = {},
): CapabilityStatus {
  return capabilityStatusSchema.parse({
    dimension: "import",
    profile: "openapi-3.1",
    adapterVersion: "1.0.0",
    runtime: "hosted-server",
    implementation: "implemented",
    configuration: "not-applicable",
    evidence: "protocol-fixture",
    limitations: [],
    ...overrides,
  });
}

export function buildClaim(
  overrides: Partial<VerificationClaim> = {},
): VerificationClaim {
  return verificationClaimSchema.parse({
    kind: "credential-accepted",
    evidenceRef: "evidence:1",
    issuer: "ceremony-verifier",
    target: { kind: "account", id: "octocat" },
    observedAt: AT,
    validUntil: LATER,
    verifierVersion: "1.0.0",
    bindingRevision: 1,
    policyRevision: "policy:1",
    permissions: {
      requested: ["read:user"],
      reported: ["read:user"],
      observed: [],
      semantics: "provider-scopes",
    },
    limitations: [],
    ...overrides,
  });
}

export function buildCompatibilityIssue(
  overrides: Partial<CompatibilityIssue> = {},
): CompatibilityIssue {
  return compatibilityIssueSchema.parse({
    code: "openapi.security.unsupported-scheme",
    category: "security",
    sourcePointer: "/components/securitySchemes/legacy",
    normalizedPointer: "/authentication/0",
    dimension: "authorize",
    disposition: "unsupported",
    severity: "blocking",
    executionImpact: "blocks-authorization",
    message: "The security scheme is not executable by this runtime.",
    remediation: "Bind an approved authentication profile instead.",
    ...overrides,
  });
}

export function buildBindingReference(
  overrides: Partial<BindingReference> = {},
): BindingReference {
  return bindingReferenceSchema.parse({
    bindingRef: "binding:petstore",
    definitionRef: "definition:petstore",
    revision: 1,
    adapterId: "openapi-http",
    adapterVersion: "1.0.0",
    runtime: "hosted-server",
    custody: "host-owned",
    authorityInstance: "https://auth.example",
    status: "approved",
    approvedAt: AT,
    policyRevision: "policy:1",
    ...overrides,
  });
}

/** A server runtime binding with one approved destination and one read operation. */
export function buildBinding(
  overrides: Partial<RuntimeBinding> = {},
): RuntimeBinding {
  return runtimeBindingSchema.parse({
    ...buildBindingReference(),
    tenantId: "tenant-a",
    profileId: "oauth-authorization-code",
    destinations: [
      { id: "api", origin: "https://api.petstore.example", network: "public" },
    ],
    operations: [
      {
        operationRef: "operation:listPets",
        nativeId: "listPets",
        destinationId: "api",
        transport: { kind: "http", method: "GET", pathTemplate: "/v1/pets" },
        effect: "read",
        outputClassification: "public",
        cost: "unknown",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
        authenticationProfile: "oauth-authorization-code",
      },
    ],
    configuration: ["PETSTORE_CLIENT_ID"],
    permittedTargets: [],
    reviewedDigest: HEX,
    settings: {},
    ...overrides,
  });
}

export function buildHandoffSummary(
  overrides: Partial<ConnectorHandoffSummary> = {},
): ConnectorHandoffSummary {
  return connectorHandoffSummarySchema.parse({
    handoffRef: "handoff:1",
    kind: "provider-browser",
    state: "issued",
    presentation: "popup",
    expiresAt: LATER,
    generation: 0,
    ...overrides,
  });
}

export function buildConnectionSummary(
  overrides: Partial<ConnectionSummary> = {},
): ConnectionSummary {
  return connectionSummarySchema.parse({
    connectionRef: "connection:1",
    bindingRef: "binding:petstore",
    definitionRef: "definition:petstore",
    ecosystem: "openapi",
    service: "petstore",
    displayName: "Petstore",
    ownerKind: "user",
    custody: "host-owned",
    runtime: "hosted-server",
    lifecycle: "active",
    generation: 0,
    revision: 3,
    target: { kind: "account", id: "octocat" },
    verification: {
      kinds: ["credential-accepted", "account-identity"],
      observedAt: AT,
      validUntil: LATER,
      limitations: [],
    },
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function buildCatalogEntry(
  overrides: Partial<CatalogEntry> = {},
): CatalogEntry {
  return catalogEntrySchema.parse({
    id: "openapi-http",
    ecosystem: "openapi",
    service: "petstore",
    displayName: "Petstore",
    description: "Imported OpenAPI description of the pet store.",
    support: "fixture",
    custody: ["host-owned"],
    runtimes: ["hosted-server"],
    authentication: ["oauth-authorization-code"],
    configuration: [
      {
        name: "PETSTORE_CLIENT_ID",
        required: true,
        classification: "public",
        present: true,
      },
    ],
    capabilities: [buildCapabilityStatus()],
    evidence: "protocol-fixture",
    group: "petstore",
    ...overrides,
  });
}

export function buildAuditEvent(
  overrides: Partial<ConnectorAuditEvent> = {},
): ConnectorAuditEvent {
  return connectorAuditEventSchema.parse({
    schemaVersion: 1,
    at: AT,
    actorKind: "human",
    action: "connector.connection.disconnect",
    connectionRef: "connection:1",
    bindingRef: "binding:petstore",
    outcome: "applied",
    generation: 1,
    ...overrides,
  });
}
