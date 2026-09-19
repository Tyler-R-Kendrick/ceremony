import { z } from "zod";
import type { ActorContext } from "../../../../src/core/operation-contracts.js";
import {
  OperationRegistry,
  type OperationContext,
  type OperationResult,
  type VocabularyEntry,
} from "../../../../src/server/recipes/index.js";
import type { OperationBindingCatalogInput } from "../../../../src/server/connectors/formats/arazzo/index.js";

/*
 * The host side of the executable profile: a registered vocabulary, registered
 * operations with real handlers, and the catalog that pins which reviewed
 * document and version each Arazzo operation reference means. An imported
 * description contributes none of this; that separation is what the binding
 * tests exercise.
 */

export const storeVocabulary: ReadonlyMap<string, VocabularyEntry> = new Map([
  [
    "region",
    { schema: z.enum(["eu", "us"]), classification: "public" as const },
  ],
  [
    "setup",
    { schema: z.string().max(200), classification: "artifact" as const },
  ],
  [
    "account",
    { schema: z.string().max(200), classification: "public" as const },
  ],
  ["token", { schema: z.string().max(200), classification: "secret" as const }],
  [
    "owner",
    { schema: z.string().max(200), classification: "personal" as const },
  ],
]);

export type HandlerBehavior = {
  /** Called after the fixture recorded the request; throwing leaves an uncertain effect. */
  afterRequest?: (operation: string) => Promise<void> | void;
  result?: (operation: string) => OperationResult | undefined;
  verified?: (operation: string) => boolean;
};

export type StoreRegistryOptions = {
  origin: string;
  behavior?: HandlerBehavior;
  fetch?: typeof fetch;
};

type OperationShape = {
  id: string;
  path: string;
  inputs: Record<string, { contract: string; required: boolean }>;
  outputs: Record<string, { contract: string; required: boolean }>;
};

const shapes: OperationShape[] = [
  {
    id: "store.prepare",
    path: "/prepare",
    inputs: { region: { contract: "region", required: true } },
    outputs: { setup: { contract: "setup", required: true } },
  },
  {
    id: "store.verify",
    path: "/verify",
    inputs: { setup: { contract: "setup", required: true } },
    outputs: {
      account: { contract: "account", required: true },
      token: { contract: "token", required: false },
      owner: { contract: "owner", required: false },
    },
  },
  {
    id: "store.finish",
    path: "/finish",
    inputs: { account: { contract: "account", required: true } },
    outputs: { account: { contract: "account", required: true } },
  },
];

const classificationFor = (contract: string) => ({
  classification: storeVocabulary.get(contract)!.classification,
  schema: storeVocabulary.get(contract)!.schema,
});

/**
 * A registry whose handlers make a real loopback request before returning, so
 * a handler that throws afterwards has demonstrably already had its effect.
 */
export function storeRegistry(options: StoreRegistryOptions): {
  registry: OperationRegistry;
  calls: string[];
} {
  const registry = new OperationRegistry(storeVocabulary);
  const calls: string[] = [];
  const send = options.fetch ?? fetch;
  for (const shape of shapes)
    registry.register({
      contract: {
        id: shape.id,
        version: "1.0.0",
        provider: "store",
        profile: "connect",
        inputs: shape.inputs,
        outputs: shape.outputs,
        effects: ["read"],
        verifier: "provider",
        humanFallback: "consent",
      },
      inputSchema: z.record(z.string(), z.unknown()),
      outputSchema: z.record(z.string(), z.unknown()),
      classifications: Object.fromEntries(
        Object.entries(shape.inputs).map(([name, input]) => [
          name,
          classificationFor(input.contract),
        ]),
      ),
      fixtures: ["loopback-store-fixture"],
      handler: async (
        context: OperationContext,
        inputs: Record<string, unknown>,
      ): Promise<OperationResult> => {
        calls.push(shape.id);
        const response = await send(`${options.origin}${shape.path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ node: context.nodeId, inputs }),
          redirect: "error",
        });
        const body = (await response.json()) as Record<string, unknown>;
        await options.behavior?.afterRequest?.(shape.id);
        const override = options.behavior?.result?.(shape.id);
        if (override) return override;
        return {
          state: "complete",
          outputs: Object.fromEntries(
            Object.keys(shape.outputs).flatMap((name) =>
              body[name] === undefined ? [] : [[name, body[name]]],
            ),
          ),
        };
      },
      verify: async () => options.behavior?.verified?.(shape.id) ?? true,
    });
  return { registry, calls };
}

/** The reviewed catalog: exact source, document identity, version and registered operation. */
export function storeCatalog(
  tenantId: string,
  overrides: Partial<OperationBindingCatalogInput> = {},
): OperationBindingCatalogInput {
  return {
    tenantId,
    documents: [
      {
        sourceDescriptionName: "store",
        identity: {
          kind: "url" as const,
          url: "https://api.example.com/openapi.json",
        },
        version: "2026-01-04",
        operations: [
          {
            operationId: "prepareConnection",
            operation: { id: "store.prepare", version: "1.0.0" },
            parameters: { "query:region": "region" },
            outputs: { "$response.body#/setup": "setup" },
            replay: "read-only" as const,
          },
          {
            operationId: "verifyAccount",
            operation: { id: "store.verify", version: "1.0.0" },
            parameters: { "query:setup": "setup" },
            outputs: {
              "$response.body#/account": "account",
              "$response.body#/token": "token",
              "$response.body#/owner": "owner",
            },
            replay: "read-only" as const,
          },
        ],
      },
    ],
    workflows: [],
    ...overrides,
  };
}

/** Both documents define `createOrder`; only an explicit source can disambiguate. */
export function ambiguousCatalog(
  tenantId: string,
): OperationBindingCatalogInput {
  const operations = [
    {
      operationId: "createOrder",
      operation: { id: "store.prepare", version: "1.0.0" },
      parameters: { "query:region": "region" },
      outputs: { "$response.body#/order": "setup" },
      replay: "read-only" as const,
    },
  ];
  return {
    tenantId,
    documents: [
      {
        sourceDescriptionName: "primary",
        identity: {
          kind: "url" as const,
          url: "https://primary.example.com/openapi.json",
        },
        version: "1.0.0",
        operations,
      },
      {
        sourceDescriptionName: "secondary",
        identity: {
          kind: "url" as const,
          url: "https://secondary.example.com/openapi.json",
        },
        version: "1.0.0",
        operations,
      },
    ],
    workflows: [],
  };
}

export const storeActor: ActorContext = {
  tenantId: "tenant-store",
  subjectId: "subject-1",
  sessionId: "session-1",
  actorKind: "human",
  capabilities: ["executor", "author", "reviewer", "publisher", "admin"],
};

export const storeRunContext = {
  provider: "store",
  profile: "connect",
  target: "https://api.example.com",
  origin: "https://app.example",
  environment: "test",
  configurationVersion: "v1",
};
