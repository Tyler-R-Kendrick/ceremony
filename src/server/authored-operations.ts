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
import type { ActorContext } from "../core/operation-contracts.js";
import type { AsyncCeremonyStore } from "./persistence/index.js";

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

const sessionSchema = z.strictObject({
  handle: z.string().min(1).max(256),
  did: z.string().min(1).max(256),
  accessJwt: z.string().min(1).max(8000),
});
function sessionKey(actor: ActorContext, runId: string) {
  return {
    tenant: actor.tenantId,
    kind: "artifact" as const,
    id: `authored-session:${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`,
  };
}
export async function publicAuthoredIdentity(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
) {
  const record = await store.transaction((tx) =>
    tx.get(sessionKey(actor, runId)),
  );
  const parsed = sessionSchema.safeParse(record?.value);
  return parsed.success
    ? { handle: parsed.data.handle, did: parsed.data.did }
    : undefined;
}
export async function saveAuthoredSession(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
  credentials: { identifier: string; password: string },
  fetcher: typeof fetch,
) {
  const response = await fetcher(
    "https://bsky.social/xrpc/com.atproto.server.createSession",
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        identifier: credentials.identifier,
        password: credentials.password,
      }),
    },
  );
  if (!response.ok) return undefined;
  const session = sessionSchema.safeParse(await response.json());
  if (!session.success) return undefined;
  await store.transaction(async (tx) => {
    const prior = await tx.get(sessionKey(actor, runId));
    await tx.put(
      sessionKey(actor, runId),
      session.data,
      prior?.revision ?? null,
    );
  });
  return { handle: session.data.handle, did: session.data.did };
}
async function liveSession(
  store: AsyncCeremonyStore,
  context: OperationContext,
  fetcher: typeof fetch,
) {
  const record = await store.transaction((tx) =>
    tx.get(sessionKey(context.actor, context.runId)),
  );
  const session = sessionSchema.safeParse(record?.value);
  if (!session.success) return undefined;
  const response = await fetcher(
    "https://bsky.social/xrpc/com.atproto.server.getSession",
    {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${session.data.accessJwt}`,
      },
    },
  );
  if (!response.ok) return undefined;
  const live = sessionSchema
    .pick({ handle: true, did: true })
    .safeParse(await response.json());
  if (
    !live.success ||
    live.data.did !== session.data.did ||
    live.data.handle !== session.data.handle
  )
    return undefined;
  return session.data;
}

export function registerAuthoredOperations(
  registry: OperationRegistry,
  options: { store: AsyncCeremonyStore; fetch?: typeof fetch },
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
        const session = await publicAuthoredIdentity(
          options.store,
          context.actor,
          context.runId,
        );
        if (!session)
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
      handler: async (context: OperationContext) => {
        const session = await liveSession(
          options.store,
          context,
          options.fetch ?? fetch,
        );
        if (!session)
          return {
            state: "awaiting-human" as const,
            outputs: {},
            diagnosticCode: "awaiting-human" as const,
          };
        return complete({ connection: artifact("connection") });
      },
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
      verify: async (context, result) => {
        if (result.state !== "complete") return false;
        if (operation.id === "authored.prepare-app") return true;
        return Boolean(
          await publicAuthoredIdentity(
            options.store,
            context.actor,
            context.runId,
          ),
        );
      },
    });
}
