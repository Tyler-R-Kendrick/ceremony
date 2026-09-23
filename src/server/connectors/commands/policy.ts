import type { ActorContext } from "../../../core/operation-contracts.js";
import type {
  NormalizedDefinition,
  OwnerKind,
} from "../../../core/connectors/index.js";
import type { AsyncCeremonyStore } from "../../persistence/index.js";
import type {
  ApprovedDestination,
  BoundOperation,
  RuntimeBinding,
} from "../binding.js";
import type { Clock, ConnectionRecord } from "../ports.js";

/*
 * Host policy is consulted at every effect boundary, not once at the start of
 * a flow: when a human resumes, when a callback arrives, when a token is
 * acquired, when a proxy call is dispatched, when an event continues a flow.
 * The hooks receive the authenticated actor and the server-side record; none
 * of them receives anything a client typed except the parameter it is asked
 * to judge. A hook that throws denies.
 */

export type ConnectorAction =
  | "catalog"
  | "review"
  | "import"
  | "approve"
  | "configure"
  | "connect"
  | "connect-durable"
  | "callback"
  | "poll"
  | "verify"
  | "input"
  | "invoke"
  | "reconnect"
  | "account-switch"
  | "disconnect"
  | "disconnect-broker"
  | "disconnect-upstream"
  | "revoke"
  | "revoke-request"
  | "delete"
  | "event";

export type PolicySubject =
  | { kind: "catalog" }
  | { kind: "import"; adapterId?: string; origin: "upload" | "url" }
  | { kind: "definition"; definition: NormalizedDefinition }
  | { kind: "binding"; binding: RuntimeBinding }
  | {
      kind: "connection";
      connection: ConnectionRecord;
      binding?: RuntimeBinding;
    };

export type DestinationCandidate = {
  /** Exact origin the reviewer named. */
  origin: string;
  /** Whether the definition itself declares this server; a declaration is never approval. */
  declared: boolean;
  definition: NormalizedDefinition;
};

/** An OAuth issuer policy a person is pinning in a binding under review. */
export type IssuerCandidate = {
  /** The issuer identifier, verbatim. */
  issuer: string;
  /** Every origin the policy lets the grants contact: the issuer's, listed trusted origins, configured endpoints. */
  origins: string[];
  /** Origins the definition itself declares for its OAuth profiles; a declaration is never approval. */
  declaredOrigins: string[];
  definition: NormalizedDefinition;
};

type MaybePromise<T> = T | Promise<T>;

export interface ConnectorPolicy {
  /** Host policy revision, recorded on every binding and every claim. */
  readonly revision: string;
  /** Whether this actor may create a connection owned by this kind of principal. */
  allowOwnerKind(
    actor: ActorContext,
    ownerKind: OwnerKind,
    binding: RuntimeBinding,
  ): MaybePromise<boolean>;
  /** Whether this actor may name this target (account, project, repository) under this binding. */
  allowTarget(
    actor: ActorContext,
    target: { kind: string; id: string },
    binding: RuntimeBinding,
  ): MaybePromise<boolean>;
  /** Shared-key mode: a grant other principals will use. A radio button cannot change the grant owner. */
  allowSharedKey(
    actor: ActorContext,
    ownerKind: OwnerKind,
    binding: RuntimeBinding,
  ): MaybePromise<boolean>;
  /** Whether an invocation of this operation needs an explicit human confirmation first. */
  requireConsent(
    actor: ActorContext,
    operation: BoundOperation,
    connection: ConnectionRecord,
  ): MaybePromise<boolean>;
  /** Rechecked at every boundary; a prior approval never carries over. */
  authorize(
    actor: ActorContext,
    subject: PolicySubject,
    action: ConnectorAction,
  ): MaybePromise<boolean>;
  /**
   * Whether an output of this classification may be returned to this actor.
   * `consent` carries what a person approved on the binding; a policy may
   * honour it or be stricter, never looser for secret output.
   */
  allowOutput(
    actor: ActorContext,
    classification: "public" | "personal" | "secret",
    operation: BoundOperation,
    consent?: { agentOutputConsent?: "personal" | undefined },
  ): MaybePromise<boolean>;
  /** Which network class admits a destination a reviewer named, or false. */
  allowDestination(
    actor: ActorContext,
    candidate: DestinationCandidate,
  ): MaybePromise<ApprovedDestination["network"] | false>;
  /**
   * Whether a person may pin this OAuth issuer policy in a binding they
   * review. Only a human reviewer reaches this; absent means no issuer is
   * admitted, so OAuth profiles stay unbound rather than calling a declared
   * endpoint nobody approved.
   */
  allowIssuer?(
    actor: ActorContext,
    candidate: IssuerCandidate,
  ): MaybePromise<boolean>;
}

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLoopbackOrigin(origin: string): boolean {
  if (!URL.canParse(origin)) return false;
  const url = new URL(origin);
  return url.protocol === "http:" && loopbackHosts.has(url.hostname);
}

/**
 * Whether an agent's delegation is still live. Mirrors the teaching runtime:
 * the delegation record under the workload tenant must exist, be unrevoked,
 * be unexpired and name the same tenant, subject and session, and the
 * `budget` record for that delegation must not be stopped. Stopping an
 * assistant therefore prevents new delegated connector work through every
 * transport that consults this policy.
 */
export async function delegationAllows(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  now?: Clock,
): Promise<boolean> {
  if (actor.actorKind !== "agent") return true;
  const delegationId = actor.delegationId;
  if (!delegationId) return false;
  return store.transaction(async (tx) => {
    const delegation = await tx.get<{
      actor: ActorContext;
      runId: string;
      expiresAt: number;
      revoked: boolean;
    }>({ tenant: "workload", kind: "session", id: delegationId });
    const budget = await tx.get<{ stopped: boolean }>({
      tenant: actor.tenantId,
      kind: "budget",
      id: `agent:${delegationId}`,
    });
    const current = now ? now() : await tx.now();
    return Boolean(
      delegation &&
      !delegation.value.revoked &&
      delegation.value.expiresAt > current &&
      delegation.value.runId === delegationId &&
      delegation.value.actor.tenantId === actor.tenantId &&
      delegation.value.actor.subjectId === actor.subjectId &&
      delegation.value.actor.sessionId === actor.sessionId &&
      !budget?.value.stopped,
    );
  });
}

export interface DefaultPolicyOptions {
  /** Shared store holding delegation and budget records; without it every agent action is denied. */
  store?: AsyncCeremonyStore;
  /** Exact HTTPS origins the host pre-approves as destinations, beyond what a reviewer names from declared servers. */
  destinations?: readonly string[];
  /** Admit loopback HTTP destinations as `loopback-fixture`; only for local fixtures, never a deployment default. */
  loopbackFixtures?: boolean;
  /** Exact HTTPS origins the host pre-approves for OAuth issuers and their endpoints, beyond those a definition declares. */
  issuers?: readonly string[];
  revision?: string;
  now?: Clock;
}

/**
 * A conservative default. Humans and the system act under their capabilities;
 * agents act only under a live delegation and only see public output; shared
 * grants need publisher or admin; a write needs confirmation; destinations are
 * public HTTPS origins that a reviewer named explicitly.
 */
export function defaultConnectorPolicy(
  options: DefaultPolicyOptions = {},
): ConnectorPolicy {
  const allowlist = new Set(options.destinations ?? []);
  const issuerAllowlist = new Set(options.issuers ?? []);
  const privileged = (actor: ActorContext) =>
    actor.capabilities.includes("admin") ||
    actor.capabilities.includes("publisher");
  const live = async (actor: ActorContext) => {
    if (actor.actorKind !== "agent") return true;
    if (!options.store) return false;
    return delegationAllows(options.store, actor, options.now);
  };
  return {
    revision: options.revision ?? "policy:default:1",
    allowOwnerKind: (actor, ownerKind) =>
      ownerKind === "user" ? true : privileged(actor),
    allowTarget: () => true,
    allowSharedKey: (actor, ownerKind) =>
      ownerKind === "user" ? true : privileged(actor),
    requireConsent: (_actor, operation) =>
      operation.consent === "confirm" || operation.effect !== "read",
    authorize: (actor) => live(actor),
    allowOutput: (actor, classification, _operation, consent) =>
      actor.actorKind !== "agent" ||
      classification === "public" ||
      (classification === "personal" &&
        consent?.agentOutputConsent === "personal"),
    allowDestination: (_actor, candidate) => {
      if (isLoopbackOrigin(candidate.origin))
        return options.loopbackFixtures ? "loopback-fixture" : false;
      if (!candidate.origin.startsWith("https://")) return false;
      return candidate.declared || allowlist.has(candidate.origin)
        ? "public"
        : false;
    },
    // Same rule as destinations, for every origin the policy may contact:
    // HTTPS and either declared by the definition (the reviewer naming it is
    // the approval) or pre-approved by the host.
    allowIssuer: (actor, candidate) =>
      actor.actorKind === "human" &&
      candidate.origins.length > 0 &&
      candidate.origins.every((origin) =>
        isLoopbackOrigin(origin)
          ? Boolean(options.loopbackFixtures)
          : origin.startsWith("https://") &&
            (candidate.declaredOrigins.includes(origin) ||
              issuerAllowlist.has(origin)),
      ),
  };
}
