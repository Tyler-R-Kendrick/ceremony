import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ActorContext } from "../core/operation-contracts.js";
import {
  applyProviderProposal,
  composeAuthoredMethods,
  newConnectorProject,
  parseConnectorDraft,
  type ConnectorDraft,
} from "../core/connector-authoring.js";
import type {
  AuthoringHuman,
  AuthoringResult,
} from "../core/authoring-tools.js";
import { AuthorizationError, requireCapability } from "./identity.js";
import type { AsyncCeremonyStore } from "./persistence/index.js";

const recordSchema = z.strictObject({
  author: z.string().min(1).max(200),
  session: z.string().min(1).max(200),
  project: z.unknown(),
});

function key(actor: ActorContext, id: string) {
  return { tenant: actor.tenantId, kind: "draft" as const, id };
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
): AuthoringResult {
  const human = humanFor(project, intent);
  return {
    ok: true,
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
  constructor(private readonly store: AsyncCeremonyStore) {}
  async fromProvider(
    actor: ActorContext,
    provider: string,
    openApiUrl?: string,
    intent: "draft" | "complete" | "run" = "draft",
  ): Promise<AuthoringResult> {
    requireCapability(actor, "author");
    const project = newConnectorProject();
    applyProviderProposal(project, provider);
    if (openApiUrl)
      project.workflows[0]!.sourceDescriptions[0]!.url = openApiUrl;
    const saved = parseConnectorDraft(JSON.stringify(project));
    const id = randomUUID();
    const revision = await this.store.transaction((tx) =>
      tx.put(
        key(actor, id),
        { author: actor.subjectId, session: actor.sessionId, project: saved },
        null,
      ),
    );
    return summarize(id, revision, saved, intent);
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
}
