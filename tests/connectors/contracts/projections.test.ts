import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentConnectorProjection,
  agentDefinitionProjection,
  auditConnectorProjection,
  authorReviewProjection,
  exportDefinitionProjection,
  humanConnectionProjection,
  publicCatalogProjection,
  strongestEvidence,
  type CatalogEntry,
  type ConnectionSummary,
  type ConnectorAuditEvent,
  type NormalizedDefinition,
  type SourceRecord,
} from "../../../src/core/connectors/index.js";
import {
  buildAuditEvent,
  buildCapability,
  buildCatalogEntry,
  buildCompatibilityIssue,
  buildConnectionSummary,
  buildDefinition,
  buildHandoffSummary,
  buildProfile,
  buildSourceRecord,
  canaries,
  canaryValues,
} from "../fixtures/builders.js";

const containsCanary = (value: unknown) => {
  const text = JSON.stringify(value);
  return canaryValues.filter((canary) => text.includes(canary));
};

/** A valid definition with a canary in every field a source can influence. */
function poisonedDefinition(): NormalizedDefinition {
  const base = buildDefinition();
  return buildDefinition({
    definitionRef: "definition:CANARY-DEF-REF-6b7",
    sourceRef: "source:CANARY-SRC-REF-6b7",
    display: { ...base.display, description: canaries.providerMessage },
    authentication: [
      buildProfile("oauth-authorization-code", { label: canaries.secret }),
    ],
    configuration: [
      { ...base.configuration[0]!, description: canaries.configValue },
    ],
    capabilities: [
      buildCapability({
        label: canaries.token,
        summary: canaries.providerMessage,
        inputSchemaRef: `#/components/schemas/${canaries.secret}`,
        outputSchemaRef: canaries.signedUrl,
        nativeExtensions: {
          "x-ms-example": canaries.secret,
          "x-nested": { deeper: [canaries.email] },
        },
      }),
    ],
    declaredServers: [
      {
        url: "https://api.petstore.example/v1",
        description: canaries.configValue,
        status: "declared",
      },
    ],
    compatibility: {
      ...base.compatibility,
      issues: [
        buildCompatibilityIssue({
          message: canaries.providerMessage,
          remediation: canaries.email,
          sourcePointer: canaries.secret,
        }),
      ],
    },
    nativeExtensions: {
      "x-example": {
        token: canaries.token,
        url: canaries.signedUrl,
        userinfo: canaries.userinfoUrl,
      },
    },
  });
}

function poisonedSummary(): ConnectionSummary {
  const summary = buildConnectionSummary({ handoff: buildHandoffSummary() });
  return {
    ...summary,
    credentialRef: canaries.secret,
    accessToken: canaries.token,
    externalIds: { connectionId: canaries.secret },
    state: { cursor: canaries.configValue },
    handoff: {
      ...summary.handoff!,
      url: canaries.userinfoUrl,
      private: { verifier: canaries.secret },
    },
    verification: { ...summary.verification!, raw: canaries.providerMessage },
    target: { ...summary.target!, email: canaries.email },
  } as unknown as ConnectionSummary;
}

test("AC-IMP-13: the agent definition view carries identifiers and classifications only", () => {
  const projected = agentDefinitionProjection(poisonedDefinition());
  assert.deepEqual(containsCanary(projected), []);
  assert.deepEqual(Object.keys(projected), [
    "definitionRef",
    "identity",
    "displayName",
    "service",
    "authentication",
    "capabilities",
    "dimensions",
    "blocked",
  ]);
  assert.deepEqual(Object.keys(projected.capabilities[0]!), [
    "kind",
    "nativeId",
    "effect",
    "dataClassification",
    "cost",
    "authentication",
  ]);
  assert.deepEqual(projected.authentication, [
    { id: "oauth-authorization-code", kind: "oauth-authorization-code" },
  ]);
  assert.deepEqual(projected.blocked, [
    {
      code: "openapi.security.unsupported-scheme",
      dimension: "authorize",
      executionImpact: "blocks-authorization",
    },
  ]);
  assert.equal(projected.definitionRef, "definition:CANARY-DEF-REF-6b7");
  assert.throws(() =>
    agentDefinitionProjection({
      ...poisonedDefinition(),
      secret: canaries.secret,
    } as NormalizedDefinition),
  );
});

test("AC-IMP-13: exports drop persistence references and native extensions unless an operator opts in", () => {
  const definition = poisonedDefinition();
  const exported = exportDefinitionProjection(definition);
  const text = JSON.stringify(exported);
  // Extension blocks and persistence references are dropped; prose and pointers are the export.
  for (const forbidden of [
    "CANARY-DEF-REF-6b7",
    "CANARY-SRC-REF-6b7",
    canaries.userinfoUrl,
    "x-ms-example",
    "x-example",
    "x-nested",
  ])
    assert.equal(text.includes(forbidden), false, forbidden);
  assert.equal("definitionRef" in exported, false);
  assert.equal("sourceRef" in exported, false);
  assert.deepEqual(exported.nativeExtensions, {});
  assert.equal("nativeExtensions" in exported.capabilities[0]!, false);
  const withExtensions = exportDefinitionProjection(definition, {
    includeNativeExtensions: true,
  });
  assert.deepEqual(
    withExtensions.nativeExtensions,
    definition.nativeExtensions,
  );
  assert.deepEqual(
    withExtensions.capabilities[0]!.nativeExtensions,
    definition.capabilities[0]!.nativeExtensions,
  );
  assert.equal("definitionRef" in withExtensions, false);
  assert.throws(() =>
    exportDefinitionProjection({
      ...definition,
      artifactRef: canaries.artifactRef,
    } as NormalizedDefinition),
  );
});

test("AC-IMP-13: the public catalog row is rebuilt from an allowlist and unknown fields never travel", () => {
  const entry = {
    ...buildCatalogEntry(),
    secret: canaries.secret,
    destination: canaries.userinfoUrl,
    configuration: [
      { ...buildCatalogEntry().configuration[0]!, value: canaries.configValue },
    ],
    capabilities: [
      {
        ...buildCatalogEntry().capabilities[0]!,
        evidenceUrl: canaries.signedUrl,
        transcript: canaries.providerMessage,
      },
    ],
  } as unknown as CatalogEntry;
  const projected = publicCatalogProjection(entry);
  assert.deepEqual(containsCanary(projected), []);
  assert.deepEqual(Object.keys(projected), [
    "id",
    "ecosystem",
    "service",
    "displayName",
    "description",
    "support",
    "custody",
    "runtimes",
    "authentication",
    "configuration",
    "capabilities",
    "evidence",
    "group",
  ]);
  assert.deepEqual(Object.keys(projected.configuration[0]!), [
    "name",
    "required",
    "classification",
    "present",
  ]);
  assert.deepEqual(Object.keys(projected.capabilities[0]!), [
    "dimension",
    "profile",
    "adapterVersion",
    "runtime",
    "implementation",
    "configuration",
    "evidence",
    "limitations",
  ]);
  assert.equal(
    publicCatalogProjection({
      ...buildCatalogEntry(),
      definitionRef: "definition:petstore",
    }).definitionRef,
    "definition:petstore",
  );
});

test("AC-IMP-13: human and agent connection views strip credentials, private handoff material and account identity", () => {
  const summary = poisonedSummary();
  const human = humanConnectionProjection(summary);
  assert.deepEqual(containsCanary(human), []);
  assert.deepEqual(Object.keys(human).sort(), [
    "bindingRef",
    "connectionRef",
    "createdAt",
    "custody",
    "definitionRef",
    "displayName",
    "ecosystem",
    "generation",
    "handoff",
    "lifecycle",
    "ownerKind",
    "revision",
    "runtime",
    "service",
    "target",
    "updatedAt",
    "verification",
  ]);
  assert.deepEqual(Object.keys(human.handoff!), [
    "handoffRef",
    "kind",
    "state",
    "presentation",
    "expiresAt",
    "generation",
  ]);
  assert.deepEqual(Object.keys(human.target!), ["kind", "id"]);
  const agent = agentConnectorProjection(summary);
  assert.deepEqual(containsCanary(agent), []);
  assert.deepEqual(Object.keys(agent), [
    "connectionRef",
    "bindingRef",
    "ecosystem",
    "service",
    "lifecycle",
    "generation",
    "revision",
    "custody",
    "verified",
    "targetKind",
    "handoff",
  ]);
  assert.equal(JSON.stringify(agent).includes("octocat"), false);
  assert.deepEqual(agent.handoff, {
    kind: "provider-browser",
    state: "issued",
  });
  assert.equal(agent.verified, true);
  assert.equal(
    agentConnectorProjection(buildConnectionSummary({ lifecycle: "expired" }))
      .verified,
    false,
  );
});

test("AC-IMP-13: only the human view may carry a destination, and only a safe one", () => {
  const summary = buildConnectionSummary();
  const shown = humanConnectionProjection(summary, {
    url: "https://provider.example/authorize/abc",
    userCode: "ABCD-EFGH",
    instructions: "Enter the code on the provider page.",
  });
  assert.deepEqual(shown.presentation, {
    url: "https://provider.example/authorize/abc",
    userCode: "ABCD-EFGH",
    instructions: "Enter the code on the provider page.",
  });
  assert.equal(
    humanConnectionProjection(summary, {
      url: "http://127.0.0.1:8080/continue",
    }).presentation?.url,
    "http://127.0.0.1:8080/continue",
  );
  for (const url of [
    canaries.userinfoUrl,
    "http://provider.example/authorize",
    "javascript:alert(1)",
    "https://provider.example/authorize#token=abc",
    "data:text/html,hi",
  ])
    assert.throws(() => humanConnectionProjection(summary, { url }), url);
  assert.throws(() =>
    humanConnectionProjection(summary, {
      userCode: `AB${String.fromCharCode(0)}CD`,
    }),
  );
  assert.throws(() =>
    humanConnectionProjection(summary, { instructions: "x".repeat(501) }),
  );
  assert.equal("presentation" in humanConnectionProjection(summary), false);
  assert.equal("presentation" in agentConnectorProjection(summary), false);
});

test("AC-IMP-13: author review drops the protected artifact handle and refuses undeclared fields", () => {
  const source = buildSourceRecord({ artifactRef: canaries.artifactRef });
  const review = authorReviewProjection(poisonedDefinition(), source);
  assert.equal("artifactRef" in review.source, false);
  assert.equal(
    JSON.stringify(review.source).includes(canaries.artifactRef),
    false,
  );
  assert.deepEqual(
    review.definition.nativeExtensions,
    poisonedDefinition().nativeExtensions,
  );
  assert.throws(() =>
    authorReviewProjection(poisonedDefinition(), {
      ...source,
      secret: canaries.secret,
    } as SourceRecord),
  );
  assert.throws(() =>
    authorReviewProjection(
      { ...poisonedDefinition(), approved: true } as NormalizedDefinition,
      source,
    ),
  );
});

test("AC-IMP-13: audit events are codes and references, never provider text", () => {
  const event = {
    ...buildAuditEvent(),
    message: canaries.providerMessage,
    detail: canaries.secret,
    token: canaries.token,
  } as unknown as ConnectorAuditEvent;
  const projected = auditConnectorProjection(event);
  assert.deepEqual(containsCanary(projected), []);
  assert.deepEqual(Object.keys(projected), [
    "schemaVersion",
    "at",
    "actorKind",
    "action",
    "connectionRef",
    "bindingRef",
    "outcome",
    "generation",
  ]);
  assert.throws(() =>
    auditConnectorProjection({
      ...buildAuditEvent(),
      code: canaries.providerMessage,
    }),
  );
});

test("CON-04-08: strongest evidence never exceeds any measured level and defaults to not-tested", () => {
  assert.equal(strongestEvidence([]), "not-tested");
  assert.equal(
    strongestEvidence(["unit", "live-authorized", "protocol-fixture"]),
    "live-authorized",
  );
  assert.equal(strongestEvidence(["not-tested", "unit"]), "unit");
});
