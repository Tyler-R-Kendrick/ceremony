import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ActorContext } from "../core/operation-contracts.js";
import {
  applyProviderProposal,
  composeAuthoredMethods,
  disambiguateProvider,
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
  if (result.human?.mode === "elicit") return result.human.body;
  if (result.human?.mode === "a2h-authorize")
    return `${result.human.body} I'll use A2H. Do not send passwords in chat.`;
  if (result.human?.mode === "private-collector")
    return `${result.human.body} Use the private collector. Do not send passwords in chat.`;
  const methods = result.draft?.methods.join(", ") ?? "none";
  const corrected =
    result.resolution &&
    result.resolution.query.trim().toLowerCase() !== result.resolution.resolved
      ? ` I used ${result.resolution.resolved} after correcting the name.`
      : "";
  const found = result.discovery?.documents.length
    ? ` Discovery found ${result.discovery.documents.join(", ")}.`
    : "";
  return `Drafted ${result.draft?.provider ?? "the provider"} with ${methods}.${corrected}${found} This is a definition, not a live connection.`;
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
      provider: project.manifest.id || project.manifest.name || "provider",
      methods: project.manifest.methods.map((method) => method.kind),
      executable: false,
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
    const discovery = origins.length
      ? await discoverProviderAuth(origins, {
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
          ...(this.options.search ? { search: this.options.search } : {}),
          query: resolution.resolved,
          ...(this.options.allowLoopbackHttp
            ? { allowLoopbackHttp: true }
            : {}),
        })
      : {
          origin: "",
          documents: [] as string[],
          methods:
            [] as ConnectorDraft["manifest"]["methods"][number]["kind"][],
          searchUsed: false,
        };
    if (
      resolution.confidence === "low" &&
      !origins.length &&
      !discovery.documents.length
    )
      return {
        ok: true,
        resolution,
        discovery: {
          origin: "",
          documents: [],
          searchUsed: Boolean(this.options.search),
        },
        human: {
          mode: "elicit",
          reason: "origin-url",
          title: "Provider origin",
          body: "A public HTTPS origin is required to discover well-known auth documents. Do not send credentials.",
          fields: [
            { name: "origin", label: "Provider HTTPS origin", type: "url" },
          ],
        },
      };
    const project = newConnectorProject();
    applyProviderProposal(project, resolution.resolved, {
      ...(discovery.methods.length ? { methods: discovery.methods } : {}),
      ...(openApiUrl || discovery.openApiUrl
        ? { openApiUrl: openApiUrl ?? discovery.openApiUrl }
        : {}),
    });
    const saved = parseConnectorDraft(JSON.stringify(project));
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
