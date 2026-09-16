import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachGenericCeremony,
  connectorProjectSchema,
  defaultWorkflowSteps,
  newAuthoredMethod,
  newConnectorProject,
} from "../src/core/connector-authoring.js";
import { flowKinds } from "../src/core/schema.js";

test("only OAuth and GitHub App drafts require shared provider registration", () => {
  for (const kind of flowKinds) {
    const method = newAuthoredMethod(kind, "selected");
    assert.deepEqual(
      method.contract!.prerequisites,
      kind === "oauth-code" || kind === "github-app"
        ? [
            {
              id: "shared-app",
              kind: "provider-registration",
              reuse: "verified-context",
              handoff: {
                surface: "private-collector",
                recipient: "authorized-owner",
                delegation: "a2h-authorize",
                resume: "verify",
              },
            },
          ]
        : [],
      kind,
    );
  }
});

test("every family outline retains actionable instructions and host bindings", () => {
  const expected = {
    "api-key": [
      {
        stepId: "collect-credential",
        description: "Collect the API key through the private collector",
        operationId: "provider.collect-credential",
      },
      {
        stepId: "verify-access",
        description: "Verify the key against the provider",
        operationId: "provider.verify-access",
      },
    ],
    basic: [
      {
        stepId: "collect-credentials",
        description:
          "Collect username and password through the private collector",
        operationId: "provider.collect-credentials",
      },
      {
        stepId: "verify-access",
        description: "Verify Basic access",
        operationId: "provider.verify-access",
      },
    ],
    form: [
      {
        stepId: "collect-credentials",
        description: "Collect sign-in fields through the private collector",
        operationId: "provider.collect-credentials",
      },
      {
        stepId: "verify-access",
        description: "Verify the signed-in session",
        operationId: "provider.verify-access",
      },
    ],
    "oauth-code": [
      {
        stepId: "prepare-app",
        description: "Prepare the shared OAuth app when the host has none",
        operationId: "provider.prepare-app",
      },
      {
        stepId: "authorize-user",
        description: "Authorize the user at the provider",
        operationId: "provider.authorize-user",
      },
      {
        stepId: "verify-access",
        description: "Verify provider access",
        operationId: "provider.verify-access",
      },
    ],
    device: [
      {
        stepId: "request-device",
        description: "Request a device code",
        operationId: "provider.request-device",
      },
      {
        stepId: "wait-approval",
        description: "Wait for the user to approve the device",
        operationId: "provider.wait-approval",
      },
      {
        stepId: "verify-access",
        description: "Verify provider access",
        operationId: "provider.verify-access",
      },
    ],
    "authmd-anonymous": [
      {
        stepId: "register-anonymous",
        description: "Register an anonymous identity",
        operationId: "provider.register-anonymous",
      },
      {
        stepId: "verify-anonymous",
        description: "Verify anonymous access",
        operationId: "provider.verify-anonymous",
      },
      {
        stepId: "claim-ownership",
        description: "Claim the identity when the provider requires it",
        operationId: "provider.claim-ownership",
      },
    ],
    "account-registration": [
      {
        stepId: "find-signup",
        description: "Find the provider account registration page",
        operationId: "provider.find-signup",
      },
      {
        stepId: "register-account",
        description: "Register an account in the isolated browser",
        operationId: "provider.register-account",
      },
      {
        stepId: "verify-account",
        description: "Verify the new account can authenticate",
        operationId: "provider.verify-access",
      },
    ],
    "github-app": [
      {
        stepId: "register-app",
        description: "Register the GitHub App",
        operationId: "github.register-app",
      },
      {
        stepId: "install-app",
        description: "Install the GitHub App",
        operationId: "github.install-app",
      },
      {
        stepId: "verify-access",
        description: "Verify installation access",
        operationId: "github.verify-access",
      },
    ],
  } as const;
  for (const kind of flowKinds)
    assert.deepEqual(defaultWorkflowSteps(kind), expected[kind]);
});

test("attachment reuses presentation identity and rejects the thirteenth method without mutation", () => {
  const draft = newConnectorProject();
  const first = attachGenericCeremony(draft, "api-key", "First key");
  const presentation = draft.templates[0]!;
  presentation.screens.intro += "\nCustom instructions";
  const second = attachGenericCeremony(draft, "api-key", "Second key");
  assert.equal(draft.templates.length, 1);
  assert.equal(draft.templates[0], presentation);
  assert.equal(first.templateId, second.templateId);
  for (let index = 2; index < 12; index++)
    attachGenericCeremony(draft, "api-key", `Key ${index}`);
  assert.equal(draft.manifest.methods.length, 12);
  const saved = structuredClone(draft);
  assert.throws(() => attachGenericCeremony(draft, "api-key", "Overflow"), {
    message: "method limit",
  });
  assert.deepEqual(draft, saved);
});

test("completed authoring rejects multiple workflow references with an actionable diagnostic", () => {
  const draft = newConnectorProject();
  draft.manifest.id = "acme";
  draft.manifest.name = "Acme";
  draft.workflows[0]!.sourceDescriptions[0]!.url =
    "https://acme.example/openapi.json";
  const method = attachGenericCeremony(draft, "api-key", "Key");
  assert.equal(connectorProjectSchema.safeParse(draft).success, true);
  method.contract!.workflows.push({ ...method.contract!.workflows[0]! });
  const result = connectorProjectSchema.safeParse(draft);
  assert.equal(result.success, false);
  if (!result.success)
    assert.ok(
      result.error.issues.some(
        (issue) =>
          issue.message ===
          "Studio methods require exactly one editable workflow",
      ),
    );
});

test("cross-family presentation reuse reports the specific authoring conflict", () => {
  const draft = newConnectorProject();
  draft.manifest.id = "acme";
  draft.manifest.name = "Acme";
  draft.workflows[0]!.sourceDescriptions[0]!.url =
    "https://acme.example/openapi.json";
  const key = attachGenericCeremony(draft, "api-key", "Key");
  const form = attachGenericCeremony(draft, "form", "Form");
  assert.equal(connectorProjectSchema.safeParse(draft).success, true);
  form.templateId = key.templateId;
  const result = connectorProjectSchema.safeParse(draft);
  assert.equal(result.success, false);
  if (!result.success)
    assert.ok(
      result.error.issues.some(
        (issue) =>
          issue.message ===
          "Presentation ID cannot be shared across authentication families",
      ),
    );
});
