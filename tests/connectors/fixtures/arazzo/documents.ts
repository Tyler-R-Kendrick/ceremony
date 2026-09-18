/*
 * Arazzo descriptions used as third-party input. Each factory returns a fresh
 * deep copy so a test may mutate one without affecting another, and every
 * document is written as a host would receive it: plain JSON data, never a
 * module the test imports for behaviour.
 */

type Json = Record<string, unknown>;

const clone = <T>(value: T): T => structuredClone(value);

/** A supported 1.0.1 description: sequential steps, outputs, simple criteria, a bounded retry. */
export function storeWorkflow101(): Json {
  return clone({
    arazzo: "1.0.1",
    info: {
      title: "Store connection",
      summary: "Connect and verify a store account",
      version: "1.0.0",
    },
    sourceDescriptions: [
      {
        name: "store",
        url: "https://api.example.com/openapi.json",
        type: "openapi",
      },
    ],
    workflows: [
      {
        workflowId: "connect-store",
        summary: "Connect the store account",
        description: "Prepare a connection and verify the resulting account.",
        inputs: {
          type: "object",
          properties: { region: { type: "string" } },
          required: ["region"],
        },
        steps: [
          {
            stepId: "prepare",
            description: "Prepare the connection",
            operationId: "prepareConnection",
            parameters: [{ name: "region", in: "query", value: "$inputs.region" }],
            successCriteria: [{ condition: "$statusCode == 200" }],
            outputs: { setup: "$response.body#/setup" },
          },
          {
            stepId: "verify",
            description: "Verify the account",
            operationId: "verifyAccount",
            parameters: [
              { name: "setup", in: "query", value: "$steps.prepare.outputs.setup" },
            ],
            successCriteria: [
              {
                condition:
                  "$statusCode == 200 && $response.header.X-Verified == 'true'",
              },
            ],
            onFailure: [
              { name: "again", type: "retry", retryAfter: 1, retryLimit: 2 },
            ],
            outputs: { account: "$response.body#/account" },
          },
        ],
        outputs: { account: "$steps.verify.outputs.account" },
      },
    ],
  });
}

/** Two OpenAPI descriptions that both define `createOrder`; AC-IMP-07's stimulus. */
export function ambiguousOperation101(): Json {
  return clone({
    arazzo: "1.0.1",
    info: { title: "Order across stores", version: "2.0.0" },
    sourceDescriptions: [
      {
        name: "primary",
        url: "https://primary.example.com/openapi.json",
        type: "openapi",
      },
      {
        name: "secondary",
        url: "https://secondary.example.com/openapi.json",
        type: "openapi",
      },
    ],
    workflows: [
      {
        workflowId: "place-order",
        summary: "Place an order",
        steps: [
          {
            stepId: "create",
            description: "Create the order",
            operationId: "createOrder",
            parameters: [{ name: "region", in: "query", value: "$inputs.region" }],
            outputs: { account: "$response.body#/order" },
          },
        ],
        outputs: { account: "$steps.create.outputs.account" },
      },
    ],
  });
}

/** Every construct the executable profile refuses, each preserved and pointed at. */
export function unsupportedFeatures101(): Json {
  return clone({
    arazzo: "1.0.1",
    info: { title: "Unsupported constructs", version: "1.0.0" },
    sourceDescriptions: [
      { name: "store", url: "https://api.example.com/openapi.json", type: "openapi" },
    ],
    workflows: [
      {
        workflowId: "unsupported",
        summary: "Unsupported constructs",
        steps: [
          {
            stepId: "first",
            description: "JSONPath criteria over a response body",
            operationId: "prepareConnection",
            parameters: [{ name: "region", in: "query", value: "$inputs.region" }],
            successCriteria: [
              {
                context: "$response.body",
                condition: "$[?count(@.pets) > 0]",
                type: "jsonpath",
              },
            ],
            outputs: { setup: "$response.body#/setup" },
          },
          {
            stepId: "second",
            description: "Criteria reaching into the raw response body",
            operationId: "verifyAccount",
            parameters: [
              { name: "setup", in: "query", value: "$steps.first.outputs.setup" },
            ],
            successCriteria: [{ condition: "$response.body#/count > 2" }],
            onSuccess: [{ name: "back", type: "goto", stepId: "first" }],
            outputs: { account: "$response.body#/account" },
          },
        ],
        outputs: { account: "$steps.second.outputs.account" },
      },
    ],
  });
}

/** A step-level dependsOn cycle (1.1.0 only); the graph cannot be ordered. */
export function cyclicSteps110(): Json {
  return clone({
    arazzo: "1.1.0",
    info: { title: "Cyclic steps", version: "1.0.0" },
    sourceDescriptions: [
      { name: "store", url: "https://api.example.com/openapi.json", type: "openapi" },
    ],
    workflows: [
      {
        workflowId: "cyclic",
        summary: "Steps that depend on each other",
        steps: [
          {
            stepId: "first",
            description: "Depends on the second step",
            operationId: "prepareConnection",
            dependsOn: ["second"],
            parameters: [{ name: "region", in: "query", value: "$inputs.region" }],
            outputs: { setup: "$response.body#/setup" },
          },
          {
            stepId: "second",
            description: "Depends on the first step",
            operationId: "verifyAccount",
            dependsOn: ["first"],
            parameters: [
              { name: "setup", in: "query", value: "$steps.first.outputs.setup" },
            ],
            outputs: { account: "$response.body#/account" },
          },
        ],
        outputs: { account: "$steps.second.outputs.account" },
      },
    ],
  });
}

/** Publishes a secret-classified step output as a workflow output. */
export function privateOutput101(): Json {
  const document = storeWorkflow101();
  const workflow = (document.workflows as Json[])[0]!;
  (workflow.steps as Json[])[1]!.outputs = {
    account: "$response.body#/account",
    token: "$response.body#/token",
  };
  workflow.outputs = {
    account: "$steps.verify.outputs.account",
    token: "$steps.verify.outputs.token",
  };
  return document;
}

/** A full 1.1.0 description: $self, step dependsOn, selectors, components, extensions. */
export function full110(): Json {
  return clone({
    arazzo: "1.1.0",
    $self: "https://api.example.com/workflows/store.arazzo.yaml",
    info: {
      title: "Store connection",
      summary: "Connect a store",
      description: "Full 1.1.0 description.",
      version: "2.0.0",
      "x-owner": "platform",
    },
    sourceDescriptions: [
      { name: "store", url: "https://api.example.com/openapi.json", type: "openapi" },
      { name: "events", url: "https://api.example.com/asyncapi.json", type: "asyncapi" },
    ],
    workflows: [
      {
        workflowId: "connect-store",
        summary: "Connect the store account",
        inputs: { type: "object", properties: { region: { type: "string" } } },
        steps: [
          {
            stepId: "prepare",
            description: "Prepare the connection",
            operationId: "prepareConnection",
            parameters: [
              { name: "region", in: "query", value: "$inputs.region" },
              { reference: "$components.parameters.storeId" },
            ],
            requestBody: {
              contentType: "application/json",
              payload: { region: "$inputs.region" },
              replacements: [{ target: "/region", value: "$inputs.region" }],
            },
            successCriteria: [{ condition: "$statusCode == 200" }],
            timeout: 6000,
            outputs: { setup: "$response.body#/setup" },
          },
          {
            stepId: "collect",
            description: "Collect an event",
            channelPath: "{$sourceDescriptions.events.url}#/channels/orders",
            correlationId: "$message.header.correlationId",
            action: "receive",
            dependsOn: ["prepare"],
            outputs: {
              detail: {
                context: "$message.payload",
                selector: "$.detail",
                type: "jsonpath",
              },
            },
          },
        ],
        successActions: [{ name: "done", type: "end" }],
        outputs: { setup: "$steps.prepare.outputs.setup" },
        "x-team": "connections",
      },
    ],
    components: {
      inputs: { pagination: { type: "object" } },
      parameters: { storeId: { name: "storeId", in: "header", value: "$inputs.region" } },
      successActions: { notify: { name: "notify", type: "end" } },
      failureActions: {
        again: { name: "again", type: "retry", retryAfter: 1, retryLimit: 2 },
      },
    },
    "x-generator": "fixture",
  });
}

/** Version strings this reader must refuse without rewriting them. */
export const unknownVersions = ["1.0.0", "1.2.0", "2.0.0", "1.1", ""] as const;
