import { z } from "zod";
import {
  authenticatedActor,
  AuthorizationError,
  requireCapability,
} from "./identity.js";
import {
  assertRequestBoundary,
  boundedJson,
  reserveRequest,
} from "./authorization.js";
import { PersistenceConflict } from "./persistence/index.js";
import {
  recipeDefinitionSchema,
  parseRecipeImport,
} from "../core/recipe-contracts.js";
import {
  demonstrationConsentSchema,
  type DemonstrationEvent,
} from "../core/teaching-contracts.js";
import type { TeachingRuntime } from "./teaching-runtime.js";
import type { PublishedRecipe } from "./recipes/index.js";
import { agentStatusStream } from "./agent/stream.js";
import { suggestRecipeLabels } from "./agent/authoring.js";
import { configuredModel } from "./agent/model.js";

const revision = z.number().int().positive();
const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/);
const review = z.strictObject({
  revision,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
const reply = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });

/** Mounted unchanged by the local example and authenticated hosted adapter. */
export async function teachingHttp(
  request: Request,
  runtime: TeachingRuntime,
  startAgent?: (runId: string, turnId: string) => Promise<void>,
): Promise<Response> {
  try {
    const path = new URL(request.url).pathname.replace(
      /^\/api\/v1\/teaching/,
      "",
    );
    assertRequestBoundary(request, { origin: runtime.origin });
    let actor;
    try {
      actor = await authenticatedActor(request, runtime.identity);
    } catch (error) {
      if (
        path === "/capabilities" &&
        request.method === "GET" &&
        error instanceof AuthorizationError &&
        error.code === "unauthenticated"
      )
        return reply({
          available: true,
          authenticated: false,
          modelAvailable: false,
        });
      throw error;
    }
    await reserveRequest(runtime.store, actor, 120, 60_000);
    if (!["GET", "POST"].includes(request.method))
      return reply({ error: "unavailable" }, 405);
    const post = request.method === "POST";
    if (
      (/^\/jira\/[^/]+\/owner-setup$/.test(path) ||
        /^\/jira\/owner-setup\/[^/]+$/.test(path)) &&
      runtime.ownerSetup
    ) {
      if (actor.actorKind !== "human") throw new AuthorizationError("denied");
      return await runtime.ownerSetup(actor, request);
    }
    if (
      ["/github/installation-return", "/jira/authorization-return"].includes(
        path,
      ) &&
      runtime.humanReturn
    ) {
      if (post) return reply({ error: "unavailable" }, 405);
      requireCapability(actor, "executor");
      if (actor.actorKind !== "human") throw new AuthorizationError("denied");
      return await runtime.humanReturn(actor, request);
    }
    if (
      (/^\/github\/[^/]+\/(human|callback|recovery)$/.test(path) ||
        /^\/(stripe|supabase|jira)\/[^/]+\/human$/.test(path)) &&
      runtime.human
    ) {
      const action = path.split("/")[3];
      if (
        post &&
        action !== "recovery" &&
        !/^\/(stripe|supabase|jira)\//.test(path)
      )
        return reply({ error: "unavailable" }, 405);
      if (actor.actorKind !== "human") throw new AuthorizationError("denied");
      requireCapability(actor, "executor");
      const runId = id.parse(decodeURIComponent(path.split("/")[2]!));
      await runtime.commands.snapshot(actor, runId);
      // Recovery handler owns bounded private-body parsing. Never clone it into generic authoring state.
      return await runtime.human(actor, runId, request);
    }
    const body = post ? await boundedJson(request) : undefined;
    if (path.startsWith("/authoring/")) {
      requireCapability(actor, "author");
      if (path === "/authoring/from-provider") {
        if (!post) return reply({ error: "unavailable" }, 405);
        const input = z
          .strictObject({
            provider: z.string().min(1).max(100),
            openApiUrl: z.string().url().max(500).optional(),
            intent: z.enum(["draft", "complete", "run"]).default("draft"),
          })
          .parse(body);
        return reply(
          await runtime.authoring.fromProvider(
            actor,
            input.provider,
            input.openApiUrl,
            input.intent,
          ),
        );
      }
      if (path === "/authoring/compose") {
        if (!post) return reply({ error: "unavailable" }, 405);
        const input = z
          .strictObject({
            draftId: z.uuid(),
            revision: revision,
            childIds: z.array(z.string().min(1).max(64)).min(2).max(12),
          })
          .parse(body);
        return reply(
          await runtime.authoring.compose(
            actor,
            input.draftId,
            input.revision,
            input.childIds,
          ),
        );
      }
      const draft = /^\/authoring\/drafts\/([^/]+)$/.exec(path);
      if (draft && !post)
        return reply(
          await runtime.authoring.read(
            actor,
            z.uuid().parse(decodeURIComponent(draft[1]!)),
          ),
        );
      return reply({ error: "unavailable" }, 404);
    }
    if (path.startsWith("/tools/")) {
      requireCapability(actor, "executor");
      if (!post) return reply({ error: "unavailable" }, 405);
      if (path === "/tools/connect") {
        const input = z.strictObject({ connectorId: id }).parse(body);
        const delegated = await runtime.connectForAgent(
          actor,
          input.connectorId,
        );
        let run = delegated.run;
        for (const node of run.nodes) {
          if (node.verified) continue;
          const result = await runtime.commands.advance(
            delegated.actor,
            run.id,
            node.id,
            run.revision,
            `native:${run.id}:${node.id}:${run.revision}`,
          );
          run = await runtime.commands.snapshot(delegated.actor, run.id);
          if (result.state !== "complete") break;
        }
        return reply(run);
      }
      if (path === "/tools/snapshot") {
        const input = z.strictObject({ runId: id }).parse(body);
        return reply(await runtime.commands.snapshot(actor, input.runId));
      }
      const input =
        path === "/tools/advance"
          ? {
              kind: "advance" as const,
              ...z
                .strictObject({
                  runId: id,
                  nodeId: id,
                  revision,
                  commandId: id,
                })
                .parse(body),
            }
          : path === "/tools/cancel"
            ? {
                kind: "cancel" as const,
                ...z.strictObject({ runId: id, revision }).parse(body),
              }
            : undefined;
      if (!input) return reply({ error: "unavailable" }, 404);
      await runtime.commands.snapshot(actor, input.runId);
      const delegated = await runtime.agentActor(input.runId);
      if (
        delegated.tenantId !== actor.tenantId ||
        delegated.subjectId !== actor.subjectId ||
        delegated.sessionId !== actor.sessionId
      )
        throw new AuthorizationError("denied");
      if (input.kind === "advance")
        await runtime.commands.advance(
          delegated,
          input.runId,
          input.nodeId,
          input.revision,
          input.commandId,
        );
      else {
        await runtime.commands.cancel(delegated, input.runId, input.revision);
        await runtime.cancel?.(delegated, input.runId);
      }
      return reply(await runtime.commands.snapshot(actor, input.runId));
    }
    if (path === "/capabilities" && !post)
      return reply({
        available: true,
        authenticated: true,
        modelAvailable: Boolean(runtime.modelConfiguration.model),
        signOutAvailable:
          typeof Reflect.get(runtime.identity, "logout") === "function",
        connectors: runtime.connectors,
      });
    if (path === "/runs" && post) {
      const input = z
        .strictObject({
          connectorId: id,
          teach: z.boolean().optional(),
          target: z.string().min(1).max(2048).optional(),
        })
        .refine(
          (input) =>
            !input.target ||
            input.connectorId === "jira" ||
            /^[a-zA-Z0-9-]{1,100}$/.test(input.target),
        )
        .parse(body);
      if (!runtime.connectors.includes(input.connectorId))
        throw new AuthorizationError("invalid_request");
      if (input.target) {
        if (!runtime.selectTarget) throw new AuthorizationError("denied");
        await runtime.selectTarget(actor, input.target, input.connectorId);
      }
      let run = await runtime.connect(actor, input.connectorId);
      const demo = input.teach
        ? await runtime.demonstrations.start(actor, run.id)
        : undefined;
      for (const node of run.nodes) {
        if (node.verified) continue;
        const result = await runtime.commands.advance(
          actor,
          run.id,
          node.id,
          run.revision,
          `auto:${run.id}:${node.id}:${run.revision}`,
        );
        run = await runtime.commands.snapshot(actor, run.id);
        if (result.state !== "complete") break;
      }
      return reply({ ...run, ...(demo ? { demonstration: demo } : {}) });
    }
    const runRoute = /^\/runs\/([^/]+)(?:\/(advance|cancel))?$/.exec(path);
    const activeDemo = /^\/runs\/([^/]+)\/demonstration$/.exec(path);
    if (activeDemo && !post) {
      const runId = id.parse(decodeURIComponent(activeDemo[1]!));
      await runtime.commands.snapshot(actor, runId);
      const pointer = await runtime.store.transaction((tx) =>
        tx.get<{ id: string }>({
          tenant: actor.tenantId,
          kind: "session",
          id: `demonstration:${runId}`,
        }),
      );
      if (!pointer) return reply({ demonstration: null });
      try {
        return reply({
          demonstration: await runtime.demonstrations.timeline(
            actor,
            pointer.value.id,
          ),
        });
      } catch {
        return reply({ demonstration: null });
      }
    }
    if (runRoute) {
      const runId = id.parse(decodeURIComponent(runRoute[1]!));
      if (!post && !runRoute[2])
        return reply(await runtime.commands.snapshot(actor, runId));
      if (post && runRoute[2] === "cancel") {
        const result = await runtime.commands.cancel(
          actor,
          runId,
          z.strictObject({ revision }).parse(body).revision,
        );
        await runtime.cancel?.(actor, runId);
        return reply(result);
      }
      if (post && runRoute[2] === "advance") {
        const input = z
          .strictObject({ nodeId: id, revision, commandId: id })
          .parse(body);
        await runtime.commands.advance(
          actor,
          runId,
          input.nodeId,
          input.revision,
          input.commandId,
        );
        return reply(await runtime.commands.snapshot(actor, runId));
      }
    }
    if (path === "/demonstrations" && post) {
      const input = z
        .strictObject({ runId: id, scope: z.array(id).max(32).optional() })
        .parse(body);
      return reply(
        await runtime.demonstrations.start(actor, input.runId, input.scope),
      );
    }
    const demoRoute = /^\/demonstrations\/([^/]+)$/.exec(path);
    if (demoRoute) {
      const demoId = id.parse(decodeURIComponent(demoRoute[1]!));
      if (post) {
        const input = z
          .strictObject({ revision, consent: demonstrationConsentSchema })
          .parse(body);
        return reply(
          await runtime.demonstrations.change(
            actor,
            demoId,
            input.revision,
            input.consent,
          ),
        );
      }
      const url = new URL(request.url);
      return reply(
        await runtime.demonstrations.timeline(
          actor,
          demoId,
          Number(url.searchParams.get("after") ?? 0),
          Number(url.searchParams.get("limit") ?? 100),
        ),
      );
    }
    if (path === "/drafts/compile" && post) {
      const input = z
        .strictObject({
          demonstrationId: id,
          first: z.number().int().nonnegative(),
          last: z.number().int().nonnegative(),
        })
        .parse(body);
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
        events.push(
          ...page.events.filter((event) => event.sequence <= input.last),
        );
        after = page.events.at(-1)!.sequence;
      }
      return reply(
        await runtime.recipes.compileDraft(actor, events, {
          first: input.first,
          last: input.last,
        }),
      );
    }
    if (path === "/drafts/import" && post) {
      const input = z
        .strictObject({ definition: z.string().max(262144) })
        .parse(body);
      return reply(
        await runtime.recipes.createDraft(
          actor,
          parseRecipeImport(input.definition),
        ),
      );
    }
    const draftRoute =
      /^\/drafts\/([^/]+)(?:\/(edit|review|publish|suggest))?$/.exec(path);
    if (draftRoute) {
      const draftId = id.parse(decodeURIComponent(draftRoute[1]!));
      if (!post && !draftRoute[2])
        return reply(await runtime.recipes.getDraft(actor, draftId));
      if (post && draftRoute[2] === "edit") {
        const input = z
          .strictObject({ revision, definition: recipeDefinitionSchema })
          .parse(body);
        return reply(
          await runtime.recipes.editDraft(
            actor,
            draftId,
            input.revision,
            input.definition,
          ),
        );
      }
      if (post && draftRoute[2] === "suggest") {
        z.strictObject({ revision }).parse(body);
        const draft = await runtime.recipes.getDraft(actor, draftId);
        if (
          draft.revision !== z.strictObject({ revision }).parse(body).revision
        )
          throw new PersistenceConflict();
        if (draft.author !== actor.subjectId)
          throw new AuthorizationError("denied");
        const preview = await runtime.recipes.preview(actor, draft.definition);
        if (preview.diagnostics.length)
          throw new AuthorizationError("invalid_request");
        const suggestion = await suggestRecipeLabels(
          runtime.store,
          actor,
          draftId,
          preview.leaves.map((leaf) => ({
            id: leaf.use.id,
            version: leaf.use.version,
          })),
          configuredModel(runtime.modelConfiguration),
        );
        return reply({ suggestion });
      }
      if (post && (draftRoute[2] === "review" || draftRoute[2] === "publish")) {
        const input = review.parse(body);
        return reply(
          (await runtime.recipes[draftRoute[2]](
            actor,
            draftId,
            input.revision,
            input.digest,
          )) ?? { reviewed: true },
        );
      }
    }
    if (path === "/recipes" && !post) {
      requireCapability(actor, "executor");
      const rows = await runtime.store.transaction((tx) =>
        tx.list<PublishedRecipe>(actor.tenantId, "recipe", 100),
      );
      return reply({
        recipes: rows
          .filter((x) => x.value.definition && !x.value.retired)
          .map((x) => ({
            id: x.value.definition.id,
            title: x.value.definition.title,
            version: x.value.version,
            digest: x.value.digest,
            definition: x.value.definition,
          })),
      });
    }
    const publishedRoute = /^\/recipes\/([^/]+)\/(export|retire)$/.exec(path);
    if (publishedRoute) {
      const recipeId = id.parse(decodeURIComponent(publishedRoute[1]!));
      if (post && publishedRoute[2] === "retire") {
        const input = z
          .strictObject({ version: z.string().regex(/^\d+\.\d+\.\d+$/) })
          .parse(body);
        await runtime.recipes.retire(actor, recipeId, input.version);
        return reply({ retired: true });
      }
      if (!post && publishedRoute[2] === "export") {
        const url = new URL(request.url);
        const published = await runtime.recipes.getPublished(
          actor,
          recipeId,
          z
            .string()
            .regex(/^\d+\.\d+\.\d+$/)
            .parse(url.searchParams.get("version")),
          z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(url.searchParams.get("digest")),
        );
        return reply(published.definition);
      }
    }
    if (path === "/composition/preview" && post)
      return reply(
        await runtime.recipes.preview(
          actor,
          recipeDefinitionSchema.parse(body),
        ),
      );
    if (path === "/recipes/compose" && post) {
      const input = z
        .strictObject({
          references: z
            .array(
              z.strictObject({ id, version: z.string(), digest: z.string() }),
            )
            .min(2)
            .max(32),
        })
        .parse(body);
      return reply(
        await runtime.recipes.composePublished(actor, input.references),
      );
    }
    if (path === "/recipes/execute" && post) {
      const input = z
        .strictObject({
          connectorId: id.default("github"),
          id,
          version: z.string(),
          digest: z.string(),
          inputs: z.record(
            id,
            z.union([
              z.string().max(512),
              z.number().finite(),
              z.boolean(),
              z.null(),
            ]),
          ),
        })
        .parse(body);
      const published = await runtime.recipes.getPublished(
        actor,
        input.id,
        input.version,
        input.digest,
      );
      return reply(
        await runtime.executeRecipe(
          actor,
          published.definition,
          input.inputs,
          input.connectorId,
        ),
      );
    }
    const agentRoute = /^\/agent\/([^/]+)\/(start|stop|status|stream)$/.exec(
      path,
    );
    if (agentRoute) {
      const runId = id.parse(decodeURIComponent(agentRoute[1]!));
      if (post && agentRoute[2] === "stop") {
        z.strictObject({}).parse(body);
        await runtime.agent.stop(actor, runId);
        return reply({ status: "stopped" });
      }
      if (post && agentRoute[2] === "start") {
        z.strictObject({}).parse(body);
        if (!runtime.modelConfiguration.model)
          return reply({ status: "unavailable" });
        const turnId = await runtime.delegate(actor, runId);
        if (startAgent) {
          await startAgent(runId, turnId);
          return reply({ turnId, status: "running" });
        }
        return reply({
          turnId,
          status: await runtime.agent.turn(actor, runId, turnId),
        });
      }
      if (!post && agentRoute[2] === "status")
        return reply(
          await runtime.agent.status(
            actor,
            runId,
            id
              .optional()
              .parse(
                new URL(request.url).searchParams.get("turnId") ?? undefined,
              ),
          ),
        );
      if (!post && agentRoute[2] === "stream")
        return await agentStatusStream(
          runtime.agent,
          actor,
          runId,
          id
            .optional()
            .parse(
              new URL(request.url).searchParams.get("turnId") ?? undefined,
            ),
          async () => {
            const current = await authenticatedActor(request, runtime.identity);
            if (
              current.tenantId !== actor.tenantId ||
              current.subjectId !== actor.subjectId ||
              current.sessionId !== actor.sessionId
            )
              throw new AuthorizationError("denied");
            requireCapability(current, "executor");
          },
        );
    }
    return reply({ error: "unavailable" }, 404);
  } catch (error) {
    if (error instanceof Error && error.message === "account-required")
      return reply({ error: "account-required" }, 409);
    if (error instanceof Error && error.message === "jira-site-required")
      return reply({ error: "jira-site-required" }, 409);
    if (
      error instanceof Error &&
      error.message === "incomplete-github-configuration"
    )
      return reply({ error: "incomplete-github-configuration" }, 409);
    if (error instanceof PersistenceConflict)
      return reply({ error: "conflict" }, 409);
    if (error instanceof AuthorizationError)
      return reply(
        { error: error.code },
        error.code === "unauthenticated"
          ? 401
          : error.code === "invalid_request"
            ? 400
            : 403,
      );
    if (error instanceof z.ZodError)
      return reply({ error: "invalid_request" }, 400);
    return reply({ error: "unavailable" }, 400);
  }
}
