import { createHash } from "node:crypto";
import { z } from "zod";
import { manifestSchema, type ConnectorManifest } from "../core/schema.js";
import type { ConnectorDraft } from "../core/connector-authoring.js";
import type { RecipeDefinition } from "../core/recipe-contracts.js";
import type {
  OperationRegistry,
  OperationContext,
  OperationResult,
  VocabularyEntry,
} from "./recipes/registry.js";

const slot = (contract: string) => ({ contract, required: true });
const artifact = (kind: string) =>
  `authored-${kind}-${createHash("sha256").update(kind).digest("hex").slice(0, 16)}`;

export const authoredVocabulary = new Map<string, VocabularyEntry>(
  ["app", "session", "connection"].map((kind) => [
    `authored.${kind}`,
    {
      schema: z.string().regex(/^authored-[a-z0-9-]{4,80}$/),
      classification: "artifact",
      provider: "authored",
      profile: "authored",
    },
  ]),
);

export function manifestFromProject(
  project: ConnectorDraft,
): ConnectorManifest {
  const id = project.manifest.id || "authored";
  return manifestSchema.parse({
    schemaVersion: 1,
    support: "fixture",
    id,
    name: project.manifest.name || id,
    description:
      project.manifest.description ||
      `Authored ${project.manifest.name || id} ceremony.`,
    methods: project.manifest.methods.map((method) => ({
      id: method.kind,
      label: method.label,
      kind: method.kind,
      templateId: method.templateId,
      fields:
        method.kind === "api-key" ||
        method.kind === "basic" ||
        method.kind === "form"
          ? [
              {
                name: "token",
                label: "Secret",
                type: "password",
                required: true,
                classification: "secret",
              },
            ]
          : [],
      scopes: method.scopes,
      contract: method.contract,
    })),
  });
}

export function recipeFromProject(project: ConnectorDraft): RecipeDefinition {
  const secret = project.manifest.methods.every((method) =>
    ["api-key", "basic", "form"].includes(method.kind),
  );
  if (!secret)
    return {
      schemaVersion: 1,
      id: `${project.manifest.id || "authored"}-connect`,
      title: `Connect ${project.manifest.name || "provider"}`,
      description: "Prepare, authorize, and verify the authored ceremony.",
      inputs: {},
      invocations: [
        {
          id: "app",
          use: {
            kind: "operation",
            id: "authored.prepare-app",
            version: "1.0.0",
          },
          dependsOn: [],
          bindings: {},
        },
        {
          id: "user",
          use: {
            kind: "operation",
            id: "authored.authorize-user",
            version: "1.0.0",
          },
          dependsOn: ["app"],
          bindings: { app: { from: "output", node: "app", name: "app" } },
        },
        {
          id: "access",
          use: {
            kind: "operation",
            id: "authored.verify-access",
            version: "1.0.0",
          },
          dependsOn: ["user"],
          bindings: {
            session: { from: "output", node: "user", name: "session" },
          },
        },
      ],
      outputs: { connection: { node: "access", name: "connection" } },
    };
  if (secret)
    return {
      schemaVersion: 1,
      id: `${project.manifest.id || "authored"}-connect`,
      title: `Connect ${project.manifest.name || "provider"}`,
      description: "Collect a secret and verify the authored ceremony.",
      inputs: {},
      invocations: [
        {
          id: "secret",
          use: {
            kind: "operation",
            id: "authored.collect-credential",
            version: "1.0.0",
          },
          dependsOn: [],
          bindings: {},
        },
        {
          id: "access",
          use: {
            kind: "operation",
            id: "authored.verify-access",
            version: "1.0.0",
          },
          dependsOn: ["secret"],
          bindings: {
            session: { from: "output", node: "secret", name: "session" },
          },
        },
      ],
      outputs: { connection: { node: "access", name: "connection" } },
    };
  return {
    schemaVersion: 1,
    id: `${project.manifest.id || "authored"}-connect`,
    title: `Connect ${project.manifest.name || "provider"}`,
    description: "Verify the authored ceremony.",
    inputs: {},
    invocations: [
      {
        id: "access",
        use: {
          kind: "operation",
          id: "authored.verify-access",
          version: "1.0.0",
        },
        dependsOn: [],
        bindings: {},
      },
    ],
    outputs: { connection: { node: "access", name: "connection" } },
  };
}

export function registerAuthoredOperations(
  registry: OperationRegistry,
  options: { allowLoopbackHttp?: boolean },
): void {
  const complete = (outputs: Record<string, string>): OperationResult => ({
    state: "complete",
    outputs,
  });
  const operations = [
    {
      id: "authored.prepare-app",
      effect: "authored.prepare-app",
      inputs: {},
      outputs: { app: slot("authored.app") },
      handler: async () => complete({ app: artifact("app") }),
    },
    {
      id: "authored.authorize-user",
      effect: "authored.authorize-user",
      inputs: { app: slot("authored.app") },
      outputs: { session: slot("authored.session") },
      handler: async (context: OperationContext) => {
        if (!options.allowLoopbackHttp && !context.origin.startsWith("https:"))
          return {
            state: "awaiting-human" as const,
            outputs: {},
            diagnosticCode: "awaiting-human" as const,
          };
        return complete({ session: artifact("session") });
      },
    },
    {
      id: "authored.collect-credential",
      effect: "authored.collect-credential",
      inputs: {},
      outputs: { session: slot("authored.session") },
      handler: async () => ({
        state: "awaiting-human" as const,
        outputs: {},
        diagnosticCode: "awaiting-human" as const,
      }),
    },
    {
      id: "authored.verify-access",
      effect: "authored.verify-access",
      inputs: { session: slot("authored.session") },
      outputs: { connection: slot("authored.connection") },
      handler: async () => complete({ connection: artifact("connection") }),
    },
  ];
  for (const operation of operations)
    registry.register({
      contract: {
        id: operation.id,
        version: "1.0.0",
        provider: "authored",
        profile: "authored",
        inputs: operation.inputs,
        outputs: operation.outputs,
        effects: [operation.effect],
        verifier: "authored.verify-access",
        humanFallback: "authored.own-browser",
      },
      inputSchema: z
        .object(
          Object.fromEntries(
            Object.keys(operation.inputs).map((name) => [name, z.string()]),
          ),
        )
        .strict(),
      outputSchema: z
        .object(
          Object.fromEntries(
            Object.keys(operation.outputs).map((name) => [name, z.string()]),
          ),
        )
        .strict(),
      classifications: {},
      fixtures: ["tests/authoring-tools.test.ts"],
      handler: operation.handler,
      verify: async (_context, result) => result.state === "complete",
    });
}
