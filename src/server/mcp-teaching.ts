import type {
  CallToolResult,
  McpServer,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  authoringToolDefinitions,
  authoringToolName,
  runAuthoringTool,
} from "../core/authoring-tools.js";
import { recipeDefinitionSchema } from "../core/recipe-contracts.js";
import { AuthorizationError, type ActorContext } from "./identity.js";
import type { Capability } from "./identity.js";
import {
  authoringTransportFor,
  compileDemonstrationDraft,
  executePublishedRecipe,
  importArazzoDraft,
  importRecipeDraft,
  listPublishedRecipes,
  teachingIdentifier,
  teachingInputs,
} from "./teaching-operations.js";
import type { TeachingRuntime } from "./teaching-runtime.js";

/**
 * Recording, authoring and chaining over MCP.
 *
 * The browser application could always record a demonstration, compile it
 * into a recipe draft, compose published recipes and execute one; a chat
 * client could only drive runs. These tools close that gap by calling the
 * same operations the HTTP routes call (`teaching-operations.ts`, the
 * authoring definitions in `core/authoring-tools.ts`), so there is one set
 * of request schemas and one set of checks for both transports.
 *
 * Three rules hold here as everywhere on this server:
 *
 * - **The actor is never an argument.** It comes from the host's
 *   `authenticate`; every service below re-checks capability and ownership
 *   against it.
 * - **Absent beats always refusing.** A tool is registered only when the
 *   authenticated actor holds a capability that could ever let it succeed.
 *   That is a courtesy to the model, not the authorization: the services
 *   refuse regardless of what was registered.
 * - **Review and publication stay with people.** Nothing here reviews or
 *   publishes a draft. An agent can record, draft, compose and preview, and
 *   can execute only a recipe a person already published, pinned by version
 *   and digest.
 */

/**
 * How a refusal reads for tools that act on something other than a run:
 * recordings, drafts, recipes and authored connectors. The codes are the
 * same; only the noun changes, so a model is not told a recipe "belongs to a
 * different session".
 */
export const teachingRefusals = {
  denied: "That is not available to you, or it does not exist.",
  fallback:
    "That could not be completed. Read the record again and check its identifiers.",
} as const;
export type RefusalWording = Partial<typeof teachingRefusals>;

export type TeachingToolContext = {
  /** The actor for this request, resolved by the host's authenticate path. */
  actor: ActorContext | undefined;
  /** The server's refusal-mapping wrapper, so every tool refuses alike. */
  run(
    operate: (actor: ActorContext) => Promise<unknown>,
    wording?: RefusalWording,
  ): Promise<CallToolResult>;
};

export function registerTeachingTools(
  server: McpServer,
  runtime: TeachingRuntime,
  context: TeachingToolContext,
): void {
  const { actor } = context;
  const holds = (...capabilities: Capability[]) =>
    Boolean(
      actor &&
      (actor.capabilities.includes("admin") ||
        capabilities.some((capability) =>
          actor.capabilities.includes(capability),
        )),
    );
  const teaching = (operate: (actor: ActorContext) => Promise<unknown>) =>
    context.run(operate, teachingRefusals);
  const tool = (
    name: string,
    description: string,
    inputSchema: z.ZodType,
    annotations: ToolAnnotations,
    operate: (actor: ActorContext, input: unknown) => Promise<unknown>,
  ) =>
    server.registerTool(
      name,
      { description, inputSchema, annotations },
      async (input: unknown) => await teaching((who) => operate(who, input)),
    );

  // Authoring: the same four actions, schemas and result projection the
  // browser registers as WebMCP tools, reached without the HTTP hop. Every
  // `/authoring/*` route requires `author`; delete also requires `executor`.
  if (holds("author"))
    for (const definition of authoringToolDefinitions) {
      if (definition.action === "delete" && !holds("executor")) continue;
      tool(
        authoringToolName("ceremony_author", definition),
        definition.description,
        definition.schema,
        {
          readOnlyHint: definition.action === "read",
          destructiveHint: definition.action === "delete",
          openWorldHint: definition.action === "from-provider",
        },
        (who, input) =>
          runAuthoringTool(
            definition,
            authoringTransportFor(runtime, who),
            input,
          ),
      );
    }

  // Recording: a demonstration captures the semantic transitions of a run the
  // caller owns while it is advanced (with `ceremony_advance`, or from its
  // first step with `ceremony_connect` and `teach`). Events are the same
  // public projection the application shows; no value a person entered is in
  // them.
  if (holds("author")) {
    tool(
      "ceremony_demonstration_start",
      "Start recording a run you own. Each step you then advance is recorded as a public transition, never as the values a person entered. Scope limits recording to the named steps.",
      teachingInputs.demonstrationStart,
      { destructiveHint: false },
      (who, input) => {
        const checked = teachingInputs.demonstrationStart.parse(input);
        return runtime.demonstrations.start(who, checked.runId, checked.scope);
      },
    );
    tool(
      "ceremony_demonstration_consent",
      "Pause, resume, stop or discard a recording. Use stopped to finish it before compiling. Discarded deletes what it recorded and cannot be undone. The revision must be the one you last read.",
      teachingInputs.demonstrationConsent.extend({
        demonstrationId: teachingIdentifier,
      }),
      { destructiveHint: true },
      (who, input) => {
        const checked = teachingInputs.demonstrationConsent
          .extend({ demonstrationId: teachingIdentifier })
          .parse(input);
        return runtime.demonstrations.change(
          who,
          checked.demonstrationId,
          checked.revision,
          checked.consent,
        );
      },
    );
    tool(
      "ceremony_draft_compile",
      "Compile a span of a recording, by event sequence numbers, into a recipe draft. Returns the draft with any diagnostics. A draft cannot be executed until a person reviews and publishes it.",
      teachingInputs.draftCompile,
      { destructiveHint: false },
      (who, input) =>
        compileDemonstrationDraft(
          runtime,
          who,
          teachingInputs.draftCompile.parse(input),
        ),
    );
    tool(
      "ceremony_draft_import",
      "Create a recipe draft from a recipe definition given as JSON text. A draft cannot be executed until a person reviews and publishes it.",
      teachingInputs.draftImport,
      { destructiveHint: false },
      (who, input) =>
        importRecipeDraft(
          runtime,
          who,
          teachingInputs.draftImport.parse(input),
        ),
    );
    // Offered only where the host has reviewed which operations Arazzo
    // references may mean; without that catalog every step would be unbound.
    if (runtime.arazzoCatalog)
      tool(
        "ceremony_arazzo_import",
        "Compile one workflow of an Arazzo 1.0.1 or 1.1.0 description, given as JSON text, into a recipe draft. Each step must map to an operation this server already has; source URLs are never fetched. Success criteria and retries the server can enforce are kept. Returns the draft, or the blocking issues and no draft. A draft cannot be executed until a person reviews and publishes it.",
        teachingInputs.arazzoImport,
        { destructiveHint: false },
        (who, input) =>
          importArazzoDraft(
            runtime,
            who,
            teachingInputs.arazzoImport.parse(input),
          ),
      );
    tool(
      "ceremony_draft_edit",
      "Replace the definition of a recipe draft you authored. The revision must be the one you last read.",
      teachingInputs.draftEdit.extend({ draftId: teachingIdentifier }),
      { destructiveHint: false, idempotentHint: true },
      (who, input) => {
        const checked = teachingInputs.draftEdit
          .extend({ draftId: teachingIdentifier })
          .parse(input);
        return runtime.recipes.editDraft(
          who,
          checked.draftId,
          checked.revision,
          checked.definition,
        );
      },
    );
  }
  if (holds("author", "reviewer")) {
    const readInput = z.strictObject({
      demonstrationId: teachingIdentifier,
      after: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    });
    tool(
      "ceremony_demonstration_read",
      "Read a recording and up to 100 of its events after a sequence number. Use the sequence numbers to choose what to compile.",
      readInput,
      { readOnlyHint: true },
      (who, input) => {
        const checked = readInput.parse(input);
        return runtime.demonstrations.timeline(
          who,
          checked.demonstrationId,
          checked.after ?? 0,
          checked.limit ?? 100,
        );
      },
    );
  }
  if (holds("author", "reviewer", "publisher")) {
    const readInput = z.strictObject({ draftId: teachingIdentifier });
    tool(
      "ceremony_draft_read",
      "Read a recipe draft, its digest and its diagnostics.",
      readInput,
      { readOnlyHint: true },
      (who, input) =>
        runtime.recipes.getDraft(who, readInput.parse(input).draftId),
    );
  }

  // Chaining: published recipes are the units that compose and execute.
  if (holds("executor")) {
    tool(
      "ceremony_recipes",
      "List the published recipes you can execute or compose, with the version and digest that pin each one.",
      z.strictObject({}),
      { readOnlyHint: true },
      async (who) => ({ recipes: await listPublishedRecipes(runtime, who) }),
    );
    const previewInput = z.strictObject({ definition: recipeDefinitionSchema });
    tool(
      "ceremony_recipe_preview",
      "Check a recipe definition without saving or executing it: resolves nested published recipes and reports diagnostics.",
      previewInput,
      { readOnlyHint: true },
      (who, input) =>
        runtime.recipes.preview(who, previewInput.parse(input).definition),
    );
    tool(
      "ceremony_recipe_execute",
      "Execute a published recipe, pinned by id, version and digest, as a new run. Inputs may bind only public values. The run is driven with ceremony_advance, and a person is asked for anything private.",
      teachingInputs.recipeExecute,
      { destructiveHint: false, openWorldHint: true },
      async (who, input) => {
        const run = await executePublishedRecipe(
          runtime,
          who,
          teachingInputs.recipeExecute.parse(input),
        );
        // `ceremony_advance` acts as the delegated agent, exactly as it does
        // for a run `ceremony_connect` started. Delegation is host policy;
        // where it is refused, the run stands and a person continues it in
        // the application.
        let delegated = true;
        try {
          await runtime.delegate(who, run.id);
        } catch (error) {
          if (!(error instanceof AuthorizationError)) throw error;
          delegated = false;
        }
        return { run, delegated };
      },
    );
  }
  // Composing saves a draft (author) from published recipes it must be able to
  // read (executor); the service checks both, so both are needed to offer it.
  if (holds("author") && holds("executor"))
    tool(
      "ceremony_recipe_compose",
      "Compose two to thirty-two published recipes, pinned by version and digest, into a new recipe draft. Nothing is executed, and the draft needs a person's review and publication before it can run.",
      teachingInputs.recipeCompose,
      { destructiveHint: false },
      (who, input) =>
        runtime.recipes.composePublished(
          who,
          teachingInputs.recipeCompose.parse(input).references,
        ),
    );
}
