import { z } from "zod";
import type { AuthoringTransport } from "../core/authoring-tools.js";
import {
  parseRecipeImport,
  recipeDefinitionSchema,
} from "../core/recipe-contracts.js";
import {
  demonstrationConsentSchema,
  type DemonstrationEvent,
} from "../core/teaching-contracts.js";
import { identifierSchema } from "../core/operation-contracts.js";
import {
  approveAuthoredCredentialVerification,
  credentialVerificationSchema,
  deleteAuthoredSession,
  proposeAuthoredCredentialVerification,
} from "./authored-operations.js";
import {
  compileArazzoToRecipe,
  readArazzo,
} from "./connectors/formats/arazzo/index.js";
import {
  AuthorizationError,
  requireCapability,
  type ActorContext,
} from "./identity.js";
import type { PublishedRecipe } from "./recipes/index.js";
import type { TeachingRuntime } from "./teaching-runtime.js";

/**
 * Teaching operations that more than one transport performs.
 *
 * The browser application reaches these through `teaching-http.ts`; a chat
 * client reaches the same ones through `mcp.ts`. Each is the service call the
 * HTTP route always made, moved here so the route and the tool cannot come to
 * disagree about what a request may contain or which checks run. The services
 * behind them re-check capability and ownership themselves; the checks here
 * are the ones the HTTP route added on top, kept so neither transport is the
 * weaker one.
 *
 * Review and publication are deliberately absent. They are a person's
 * decision about what the tenant may run, and no agent transport offers them.
 */

export const teachingIdentifier = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/);
const revision = z.number().int().positive();
const publicValue = z.union([
  z.string().max(512),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const teachingInputs = {
  demonstrationStart: z.strictObject({
    runId: teachingIdentifier,
    scope: z.array(teachingIdentifier).max(32).optional(),
  }),
  demonstrationConsent: z.strictObject({
    revision,
    consent: demonstrationConsentSchema,
  }),
  draftCompile: z.strictObject({
    demonstrationId: teachingIdentifier,
    first: z.number().int().nonnegative(),
    last: z.number().int().nonnegative(),
  }),
  draftImport: z.strictObject({ definition: z.string().max(262144) }),
  arazzoImport: z.strictObject({
    /** The Arazzo 1.0.1 or 1.1.0 description as JSON text. */
    document: z.string().max(262144),
    workflowId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    /** The recipe id for the draft; the workflow id when it is representable. */
    recipeId: identifierSchema.optional(),
  }),
  draftEdit: z.strictObject({ revision, definition: recipeDefinitionSchema }),
  recipeCompose: z.strictObject({
    references: z
      .array(
        z.strictObject({
          id: teachingIdentifier,
          version: z.string(),
          digest: z.string(),
        }),
      )
      .min(2)
      .max(32),
  }),
  recipeExecute: z.strictObject({
    connectorId: teachingIdentifier.default("github"),
    sourceRunId: teachingIdentifier.optional(),
    id: teachingIdentifier,
    version: z.string(),
    digest: z.string(),
    inputs: z.record(teachingIdentifier, publicValue),
  }),
  /**
   * How an authored API-key, Basic or form connector's collected credential
   * is proved: one HTTPS request to an origin the provider already declared.
   * Proposing it saves it for a person's approval; it verifies nothing yet.
   */
  verificationPropose: z.strictObject({
    connectorId: z.string().regex(/^[a-z0-9-]{1,64}$/),
    declaration: credentialVerificationSchema,
  }),
  verificationApprove: z.strictObject({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  authoringDelete: z.strictObject({
    connectorId: z.string().min(1).max(64),
    runId: z.string().min(1).max(120).optional(),
    revision: revision.optional(),
  }),
} as const;

/**
 * Compile a contiguous span of a demonstration into a recipe draft. The span
 * is bounded before any page is read, and the draft is saved by the recipe
 * service under the caller's authorship.
 */
export async function compileDemonstrationDraft(
  runtime: TeachingRuntime,
  actor: ActorContext,
  input: z.infer<typeof teachingInputs.draftCompile>,
) {
  if (
    input.first < 1 ||
    input.last < input.first ||
    input.last - input.first >= 1000
  )
    throw new AuthorizationError("invalid_request");
  const events: DemonstrationEvent[] = [];
  let after = input.first - 1;
  while (after < input.last) {
    const page = await runtime.demonstrations.timeline(
      actor,
      input.demonstrationId,
      after,
      Math.min(100, input.last - after),
    );
    if (!page.events.length) break;
    events.push(...page.events.filter((event) => event.sequence <= input.last));
    after = page.events.at(-1)!.sequence;
  }
  return await runtime.recipes.compileDraft(actor, events, {
    first: input.first,
    last: input.last,
  });
}

export async function importRecipeDraft(
  runtime: TeachingRuntime,
  actor: ActorContext,
  input: z.infer<typeof teachingInputs.draftImport>,
) {
  return await runtime.recipes.createDraft(
    actor,
    parseRecipeImport(input.definition),
  );
}

/** At most this many compilation issues are returned; the rest are counted. */
const ARAZZO_IMPORT_ISSUES = 64;

/**
 * Compile one workflow of an Arazzo description into a recipe draft.
 *
 * The description is third-party data: it is read within bounds, never
 * fetched from its source URLs, and it contributes no operation. Every step
 * must resolve through the host's reviewed operation-binding catalog to an
 * operation the registry already holds. A workflow outside the executable
 * profile yields its blocking issues and no draft; one inside it yields a
 * draft under the caller's authorship, carrying its success criteria and
 * retries as recipe outcomes. Either way nothing runs: like every draft, it
 * executes only after a person reviews and publishes it.
 */
export async function importArazzoDraft(
  runtime: TeachingRuntime,
  actor: ActorContext,
  input: z.infer<typeof teachingInputs.arazzoImport>,
) {
  requireCapability(actor, "author");
  if (!runtime.arazzoCatalog) throw new AuthorizationError("invalid_request");
  let document: unknown;
  try {
    document = JSON.parse(input.document);
  } catch {
    throw new AuthorizationError("invalid_request");
  }
  const compilation = compileArazzoToRecipe(
    readArazzo(document),
    await runtime.arazzoCatalog(actor),
    {
      workflowId: input.workflowId,
      registry: runtime.registry,
      tenantId: actor.tenantId,
      ...(input.recipeId ? { recipeId: input.recipeId } : {}),
    },
  );
  // Fixed messages and pointers only: an issue never quotes document text.
  const issues = compilation.issues
    .slice(0, ARAZZO_IMPORT_ISSUES)
    .map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      pointer: issue.sourcePointer,
      message: issue.message,
      ...(issue.remediation ? { remediation: issue.remediation } : {}),
    }));
  const omitted = Math.max(0, compilation.issues.length - issues.length);
  if (compilation.status !== "executable" || !compilation.recipe)
    return { status: "blocked" as const, issues, omitted };
  const draft = await runtime.recipes.createDraft(actor, compilation.recipe);
  return { status: "drafted" as const, draft, issues, omitted };
}

/** The tenant's current published recipes, with what executing one needs. */
export async function listPublishedRecipes(
  runtime: TeachingRuntime,
  actor: ActorContext,
) {
  requireCapability(actor, "executor");
  // Every page, not the first: a catalog past one page, or one whose early
  // rows are retired or superseded versions, must not lose recipes.
  const latest = new Map<string, PublishedRecipe>();
  const page = 100;
  let after = "";
  for (;;) {
    const rows = await runtime.store.transaction((tx) =>
      tx.list<PublishedRecipe>(actor.tenantId, "recipe", page, after),
    );
    for (const { value } of rows) {
      if (!value.definition || value.retired) continue;
      const prior = latest.get(value.definition.id);
      if (
        !prior ||
        value.version.localeCompare(prior.version, undefined, {
          numeric: true,
        }) > 0
      )
        latest.set(value.definition.id, value);
    }
    if (rows.length < page) break;
    after = rows.at(-1)!.id;
  }
  return [...latest.values()].map((value) => ({
    id: value.definition.id,
    title: value.definition.title,
    version: value.version,
    digest: value.digest,
    definition: value.definition,
  }));
}

/**
 * The operations a recipe can invoke on this host, built-in and pack-provided
 * alike, each with its contract and where it came from. A pack operation
 * carries its pack, version, publisher key, effect and declared destinations,
 * so an author or reviewer can see exactly what a step from a third party may
 * reach before a recipe that uses it is published.
 */
export function listOperations(runtime: TeachingRuntime, actor: ActorContext) {
  const roles = ["author", "executor", "reviewer", "admin"] as const;
  if (!roles.some((capability) => actor.capabilities.includes(capability)))
    throw new AuthorizationError("denied");
  return runtime.registry.describe();
}

/**
 * Execute a published recipe, pinned by version and digest. Only a published,
 * unretired recipe can be named here: a draft is never executable, which is
 * what keeps review and publication a person's decision.
 */
export async function executePublishedRecipe(
  runtime: TeachingRuntime,
  actor: ActorContext,
  input: z.infer<typeof teachingInputs.recipeExecute>,
) {
  const published = await runtime.recipes.getPublished(
    actor,
    input.id,
    input.version,
    input.digest,
  );
  return await runtime.executeRecipe(
    actor,
    published.definition,
    input.inputs,
    input.connectorId,
    input.sourceRunId,
  );
}

/**
 * Remove a local authored connection: cancel its run if a revision is known,
 * delete the stored session, and uninstall the connector. The provider
 * account itself is untouched.
 */
export async function deleteAuthoredConnection(
  runtime: TeachingRuntime,
  actor: ActorContext,
  input: z.infer<typeof teachingInputs.authoringDelete>,
) {
  requireCapability(actor, "author");
  requireCapability(actor, "executor");
  if (input.runId) {
    try {
      if (input.revision)
        await runtime.commands.cancel(actor, input.runId, input.revision);
    } catch {
      /* Already complete or cancelled. */
    }
    await deleteAuthoredSession(runtime.store, actor, input.runId);
  }
  return await runtime.authoring.uninstall(actor, input.connectorId);
}

/**
 * Propose how an authored connector's collected credential is verified. The
 * declaration is validated, bound to the author's own connector and to an
 * origin its provider declared, and saved as pending; a person approves it
 * with {@link approveCredentialVerification} before anything uses it.
 */
export async function proposeCredentialVerification(
  runtime: TeachingRuntime,
  actor: ActorContext,
  input: z.infer<typeof teachingInputs.verificationPropose>,
) {
  requireCapability(actor, "author");
  return await proposeAuthoredCredentialVerification(
    runtime.store,
    actor,
    input.connectorId,
    input.declaration,
  );
}

/** A person's approval of the pending declaration, pinned by digest. Never an agent's. */
export async function approveCredentialVerification(
  runtime: TeachingRuntime,
  actor: ActorContext,
  connectorId: string,
  input: z.infer<typeof teachingInputs.verificationApprove>,
) {
  requireCapability(actor, "author");
  return await approveAuthoredCredentialVerification(
    runtime.store,
    actor,
    connectorId,
    input.digest,
  );
}

/**
 * The authoring transport for an authenticated server-side caller: what the
 * browser's WebMCP tools reach over `/authoring/*`, without the HTTP hop.
 * Every action requires `author`, as every `/authoring/*` route does.
 */
export function authoringTransportFor(
  runtime: TeachingRuntime,
  actor: ActorContext,
): Required<AuthoringTransport> {
  return {
    async fromProvider(input) {
      requireCapability(actor, "author");
      return await runtime.authoring.fromProvider(
        actor,
        input.provider,
        input.openApiUrl,
        input.intent,
        input.origin,
      );
    },
    async compose(input) {
      requireCapability(actor, "author");
      return await runtime.authoring.compose(
        actor,
        input.draftId,
        input.revision,
        input.childIds,
      );
    },
    async read(draftId) {
      requireCapability(actor, "author");
      return await runtime.authoring.read(actor, z.uuid().parse(draftId));
    },
    async delete(input) {
      await deleteAuthoredConnection(runtime, actor, input);
      return { ok: true, human: null };
    },
  };
}
