import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connectorProjectSchema,
  newConnectorProject,
  newAuthoredMethod,
  parseConnectorProject,
  exportConnectorFiles,
  parseConnectorDraft,
} from "../src/core/connector-authoring.js";
import { flowKinds } from "../src/core/schema.js";
import { runArazzo, arazzoSchema } from "../src/server/arazzo.js";

function project() {
  const draft = newConnectorProject();
  draft.manifest.id = "acme";
  draft.manifest.name = "Acme";
  const method = newAuthoredMethod("oauth-code", "oauth");
  method.contract!.completion.verifier = "acme.verify-access";
  draft.manifest.methods = [method];
  draft.workflows[0]!.sourceDescriptions[0]!.url =
    "https://api.example.com/openapi.json";
  draft.workflows[0]!.workflows = [
    {
      workflowId: "oauth",
      summary: "Connect Acme",
      steps: [
        {
          stepId: "prepare",
          description: "Prepare request",
          operationId: "authorize/prepare",
        },
        {
          stepId: "verify",
          description: "Verify account",
          operationId: "accounts/get-current",
        },
      ],
    },
  ];
  return draft;
}
test("studio starts blank and requires a verifier", () => {
  assert.equal(newConnectorProject().manifest.methods.length, 0);
  assert.equal(
    connectorProjectSchema.safeParse(newConnectorProject()).success,
    false,
  );
  const candidate = project();
  assert.equal(connectorProjectSchema.safeParse(candidate).success, true);
  candidate.manifest.methods[0]!.contract!.completion.verifier = "";
  assert.equal(connectorProjectSchema.safeParse(candidate).success, false);
});
test("presentation IDs cannot cross authentication families", () => {
  const p = project();
  const other = structuredClone(p.manifest.methods[0]!);
  other.id = "other";
  other.kind = "device";
  p.manifest.methods.push(other);
  assert.equal(connectorProjectSchema.safeParse(p).success, false);
});
test("exports preserve distinct presentation IDs within the same auth family", () => {
  const p = project();
  const first = p.manifest.methods[0]!;
  first.templateId = "personal-login";
  p.manifest.methods.push({
    ...structuredClone(first),
    id: "organization",
    templateId: "organization-login",
  });
  const defaults = exportConnectorFiles(
    parseConnectorProject(JSON.stringify(p)),
  );
  assert.deepEqual(
    defaults.templates.map((t) => t.id),
    ["personal-login", "organization-login"],
  );
  p.templates = defaults.templates;
  p.templates[1]!.screens.intro += "\n";
  assert.deepEqual(
    exportConnectorFiles(parseConnectorProject(JSON.stringify(p))).templates,
    p.templates,
  );
});
test("authored exports execute through existing Arazzo with explicit host bindings", async () => {
  const bundle = parseConnectorProject(JSON.stringify(project()));
  const files = exportConnectorFiles(bundle);
  assert.equal(files.manifest.name, "Acme");
  assert.equal(files.templates[0]!.kind, "oauth-code");
  const document = arazzoSchema.parse(files.workflows[0]!.definition);
  const effects: string[] = [];
  await assert.rejects(runArazzo(document, "oauth", new Map()), /Unbound/);
  assert.equal(effects.length, 0);
  await runArazzo(
    document,
    "oauth",
    new Map(
      document.workflows[0]!.steps.map((step) => [
        step.operationId!,
        async () => {
          effects.push(step.stepId);
        },
      ]),
    ),
  );
  assert.deepEqual(effects, ["prepare", "verify"]);
  assert.deepEqual(parseConnectorProject(JSON.stringify(bundle)), bundle);
});
test("every auth family uses conservative inputs and verification-on-return", () => {
  for (const kind of flowKinds) {
    const candidate = project();
    const method = newAuthoredMethod(kind, "oauth");
    method.contract!.completion.verifier = "acme.verify-access";
    candidate.manifest.methods = [method];
    assert.equal(
      connectorProjectSchema.safeParse(candidate).success,
      true,
      kind,
    );
    assert.equal(method.contract!.handoff.resume, "verify");
    assert.equal(method.contract!.handoff.delegation, "a2h-authorize");
    assert.ok(
      method.fields.every((field) => field.classification !== "public"),
    );
  }
});
test("imports reject authority, executable expressions, private URLs and broken linkage", () => {
  const mutate = (edit: (p: ReturnType<typeof project>) => void) => {
    const p = project();
    edit(p);
    assert.equal(connectorProjectSchema.safeParse(p).success, false);
  };
  for (const key of [
    "published",
    "connectionRef",
    "owner",
    "handler",
    "__proto__",
  ])
    assert.throws(() =>
      parseConnectorProject(
        JSON.stringify(project()).replace(
          '"format":',
          `${JSON.stringify(key)}:"forged","format":`,
        ),
      ),
    );
  for (const url of [
    "javascript:alert(1)",
    "https://user:secret@example.com/api",
    "https://example.com/api?token=x",
    "https://example.com/api#secret",
  ])
    mutate((p) => {
      p.workflows[0]!.sourceDescriptions[0]!.url = url;
    });
  mutate((p) => {
    p.workflows[0]!.workflows[0]!.steps[0]!.operationId =
      "(() => fetch('/secret'))()";
  });
  mutate((p) => {
    p.manifest.methods[0]!.contract!.workflows[0]!.version = "2.0.0";
  });
  mutate((p) => {
    p.manifest.methods[0]!.contract!.workflows = [];
  });
  mutate((p) => {
    p.workflows[0]!.workflows[0]!.steps[1]!.stepId = "prepare";
  });
  mutate((p) => {
    p.workflows[0]!.workflows.push({ ...p.workflows[0]!.workflows[0]! });
  });
  mutate((p) => {
    p.workflows.push(structuredClone(p.workflows[0]!));
  });
  mutate((p) => {
    p.workflows[0]!.workflows.push({
      ...p.workflows[0]!.workflows[0]!,
      workflowId: "unattached",
    });
  });
  assert.throws(
    () => parseConnectorProject(" ".repeat(256 * 1024 + 1)),
    /256 KiB/,
  );
});
test("step limits reject rather than truncate", () => {
  const candidate = project();
  candidate.workflows[0]!.workflows[0]!.steps = Array.from(
    { length: 32 },
    (_, i) => ({
      stepId: `step-${i}`,
      description: "Verify",
      operationId: "accounts/get-current",
    }),
  );
  assert.equal(connectorProjectSchema.safeParse(candidate).success, true);
  candidate.workflows[0]!.workflows[0]!.steps.push({
    stepId: "step-33",
    description: "More",
    operationId: "accounts/get-current",
  });
  assert.equal(connectorProjectSchema.safeParse(candidate).success, false);
});

test("unfinished drafts roundtrip but cannot become completed exports", () => {
  const blank = parseConnectorDraft(JSON.stringify(newConnectorProject()));
  assert.equal(blank.manifest.name, "");
  assert.equal(connectorProjectSchema.safeParse(blank).success, false);
  const candidate = project();
  candidate.manifest.methods[0]!.contract!.completion.verifier = "";
  candidate.workflows[0]!.workflows[0]!.steps[0]!.operationId = "";
  assert.equal(
    parseConnectorDraft(JSON.stringify(candidate)).manifest.id,
    "acme",
  );
  assert.throws(() => parseConnectorProject(JSON.stringify(candidate)));
  candidate.manifest.methods[0]!.contract!.workflows[0]!.document = "missing";
  assert.throws(() => parseConnectorDraft(JSON.stringify(candidate)));
  assert.throws(
    () => parseConnectorDraft(" ".repeat(256 * 1024 + 1)),
    /256 KiB/,
  );
});

test("ambiguous presentation and non-editable workflow references are rejected", () => {
  const candidate = project();
  candidate.manifest.methods[0]!.contract!.workflows.push({
    ...candidate.manifest.methods[0]!.contract!.workflows[0]!,
    workflowId: "second",
  });
  assert.throws(() => parseConnectorDraft(JSON.stringify(candidate)));
  const saved = parseConnectorProject(JSON.stringify(project()));
  const template = exportConnectorFiles(saved).templates[0]!;
  saved.templates = [template, template];
  assert.throws(() => parseConnectorDraft(JSON.stringify(saved)));
  saved.templates = [{ ...template, id: "unattached" }];
  assert.throws(() => parseConnectorDraft(JSON.stringify(saved)));
});

test("exact import boundaries and identifier anchors are enforced without throwing from safeParse", () => {
  const text = JSON.stringify(project());
  const exact =
    text + " ".repeat(256 * 1024 - new TextEncoder().encode(text).byteLength);
  assert.equal(parseConnectorDraft(exact).manifest.id, "acme");
  assert.equal(parseConnectorProject(exact).manifest.id, "acme");
  assert.throws(() => parseConnectorDraft(exact + " "), /256 KiB/);
  assert.throws(() => parseConnectorProject(exact + " "), /256 KiB/);
  for (const value of ["!step", "step!", "x".repeat(65)]) {
    const p = project();
    p.workflows[0]!.workflows[0]!.steps[0]!.stepId = value;
    assert.equal(connectorProjectSchema.safeParse(p).success, false);
  }
  for (const value of ["!operation", "operation!", "x".repeat(121)]) {
    const p = project();
    p.workflows[0]!.workflows[0]!.steps[0]!.operationId = value;
    assert.equal(connectorProjectSchema.safeParse(p).success, false);
  }
  const p = project();
  p.workflows[0]!.sourceDescriptions[0]!.url =
    "https://example.com/api?secret=x";
  const result = connectorProjectSchema.safeParse(p);
  assert.equal(result.success, false);
  if (!result.success)
    assert.ok(
      result.error.issues.some(
        (issue) =>
          issue.message ===
          "Use a public HTTPS OpenAPI document URL without credentials or query parameters",
      ),
    );
});

function twoMethods() {
  const p = project();
  const second = newAuthoredMethod("api-key", "key");
  second.contract!.completion.verifier = "acme.verify-key";
  second.contract!.workflows[0]!.document = "second";
  p.manifest.methods.push(second);
  p.workflows.push({
    ...structuredClone(p.workflows[0]!),
    document: "second",
    workflows: [
      {
        workflowId: "key",
        summary: "Verify key",
        steps: [
          {
            stepId: "check",
            description: "Verify key",
            operationId: "keys/verify",
          },
        ],
      },
    ],
  });
  p.templates = exportConnectorFiles(
    parseConnectorProject(JSON.stringify(p)),
  ).templates;
  return p;
}

test("multiple documents and presentation families export the exact saved content", () => {
  const p = twoMethods();
  p.templates[0]!.screens.intro += "\n";
  const parsed = parseConnectorProject(JSON.stringify(p));
  const exported = exportConnectorFiles(parsed);
  assert.deepEqual(
    exported.workflows.map((w) => w.name),
    ["ceremonies.arazzo.json", "second.arazzo.json"],
  );
  assert.deepEqual(exported.templates, p.templates);
  assert.deepEqual(
    parseConnectorDraft(JSON.stringify(p)).templates,
    p.templates,
  );
  const { templates: _templates, ...without } = p;
  assert.deepEqual(
    parseConnectorProject(JSON.stringify(without)).templates,
    [],
  );
  const combined = structuredClone(p);
  combined.manifest.methods[1]!.contract!.workflows[0]!.document = "ceremonies";
  combined.workflows[0]!.workflows.push(combined.workflows[1]!.workflows[0]!);
  combined.workflows.pop();
  assert.equal(connectorProjectSchema.safeParse(combined).success, true);
});

test("graph diagnostics identify independent failure causes", () => {
  const check = (
    edit: (p: ReturnType<typeof twoMethods>) => void,
    message: string,
  ) => {
    const p = twoMethods();
    edit(p);
    const result = connectorProjectSchema.safeParse(p);
    assert.equal(result.success, false);
    if (!result.success)
      assert.ok(
        result.error.issues.some(
          (issue) => issue.code === "custom" && issue.message === message,
        ),
        message,
      );
  };
  check((p) => {
    p.workflows[1]!.document = p.workflows[0]!.document;
  }, "Duplicate workflow document");
  check((p) => {
    p.workflows[0]!.workflows.push(
      structuredClone(p.workflows[0]!.workflows[0]!),
    );
  }, "Duplicate workflow ID");
  check((p) => {
    p.workflows[0]!.workflows[0]!.steps[1]!.stepId = "prepare";
  }, "Duplicate step ID");
  check((p) => {
    for (const [index, doc] of p.workflows.entries())
      doc.workflows[0]!.steps = Array.from(
        { length: index ? 17 : 16 },
        (_, i) => ({
          stepId: `step-${i}`,
          description: "Verify",
          operationId: "check",
        }),
      );
  }, "A connector project supports at most 32 steps");
  check((p) => {
    p.manifest.methods[0]!.contract!.workflows.push(
      p.manifest.methods[1]!.contract!.workflows[0]!,
    );
  }, "Studio methods require exactly one editable workflow");
  check((p) => {
    p.manifest.methods[0]!.contract!.workflows[0]!.document = "absent";
  }, "Method references an unavailable workflow version");
  check((p) => {
    p.manifest.methods[0]!.contract!.workflows[0]!.workflowId = "absent";
  }, "Method references an unavailable workflow version");
  check((p) => {
    p.workflows[0]!.workflows.push({
      ...p.workflows[0]!.workflows[0]!,
      workflowId: "extra",
    });
  }, "Workflow is not attached to an authentication method");
  check((p) => {
    p.templates.push(p.templates[0]!);
  }, "Duplicate presentation ID");
  check((p) => {
    p.templates[0]!.id = "foreign";
  }, "Presentation is not attached to a method");
  check((p) => {
    p.templates[0]!.kind = "device";
  }, "Presentation is not attached to a method");
});

test("draft configuration, prerequisites and default ownership remain conservative", () => {
  const p = project();
  const c = p.manifest.methods[0]!.contract!;
  c.configuration.push({
    name: "CLIENT_KEY",
    source: "session-environment",
    classification: "secret",
    required: true,
  });
  c.prerequisites.push({
    id: "register",
    kind: "provider-registration",
    reuse: "verified-context",
    handoff: c.handoff,
  });
  assert.equal(
    parseConnectorDraft(JSON.stringify(p)).manifest.methods[0]!.contract
      .configuration[0]!.name,
    "CLIENT_KEY",
  );
  c.configuration[0]!.name = "A".repeat(97);
  assert.throws(() => parseConnectorDraft(JSON.stringify(p)));
  c.configuration[0]!.name = "";
  c.prerequisites[0]!.id = "x".repeat(121);
  assert.throws(() => parseConnectorDraft(JSON.stringify(p)));
  const empty = newConnectorProject();
  assert.equal(empty.manifest.id, "");
  assert.equal(empty.manifest.description, "");
  for (const kind of flowKinds) {
    const method = newAuthoredMethod(kind, "method");
    assert.deepEqual(method.scopes, []);
    assert.ok(method.fields.every((field) => field.required));
    assert.equal(method.contract!.completion.verifier, "");
    assert.deepEqual(method.contract!.completion.ownership, [
      kind === "authmd-anonymous" ? "anonymous" : "authenticated",
    ]);
  }
});
