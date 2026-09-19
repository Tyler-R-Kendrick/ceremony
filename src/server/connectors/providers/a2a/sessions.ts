import { z } from "zod";
import {
  nativeIdentifierSchema,
  verificationClaimSchema,
  type VerificationClaim,
} from "../../../../core/connectors/index.js";
import type {
  AdapterCallContext,
  AuthorizationIntent,
  AuthorizationStart,
  CompletionInput,
  CompletionResult,
  DisconnectResult,
  DisconnectScope,
} from "../../adapter.js";
import { ConnectorError } from "../../errors.js";
import { credentialScope, requireConnection, resolveA2a } from "./context.js";
import {
  A2A_ADAPTER_VERSION,
  A2A_CONFIGURATION_NAMES,
  A2A_PROTOCOL_VERSIONS,
  A2A_WELL_KNOWN_CARD_PATH,
  detectCardProfile,
  readAgentCard,
} from "./schemas.js";

/*
 * Configuring, verifying and taking apart one A2A connection.
 *
 * There is no human handoff here: an A2A agent is a service this deployment
 * was configured to talk to, not an account a person signs into. What
 * verification establishes is therefore narrow and is recorded narrowly — the
 * agent accepted this deployment's credential, and the card it serves still
 * matches the card that was reviewed. It does not establish who operates the
 * agent, and nothing in this file claims that it does.
 */

export { A2A_ADAPTER_VERSION };

export function authorizeA2a(
  ctx: AdapterCallContext,
  intent: AuthorizationIntent,
): Promise<AuthorizationStart> {
  return (async () => {
    const resolved = resolveA2a(ctx);
    if (intent.ownerKind !== "user" && intent.ownerKind !== "organization")
      return {
        kind: "unsupported" as const,
        code: "a2a.owner.unsupported",
      };
    if (resolved.settings.security.kind === "none")
      return { kind: "verify" as const };
    const name = resolved.settings.security.configurationName;
    const present = await ctx.environment.configuration.present([name]);
    if (!present.has(name))
      return { kind: "configuration-required" as const, missing: [name] };
    return { kind: "verify" as const };
  })();
}

function claim(
  ctx: AdapterCallContext,
  input: Pick<VerificationClaim, "kind" | "issuer" | "target" | "limitations"> &
    Partial<Pick<VerificationClaim, "permissions">>,
): VerificationClaim {
  return verificationClaimSchema.parse({
    kind: input.kind,
    evidenceRef: `evidence:a2a:${ctx.environment.random.uuid()}`,
    issuer: input.issuer,
    target: input.target,
    observedAt: new Date(ctx.environment.now()).toISOString(),
    verifierVersion: A2A_ADAPTER_VERSION,
    bindingRevision: ctx.binding.revision,
    policyRevision: ctx.binding.policyRevision,
    ...(input.permissions ? { permissions: input.permissions } : {}),
    limitations: input.limitations,
  });
}

/**
 * Reads the agent's live card through the approved destination and compares
 * it with what was reviewed. A card that renamed itself, changed protocol
 * version or moved its interface is drift: the connection does not become
 * active on it, because the reviewed binding described a different agent.
 */
export async function verifyA2a(
  ctx: AdapterCallContext,
): Promise<CompletionResult> {
  const resolved = resolveA2a(ctx);
  const connection = requireConnection(ctx);
  const bytes = await resolved.client.fetchCard(A2A_WELL_KNOWN_CARD_PATH);
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return { state: "denied", claims: [], code: "a2a.card.not-json" };
  }
  const profile = detectCardProfile(parsed);
  if (!profile || profile !== resolved.settings.agent.profile)
    return { state: "denied", claims: [], code: "a2a.card.profile-drift" };
  let card;
  try {
    card = readAgentCard(profile, parsed);
  } catch {
    return { state: "denied", claims: [], code: "a2a.card.invalid" };
  }
  if (card.name !== resolved.settings.agent.name)
    return { state: "denied", claims: [], code: "a2a.card.name-drift" };
  const expectedUrl = `${resolved.destination.origin}${resolved.settings.agent.rpcPath}`;
  const matching = card.interfaces.find(
    (entry) =>
      entry.url === expectedUrl &&
      A2A_PROTOCOL_VERSIONS[resolved.settings.agent.profile].includes(
        entry.protocolVersion,
      ),
  );
  if (!matching)
    return { state: "denied", claims: [], code: "a2a.card.interface-drift" };
  const targetId = nativeIdentifierSchema.safeParse(card.name).success
    ? card.name
    : resolved.destination.origin;
  const credentialRef =
    resolved.settings.security.kind === "none"
      ? undefined
      : await (async () => {
          const value = connection.credentialRef
            ? undefined
            : await ctx.environment.configuration.read(
                resolved.settings.security.kind === "none"
                  ? A2A_CONFIGURATION_NAMES.credential
                  : resolved.settings.security.configurationName,
              );
          if (connection.credentialRef) return connection.credentialRef;
          if (!value)
            throw new ConnectorError("configuration-required", {
              detail: "a2a.configuration.credential",
            });
          return ctx.environment.credentials.store(
            credentialScope(ctx, connection),
            { credential: value },
          );
        })();
  const limitations = [
    "An Agent Card is the agent's own statement about itself; serving it proves the endpoint answers, not who operates it.",
    "Card signatures are preserved but not verified: a signature is a signer's claim only under a trust policy this adapter does not hold.",
    card.version === resolved.settings.agent.cardVersion
      ? "Agent version matches the reviewed card."
      : "The agent reports a version other than the reviewed one; skills and behaviour may have changed.",
  ];
  return {
    state: "complete",
    claims: [
      claim(ctx, {
        kind: "credential-accepted",
        issuer: "provider",
        target: { kind: "a2a-agent", id: targetId },
        limitations: [
          "The agent served its card to this deployment's credential; it did not report a scope.",
        ],
        permissions: {
          requested: resolved.settings.approvedSkills.map(
            (skill) => skill.skillId,
          ),
          reported: [],
          observed: [],
          semantics: "operations",
        },
      }),
      claim(ctx, {
        kind: "resource-access",
        issuer: "ceremony-verifier",
        target: { kind: "a2a-agent", id: targetId },
        limitations,
      }),
    ],
    ...(credentialRef ? { credentialRef } : {}),
    externalIds: {
      agentName: card.name,
      agentVersion: card.version,
      protocolVersion: matching.protocolVersion,
      profile,
    },
    target: { kind: "a2a-agent", id: targetId },
    adapterState: {
      skills: card.skills.map((skill) => skill.id).slice(0, 256),
      cardVersion: card.version,
    },
  };
}

export async function completeA2a(
  ctx: AdapterCallContext,
  input: CompletionInput,
): Promise<CompletionResult> {
  // There is no redirect, popup or device flow for a configured agent: the
  // only completion is the verification the authorization already asked for.
  if (input.kind !== "poll")
    return { state: "denied", claims: [], code: "a2a.completion.unsupported" };
  return verifyA2a(ctx);
}

export function reconnectA2a(
  ctx: AdapterCallContext,
  intent: AuthorizationIntent,
): Promise<AuthorizationStart> {
  return authorizeA2a(ctx, intent);
}

/**
 * A2A publishes no operation for ending a relationship with an agent: there
 * is no connection resource, no grant and no revocation endpoint. Local
 * disconnect is therefore the whole of what can be applied, and the two other
 * scopes report the exact native limitation rather than a fabricated success.
 */
export async function disconnectA2a(
  ctx: AdapterCallContext,
  scope: DisconnectScope,
): Promise<DisconnectResult> {
  const connection = requireConnection(ctx);
  await ctx.environment.handoffs.cancelAll(
    connection.connectionRef,
    "a2a.disconnect",
  );
  if (connection.credentialRef)
    await ctx.environment.credentials.revoke(
      credentialScope(ctx, connection),
      connection.credentialRef,
    );
  return {
    local: "applied",
    broker: scope === "broker" ? "unsupported" : "not-attempted",
    upstream: scope === "upstream" ? "unsupported" : "not-attempted",
  };
}

export async function revokeA2a(): Promise<DisconnectResult> {
  return {
    local: "not-attempted",
    broker: "unsupported",
    upstream: "unsupported",
  };
}

export const a2aOwnerKindSchema = z.enum(["user", "organization"]);
