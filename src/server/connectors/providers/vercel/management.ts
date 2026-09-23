import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalConnectorJson } from "../../../../core/index.js";
import { AuthorizationError, requireCapability } from "../../../identity.js";
import type {
  AdapterCallContext,
  DiscoverInput,
  DiscoverResult,
  DiscoveredItem,
  InvokeRequest,
  InvokeResult,
} from "../../adapter.js";
import type { BoundOperation } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import { attemptDigest, beginAttempt } from "../../attempts.js";
import type { EffectOutcome } from "../../ports.js";
import { callVercel } from "./client.js";
import {
  connectConnectorListSchema,
  connectConnectorProjectListSchema,
  connectConnectorSchema,
  connectConnectorUpdateResultSchema,
  connectProjectConnectionSchema,
  connectProjectConnectorListSchema,
  permitsTarget,
  requireTarget,
  vercelConnectOperationTable,
  vercelInvokeInputSchemas,
  vercelOperationRef,
  vercelSettings,
  vercelTargetKinds,
  type ConnectConnector,
  type ConnectProjectConnection,
  type TriggerDestinationInput,
  type VercelManagementOperationId,
  type VercelSettings,
} from "./contracts.js";
import {
  configuredTeamId,
  resolveCredential,
  type ManagementCredential,
} from "./credentials.js";

/*
 * Administration of connectors and project links. Every call here uses the
 * management credential and the configured team; the caller contributes an
 * operation id and validated arguments, and the binding's permitted targets
 * decide which connectors, projects and environments those arguments may
 * name. Writes need the host's administrative policy and are journaled so a
 * retried command cannot repeat a mutation blindly.
 */

export type VercelAdminPolicy = (
  ctx: AdapterCallContext,
  operation: { id: VercelManagementOperationId; effect: "write" },
) => Promise<void>;

/** Default policy: the host's `admin` capability, derived from authentication, never from input. */
export const defaultAdminPolicy: VercelAdminPolicy = async (ctx) => {
  try {
    requireCapability(ctx.actor, "admin");
  } catch (error) {
    if (error instanceof AuthorizationError)
      throw new ConnectorError("denied", {
        detail: "vercel.admin-required",
        cause: error,
      });
    throw error;
  }
};

export type ManagementOptions = { policy: VercelAdminPolicy };

const managementIds = new Set<string>(Object.keys(vercelInvokeInputSchemas));

/** The management operation a bound operation names, if it names one at all. */
export function managementOperationFor(
  bound: BoundOperation,
): VercelManagementOperationId | undefined {
  return managementIds.has(bound.nativeId)
    ? (bound.nativeId as VercelManagementOperationId)
    : undefined;
}

/** A binding may not move an operation to another version, method or destination. */
export function assertTransportMatches(
  bound: BoundOperation,
  id: VercelManagementOperationId,
): void {
  const operation = vercelConnectOperationTable[id];
  if (
    bound.transport.kind !== "http" ||
    bound.transport.method !== operation.method ||
    bound.transport.pathTemplate !== operation.pathTemplate ||
    bound.destinationId !== "api" ||
    bound.effect !== operation.effect
  )
    throw new ConnectorError("invalid-request", {
      detail: "vercel.operation.transport-mismatch",
    });
}

export function effectDigest(parts: unknown): string {
  return createHash("sha256")
    .update(canonicalConnectorJson(parts))
    .digest("hex");
}

type Inputs = {
  [K in VercelManagementOperationId]: z.infer<
    (typeof vercelInvokeInputSchemas)[K]
  >;
};

function parseInput<K extends VercelManagementOperationId>(
  id: K,
  input: unknown,
): Inputs[K] {
  const parsed = vercelInvokeInputSchemas[id].safeParse(input);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "vercel.input.invalid",
    });
  return parsed.data as Inputs[K];
}

const sameDestination = (
  a: TriggerDestinationInput,
  b: TriggerDestinationInput,
) => canonicalConnectorJson(a) === canonicalConnectorJson(b);

function requireApprovedDestination(
  ctx: AdapterCallContext,
  settings: VercelSettings,
  destination: TriggerDestinationInput,
): void {
  requireTarget(
    ctx.binding,
    vercelTargetKinds.project,
    destination.projectId,
    "vercel.project.not-permitted",
  );
  const approved = settings.triggers?.destinations ?? [];
  if (!approved.some((item) => sameDestination(item, destination)))
    throw new ConnectorError("denied", {
      detail: "vercel.trigger.destination-not-approved",
    });
}

/** Every target an argument names is checked against the binding before the network is touched. */
function enforceTargets(
  ctx: AdapterCallContext,
  id: VercelManagementOperationId,
  input: Inputs[VercelManagementOperationId],
  settings: VercelSettings,
): void {
  const binding = ctx.binding;
  if ("connector" in input)
    requireTarget(
      binding,
      vercelTargetKinds.connector,
      input.connector,
      "vercel.connector.not-permitted",
    );
  if ("projectId" in input && input.projectId !== undefined)
    requireTarget(
      binding,
      vercelTargetKinds.project,
      input.projectId,
      "vercel.project.not-permitted",
    );
  if ("environments" in input)
    for (const environment of input.environments)
      requireTarget(
        binding,
        vercelTargetKinds.environment,
        environment,
        "vercel.environment.not-permitted",
      );
  if ("destinations" in input)
    for (const destination of input.destinations)
      requireApprovedDestination(ctx, settings, destination);
  if (id === "connect.connectors.create") {
    const body = (input as Inputs["connect.connectors.create"]).body;
    if (!body.uid)
      throw new ConnectorError("denied", {
        detail: "vercel.connector.uid-required",
      });
    requireTarget(
      binding,
      vercelTargetKinds.connector,
      body.uid,
      "vercel.connector.not-permitted",
    );
    if (body.projectId !== undefined)
      requireTarget(
        binding,
        vercelTargetKinds.project,
        body.projectId,
        "vercel.project.not-permitted",
      );
    for (const environment of body.environments ?? [])
      requireTarget(
        binding,
        vercelTargetKinds.environment,
        environment,
        "vercel.environment.not-permitted",
      );
    if (body.triggerDestination) {
      const projectId = body.triggerDestination.projectId ?? body.projectId;
      if (!projectId)
        throw new ConnectorError("denied", {
          detail: "vercel.trigger.destination-not-approved",
        });
      requireApprovedDestination(ctx, settings, {
        ...body.triggerDestination,
        projectId,
      });
    }
  }
  if (id === "connect.connectors.update") {
    const body = (input as Inputs["connect.connectors.update"]).body;
    if (body.uid !== undefined)
      requireTarget(
        binding,
        vercelTargetKinds.connector,
        body.uid,
        "vercel.connector.not-permitted",
      );
  }
}

/** Positive allowlist of what a connector record may show outside the adapter. */
export function projectConnector(connector: ConnectConnector) {
  return {
    id: connector.id,
    uid: connector.uid,
    name: connector.name,
    displayName: connector.displayName,
    type: connector.type,
    typeName: connector.typeName,
    service: connector.service,
    supportedSubjectTypes: [...connector.supportedSubjectTypes],
    supportsInstallation: connector.supportsInstallation,
    supportsRevocation: connector.supportsRevocation,
    supportsTriggers: connector.supportsTriggers,
    ...(connector.defaultInstallationId !== undefined
      ? { defaultInstallationId: connector.defaultInstallationId }
      : {}),
    ...(connector.triggers
      ? { triggers: { enabled: connector.triggers.enabled } }
      : {}),
    ...(connector.triggerDestinations
      ? {
          triggerDestinations: connector.triggerDestinations.map((item) => ({
            projectId: item.projectId,
            ...(item.path !== undefined ? { path: item.path } : {}),
            ...(item.branch !== undefined ? { branch: item.branch } : {}),
            ...(item.customEnvironmentId !== undefined
              ? { customEnvironmentId: item.customEnvironmentId }
              : {}),
          })),
        }
      : {}),
    ...(connector.events ? { events: [...connector.events] } : {}),
    ...(connector.connectionMethod !== undefined
      ? { connectionMethod: connector.connectionMethod }
      : {}),
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
  };
}

export function projectConnection(connection: ConnectProjectConnection) {
  return {
    connectorId: connection.connectorId,
    project: {
      id: connection.project.id,
      name: connection.project.name,
      ...(connection.project.customEnvironments
        ? {
            customEnvironments: connection.project.customEnvironments.map(
              (item) => ({ id: item.id, slug: item.slug }),
            ),
          }
        : {}),
    },
    enabledEnvironments: [...connection.enabledEnvironments],
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

type Session = {
  ctx: AdapterCallContext;
  credential: ManagementCredential;
  teamId: string;
};

async function session(
  ctx: AdapterCallContext,
  settings: VercelSettings,
): Promise<Session> {
  const teamId = await configuredTeamId(ctx);
  const credential = await resolveCredential(ctx, "management", settings);
  return { ctx, credential, teamId };
}

/** Project ids linked to a connector, across pages (bounded). */
export async function linkedProjects(
  session: Session,
  connector: string,
): Promise<string[]> {
  const projects: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    let reply;
    try {
      reply = await callVercel(session.ctx, {
        operation: "connect.connectors.projects",
        credential: session.credential,
        teamId: session.teamId,
        params: { connector },
        query: { limit: 100, cursor },
        schema: connectConnectorProjectListSchema,
      });
    } catch (error) {
      // A connector that is already gone links no projects. Reporting that as
      // a lookup failure would make a repeated deletion look like a new one.
      if (
        error instanceof ConnectorError &&
        (error.code === "not-found" || error.code === "expired")
      )
        return projects;
      throw error;
    }
    for (const item of reply.body?.projects ?? [])
      projects.push(item.project.id);
    const next = reply.body?.pagination.next;
    if (!next) break;
    cursor = next;
  }
  return [...new Set(projects)];
}

async function readConnector(
  session: Session,
  connector: string,
): Promise<ConnectConnector | undefined> {
  try {
    const reply = await callVercel(session.ctx, {
      operation: "connect.connectors.get",
      credential: session.credential,
      teamId: session.teamId,
      params: { connector },
      schema: connectConnectorSchema,
    });
    return reply.body;
  } catch (error) {
    if (
      error instanceof ConnectorError &&
      (error.code === "not-found" || error.code === "expired")
    )
      return undefined;
    throw error;
  }
}

async function readProjectLink(
  session: Session,
  connector: string,
  projectId: string,
): Promise<ConnectProjectConnection | undefined> {
  try {
    const reply = await callVercel(session.ctx, {
      operation: "connect.projects.get",
      credential: session.credential,
      teamId: session.teamId,
      params: { connector, projectId },
      schema: connectProjectConnectionSchema,
    });
    return reply.body;
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "not-found")
      return undefined;
    throw error;
  }
}

async function execute(
  session: Session,
  id: VercelManagementOperationId,
  input: Inputs[VercelManagementOperationId],
): Promise<unknown> {
  const { ctx, credential, teamId } = session;
  switch (id) {
    case "connect.connectors.list": {
      const args = input as Inputs["connect.connectors.list"];
      const reply = await callVercel(ctx, {
        operation: id,
        credential,
        teamId,
        query: {
          limit: args.limit,
          cursor: args.cursor,
          projectId: args.projectId,
          search: args.search,
          type: args.type,
          service: args.service,
          sort: args.sort,
        },
        schema: connectConnectorListSchema,
      });
      return {
        connectors: (reply.body?.connectors ?? []).map(projectConnector),
        pagination: { next: reply.body?.pagination.next ?? null },
      };
    }
    case "connect.connectors.get": {
      const args = input as Inputs["connect.connectors.get"];
      const reply = await callVercel(ctx, {
        operation: id,
        credential,
        teamId,
        params: { connector: args.connector },
        schema: connectConnectorSchema,
      });
      return reply.body ? projectConnector(reply.body) : undefined;
    }
    case "connect.connectors.create": {
      const args = input as Inputs["connect.connectors.create"];
      const reply = await callVercel(ctx, {
        operation: id,
        credential,
        teamId,
        body: args.body,
        schema: connectConnectorSchema,
      });
      return reply.body ? projectConnector(reply.body) : undefined;
    }
    case "connect.connectors.update": {
      const args = input as Inputs["connect.connectors.update"];
      const reply = await callVercel(ctx, {
        operation: id,
        credential,
        teamId,
        params: { connector: args.connector },
        body: args.body,
        schema: connectConnectorUpdateResultSchema,
      });
      return reply.body
        ? {
            connector: projectConnector(reply.body.connector),
            ...(reply.body.reconsentNeeded
              ? { reconsentNeeded: { scope: reply.body.reconsentNeeded.scope } }
              : {}),
            ...(reply.body.reinstallNeeded !== undefined
              ? { reinstallNeeded: reply.body.reinstallNeeded }
              : {}),
            ...(reply.body.serviceSync
              ? {
                  serviceSync: {
                    status: reply.body.serviceSync.status,
                    errors: (reply.body.serviceSync.errors ?? []).length,
                  },
                }
              : {}),
          }
        : undefined;
    }
    case "connect.connectors.delete": {
      const args = input as Inputs["connect.connectors.delete"];
      await callVercel(ctx, {
        operation: id,
        credential,
        teamId,
        params: { connector: args.connector },
        schema: z.unknown(),
      });
      return { deleted: true };
    }
    case "connect.projects.link": {
      const args = input as Inputs["connect.projects.link"];
      const reply = await callVercel(ctx, {
        operation: id,
        credential,
        teamId,
        params: { connector: args.connector, projectId: args.projectId },
        body: { environments: args.environments },
        schema: connectProjectConnectionSchema,
      });
      return reply.body ? projectConnection(reply.body) : undefined;
    }
    case "connect.projects.get": {
      const args = input as Inputs["connect.projects.get"];
      const reply = await callVercel(ctx, {
        operation: id,
        credential,
        teamId,
        params: { connector: args.connector, projectId: args.projectId },
        schema: connectProjectConnectionSchema,
      });
      return reply.body ? projectConnection(reply.body) : undefined;
    }
    case "connect.projects.unlink": {
      const args = input as Inputs["connect.projects.unlink"];
      await callVercel(ctx, {
        operation: id,
        credential,
        teamId,
        params: { connector: args.connector, projectId: args.projectId },
        schema: z.unknown(),
      });
      return { unlinked: true };
    }
    case "connect.projects.connectors": {
      const args = input as Inputs["connect.projects.connectors"];
      const reply = await callVercel(ctx, {
        operation: id,
        credential,
        teamId,
        params: { projectId: args.projectId },
        query: { limit: args.limit, cursor: args.cursor },
        schema: connectProjectConnectorListSchema,
      });
      return {
        connectors: (reply.body?.connectors ?? []).map(projectConnection),
        pagination: { next: reply.body?.pagination.next ?? null },
      };
    }
    case "connect.connectors.projects": {
      const args = input as Inputs["connect.connectors.projects"];
      const reply = await callVercel(ctx, {
        operation: id,
        credential,
        teamId,
        params: { connector: args.connector },
        query: { limit: args.limit, cursor: args.cursor },
        schema: connectConnectorProjectListSchema,
      });
      return {
        projects: (reply.body?.projects ?? []).map(projectConnection),
        pagination: { next: reply.body?.pagination.next ?? null },
      };
    }
    case "connect.triggers.destinations.replace": {
      const args = input as Inputs["connect.triggers.destinations.replace"];
      const reply = await callVercel(ctx, {
        operation: id,
        credential,
        teamId,
        params: { connector: args.connector },
        body: { destinations: args.destinations },
        schema: connectConnectorSchema,
      });
      return reply.body ? projectConnector(reply.body) : undefined;
    }
  }
}

/**
 * Set equality, in both directions.
 *
 * Comparing lengths and then checking that `b` is contained in `a` is not set
 * equality: a duplicate in `b` makes the lengths agree while `b` still covers
 * only part of `a`, so `["production","production"]` read as
 * `["production","preview"]`. That is exactly the comparison reconciliation
 * relies on to decide whether the upstream already reflects the intent, and no
 * input here refines away duplicates, so both sides are reduced to sets and
 * the sets are compared.
 */
const sameSet = (a: readonly string[], b: readonly string[]) => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((item) => right.has(item));
};

/**
 * Reconciles an interrupted write by reading current state. `applied` means
 * the upstream already reflects the intent; `absent` means it demonstrably
 * does not and a repeat is safe; `unknown` means neither can be shown.
 */
async function reconcile(
  session: Session,
  id: VercelManagementOperationId,
  input: Inputs[VercelManagementOperationId],
): Promise<"applied" | "absent" | "unknown"> {
  switch (id) {
    case "connect.projects.link": {
      const args = input as Inputs["connect.projects.link"];
      const link = await readProjectLink(
        session,
        args.connector,
        args.projectId,
      );
      return link && sameSet(link.enabledEnvironments, args.environments)
        ? "applied"
        : "absent";
    }
    case "connect.projects.unlink": {
      const args = input as Inputs["connect.projects.unlink"];
      return (await readProjectLink(session, args.connector, args.projectId))
        ? "absent"
        : "applied";
    }
    case "connect.connectors.delete": {
      const args = input as Inputs["connect.connectors.delete"];
      return (await readConnector(session, args.connector))
        ? "absent"
        : "applied";
    }
    case "connect.triggers.destinations.replace": {
      const args = input as Inputs["connect.triggers.destinations.replace"];
      const connector = await readConnector(session, args.connector);
      if (!connector) return "unknown";
      const current = (connector.triggerDestinations ?? []).map((item) =>
        canonicalConnectorJson({
          projectId: item.projectId,
          ...(item.path !== undefined ? { path: item.path } : {}),
          ...(item.branch !== undefined ? { branch: item.branch } : {}),
          ...(item.customEnvironmentId !== undefined
            ? { customEnvironmentId: item.customEnvironmentId }
            : {}),
        }),
      );
      const wanted = args.destinations.map((item) =>
        canonicalConnectorJson(item),
      );
      return sameSet(current, wanted) ? "applied" : "absent";
    }
    default:
      return "unknown";
  }
}

function result(
  bound: BoundOperation,
  state: InvokeResult["state"],
  extra: Partial<Pick<InvokeResult, "output" | "code" | "effectRef">> = {},
): InvokeResult {
  return {
    state,
    outputClassification: bound.outputClassification,
    effect: bound.effect,
    ...(extra.output !== undefined ? { output: extra.output } : {}),
    ...(extra.code !== undefined ? { code: extra.code } : {}),
    ...(extra.effectRef !== undefined ? { effectRef: extra.effectRef } : {}),
  };
}

/** Invokes one bound management operation with full policy, journaling and reconciliation. */
export async function invokeManagement(
  ctx: AdapterCallContext,
  request: InvokeRequest,
  bound: BoundOperation,
  id: VercelManagementOperationId,
  options: ManagementOptions,
): Promise<InvokeResult> {
  assertTransportMatches(bound, id);
  const settings = vercelSettings(ctx.binding);
  const input = parseInput(id, request.input);
  enforceTargets(ctx, id, input, settings);
  const operation = vercelConnectOperationTable[id];
  if (operation.admin) await options.policy(ctx, { id, effect: "write" });
  const live = await session(ctx, settings);

  if (operation.effect === "read")
    return result(bound, "complete", {
      output: await execute(live, id, input),
    });

  // Deleting a connector affects every project linked to it; the deletion
  // proceeds only when the administrator acknowledged exactly that set.
  if (id === "connect.connectors.delete") {
    const args = input as Inputs["connect.connectors.delete"];
    const others = (await linkedProjects(live, args.connector)).filter(
      (projectId) => projectId !== settings.project.id,
    );
    if (others.length && !sameSet(args.acknowledgeSharedWith ?? [], others))
      return result(bound, "human-required", {
        code: "vercel.connector.shared",
        output: { sharedWith: others },
      });
  }

  const digest = effectDigest({
    id,
    teamId: live.teamId,
    input,
    commandId: request.commandId,
  });
  const intent = {
    actor: ctx.actor,
    ...(ctx.connection ? { connectionRef: ctx.connection.connectionRef } : {}),
    bindingRef: ctx.binding.bindingRef,
    operation: vercelOperationRef(id),
    digest,
    commandId: request.commandId,
  };
  let begun = await ctx.environment.effects.begin(intent);
  if (begun.prior) {
    if (begun.prior.status === "applied" || begun.prior.status === "reconciled")
      return result(bound, "complete", {
        code: "vercel.effect.already-applied",
        effectRef: begun.effectRef,
      });
    if (operation.replay !== "reconciliation")
      return result(bound, "indeterminate", {
        code: "vercel.effect.indeterminate",
        effectRef: begun.effectRef,
      });
    const state = await reconcile(live, id, input);
    if (state === "applied") {
      await ctx.environment.effects.complete(begun.effectRef, {
        status: "reconciled",
        at: ctx.environment.now(),
      });
      return result(bound, "complete", {
        code: "vercel.effect.reconciled",
        effectRef: begun.effectRef,
      });
    }
    if (state === "unknown")
      return result(bound, "indeterminate", {
        code: "vercel.effect.indeterminate",
        effectRef: begun.effectRef,
      });
    // Reconciliation proved the earlier attempt absent. Its entry keeps the
    // outcome it has; this attempt is journaled as the next one, so a
    // durable journal records both rather than refusing a second outcome.
    const next = await beginAttempt(
      ctx.environment.effects,
      { ...intent, digest: attemptDigest(digest, 1) },
      { mode: "until-applied", random: ctx.environment.random },
    );
    if (next.prior)
      return next.prior.status === "applied" ||
        next.prior.status === "reconciled"
        ? result(bound, "complete", {
            code: "vercel.effect.already-applied",
            effectRef: next.effectRef,
          })
        : result(bound, "indeterminate", {
            code: "vercel.effect.indeterminate",
            effectRef: next.effectRef,
          });
    begun = next;
  }
  const finish = (outcome: EffectOutcome) =>
    ctx.environment.effects.complete(begun.effectRef, outcome);
  try {
    const output = await execute(live, id, input);
    await finish({ status: "applied", at: ctx.environment.now() });
    return result(bound, "complete", { output, effectRef: begun.effectRef });
  } catch (error) {
    const uncertain =
      !(error instanceof ConnectorError) ||
      ["upstream-unavailable", "indeterminate", "cancelled"].includes(
        error.code,
      );
    await finish({
      status: uncertain ? "indeterminate" : "failed",
      at: ctx.environment.now(),
      ...(error instanceof ConnectorError ? { code: error.code } : {}),
    });
    if (uncertain)
      return result(bound, "indeterminate", {
        code: "vercel.effect.indeterminate",
        effectRef: begun.effectRef,
      });
    throw error;
  }
}

/** Discovery is the connector list, scoped by the configured team and an optional permitted project. */
export async function discoverConnectors(
  ctx: AdapterCallContext,
  input: DiscoverInput,
): Promise<DiscoverResult> {
  const settings = vercelSettings(ctx.binding);
  for (const key of Object.keys(input.scope ?? {}))
    if (key !== "projectId")
      throw new ConnectorError("denied", {
        detail: "vercel.scope.caller-supplied",
      });
  const projectId = input.scope?.["projectId"];
  if (projectId !== undefined)
    requireTarget(
      ctx.binding,
      vercelTargetKinds.project,
      projectId,
      "vercel.project.not-permitted",
    );
  const args = parseInput("connect.connectors.list", {
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(input.query !== undefined ? { search: input.query } : {}),
  });
  const live = await session(ctx, settings);
  const reply = await callVercel(ctx, {
    operation: "connect.connectors.list",
    credential: live.credential,
    teamId: live.teamId,
    query: {
      limit: args.limit,
      cursor: args.cursor,
      projectId: args.projectId,
      search: args.search,
    },
    schema: connectConnectorListSchema,
  });
  const clean = (value: string) => value.replace(/\p{Cc}/gu, " ").slice(0, 200);
  const items: DiscoveredItem[] = (reply.body?.connectors ?? []).map(
    (connector) => ({
      identity: {
        ecosystem: "vercel-connect",
        authorityNamespace: live.teamId,
        nativeId: connector.uid,
        nativeVersion: String(connector.updatedAt),
      },
      displayName: clean(connector.displayName) || connector.uid,
      description: clean(
        `${connector.typeName} connector for ${connector.service}`,
      ),
      provenance: {
        id: connector.id,
        type: connector.type,
        service: connector.service,
        supportsInstallation: String(connector.supportsInstallation),
        supportsTriggers: String(connector.supportsTriggers),
        supportsRevocation: String(connector.supportsRevocation),
        subjectTypes: connector.supportedSubjectTypes.join(","),
        permitted: String(
          permitsTarget(
            ctx.binding,
            vercelTargetKinds.connector,
            connector.uid,
          ) ||
            permitsTarget(
              ctx.binding,
              vercelTargetKinds.connector,
              connector.id,
            ),
        ),
      },
      status: "active",
    }),
  );
  const next = reply.body?.pagination.next;
  return {
    items,
    ...(next ? { nextCursor: next } : {}),
    freshness: {
      fetchedAt: ctx.environment.now(),
      stale: false,
      source: "live",
    },
    issues: [],
  };
}

/**
 * Unlinks the binding's own project from a connector: the Vercel-side
 * counterpart of "disconnect at the broker". Other projects keep their links
 * and are reported so the caller sees what the connector still serves.
 */
export async function unlinkOwnProject(
  ctx: AdapterCallContext,
  connector: string,
  options: ManagementOptions,
): Promise<{ applied: boolean; sharedWith: string[] }> {
  const settings = vercelSettings(ctx.binding);
  requireTarget(
    ctx.binding,
    vercelTargetKinds.connector,
    connector,
    "vercel.connector.not-permitted",
  );
  requireTarget(
    ctx.binding,
    vercelTargetKinds.project,
    settings.project.id,
    "vercel.project.not-permitted",
  );
  await options.policy(ctx, { id: "connect.projects.unlink", effect: "write" });
  const live = await session(ctx, settings);
  const others = (await linkedProjects(live, connector)).filter(
    (projectId) => projectId !== settings.project.id,
  );
  const existing = await readProjectLink(live, connector, settings.project.id);
  if (existing)
    await callVercel(ctx, {
      operation: "connect.projects.unlink",
      credential: live.credential,
      teamId: live.teamId,
      params: { connector, projectId: settings.project.id },
      schema: z.unknown(),
    });
  return { applied: existing !== undefined, sharedWith: others };
}

/**
 * Deletes a connector only when no other project depends on it. A shared
 * connector is reported, not deleted: that removal is an explicit
 * administrative invocation with an acknowledged impact list.
 */
export async function deleteUnsharedConnector(
  ctx: AdapterCallContext,
  connector: string,
  options: ManagementOptions,
): Promise<{ applied: boolean; sharedWith: string[] }> {
  const settings = vercelSettings(ctx.binding);
  requireTarget(
    ctx.binding,
    vercelTargetKinds.connector,
    connector,
    "vercel.connector.not-permitted",
  );
  await options.policy(ctx, {
    id: "connect.connectors.delete",
    effect: "write",
  });
  const live = await session(ctx, settings);
  const others = (await linkedProjects(live, connector)).filter(
    (projectId) => projectId !== settings.project.id,
  );
  if (others.length) return { applied: false, sharedWith: others };
  await callVercel(ctx, {
    operation: "connect.connectors.delete",
    credential: live.credential,
    teamId: live.teamId,
    params: { connector },
    schema: z.unknown(),
  });
  return { applied: true, sharedWith: [] };
}
