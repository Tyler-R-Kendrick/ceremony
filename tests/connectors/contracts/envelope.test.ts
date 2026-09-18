import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachGenericCeremony,
  connectorProjectSchema,
  defaultWorkflowSteps,
  exportConnectorFiles,
  newConnectorProject,
  type ConnectorProject,
} from "../../../src/core/connector-authoring.js";
import { flowKinds, type ConnectorManifest } from "../../../src/core/schema.js";
import {
  CEREMONY_CONNECTOR_PROFILE,
  ENVELOPE_LIMITS,
  authenticationKinds,
  completeDimensions,
  connectorEnvelopeSchema,
  downgradeConnectorEnvelope,
  normalizedDigestOf,
  parseConnectorEnvelope,
  upgradeConnectorProject,
  verifyNormalizedDigest,
} from "../../../src/core/connectors/index.js";
import { manifests } from "../../../examples/manifests.js";
import { serviceManifests } from "../../../src/server/services.js";
import {
  AT,
  buildCapability,
  buildCompatibilityIssue,
  buildDefinition,
  buildEnvelope,
  buildProfile,
  buildPublicDefinition,
  buildSourceRecord,
  portableDefinition,
  portableSource,
} from "../fixtures/builders.js";

const producer = { id: "ceremony-tests", version: "1.0.0" };
const SOURCE_URL = "https://api.example.invalid/openapi.json";
const control = (code: number) => String.fromCharCode(code);

/** A studio project authored the way the studio authors it. */
function authoredProject(
  kinds: readonly (typeof flowKinds)[number][],
  manifest: { id: string; name: string; description: string },
): ConnectorProject {
  const draft = newConnectorProject();
  draft.manifest.id = manifest.id;
  draft.manifest.name = manifest.name;
  draft.manifest.description = manifest.description;
  draft.workflows[0]!.sourceDescriptions[0]!.url = SOURCE_URL;
  kinds.forEach((kind, index) =>
    attachGenericCeremony(draft, kind, `${kind} ceremony ${index + 1}`),
  );
  return connectorProjectSchema.parse(draft);
}

/** Wraps a shipped manifest in the smallest project that references every method's workflow. */
function projectFromManifest(manifest: ConnectorManifest): ConnectorProject {
  const clone = structuredClone(manifest);
  const documents = new Map<
    string,
    Array<{
      workflowId: string;
      summary: string;
      steps: ReturnType<typeof defaultWorkflowSteps>;
    }>
  >();
  for (const method of clone.methods) {
    const reference = method.contract!.workflows[0] ?? {
      document: "ceremonies",
      version: "1.0.0",
      workflowId: method.id,
    };
    method.contract!.workflows = [reference];
    const list = documents.get(reference.document) ?? [];
    list.push({
      workflowId: reference.workflowId,
      summary: method.label,
      steps: defaultWorkflowSteps(method.kind),
    });
    documents.set(reference.document, list);
  }
  return connectorProjectSchema.parse({
    format: "ceremony-connector",
    version: 1,
    manifest: clone,
    templates: [],
    workflows: [...documents].map(([document, workflows]) => ({
      document,
      arazzo: "1.0.1",
      info: { title: `${document} ceremonies`, version: "1.0.0" },
      sourceDescriptions: [
        { name: "provider", type: "openapi", url: SOURCE_URL },
      ],
      workflows,
    })),
  });
}

const shippedProjects = [...manifests, ...serviceManifests].map(
  projectFromManifest,
);
const authoredProjects = [
  authoredProject(["oauth-code"], {
    id: "acme",
    name: "Acme",
    description: "Acme OAuth.",
  }),
  authoredProject(["api-key", "basic", "form"], {
    id: "multi",
    name: "Multi",
    description: "",
  }),
  authoredProject([...flowKinds], {
    id: "every-kind",
    name: "Every kind",
    description: "All families.",
  }),
];

async function roundTrip(project: ConnectorProject) {
  const envelope = await upgradeConnectorProject(project, producer, AT);
  const text = JSON.stringify(envelope);
  const parsed = parseConnectorEnvelope(text);
  assert.equal(parsed.version, 2);
  if (parsed.version !== 2) throw new Error("unreachable");
  const downgraded = downgradeConnectorEnvelope(parsed.envelope);
  return { envelope, parsed: parsed.envelope, downgraded };
}

test("AC-IMP-01: shipped and authored v1 projects upgrade, round-trip and downgrade to identical projects with nothing added", async () => {
  for (const project of [...shippedProjects, ...authoredProjects]) {
    const { envelope, parsed, downgraded } = await roundTrip(project);
    assert.deepEqual(envelope.project, project);
    assert.deepEqual(parsed.project, project);
    assert.deepEqual(downgraded.project, project);
    assert.deepEqual(
      exportConnectorFiles(downgraded.project!),
      exportConnectorFiles(project),
    );
    assert.deepEqual(
      downgraded.diagnostics.map((issue) => issue.code),
      ["envelope.v1.provenance-dropped"],
    );
    assert.ok(
      downgraded.diagnostics.every((issue) => issue.severity === "info"),
    );
    assert.deepEqual(Object.keys(envelope), [
      "format",
      "version",
      "profile",
      "definition",
      "sources",
      "project",
    ]);
    const { definition } = envelope;
    assert.deepEqual(definition.capabilities, []);
    assert.deepEqual(definition.events, []);
    assert.deepEqual(definition.nativeExtensions, {});
    assert.equal(definition.compatibility.dimensions.invoke, "unsupported");
    assert.equal(
      definition.compatibility.dimensions.authorize,
      "requires-configuration",
    );
    assert.ok(
      definition.declaredServers.every(
        (server) => server.status === "declared",
      ),
    );
    assert.equal(
      definition.authentication.length,
      project.manifest.methods.length,
    );
    for (const [index, profile] of definition.authentication.entries()) {
      assert.equal(profile.kind, "ceremony-method");
      if (profile.kind !== "ceremony-method") throw new Error("unreachable");
      assert.equal(profile.methodId, project.manifest.methods[index]!.id);
      assert.equal(profile.flowKind, project.manifest.methods[index]!.kind);
    }
    assert.equal(await verifyNormalizedDigest(definition), true);
    assert.equal(envelope.sources[0]!.identity.nativeId, project.manifest.id);
    const text = JSON.stringify(envelope);
    for (const forbidden of [
      '"binding"',
      '"destinations"',
      '"credential',
      '"approved"',
      '"secret":',
      '"token":',
    ])
      assert.equal(text.includes(forbidden), false, forbidden);
    const legacy = parseConnectorEnvelope(JSON.stringify(project));
    assert.equal(legacy.version, 1);
    if (legacy.version === 1) assert.deepEqual(legacy.project, project);
  }
});

test("CON-02-02: v1 spellings a profile cannot carry are derived safely while the project stays untouched", async () => {
  const project = authoredProject(["api-key", "device"], {
    id: "-legacy",
    name: `Legacy${control(9)}name`,
    description: "x",
  });
  project.manifest.methods[0]!.id = "1-legacy";
  project.manifest.methods[0]!.label = `Tab${control(9)}label`;
  project.manifest.methods[1]!.id = "ceremony-1-legacy";
  const valid = connectorProjectSchema.parse(project);
  const { envelope, downgraded } = await roundTrip(valid);
  assert.deepEqual(downgraded.project, valid);
  const [first, second] = envelope.definition.authentication;
  assert.equal(first!.kind, "ceremony-method");
  if (first!.kind !== "ceremony-method" || second!.kind !== "ceremony-method")
    throw new Error("unreachable");
  assert.equal(first!.methodId, "1-legacy");
  assert.equal(first!.id, "ceremony-1-legacy-alt");
  assert.equal(first!.label, "Tab label");
  assert.equal(second!.id, "ceremony-1-legacy");
  assert.equal(envelope.definition.display.name, "Legacy name");
  assert.equal(envelope.definition.display.service, undefined);
  assert.equal(
    envelope.project!.manifest.methods[0]!.label,
    `Tab${control(9)}label`,
  );
});

test("AC-IMP-02: a public API is a valid description with an explicit none profile and no fabricated login", () => {
  const definition = buildPublicDefinition();
  const envelope = buildEnvelope({
    definition: portableDefinition(definition),
  });
  assert.deepEqual(
    envelope.definition.authentication.map((profile) => profile.kind),
    ["none"],
  );
  assert.deepEqual(envelope.definition.capabilities[0]!.authentication, []);
  assert.equal(envelope.project, undefined);
  const text = JSON.stringify(envelope);
  for (const forbidden of [
    '"methods"',
    '"fields"',
    "api-key",
    "password",
    '"token"',
  ])
    assert.equal(text.includes(forbidden), false, forbidden);
  const parsed = parseConnectorEnvelope(text);
  assert.equal(parsed.version, 2);
  const downgraded = downgradeConnectorEnvelope(envelope);
  assert.equal(downgraded.project, undefined);
  assert.equal(downgraded.diagnostics.length, 1);
  const [issue] = downgraded.diagnostics;
  assert.equal(issue!.code, "envelope.v1.no-project");
  assert.equal(issue!.severity, "blocking");
  assert.equal(issue!.executionImpact, "blocks-definition");
  assert.match(issue!.message, /public or no-credential API/);
  const authenticated = downgradeConnectorEnvelope(buildEnvelope());
  assert.match(authenticated.diagnostics[0]!.message, /no executable ceremony/);
  assert.equal(
    connectorEnvelopeSchema.safeParse({
      ...envelope,
      project: authoredProjects[0]!.manifest,
    }).success,
    false,
  );
});

test("CON-02-04: envelope headers, cross references, hostile keys and the byte ceiling are enforced", async () => {
  const envelope = await upgradeConnectorProject(
    authoredProjects[0],
    producer,
    AT,
  );
  const project = envelope.project!;
  const ceremonyProfile = envelope.definition.authentication[0]!;
  const withProject = (
    definition: Partial<typeof envelope.definition>,
    keepProject = true,
  ) =>
    connectorEnvelopeSchema.safeParse({
      ...envelope,
      definition: { ...envelope.definition, ...definition },
      ...(keepProject ? {} : { project: undefined }),
    }).success;
  assert.equal(withProject({}, true), true);
  assert.equal(
    withProject({}, false),
    false,
    "ceremony-method profile without a project",
  );
  assert.equal(
    withProject({ authentication: [buildProfile("none")] }),
    false,
    "project without ceremony-method profile",
  );
  assert.equal(
    withProject({
      authentication: [
        { ...ceremonyProfile, methodId: "missing" } as typeof ceremonyProfile,
      ],
    }),
    false,
    "unknown method",
  );
  assert.equal(
    withProject({
      authentication: [
        { ...ceremonyProfile, flowKind: "device" } as typeof ceremonyProfile,
      ],
    }),
    false,
    "flow kind mismatch",
  );
  assert.equal(
    connectorEnvelopeSchema.safeParse({
      ...envelope,
      profile: { id: "ceremony-connector/3", producer },
    }).success,
    false,
  );
  assert.equal(
    connectorEnvelopeSchema.safeParse({
      ...envelope,
      project: { ...project, extra: true },
    }).success,
    false,
  );
  for (const text of [
    JSON.stringify({ ...envelope, version: 3 }),
    JSON.stringify({ ...envelope, format: "other" }),
    "[]",
    "null",
    '"ceremony-connector"',
    JSON.stringify(envelope).replace(
      '{"format"',
      '{"__proto__":{"polluted":true},"format"',
    ),
  ])
    assert.throws(() => parseConnectorEnvelope(text), text.slice(0, 40));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const json = JSON.stringify(envelope);
  const exact =
    json + " ".repeat(ENVELOPE_LIMITS.bytes - Buffer.byteLength(json));
  assert.equal(parseConnectorEnvelope(exact).version, 2);
  assert.throws(() => parseConnectorEnvelope(exact + " "), /import limit/);
  assert.throws(
    () =>
      parseConnectorEnvelope(
        json.replace("Acme OAuth.", "é".repeat(2 * 1024 * 1024)),
      ),
    /import limit/,
  );
  assert.equal(CEREMONY_CONNECTOR_PROFILE, "ceremony-connector/2");
});

test("AC-IMP-14: a partially supported description round-trips its project and names every loss explicitly", async () => {
  const upgraded = await upgradeConnectorProject(
    authoredProjects[1],
    producer,
    AT,
  );
  const blocking = buildCompatibilityIssue();
  const definition = {
    ...upgraded.definition,
    identity: {
      ...upgraded.definition.identity,
      ecosystem: "openapi",
      nativeId: "example/multi",
    },
    authentication: [
      ...upgraded.definition.authentication,
      buildProfile("oauth-authorization-code"),
    ],
    configuration: [
      ...upgraded.definition.configuration,
      {
        name: "EXTRA_SETTING",
        source: "host" as const,
        classification: "public" as const,
        required: false,
      },
    ],
    capabilities: [buildCapability()],
    events: [
      {
        nativeId: "pet.created",
        transport: "http-webhook" as const,
        verification: "standard-webhooks" as const,
      },
    ],
    declaredServers: [
      ...upgraded.definition.declaredServers,
      { url: "https://api.example.invalid/v2", status: "declared" as const },
    ],
    compatibility: {
      issues: [blocking],
      dimensions: completeDimensions({
        import: "exact",
        authorize: "unsupported",
      }),
    },
    nativeExtensions: { "x-vendor": { note: "kept inert" } },
  };
  const envelope = connectorEnvelopeSchema.parse({
    ...upgraded,
    definition: {
      ...definition,
      normalizedDigest: await normalizedDigestOf(definition),
    },
    sources: [portableSource(buildSourceRecord())],
  });
  const parsed = parseConnectorEnvelope(JSON.stringify(envelope));
  if (parsed.version !== 2) throw new Error("unreachable");
  assert.deepEqual(parsed.envelope, envelope);
  assert.equal(await verifyNormalizedDigest(parsed.envelope.definition), true);
  const downgraded = downgradeConnectorEnvelope(parsed.envelope);
  assert.deepEqual(downgraded.project, authoredProjects[1]);
  assert.deepEqual(
    downgraded.diagnostics.map((issue) => `${issue.code}:${issue.severity}`),
    [
      "envelope.v1.profiles-dropped:warning",
      "envelope.v1.configuration-dropped:warning",
      "envelope.v1.capabilities-dropped:warning",
      "envelope.v1.events-dropped:warning",
      "envelope.v1.extensions-dropped:warning",
      "envelope.v1.servers-dropped:info",
      "envelope.v1.diagnostics-dropped:info",
      "envelope.v1.identity-dropped:info",
      "envelope.v1.provenance-dropped:info",
    ],
  );
  assert.ok(
    downgraded.diagnostics.every(
      (issue) =>
        issue.executionImpact === "none" && issue.dimension === "export",
    ),
  );
  assert.match(
    downgraded.diagnostics[0]!.message,
    /1 other authentication profile/,
  );
  assert.equal(
    parsed.envelope.definition.compatibility.issues[0]!.severity,
    "blocking",
  );
  assert.equal(
    parsed.envelope.definition.compatibility.dimensions.authorize,
    "unsupported",
  );
  const again = await upgradeConnectorProject(downgraded.project, producer, AT);
  assert.deepEqual(again, upgraded);
});

test("CON-02-06: digests, dimensions and kinds are stable helpers", async () => {
  const definition = buildDefinition();
  const digest = await normalizedDigestOf(definition);
  assert.equal(
    digest,
    await normalizedDigestOf(portableDefinition(definition)),
  );
  assert.equal(
    digest,
    await normalizedDigestOf({
      ...definition,
      definitionRef: "definition:other",
      normalizedDigest: "0".repeat(64),
    }),
  );
  assert.equal(
    digest,
    await normalizedDigestOf(
      Object.fromEntries(Object.entries(definition).reverse()),
    ),
  );
  assert.notEqual(
    digest,
    await normalizedDigestOf({ ...definition, capabilities: [] }),
  );
  assert.equal(await verifyNormalizedDigest(definition), false);
  assert.equal(
    await verifyNormalizedDigest({ ...definition, normalizedDigest: digest }),
    true,
  );
  assert.deepEqual(
    Object.values(completeDimensions({})),
    Array(12).fill("unsupported"),
  );
  assert.equal(completeDimensions({ import: "exact" }).import, "exact");
  assert.equal(authenticationKinds.length, 13);
  assert.ok(
    authenticationKinds.includes("none") &&
      authenticationKinds.includes("ceremony-method") &&
      authenticationKinds.includes("unsupported"),
  );
});
