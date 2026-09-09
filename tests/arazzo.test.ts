import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arazzoSchema,
  runArazzo,
  type ArazzoDocument,
} from "../src/server/arazzo.js";

const document: ArazzoDocument = {
  arazzo: "1.0.1",
  info: { title: "Test workflow", version: "1" },
  sourceDescriptions: [{ name: "auth", url: "/openapi.json", type: "openapi" }],
  workflows: [
    {
      workflowId: "connect",
      summary: "Connect",
      steps: [
        { stepId: "prepare", description: "Prepare", operationId: "prepare" },
        { stepId: "verify", description: "Verify", operationId: "verify" },
      ],
    },
  ],
};
test("Arazzo binds operation paths when the provider specification has no operation ID", async () => {
  const operationPath = "{$sourceDescriptions.auth.url}#/paths/~1token/post";
  const doc = {
    ...document,
    workflows: [
      {
        workflowId: "sign-in",
        summary: "Sign in",
        steps: [{ stepId: "sign-in", description: "Sign in", operationPath }],
      },
    ],
  };
  const events: unknown[] = [];
  let calls = 0;
  await runArazzo(
    doc,
    "sign-in",
    new Map([
      [
        operationPath,
        async () => {
          calls++;
        },
      ],
    ]),
    (event) => {
      events.push(event);
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(events, [
    {
      workflowId: "sign-in",
      stepId: "sign-in",
      operationPath,
      status: "success",
    },
  ]);
  await assert.rejects(runArazzo(doc, "sign-in", new Map()), /Unbound/);
  assert.throws(
    () =>
      arazzoSchema.parse({
        ...doc,
        workflows: [
          {
            ...doc.workflows[0],
            steps: [{ stepId: "invalid", description: "Invalid" }],
          },
        ],
      }),
    /Specify exactly one operationId or operationPath/,
  );
  for (const operation of [
    {},
    { operationId: "token", operationPath },
    { operationPath: "https://evil.example" },
    { operationPath: `prefix${operationPath}` },
    { operationPath: `${operationPath}suffix` },
  ]) {
    assert.equal(
      arazzoSchema.safeParse({
        ...doc,
        workflows: [
          {
            ...doc.workflows[0],
            steps: [
              { stepId: "sign-in", description: "Sign in", ...operation },
            ],
          },
        ],
      }).success,
      false,
    );
  }
});
test("Arazzo executes document order and reports redacted success/failure without retry", async () => {
  const calls: string[] = [];
  const events: unknown[] = [];
  const operations = new Map([
    [
      "prepare",
      async () => {
        calls.push("prepare");
        return { secret: "private-test-value" };
      },
    ],
    [
      "verify",
      async () => {
        calls.push("verify");
        throw new Error("verification failed");
      },
    ],
  ]);
  await assert.rejects(
    runArazzo(document, "connect", operations, (event) => {
      events.push(event);
    }),
    /verification failed/,
  );
  assert.deepEqual(calls, ["prepare", "verify"]);
  assert.deepEqual(events, [
    {
      workflowId: "connect",
      stepId: "prepare",
      operationId: "prepare",
      status: "success",
    },
    {
      workflowId: "connect",
      stepId: "verify",
      operationId: "verify",
      status: "failure",
    },
  ]);
  calls.length = 0;
  await assert.rejects(
    runArazzo(
      document,
      "connect",
      new Map([["prepare", operations.get("prepare")!]]),
    ),
    /Unbound/,
  );
  assert.deepEqual(calls, []);
});
test("Arazzo validates full identifiers, multiple workflows and duplicate steps before effects", () => {
  for (const workflowId of ["!connect", "connect!", "", "connect\n"]) {
    assert.equal(
      arazzoSchema.safeParse({
        ...document,
        workflows: [{ ...document.workflows[0], workflowId }],
      }).success,
      false,
    );
  }
  const composed = {
    ...document,
    workflows: [
      document.workflows[0]!,
      { ...structuredClone(document.workflows[0]!), workflowId: "second" },
    ],
  };
  assert.equal(arazzoSchema.safeParse(composed).success, true);
  const duplicate = structuredClone(composed);
  duplicate.workflows[1]!.steps[1]!.stepId = "prepare";
  const result = arazzoSchema.safeParse(duplicate);
  assert.equal(result.success, false);
  if (!result.success)
    assert.deepEqual(result.error.issues, [
      {
        code: "custom",
        path: [],
        message: "Workflow and step IDs must be unique",
      },
    ]);
});
test("Arazzo fails closed for unknown workflows, duplicate IDs and unsupported semantics", async () => {
  const operations = new Map([
    ["prepare", async () => {}],
    ["verify", async () => {}],
  ]);
  await assert.rejects(runArazzo(document, "missing", operations), /Unknown/);
  await assert.rejects(
    runArazzo(
      {
        ...document,
        workflows: [...document.workflows, ...document.workflows],
      },
      "connect",
      operations,
    ),
    /unique/,
  );
  const invalid = structuredClone(document);
  Object.assign(invalid.workflows[0]!.steps[0]!, {
    onFailure: [{ type: "retry" }],
  });
  await assert.rejects(
    runArazzo(invalid, "connect", operations),
    /Unrecognized/,
  );
  await runArazzo(document, "connect", operations, () => {
    throw new Error("observer");
  });
  await runArazzo(document, "connect", operations, async () => {
    throw new Error("async observer");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
});
