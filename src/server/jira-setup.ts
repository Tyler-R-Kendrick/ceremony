import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  actorContextSchema,
  type ActorContext,
} from "../core/operation-contracts.js";
import { AuthorizationError } from "./identity.js";
import { appendSemanticTransition } from "./demonstrations.js";
import type { RunRecord } from "./commands.js";
import type {
  AsyncCeremonyStore,
  AsyncTransaction,
  RecordKey,
} from "./persistence/index.js";
import {
  jiraOAuthConfigurationSchema,
  type JiraOAuthConfiguration,
} from "./jira-auth.js";

const assignmentSchema = z.strictObject({
  requester: actorContextSchema,
  owner: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  nodeId: z.string().min(1).max(200),
  runRevision: z.number().int().positive(),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  expires: z.number().int().positive(),
  state: z.enum(["pending", "configured"]),
});
type Assignment = z.infer<typeof assignmentSchema>;
const sharedSchema = z.strictObject({
  owner: z.string().min(1).max(200),
  expires: z.number().int().positive(),
  app: jiraOAuthConfigurationSchema,
});

/** Host-owned assignment policy. Resolving an owner does not impersonate that owner. */
export type JiraSetupPolicy = {
  owner(requester: ActorContext, target: string): Promise<string | undefined>;
  authorize(requester: ActorContext, run: RunRecord): Promise<void>;
  scopes: JiraOAuthConfiguration["scopes"];
  /** Optional owner notification. Failure must not revoke the assignment. */
  deliver?(input: {
    owner: string;
    run: RunRecord;
    assignmentId: string;
    tenantId: string;
  }): Promise<void>;
};

/** Protected shared app configuration only: never shares user tokens or marks access verified. */
export class JiraSetupAssignments {
  constructor(
    private readonly store: AsyncCeremonyStore,
    private readonly policy: JiraSetupPolicy,
  ) {}
  private requestKey(actor: ActorContext, id: string): RecordKey {
    if (!z.uuid().safeParse(id).success) throw new AuthorizationError("denied");
    return { tenant: actor.tenantId, kind: "handoff", id: `jira-setup:${id}` };
  }
  private scope(run: RunRecord) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          run.provider,
          run.profile,
          run.origin,
          run.environment,
          run.configurationVersion,
          run.target,
          [...new Set(this.policy.scopes)].sort(),
        ]),
      )
      .digest("hex");
  }
  private appKey(actor: ActorContext, scope: string): RecordKey {
    return {
      tenant: actor.tenantId,
      kind: "artifact",
      id: `jira-shared-app:${scope}`,
    };
  }
  private async run(
    tx: AsyncTransaction,
    requester: ActorContext,
    runId: string,
  ) {
    const record = await tx.get<RunRecord>({
      tenant: requester.tenantId,
      kind: "run",
      id: runId,
    });
    if (
      !record ||
      record.value.subjectId !== requester.subjectId ||
      record.value.sessionId !== requester.sessionId ||
      record.value.status !== "active" ||
      record.value.provider !== "jira" ||
      record.value.profile !== "jira-3lo"
    )
      throw new AuthorizationError("denied");
    return record;
  }
  private async pending(tx: AsyncTransaction, assignment: Assignment) {
    const run = await this.run(tx, assignment.requester, assignment.runId);
    const node = run.value.nodes.find((item) => item.id === assignment.nodeId);
    const state = await tx.get<{ state: string; verified: boolean }>({
      tenant: assignment.requester.tenantId,
      kind: "node",
      id: `${assignment.runId}:${assignment.nodeId}`,
    });
    if (
      run.revision !== assignment.runRevision ||
      this.scope(run.value) !== assignment.scope ||
      assignment.expires <= (await tx.now()) ||
      node?.operationId !== "jira.prepare-app" ||
      node.operationVersion !== "1.0.0" ||
      state?.value.state !== "awaiting-human" ||
      state.value.verified
    )
      throw new AuthorizationError("denied");
    return run;
  }
  /** Called from a trusted run, not with caller-supplied owner or configuration fields. */
  async request(requester: ActorContext, runId: string, revision: number) {
    actorContextSchema.parse(requester);
    const run = await this.store.transaction((tx) =>
      this.run(tx, requester, runId),
    );
    await this.policy.authorize(requester, run.value);
    const owner = await this.policy.owner(requester, run.value.target);
    if (!owner) throw new AuthorizationError("denied");
    const node = run.value.nodes.find(
      (item) => item.operationId === "jira.prepare-app",
    );
    if (!node || run.revision !== revision)
      throw new AuthorizationError("denied");
    const id = randomUUID();
    const result = await this.store.transaction(async (tx) => {
      const assignment = assignmentSchema.parse({
        requester,
        owner,
        runId,
        nodeId: node.id,
        runRevision: revision,
        scope: this.scope(run.value),
        expires: (await tx.now()) + 86400000,
        state: "pending",
      });
      await this.pending(tx, assignment);
      // One current assignment per parent; retries do not create another owner request.
      const indexKey: RecordKey = {
        tenant: requester.tenantId,
        kind: "handoff",
        id: `jira-setup-index:${runId}`,
      };
      const index = await tx.get<{ id: string }>(indexKey);
      if (index) {
        const existing = await tx.get(
          this.requestKey(requester, index.value.id),
        );
        const value = assignmentSchema.parse(existing?.value);
        if (
          value.owner !== owner ||
          value.scope !== assignment.scope ||
          value.runRevision !== revision
        )
          throw new AuthorizationError("denied");
        if (value.expires > (await tx.now()))
          return {
            id: index.value.id,
            revision: existing!.revision,
            state: value.state,
          };
        if (value.state !== "pending") throw new AuthorizationError("denied");
        // Renew the assignment, never its expired link or completed provider effects.
      }
      const saved = await tx.put(
        this.requestKey(requester, id),
        assignment,
        null,
      );
      await tx.put(indexKey, { id }, index?.revision ?? null);
      return { id, revision: saved, state: assignment.state };
    });
    if (result.state === "pending") {
      try {
        await this.policy.deliver?.({
          owner,
          run: run.value,
          assignmentId: result.id,
          tenantId: requester.tenantId,
        });
      } catch {
        // Uncertain notification cannot revoke the assignment or imply owner action.
      }
    }
    return result;
  }
  private async authorizedOwner(owner: ActorContext, id: string) {
    actorContextSchema.parse(owner);
    if (owner.actorKind !== "human" || !owner.capabilities.includes("admin"))
      throw new AuthorizationError("denied");
    const request = await this.store.transaction((tx) =>
      tx.get(this.requestKey(owner, id)),
    );
    const parsed = assignmentSchema.safeParse(request?.value);
    if (
      !parsed.success ||
      parsed.data.requester.tenantId !== owner.tenantId ||
      parsed.data.owner !== owner.subjectId
    )
      throw new AuthorizationError("denied");
    const run = await this.store.transaction(async (tx) => {
      if (parsed.data.expires <= (await tx.now()))
        throw new AuthorizationError("denied");
      return parsed.data.state === "pending"
        ? this.pending(tx, parsed.data)
        : this.run(tx, parsed.data.requester, parsed.data.runId);
    });
    await this.policy.authorize(parsed.data.requester, run.value);
    if (
      (await this.policy.owner(parsed.data.requester, run.value.target)) !==
      owner.subjectId
    )
      throw new AuthorizationError("denied");
    return { request: request!, assignment: parsed.data, run };
  }
  /** Read-only requester status; never advances provider state or returns app values. */
  async status(requester: ActorContext, runId: string) {
    actorContextSchema.parse(requester);
    const run = await this.store.transaction((tx) =>
      this.run(tx, requester, runId),
    );
    const scope = this.scope(run.value);
    await this.policy.authorize(requester, run.value);
    const owner = await this.policy.owner(requester, run.value.target);
    if (!owner) throw new AuthorizationError("denied");
    return this.store.transaction(async (tx) => {
      const current = await this.run(tx, requester, runId);
      if (
        current.revision !== run.revision ||
        this.scope(current.value) !== scope
      )
        throw new AuthorizationError("denied");
      const index = await tx.get<{ id: string }>({
        tenant: requester.tenantId,
        kind: "handoff",
        id: `jira-setup-index:${runId}`,
      });
      if (!index) return { state: "none" as const, revision: current.revision };
      const record = await tx.get(this.requestKey(requester, index.value.id));
      const assignment = assignmentSchema.parse(record?.value);
      if (assignment.owner !== owner || assignment.scope !== scope)
        throw new AuthorizationError("denied");
      const now = await tx.now();
      if (assignment.state === "configured") {
        const app = await tx.get(this.appKey(requester, scope));
        const shared = sharedSchema.safeParse(app?.value);
        return {
          state:
            shared.success &&
            shared.data.owner === owner &&
            shared.data.expires > now
              ? ("configured" as const)
              : ("unavailable" as const),
          revision: current.revision,
        };
      }
      if (assignment.runRevision !== current.revision)
        throw new AuthorizationError("denied");
      return {
        state:
          assignment.expires <= now
            ? ("expired" as const)
            : ("pending" as const),
        revision: current.revision,
        id: index.value.id,
      };
    });
  }
  /** Private human projection. No requester session, app secret or credential handle is returned. */
  async view(owner: ActorContext, id: string) {
    const { request, assignment, run } = await this.authorizedOwner(owner, id);
    return {
      id,
      revision: request.revision,
      state: assignment.state,
      siteUrl: run.value.target,
      callbackUrl: `${run.value.origin}/api/v1/teaching/jira/authorization-return`,
      scopes: [...this.policy.scopes],
    };
  }
  async configure(
    owner: ActorContext,
    id: string,
    revision: number,
    input: unknown,
  ): Promise<void> {
    const values = jiraOAuthConfigurationSchema
      .pick({ clientId: true, clientSecret: true })
      .strict()
      .safeParse(input);
    if (!values.success) throw new AuthorizationError("invalid_request");
    const { assignment, run } = await this.authorizedOwner(owner, id);
    const app = jiraOAuthConfigurationSchema.parse({
      ...values.data,
      siteUrl: run.value.target,
      callbackUrl: `${run.value.origin}/api/v1/teaching/jira/authorization-return`,
      scopes: this.policy.scopes,
    });
    try {
      await this.store.transaction(async (tx) => {
        const requestKey = this.requestKey(owner, id);
        const current = await tx.get(requestKey);
        if (
          !current ||
          current.revision !== revision ||
          assignmentSchema.parse(current.value).state !== "pending"
        )
          throw new AuthorizationError("denied");
        const currentRun = await this.pending(tx, assignment);
        const runKey: RecordKey = {
          tenant: owner.tenantId,
          kind: "run",
          id: assignment.runId,
        };
        const fence = await tx.claim(runKey, `jira-setup-${id}`, 30000);
        const appKey = this.appKey(owner, assignment.scope);
        // Changing an already published app requires a new host configuration version.
        if (await tx.get(appKey)) throw new AuthorizationError("denied");
        await tx.put(
          appKey,
          sharedSchema.parse({
            owner: owner.subjectId,
            app,
            expires: (await tx.now()) + 86400000,
          }),
          null,
        );
        await tx.put(
          requestKey,
          { ...assignment, state: "configured" },
          revision,
        );
        await tx.put(runKey, currentRun.value, currentRun.revision);
        await tx.put(
          { tenant: owner.tenantId, kind: "audit", id: `jira-setup:${id}` },
          {
            event: "jira-app-configured",
            subjectId: owner.subjectId,
            runId: assignment.runId,
            operationId: "jira.prepare-app",
          },
          null,
        );
        await appendSemanticTransition(
          tx,
          assignment.requester,
          assignment.runId,
          {
            nodeId: assignment.nodeId,
            operationId: "jira.prepare-app",
            operationVersion: "1.0.0",
            actorKind: "human",
            kind: "handoff",
            beforeState: "awaiting-human",
            afterState: "awaiting-human",
            publicBindings: {},
            verification: "pending",
          },
          {},
        );
        await tx.assertFence(fence);
        await tx.cancel(runKey);
      });
    } finally {
      values.data.clientId = "";
      values.data.clientSecret = "";
      app.clientId = "";
      app.clientSecret = "";
    }
  }
  /** Provider children still validate this configuration and require each user's own consent. */
  async resolve(
    requester: ActorContext,
    runId: string,
  ): Promise<JiraOAuthConfiguration | undefined> {
    const run = await this.store.transaction((tx) =>
      this.run(tx, requester, runId),
    );
    const scope = this.scope(run.value);
    await this.policy.authorize(requester, run.value);
    const owner = await this.policy.owner(requester, run.value.target);
    if (!owner) return undefined;
    return this.store.transaction(async (tx) => {
      const current = await this.run(tx, requester, runId);
      if (
        current.revision !== run.revision ||
        this.scope(current.value) !== scope
      )
        throw new AuthorizationError("denied");
      const record = await tx.get(this.appKey(requester, scope));
      if (!record) return undefined;
      const shared = sharedSchema.parse(record.value);
      return shared.owner === owner && shared.expires > (await tx.now())
        ? shared.app
        : undefined;
    });
  }
}

/** Operator retention: remove expired pending assignments and expired shared apps. Audit stays. */
export async function retainExpiredJiraSetup(
  store: AsyncCeremonyStore,
  tenant: string,
) {
  z.string().min(1).max(200).parse(tenant);
  const counts = { assignments: 0, apps: 0, indexes: 0 };
  const sweep = async (
    kind: "handoff" | "artifact",
    prefix: string,
    expired: (value: unknown, now: number) => boolean,
  ) => {
    let after = "";
    let removed = 0;
    for (;;) {
      const page = await store.transaction((tx) =>
        tx.list(tenant, kind, 100, after),
      );
      if (!page.length) break;
      after = page.at(-1)!.id;
      for (const record of page) {
        if (
          !record.id.startsWith(prefix) ||
          (prefix === "jira-setup:" &&
            record.id.startsWith("jira-setup-index:"))
        )
          continue;
        const deleted = await store.transaction(async (tx) => {
          const current = await tx.get({
            tenant,
            kind,
            id: record.id,
          });
          if (!current) return false;
          if (!expired(current.value, await tx.now())) return false;
          await tx.delete({ tenant, kind, id: record.id }, current.revision);
          return true;
        });
        if (deleted) removed++;
      }
      if (page.length < 100) break;
    }
    return removed;
  };
  counts.assignments = await sweep("handoff", "jira-setup:", (value, now) => {
    const assignment = assignmentSchema.safeParse(value);
    return assignment.success && assignment.data.expires <= now;
  });
  counts.apps = await sweep("artifact", "jira-shared-app:", (value, now) => {
    const shared = sharedSchema.safeParse(value);
    return shared.success && shared.data.expires <= now;
  });
  let after = "";
  for (;;) {
    const page = await store.transaction((tx) =>
      tx.list<{ id: string }>(tenant, "handoff", 100, after),
    );
    if (!page.length) break;
    after = page.at(-1)!.id;
    for (const record of page) {
      if (!record.id.startsWith("jira-setup-index:")) continue;
      const deleted = await store.transaction(async (tx) => {
        const current = await tx.get<{ id: string }>({
          tenant,
          kind: "handoff",
          id: record.id,
        });
        if (!current) return false;
        const index = z.strictObject({ id: z.uuid() }).safeParse(current.value);
        if (!index.success) {
          await tx.delete(
            { tenant, kind: "handoff", id: record.id },
            current.revision,
          );
          return true;
        }
        const assignment = await tx.get({
          tenant,
          kind: "handoff",
          id: `jira-setup:${index.data.id}`,
        });
        if (assignment) return false;
        await tx.delete(
          { tenant, kind: "handoff", id: record.id },
          current.revision,
        );
        return true;
      });
      if (deleted) counts.indexes++;
    }
    if (page.length < 100) break;
  }
  return counts;
}
