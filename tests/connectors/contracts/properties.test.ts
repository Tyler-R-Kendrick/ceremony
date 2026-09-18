import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  attachGenericCeremony,
  connectorProjectSchema,
  newConnectorProject,
} from "../../../src/core/connector-authoring.js";
import { flowKinds } from "../../../src/core/schema.js";
import {
  DEFINITION_LIMITS,
  EXTENSION_LIMITS,
  agentConnectorProjection,
  agentDefinitionProjection,
  capabilityStatusSchema,
  catalogEntrySchema,
  downgradeConnectorEnvelope,
  encodePathSegment,
  evidenceLevels,
  exportDefinitionProjection,
  humanConnectionProjection,
  nativeExtensionsSchema,
  nativeIdentifierSchema,
  nativeVersionSchema,
  normalizedDefinitionSchema,
  parseConnectorEnvelope,
  sourceIdentityDigest,
  supportLevels,
  upgradeConnectorProject,
  verificationClaimSchema,
  verifyNormalizedDigest,
  type CapabilityStatus,
  type CatalogEntry,
  type ConnectionSummary,
  type EvidenceLevel,
  type NormalizedDefinition,
} from "../../../src/core/connectors/index.js";
import { capabilityStatus } from "../../../src/server/connectors/adapter.js";
import {
  AT,
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
  canaryValues,
} from "../fixtures/builders.js";

const options = {
  seed: Number(process.env.FUZZ_SEED ?? 20260909),
  numRuns: Number(process.env.FUZZ_RUNS ?? 200),
};
assert.ok(Number.isSafeInteger(options.seed), "FUZZ_SEED must be an integer");
assert.ok(
  Number.isSafeInteger(options.numRuns) && options.numRuns > 0,
  "FUZZ_RUNS must be a positive integer",
);
const prototypeNames = () =>
  Object.getOwnPropertyNames(Object.prototype).sort();
const baseline = prototypeNames();
const hasControl = (value: string) => /[\p{Cc}]/u.test(value);
const hasBidi = (value: string) =>
  /[\u{202A}-\u{202E}\u{2066}-\u{2069}]/u.test(value);
const reserved = new Set(["__proto__", "constructor", "prototype"]);

test("property: any identifier the schema accepts is preserved verbatim and encodes/decodes losslessly", () => {
  fc.assert(
    fc.property(
      fc.string({ unit: "binary", minLength: 1, maxLength: 600 }),
      (value) => {
        const result = nativeIdentifierSchema.safeParse(value);
        if (
          hasControl(value) ||
          hasBidi(value) ||
          value.length > 512 ||
          !value.trim() ||
          reserved.has(value)
        )
          assert.equal(result.success, false);
        if (!result.success) return;
        assert.equal(result.data, value);
        assert.equal(decodeURIComponent(encodePathSegment(value)), value);
        assert.equal(/[/@]/.test(encodePathSegment(value)), false);
        assert.equal(JSON.parse(JSON.stringify(result.data)), value);
        assert.equal(
          nativeVersionSchema.safeParse(value.slice(0, 128)).success ||
            value.length > 128 ||
            !value.slice(0, 128).trim(),
          true,
        );
      },
    ),
    options,
  );
});

test("property: structured native ids with separators are accepted exactly unless a segment is a traversal", () => {
  const segment = fc.stringMatching(/^[A-Za-z0-9._~-]{1,24}$/);
  fc.assert(
    fc.property(
      fc.array(segment, { minLength: 1, maxLength: 6 }),
      fc.constantFrom("/", ":", "@", "."),
      (segments, separator) => {
        const id = segments.join(separator);
        const traversal = /(^|[\\/])\.\.?([\\/]|$)/.test(id);
        const result = nativeIdentifierSchema.safeParse(id);
        assert.equal(result.success, !traversal && !reserved.has(id), id);
        if (result.success) assert.equal(result.data, id);
      },
    ),
    options,
  );
});

test("property: identities that differ in any field digest apart; spelling is never normalized", async () => {
  const token = fc
    .stringMatching(/^[A-Za-z0-9./:@_-]{1,40}$/)
    .filter((value) => nativeIdentifierSchema.safeParse(value).success);
  await fc.assert(
    fc.asyncProperty(
      token,
      token,
      fc.constantFrom("mcp-registry", "smithery", "docker-mcp"),
      fc.constantFrom("mcp-registry", "smithery", "docker-mcp"),
      async (idA, idB, ecosystemA, ecosystemB) => {
        const a = {
          ecosystem: ecosystemA,
          authorityNamespace: "",
          nativeId: idA,
          nativeVersion: "1",
        };
        const b = {
          ecosystem: ecosystemB,
          authorityNamespace: "",
          nativeId: idB,
          nativeVersion: "1",
        };
        const same = idA === idB && ecosystemA === ecosystemB;
        assert.equal(
          (await sourceIdentityDigest(a)) === (await sourceIdentityDigest(b)),
          same,
        );
      },
    ),
    { ...options, numRuns: Math.min(options.numRuns, 100) },
  );
});

test("property: prototype keys are refused wherever a source can place them and never reach Object.prototype", () => {
  const placements: Array<
    (key: string) => { name: string; parse: () => boolean }
  > = [
    (key) => ({
      name: "nativeId",
      parse: () => nativeIdentifierSchema.safeParse(key).success,
    }),
    (key) => ({
      name: "version",
      parse: () => nativeVersionSchema.safeParse(key).success,
    }),
    (key) => ({
      name: "target id",
      parse: () =>
        verificationClaimSchema.safeParse({
          ...buildClaim(),
          target: { kind: "account", id: key },
        }).success,
    }),
    (key) => ({
      name: "extension key",
      parse: () =>
        nativeExtensionsSchema.safeParse(
          JSON.parse(`{${JSON.stringify(key)}:{"polluted":true}}`),
        ).success,
    }),
    (key) => ({
      name: "nested extension key",
      parse: () =>
        nativeExtensionsSchema.safeParse(
          JSON.parse(`{"x-a":{"b":[{${JSON.stringify(key)}:1}]}}`),
        ).success,
    }),
    (key) => ({
      name: "capability extension",
      parse: () =>
        normalizedDefinitionSchema.safeParse({
          ...buildDefinition(),
          capabilities: [
            buildCapability({
              nativeExtensions: JSON.parse(`{${JSON.stringify(key)}:1}`),
            }),
          ],
        }).success,
    }),
    (key) => ({
      name: "definition extension",
      parse: () =>
        normalizedDefinitionSchema.safeParse({
          ...buildDefinition(),
          nativeExtensions: JSON.parse(
            `{"x-v":{${JSON.stringify(key)}:{"polluted":true}}}`,
          ),
        }).success,
    }),
    (key) => ({
      name: "dimension key",
      parse: () =>
        normalizedDefinitionSchema.safeParse({
          ...buildDefinition(),
          compatibility: {
            issues: [],
            dimensions: JSON.parse(`{${JSON.stringify(key)}:"exact"}`),
          },
        }).success,
    }),
  ];
  fc.assert(
    fc.property(
      fc.constantFrom("__proto__", "constructor", "prototype"),
      fc.integer({ min: 0, max: placements.length - 1 }),
      (key, index) => {
        const placement = placements[index]!(key);
        assert.equal(placement.parse(), false, `${placement.name} ${key}`);
        assert.deepEqual(prototypeNames(), baseline);
        assert.equal(({} as Record<string, unknown>).polluted, undefined);
      },
    ),
    { ...options, numRuns: Math.min(options.numRuns, 60) },
  );
});

test("property: extension graphs are accepted exactly up to the declared depth, node and key bounds", () => {
  const nest = (depth: number): unknown =>
    depth === 0 ? 1 : [nest(depth - 1)];
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: EXTENSION_LIMITS.depth + 6 }),
      fc.integer({ min: 0, max: EXTENSION_LIMITS.nodes + 8 }),
      fc.integer({ min: 0, max: EXTENSION_LIMITS.keys + 4 }),
      (depth, nodes, keys) => {
        // The record itself is depth 1, so a value nested `depth` levels sits at depth + 1.
        assert.equal(
          nativeExtensionsSchema.safeParse({ "x-deep": nest(depth) }).success,
          depth + 2 <= EXTENSION_LIMITS.depth,
          `depth ${depth}`,
        );
        // Root record + array + `nodes` scalars.
        assert.equal(
          nativeExtensionsSchema.safeParse({
            "x-list": Array.from({ length: nodes }, () => 0),
          }).success,
          nodes + 2 <= EXTENSION_LIMITS.nodes,
          `nodes ${nodes}`,
        );
        assert.equal(
          nativeExtensionsSchema.safeParse(
            Object.fromEntries(
              Array.from({ length: keys }, (_, index) => [`k${index}`, index]),
            ),
          ).success,
          keys <= EXTENSION_LIMITS.keys,
          `keys ${keys}`,
        );
      },
    ),
    { ...options, numRuns: Math.min(options.numRuns, 80) },
  );
});

test("property: every definition list is accepted at its limit and refused one past it", () => {
  const lists = [
    "events",
    "authentication",
    "configuration",
    "declaredServers",
  ] as const;
  const build = (
    name: (typeof lists)[number],
    count: number,
  ): Partial<NormalizedDefinition> => {
    switch (name) {
      case "events":
        return {
          events: Array.from({ length: count }, (_, index) => ({
            nativeId: `event${index}`,
            transport: "http-webhook",
            verification: "unknown",
          })),
        };
      case "authentication":
        return {
          authentication: Array.from({ length: count }, (_, index) =>
            buildProfile("none", { id: `p${index}` }),
          ),
          capabilities: [],
        };
      case "configuration":
        return {
          configuration: Array.from({ length: count }, (_, index) => ({
            name: `NAME_${index}`,
            source: "host",
            classification: "public",
            required: false,
          })),
        };
      case "declaredServers":
        return {
          declaredServers: Array.from({ length: count }, (_, index) => ({
            url: `https://api${index}.example/v1`,
            status: "declared",
          })),
        };
    }
  };
  fc.assert(
    fc.property(
      fc.constantFrom(...lists),
      fc.integer({ min: -2, max: 3 }),
      (name, offset) => {
        const count = DEFINITION_LIMITS[name] + offset;
        if (count < 0) return;
        assert.equal(
          normalizedDefinitionSchema.safeParse({
            ...buildDefinition(),
            ...build(name, count),
          }).success,
          offset <= 0,
          `${name} ${count}`,
        );
      },
    ),
    { ...options, numRuns: Math.min(options.numRuns, 60) },
  );
});

test("property: strict v1 projects survive upgrade, serialization, parse and downgrade unchanged", async () => {
  const kinds = fc.array(fc.constantFrom(...flowKinds), {
    minLength: 1,
    maxLength: 4,
  });
  const text = (max: number) =>
    fc.string({ unit: "binary-ascii", minLength: 1, maxLength: max });
  await fc.assert(
    fc.asyncProperty(
      kinds,
      fc.stringMatching(/^[a-z0-9-]{1,20}$/),
      text(40),
      text(60),
      fc.array(text(30), { minLength: 4, maxLength: 4 }),
      async (chosen, id, name, description, labels) => {
        const draft = newConnectorProject();
        draft.manifest.id = id;
        draft.manifest.name = name;
        draft.manifest.description = description;
        draft.workflows[0]!.sourceDescriptions[0]!.url =
          "https://api.example.invalid/openapi.json";
        chosen.forEach((kind, index) =>
          attachGenericCeremony(draft, kind, labels[index]!),
        );
        const project = connectorProjectSchema.parse(draft);
        const envelope = await upgradeConnectorProject(
          project,
          { id: "ceremony-tests", version: "1.0.0" },
          AT,
        );
        assert.deepEqual(envelope.project, project);
        const parsed = parseConnectorEnvelope(JSON.stringify(envelope));
        if (parsed.version !== 2) throw new Error("expected version 2");
        assert.deepEqual(parsed.envelope, envelope);
        assert.equal(
          await verifyNormalizedDigest(parsed.envelope.definition),
          true,
        );
        const downgraded = downgradeConnectorEnvelope(parsed.envelope);
        assert.deepEqual(downgraded.project, project);
        assert.ok(
          downgraded.diagnostics.every((issue) => issue.severity === "info"),
        );
        assert.equal(
          parsed.envelope.definition.authentication.length,
          project.manifest.methods.length,
        );
        assert.deepEqual(parsed.envelope.definition.capabilities, []);
        const labelsShown = parsed.envelope.definition.authentication.map(
          (profile) => profile.label,
        );
        assert.ok(labelsShown.every((label) => !hasControl(label)));
        const v1 = parseConnectorEnvelope(JSON.stringify(project));
        assert.equal(v1.version, 1);
      },
    ),
    { ...options, numRuns: Math.min(options.numRuns, 40) },
  );
});

test("property: canaries injected into any source-controlled field never reach agent, export or catalog views", () => {
  const definition = buildDefinition();
  const injections: Array<(canary: string) => Partial<NormalizedDefinition>> = [
    (canary) => ({ display: { ...definition.display, description: canary } }),
    (canary) => ({
      authentication: [
        buildProfile("oauth-authorization-code", { label: canary }),
      ],
    }),
    (canary) => ({
      configuration: [{ ...definition.configuration[0]!, description: canary }],
    }),
    (canary) => ({ capabilities: [buildCapability({ summary: canary })] }),
    (canary) => ({ capabilities: [buildCapability({ label: canary })] }),
    (canary) => ({
      capabilities: [
        buildCapability({ inputSchemaRef: canary, outputSchemaRef: canary }),
      ],
    }),
    (canary) => ({
      capabilities: [
        buildCapability({ nativeExtensions: { "x-secret": canary } }),
      ],
    }),
    (canary) => ({
      capabilities: [
        buildCapability({
          nativeExtensions: { "x-nested": { list: [{ deep: canary }] } },
        }),
      ],
    }),
    (canary) => ({
      declaredServers: [
        {
          url: "https://api.petstore.example/v1",
          description: canary,
          status: "declared",
        },
      ],
    }),
    (canary) => ({
      compatibility: {
        ...definition.compatibility,
        issues: [
          buildCompatibilityIssue({
            message: canary,
            remediation: canary,
            sourcePointer: canary,
            normalizedPointer: canary,
          }),
        ],
      },
    }),
    (canary) => ({ nativeExtensions: { "x-vendor": canary } }),
    (canary) => ({
      nativeExtensions: {
        "x-vendor": { examples: [{ headers: { authorization: canary } }] },
      },
    }),
    (canary) => ({
      events: [
        {
          nativeId: "evt",
          transport: "http-webhook",
          verification: "unknown",
          label: canary,
          messageSchemaRef: canary,
        },
      ],
    }),
  ];
  const extensionInjections = new Set([6, 7, 10, 11]);
  fc.assert(
    fc.property(
      fc.constantFrom(...canaryValues),
      fc.integer({ min: 0, max: injections.length - 1 }),
      (canary, index) => {
        const poisoned = normalizedDefinitionSchema.parse({
          ...definition,
          ...injections[index]!(canary),
        });
        assert.equal(
          JSON.stringify(agentDefinitionProjection(poisoned)).includes(canary),
          false,
          `agent ${index}`,
        );
        const exported = JSON.stringify(exportDefinitionProjection(poisoned));
        if (extensionInjections.has(index))
          assert.equal(exported.includes(canary), false, `export ${index}`);
        assert.equal(exported.includes("definition:petstore"), false);
      },
    ),
    options,
  );
  fc.assert(
    fc.property(
      fc.constantFrom(...canaryValues),
      fc.constantFrom("root", "handoff", "verification", "target"),
      (canary, where) => {
        const summary = buildConnectionSummary({
          handoff: buildHandoffSummary(),
        });
        const poisoned = {
          ...summary,
          ...(where === "root"
            ? { credentialRef: canary, accessToken: canary }
            : {}),
          ...(where === "handoff"
            ? {
                handoff: {
                  ...summary.handoff!,
                  url: canary,
                  private: { verifier: canary },
                },
              }
            : {}),
          ...(where === "verification"
            ? { verification: { ...summary.verification!, raw: canary } }
            : {}),
          ...(where === "target"
            ? { target: { ...summary.target!, email: canary } }
            : {}),
        } as unknown as ConnectionSummary;
        assert.equal(
          JSON.stringify(humanConnectionProjection(poisoned)).includes(canary),
          false,
          `human ${where}`,
        );
        assert.equal(
          JSON.stringify(agentConnectorProjection(poisoned)).includes(canary),
          false,
          `agent ${where}`,
        );
        assert.throws(() =>
          normalizedDefinitionSchema.parse({
            ...definition,
            declaredServers: [
              {
                url: `https://api.example/v1?sig=${encodeURIComponent(canary)}`,
                status: "declared",
              },
            ],
          }),
        );
      },
    ),
    { ...options, numRuns: Math.min(options.numRuns, 60) },
  );
});

test("property: every implementation, evidence and configuration combination is classified consistently", () => {
  const live = new Set<EvidenceLevel>([
    "live-authorized",
    "deployed-authorized",
  ]);
  const implementations = ["implemented", "unsupported"] as const;
  const configurations = ["ready", "missing", "not-applicable"] as const;
  let combinations = 0;
  for (const implementation of implementations)
    for (const evidence of evidenceLevels)
      for (const configuration of configurations) {
        combinations++;
        const expected =
          !(implementation === "unsupported" && evidence !== "not-tested") &&
          !(configuration === "missing" && live.has(evidence));
        const status: CapabilityStatus = buildCapabilityStatus({
          ...(expected ? {} : { evidence: "unit" }),
          implementation: "implemented",
        });
        const candidate = {
          ...status,
          implementation,
          evidence,
          configuration,
        };
        assert.equal(
          capabilityStatusSchema.safeParse(candidate).success,
          expected,
          JSON.stringify([implementation, evidence, configuration]),
        );
      }
  assert.equal(combinations, 2 * evidenceLevels.length * 3);
  // The adapter helper coerces unsupported dimensions but does not know about
  // configuration; the schema is the authority and the disagreement is exact.
  fc.assert(
    fc.property(
      fc.constantFrom(...implementations),
      fc.constantFrom(...evidenceLevels),
      fc.constantFrom(...configurations),
      fc.boolean(),
      (implementation, evidence, configuration, withRef) => {
        const status = capabilityStatus(
          { adapterVersion: "1.0.0", runtime: "hosted-server" },
          {
            dimension: "invoke",
            profile: "openapi-3.1",
            implementation,
            evidence,
            configuration,
            ...(withRef ? { evidenceRef: "evidence:1" } : {}),
          },
        );
        const valid = capabilityStatusSchema.safeParse(status).success;
        assert.equal(
          valid,
          !(configuration === "missing" && live.has(status.evidence)),
          JSON.stringify(status),
        );
        if (implementation === "unsupported")
          assert.equal(status.evidence, "not-tested");
      },
    ),
    options,
  );
});

test("property: catalog rows never outrank their dimensions or claim live proof for fixtures", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...supportLevels),
      fc.constantFrom(...evidenceLevels),
      fc.constantFrom(...evidenceLevels),
      fc.boolean(),
      fc.boolean(),
      (support, entryEvidence, capabilityEvidence, present, implemented) => {
        const capability = {
          ...buildCapabilityStatus({ implementation: "implemented" }),
          implementation: implemented ? "implemented" : "unsupported",
          evidence: capabilityEvidence,
          configuration: present ? "ready" : "missing",
        } as CapabilityStatus;
        const entry = {
          ...buildCatalogEntry(),
          support,
          evidence: entryEvidence,
          configuration: [
            {
              name: "PETSTORE_CLIENT_ID",
              required: true,
              classification: "public",
              present,
            },
          ],
          capabilities: [capability],
        } as CatalogEntry;
        const rank = (level: EvidenceLevel) => evidenceLevels.indexOf(level);
        const live = (level: EvidenceLevel) =>
          rank(level) >= rank("live-authorized");
        const capabilityValid =
          !(!implemented && capabilityEvidence !== "not-tested") &&
          !(!present && live(capabilityEvidence));
        const expected =
          capabilityValid &&
          rank(entryEvidence) <= rank(capabilityEvidence) &&
          !(support === "provider-backed" && !present) &&
          !(support === "unconfigured" && present) &&
          !(
            (support === "fixture" || support === "catalog-only") &&
            (live(entryEvidence) || live(capabilityEvidence))
          ) &&
          !(support === "catalog-only" && implemented);
        assert.equal(
          catalogEntrySchema.safeParse(entry).success,
          expected,
          JSON.stringify([
            support,
            entryEvidence,
            capabilityEvidence,
            present,
            implemented,
          ]),
        );
      },
    ),
    { ...options, numRuns: Math.max(options.numRuns, 400) },
  );
});

test("property: source records with a canary anywhere reachable by a URL field are refused, not laundered", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...canaryValues),
      fc.constantFrom("query", "userinfo", "fragment"),
      (canary, shape) => {
        const location =
          shape === "query"
            ? `https://example.invalid/openapi.json?token=${encodeURIComponent(canary)}`
            : shape === "userinfo"
              ? `https://user:${encodeURIComponent(canary)}@example.invalid/openapi.json`
              : `https://example.invalid/openapi.json#${encodeURIComponent(canary)}`;
        const source = {
          ...buildSourceRecord(),
          origin: { kind: "url", location },
        };
        assert.equal(
          normalizedDefinitionSchema.safeParse({
            ...buildDefinition(),
            declaredServers: [{ url: location, status: "declared" }],
          }).success,
          false,
        );
        assert.equal(
          JSON.stringify(source).includes(canary) ||
            JSON.stringify(source).includes(encodeURIComponent(canary)),
          true,
        );
        assert.throws(() =>
          buildSourceRecord({ origin: { kind: "url", location } }),
        );
      },
    ),
    { ...options, numRuns: Math.min(options.numRuns, 60) },
  );
});
