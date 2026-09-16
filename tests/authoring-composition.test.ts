import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProviderProposal,
  attachGenericCeremony,
  ceremonyFamilyLabel,
  ceremonyPrerequisiteLabels,
  composeAuthoredMethods,
  connectorProjectSchema,
  exportConnectorFiles,
  extraDiscoveredCeremonies,
  methodsForDiscoveredAuth,
  newConnectorProject,
  proposeConnectorForProvider,
} from "../src/core/connector-authoring.js";
import type { FlowKind } from "../src/core/schema.js";

test("new connector projects contain independent, empty editable files", () => {
  const project = newConnectorProject();
  assert.deepEqual(project, {
    format: "ceremony-connector",
    version: 1,
    templates: [],
    manifest: {
      schemaVersion: 1,
      support: "live-adapter",
      id: "",
      name: "",
      description: "",
      methods: [],
    },
    workflows: [
      {
        document: "ceremonies",
        arazzo: "1.0.1",
        info: { title: "Connector ceremonies", version: "1.0.0" },
        sourceDescriptions: [{ name: "provider", url: "", type: "openapi" }],
        workflows: [],
      },
    ],
  });
  const untouched = structuredClone(project);
  const other = newConnectorProject();
  applyProviderProposal(other, "Stripe");
  other.workflows[0]!.sourceDescriptions[0]!.url = "https://example.com/spec";
  assert.deepEqual(project, untouched);
  assert.throws(() => exportConnectorFiles(project));
});

test("discovered methods preserve catalog priority, deduplicate and add required registration", () => {
  const discovered: FlowKind[] = ["device", "form", "device"];
  assert.deepEqual(methodsForDiscoveredAuth("stripe", discovered), [
    "api-key",
    "device",
    "form",
    "account-registration",
  ]);
  assert.deepEqual(discovered, ["device", "form", "device"]);
  assert.deepEqual(methodsForDiscoveredAuth("unknown", []), [
    "oauth-code",
    "account-registration",
  ]);
  for (const kind of ["oauth-code", "device", "github-app"] as const)
    assert.deepEqual(methodsForDiscoveredAuth("unknown", [kind, kind]), [
      kind,
      "account-registration",
    ]);
  assert.deepEqual(
    methodsForDiscoveredAuth("unknown", ["basic", "form", "api-key"]),
    ["basic", "form", "api-key"],
  );
  assert.deepEqual(
    methodsForDiscoveredAuth("unknown", ["account-registration", "device"]),
    ["account-registration", "device"],
  );
});

test("prototype member names are unknown provider catalog keys", () => {
  for (const name of ["constructor", "toString", "__proto__"])
    assert.deepEqual(methodsForDiscoveredAuth(name, []), [
      "oauth-code",
      "account-registration",
    ]);
});

test("provider proposals distinguish catalog entries, generic names and empty drafts", () => {
  assert.deepEqual(proposeConnectorForProvider("Stripe"), {
    slug: "stripe",
    name: "Stripe",
    description: "Verify a Stripe secret or restricted key.",
    methods: ["api-key"],
    origins: ["https://api.stripe.com"],
    resolution: {
      query: "Stripe",
      resolved: "stripe",
      confidence: "high",
      alternatives: [],
    },
  });
  assert.deepEqual(proposeConnectorForProvider("Obscure SaaS"), {
    slug: "obscure-saas",
    name: "Obscure SaaS",
    description:
      "Connect Obscure SaaS with a generic discovered-auth ceremony. Review every step before export.",
    methods: ["oauth-code", "account-registration"],
    origins: [],
    resolution: {
      query: "Obscure SaaS",
      resolved: "obscure-saas",
      confidence: "low",
      alternatives: [],
    },
  });
  const empty = proposeConnectorForProvider("");
  assert.equal(empty.slug, "provider");
  assert.equal(empty.name, "Provider");
  assert.equal(
    empty.description,
    "Connect Provider with a generic discovered-auth ceremony. Review every step before export.",
  );
  const url = proposeConnectorForProvider("https://auth.example.com");
  assert.equal(url.name, "auth.example.com");
  assert.equal(
    url.description,
    "Connect auth.example.com with a generic discovered-auth ceremony. Review every step before export.",
  );
});

test("all ceremony families expose their exact labels and unattended prerequisites", () => {
  const labels: Array<[FlowKind, string, string[]]> = [
    ["api-key", "API key", []],
    ["basic", "HTTP Basic", []],
    ["form", "Form sign-in", []],
    [
      "oauth-code",
      "OAuth authorization code",
      ["a provider account (registration runs first when none is stored)"],
    ],
    [
      "device",
      "OAuth device code",
      ["a provider account (registration runs first when none is stored)"],
    ],
    ["authmd-anonymous", "Anonymous claim", []],
    ["github-app", "GitHub App registration", []],
    [
      "account-registration",
      "Account registration",
      ["a fresh email address the agent can receive (agent inbox)"],
    ],
  ];
  for (const [kind, label, prerequisites] of labels) {
    assert.equal(ceremonyFamilyLabel(kind), label);
    assert.deepEqual(ceremonyPrerequisiteLabels(kind), prerequisites);
  }
});

test("extra discovered ceremonies exclude known grants, retain labels and cap unique entries", () => {
  const grants = [
    "authorization_code",
    "refresh_token",
    "password",
    "client_credentials",
    "urn:ietf:params:oauth:grant-type:device_code",
  ];
  assert.deepEqual(extraDiscoveredCeremonies(grants), []);
  assert.deepEqual(
    extraDiscoveredCeremonies([
      ...grants,
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
      "urn:ietf:params:oauth:grant-type:token-exchange",
      "urn:ietf:params:oauth:grant-type:saml2-bearer",
      "urn:example:custom",
      "urn:example:custom",
    ]),
    [
      "On-behalf-of (JWT bearer)",
      "On-behalf-of (token exchange)",
      "SAML bearer",
      "urn:example:custom",
    ],
  );
  assert.deepEqual(
    extraDiscoveredCeremonies([
      "one",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
    ]),
    ["one", "two", "three", "four", "five", "six", "seven", "eight"],
  );
});

test("unknown grant names cannot resolve inherited object members as ceremony labels", () => {
  assert.deepEqual(
    extraDiscoveredCeremonies(["toString", "constructor", "__proto__"]),
    ["toString", "constructor", "__proto__"],
  );
});

test("provider application fills blank metadata and honors a URL-only override", () => {
  const project = newConnectorProject();
  const proposal = applyProviderProposal(project, "Stripe", {
    openApiUrl: "https://example.com/openapi.json",
  });
  assert.equal(proposal.slug, "stripe");
  assert.deepEqual(
    [project.manifest.id, project.manifest.name, project.manifest.description],
    ["stripe", "Stripe", "Verify a Stripe secret or restricted key."],
  );
  assert.equal(
    project.workflows[0]!.sourceDescriptions[0]!.url,
    "https://example.com/openapi.json",
  );
  assert.deepEqual(
    project.manifest.methods.map(({ kind, label }) => ({ kind, label })),
    [{ kind: "api-key", label: "API key" }],
  );
});

test("provider application preserves authored metadata and uses explicit family selection", () => {
  const project = newConnectorProject();
  Object.assign(project.manifest, {
    id: "chosen-id",
    name: "Chosen name",
    description: "Chosen description",
  });
  project.workflows[0]!.sourceDescriptions[0]!.url =
    "https://example.com/original.json";
  applyProviderProposal(project, "GitHub", { methods: ["basic", "form"] });
  assert.deepEqual(
    [project.manifest.id, project.manifest.name, project.manifest.description],
    ["chosen-id", "Chosen name", "Chosen description"],
  );
  assert.equal(
    project.workflows[0]!.sourceDescriptions[0]!.url,
    "https://example.com/original.json",
  );
  assert.deepEqual(
    project.manifest.methods.map(({ kind, label }) => ({ kind, label })),
    [
      { kind: "basic", label: "HTTP Basic" },
      { kind: "form", label: "Form sign-in" },
    ],
  );
  const fallback = newConnectorProject();
  applyProviderProposal(fallback, "Stripe", { methods: [], openApiUrl: "" });
  assert.deepEqual(
    fallback.manifest.methods.map((method) => method.kind),
    ["api-key"],
  );
  assert.equal(fallback.workflows[0]!.sourceDescriptions[0]!.url, "");
});

test("composition rejects missing or insufficient children without changing the draft", () => {
  const project = newConnectorProject();
  const child = attachGenericCeremony(project, "basic", "Existing child");
  const before = structuredClone(project);
  for (const ids of [[], [child.id]]) {
    assert.throws(() => composeAuthoredMethods(project, ids), {
      message: "compose requires two ceremonies",
    });
    assert.deepEqual(project, before);
  }
  for (const ids of [
    ["missing", child.id],
    [child.id, "missing"],
  ]) {
    assert.throws(() => composeAuthoredMethods(project, ids), {
      message: "unknown method",
    });
    assert.deepEqual(project, before);
  }
});

test("composition retains child handoffs and order in one explicitly verified parent", () => {
  const project = newConnectorProject();
  const basic = attachGenericCeremony(project, "basic", "Basic child");
  const oauth = attachGenericCeremony(project, "oauth-code", "OAuth child");
  const github = attachGenericCeremony(project, "github-app", "GitHub child");
  const children = structuredClone(project.manifest.methods);
  const parent = composeAuthoredMethods(project, [
    github.id,
    basic.id,
    oauth.id,
  ]);
  assert.equal(parent.kind, "github-app");
  assert.equal(parent.label, "Composed ceremony");
  assert.deepEqual(parent.contract!.prerequisites, [
    {
      id: github.id,
      kind: "provider-registration",
      reuse: "verified-context",
      handoff: github.contract!.handoff,
    },
    {
      id: basic.id,
      kind: "provider-consent",
      reuse: "verified-context",
      handoff: basic.contract!.handoff,
    },
    {
      id: oauth.id,
      kind: "provider-registration",
      reuse: "verified-context",
      handoff: oauth.contract!.handoff,
    },
  ]);
  assert.equal(parent.contract!.completion.verifier, "method-4.verify-access");
  assert.deepEqual(project.workflows[0]!.workflows[3], {
    workflowId: "method-4",
    summary: "Complete after the composed ceremonies",
    steps: [
      {
        stepId: "verify-composed",
        description: "Verify access after the selected ceremonies succeed",
        operationId: "provider.verify-composed",
      },
    ],
  });
  assert.deepEqual(project.manifest.methods.slice(0, 3), children);
  assert.equal(project.manifest.methods[3], parent);
  const pair = composeAuthoredMethods(project, [basic.id, oauth.id]);
  assert.equal(pair.contract!.prerequisites.length, 2);
});

test("portable export emits each shared presentation once and preserves custom content", () => {
  const project = newConnectorProject();
  applyProviderProposal(project, "Stripe", {
    methods: ["oauth-code", "oauth-code", "api-key"],
    openApiUrl: "https://example.com/openapi.json",
  });
  project.manifest.methods[0]!.templateId = "shared-login";
  project.manifest.methods[1]!.templateId = "shared-login";
  project.templates[0]!.id = "shared-login";
  project.templates[0]!.screens.intro += "\n";
  const before = structuredClone(project);
  const files = exportConnectorFiles(connectorProjectSchema.parse(project));
  assert.deepEqual(files.templates, project.templates);
  assert.deepEqual(
    files.templates.map((template) => template.id),
    ["shared-login", "api-key"],
  );
  assert.deepEqual(files.manifest, project.manifest);
  assert.equal(files.workflows[0]!.name, "ceremonies.arazzo.json");
  assert.equal(
    Object.hasOwn(files.workflows[0]!.definition, "document"),
    false,
  );
  assert.deepEqual(
    files.workflows[0]!.definition.workflows,
    project.workflows[0]!.workflows,
  );
  assert.deepEqual(project, before);
  project.templates = [];
  const defaults = exportConnectorFiles(connectorProjectSchema.parse(project));
  assert.deepEqual(
    defaults.templates.map(({ id, kind }) => ({ id, kind })),
    [
      { id: "shared-login", kind: "oauth-code" },
      { id: "api-key", kind: "api-key" },
    ],
  );
});
