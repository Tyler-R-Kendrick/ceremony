import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ActorContext } from "../core/operation-contracts.js";
import {
  applyProviderProposal,
  composeAuthoredMethods,
  disambiguateProvider,
  extractProviderName,
  newConnectorProject,
  parseConnectorDraft,
  providerCatalog,
  type ConnectorDraft,
} from "../core/connector-authoring.js";
import type {
  AuthoringHuman,
  AuthoringResult,
} from "../core/authoring-tools.js";
import { AuthorizationError, requireCapability } from "./identity.js";
import type { AsyncCeremonyStore } from "./persistence/index.js";
import { validateAgentText } from "./agent/model.js";
import {
  discoverProviderAuth,
  type ProviderSearch,
} from "./provider-discovery.js";
import {
  manifestFromProject,
  recipeFromProject,
} from "./authored-operations.js";
import type { ConnectorManifest } from "../core/schema.js";
import type { RecipeDefinition } from "../core/recipe-contracts.js";

const recordSchema = z.strictObject({
  author: z.string().min(1).max(200),
  session: z.string().min(1).max(200),
  project: z.unknown(),
});
const chatSchema = z.strictObject({
  author: z.string().min(1).max(200),
  session: z.string().min(1).max(200),
  messages: z
    .array(
      z.strictObject({
        role: z.enum(["user", "assistant"]),
        text: z.string().min(1).max(2000),
      }),
    )
    .max(32),
  pending: z.enum(["provider-name", "origin-url"]).optional(),
  lastProvider: z.string().max(100).optional(),
});
export type AuthoringChat = {
  conversationId: string;
  messages: z.infer<typeof chatSchema>["messages"];
  result?: AuthoringResult;
};

function key(actor: ActorContext, id: string) {
  return { tenant: actor.tenantId, kind: "draft" as const, id };
}
function chatKey(actor: ActorContext, id: string) {
  return { tenant: actor.tenantId, kind: "draft" as const, id: `chat:${id}` };
}
function replyFrom(result: AuthoringResult) {
  if (result.human?.mode === "a2h-authorize")
    return `${result.human.body} I'll use A2H. Do not send passwords in chat.`;
  if (result.human?.mode === "private-collector")
    return `${result.human.body} Use the private collector. Do not send passwords in chat.`;
  if (!result.draft) {
    if (result.human?.mode === "elicit") return result.human.body;
    return "I could not draft a ceremony from that.";
  }
  const corrected =
    result.resolution &&
    result.resolution.resolved &&
    !result.resolution.query.toLowerCase().includes(result.resolution.resolved)
      ? ` I treated that as ${result.draft.provider}.`
      : "";
  const found = result.discovery?.documents.length
    ? ` Discovery found ${result.discovery.documents.join(", ")}.`
    : "";
  const outline = (result.draft.outline ?? [])
    .map((line) => `\n- ${line}`)
    .join("");
  const test = result.draft.connectorId
    ? `\nTest it here: /?connector=${result.draft.connectorId}`
    : "";
  return `Drafted a ${result.draft.provider} ceremony.${corrected}${found}${outline}${test}`;
}

function humanFor(
  project: ConnectorDraft,
  intent: "draft" | "complete" | "run",
): AuthoringHuman {
  const url = project.workflows[0]?.sourceDescriptions[0]?.url ?? "";
  const kinds = project.manifest.methods.map((method) => method.kind);
  if (intent === "draft") return null;
  if (intent === "complete" && !url)
    return {
      mode: "elicit",
      reason: "openapi-url",
      title: "Public OpenAPI document",
      body: "A public HTTPS OpenAPI URL is required to complete this definition. Do not send credentials.",
      fields: [
        { name: "openApiUrl", label: "Provider OpenAPI document", type: "url" },
      ],
    };
  if (intent !== "run") return null;
  if (kinds.some((kind) => ["api-key", "basic", "form"].includes(kind)))
    return {
      mode: "private-collector",
      reason: "private-credentials",
      title: "Private credential collection",
      body: "Enter credentials only in the private collector. Never in the tool or chat.",
      recipient: "initiating-subject",
    };
  if (kinds.includes("github-app") || kinds.includes("oauth-code"))
    return {
      mode: "a2h-authorize",
      reason: kinds.includes("oauth-code") ? "owner-setup" : "provider-consent",
      title: "Provider participation required",
      body: "Authorize the shared app or account at the provider. Approval here does not skip provider consent.",
      recipient: kinds.includes("oauth-code")
        ? "authorized-owner"
        : "initiating-subject",
    };
  if (kinds.includes("device") || kinds.includes("authmd-anonymous"))
    return {
      mode: "a2h-authorize",
      reason: "provider-consent",
      title: "Provider participation required",
      body: "Complete the provider-owned approval or claim step. Credentials stay off the agent transcript.",
      recipient: "initiating-subject",
    };
  return null;
}

function summarize(
  id: string,
  revision: number,
  project: ConnectorDraft,
  intent: "draft" | "complete" | "run",
  extra: Pick<AuthoringResult, "resolution" | "discovery"> = {},
): AuthoringResult {
  const human = humanFor(project, intent);
  return {
    ok: true,
    ...extra,
    draft: {
      id,
      revision,
      provider: project.manifest.name || project.manifest.id || "provider",
      methods: project.manifest.methods.map((method) => method.kind),
      executable: true,
      connectorId: project.manifest.id || undefined,
      outline: project.manifest.methods.map((method) => {
        const steps =
          project.workflows[0]?.workflows.find(
            (workflow) => workflow.workflowId === method.id,
          )?.steps ?? [];
        return `${method.label}: ${steps.map((step) => step.stepId).join(" → ") || "no steps"}`;
      }),
    },
    human,
  };
}

/** Authenticated authoring of connector drafts. Never executes a provider or stores credentials. */
export class ConnectorDrafts {
  constructor(
    private readonly store: AsyncCeremonyStore,
    private readonly options: {
      fetch?: typeof fetch;
      search?: ProviderSearch;
      allowLoopbackHttp?: boolean;
    } = {},
  ) {}
  async fromProvider(
    actor: ActorContext,
    provider: string,
    openApiUrl?: string,
    intent: "draft" | "complete" | "run" = "draft",
    origin?: string,
  ): Promise<AuthoringResult> {
    requireCapability(actor, "author");
    const resolution = disambiguateProvider(provider);
    if (resolution.confidence === "low" && resolution.alternatives.length)
      return {
        ok: true,
        resolution,
        human: {
          mode: "elicit",
          reason: "provider-name",
          title: "Which provider?",
          body: `Did you mean ${resolution.alternatives.join(", ")}? Confirm the provider name. Do not send credentials.`,
          fields: [{ name: "provider", label: "Provider name", type: "text" }],
        },
      };
    const catalog = providerCatalog[resolution.resolved];
    const origins = [...(origin ? [origin] : []), ...(catalog?.origins ?? [])];
    const discovery = await discoverProviderAuth(origins, {
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.search ? { search: this.options.search } : {}),
      query: resolution.resolved,
      ...(this.options.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}),
    });
    const project = newConnectorProject();
    applyProviderProposal(project, resolution.resolved, {
      ...(discovery.methods.length ? { methods: discovery.methods } : {}),
      ...(openApiUrl || discovery.openApiUrl
        ? { openApiUrl: openApiUrl ?? discovery.openApiUrl }
        : {}),
    });
    const saved = parseConnectorDraft(JSON.stringify(project));
    await this.install(actor, saved);
    const id = randomUUID();
    const revision = await this.store.transaction((tx) =>
      tx.put(
        key(actor, id),
        { author: actor.subjectId, session: actor.sessionId, project: saved },
        null,
      ),
    );
    return summarize(id, revision, saved, intent, {
      resolution,
      discovery: {
        origin: discovery.origin,
        documents: discovery.documents,
        searchUsed: discovery.searchUsed,
      },
    });
  }
  async compose(
    actor: ActorContext,
    draftId: string,
    revision: number,
    childIds: string[],
  ): Promise<AuthoringResult> {
    requireCapability(actor, "author");
    z.uuid().parse(draftId);
    return this.store.transaction(async (tx) => {
      const current = await tx.get(key(actor, draftId));
      if (!current) throw new AuthorizationError("denied");
      const record = recordSchema.parse(current.value);
      if (
        record.author !== actor.subjectId ||
        record.session !== actor.sessionId ||
        current.revision !== revision
      )
        throw new AuthorizationError("denied");
      const project = parseConnectorDraft(JSON.stringify(record.project));
      composeAuthoredMethods(project, childIds);
      const saved = parseConnectorDraft(JSON.stringify(project));
      const next = await tx.put(
        key(actor, draftId),
        { ...record, project: saved },
        current.revision,
      );
      return summarize(draftId, next, saved, "draft");
    });
  }
  async install(actor: ActorContext, project: ConnectorDraft) {
    const manifest = manifestFromProject(project);
    const definition = recipeFromProject(project);
    await this.store.transaction(async (tx) => {
      const recordKey = {
        tenant: actor.tenantId,
        kind: "artifact" as const,
        id: `installed-connector:${manifest.id}`,
      };
      const prior = await tx.get(recordKey);
      await tx.put(
        recordKey,
        {
          author: actor.subjectId,
          session: actor.sessionId,
          manifest,
          definition,
        },
        prior?.revision ?? null,
      );
    });
    return manifest.id;
  }
  async getInstalled(actor: ActorContext, connectorId: string) {
    const record = await this.store.transaction((tx) =>
      tx.get({
        tenant: actor.tenantId,
        kind: "artifact",
        id: `installed-connector:${connectorId}`,
      }),
    );
    if (!record) return undefined;
    const value = z
      .strictObject({
        author: z.string(),
        session: z.string(),
        manifest: z.unknown(),
        definition: z.unknown(),
      })
      .parse(record.value);
    if (value.author !== actor.subjectId) return undefined;
    return {
      manifest: value.manifest as ConnectorManifest,
      definition: value.definition as RecipeDefinition,
    };
  }
  async uninstall(actor: ActorContext, connectorId: string) {
    if (
      !actor.capabilities.includes("author") &&
      !actor.capabilities.includes("executor") &&
      !actor.capabilities.includes("admin")
    )
      throw new AuthorizationError("denied");
    const recordKey = {
      tenant: actor.tenantId,
      kind: "artifact" as const,
      id: `installed-connector:${connectorId}`,
    };
    const current = await this.store.transaction((tx) => tx.get(recordKey));
    if (!current) return false;
    const value = z
      .strictObject({
        author: z.string(),
        session: z.string(),
        manifest: z.unknown(),
        definition: z.unknown(),
      })
      .parse(current.value);
    if (value.author !== actor.subjectId)
      throw new AuthorizationError("denied");
    await this.store.transaction((tx) =>
      tx.delete(recordKey, current.revision),
    );
    return true;
  }
  async listManifests(actor: ActorContext): Promise<ConnectorManifest[]> {
    const manifests: ConnectorManifest[] = [];
    let after = "";
    for (;;) {
      const page = await this.store.transaction((tx) =>
        tx.list(actor.tenantId, "artifact", 100, after),
      );
      if (!page.length) break;
      after = page.at(-1)!.id;
      for (const record of page) {
        if (!record.id.startsWith("installed-connector:")) continue;
        const value = z
          .strictObject({
            author: z.string(),
            session: z.string(),
            manifest: z.unknown(),
            definition: z.unknown(),
          })
          .safeParse(record.value);
        if (!value.success || value.data.author !== actor.subjectId) continue;
        const parsed = z
          .custom<ConnectorManifest>((item) => item)
          .safeParse(value.data.manifest);
        if (parsed.success)
          manifests.push(value.data.manifest as ConnectorManifest);
      }
      if (page.length < 100) break;
    }
    return manifests;
  }
  async read(actor: ActorContext, draftId: string): Promise<AuthoringResult> {
    requireCapability(actor, "author");
    z.uuid().parse(draftId);
    const current = await this.store.transaction((tx) =>
      tx.get(key(actor, draftId)),
    );
    if (!current) throw new AuthorizationError("denied");
    const record = recordSchema.parse(current.value);
    if (record.author !== actor.subjectId)
      throw new AuthorizationError("denied");
    const project = parseConnectorDraft(JSON.stringify(record.project));
    return summarize(draftId, current.revision, project, "draft");
  }
  async chat(
    actor: ActorContext,
    message: string,
    conversationId?: string,
  ): Promise<AuthoringChat> {
    requireCapability(actor, "author");
    let text: string;
    try {
      text = validateAgentText(message.trim());
    } catch {
      const id = conversationId ?? randomUUID();
      return {
        conversationId: id,
        messages: [
          { role: "user", text: "(rejected)" },
          {
            role: "assistant",
            text: "Don't send credentials or secrets in chat. Name a provider, or complete A2H / private collection instead.",
          },
        ],
      };
    }
    const id = conversationId ?? randomUUID();
    if (conversationId) z.uuid().parse(conversationId);
    const current = conversationId
      ? await this.store.transaction((tx) => tx.get(chatKey(actor, id)))
      : undefined;
    const prior = current
      ? chatSchema.parse(current.value)
      : {
          author: actor.subjectId,
          session: actor.sessionId,
          messages: [],
        };
    if (current && prior.author !== actor.subjectId)
      throw new AuthorizationError("denied");
    if (/^(delete|remove|uninstall)\b/i.test(text)) {
      const target =
        extractProviderName(
          text.replace(
            /^(delete|remove|uninstall)\s+(the\s+)?(connection|connector|ceremony)?\s*(for|to)?\s*/i,
            "",
          ),
        ) || prior.lastProvider;
      const connectorId = target
        ? disambiguateProvider(target).resolved
        : prior.lastProvider;
      const removed = connectorId
        ? await this.uninstall(actor, connectorId)
        : false;
      const reply = removed
        ? `Deleted the local ${connectorId} connection and stored credentials. Your provider account was not deleted.`
        : "No local connection to delete for that provider.";
      const messages = [
        ...prior.messages,
        { role: "user" as const, text },
        { role: "assistant" as const, text: reply },
      ].slice(-32);
      await this.store.transaction((tx) =>
        tx.put(
          chatKey(actor, id),
          {
            ...prior,
            messages,
            lastProvider: connectorId ?? prior.lastProvider,
          },
          current?.revision ?? null,
        ),
      );
      return { conversationId: id, messages };
    }
    let result: AuthoringResult;
    if (prior.pending === "origin-url")
      result = await this.fromProvider(
        actor,
        prior.lastProvider ?? text,
        undefined,
        "draft",
        text,
      );
    else result = await this.fromProvider(actor, text, undefined, "draft");
    const pending =
      result.human?.reason === "provider-name" ||
      result.human?.reason === "origin-url"
        ? result.human.reason
        : undefined;
    const messages = [
      ...prior.messages,
      { role: "user" as const, text },
      { role: "assistant" as const, text: replyFrom(result) },
    ].slice(-32);
    const record = {
      author: actor.subjectId,
      session: actor.sessionId,
      messages,
      ...(pending ? { pending } : {}),
      lastProvider: result.resolution?.resolved ?? prior.lastProvider ?? text,
    };
    await this.store.transaction((tx) =>
      tx.put(chatKey(actor, id), record, current?.revision ?? null),
    );
    return {
      conversationId: id,
      messages,
      result,
    };
  }
}
