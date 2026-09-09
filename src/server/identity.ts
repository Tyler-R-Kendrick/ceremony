import {
  actorContextSchema,
  type ActorContext,
} from "../core/operation-contracts.js";
export {
  actorContextSchema,
  type ActorContext,
} from "../core/operation-contracts.js";
export type Capability = ActorContext["capabilities"][number];
/** Trusted host integration, never a parser for browser owner/source fields. */
export interface HostIdentityAdapter {
  authenticate(request: Request): Promise<ActorContext | null>;
}
export class AuthorizationError extends Error {
  constructor(
    readonly code:
      "unauthenticated" | "denied" | "invalid_request" | "rate_limited",
  ) {
    super(code);
  }
}
export async function authenticatedActor(
  request: Request,
  identity: HostIdentityAdapter,
): Promise<ActorContext> {
  const actor = await identity.authenticate(request);
  if (!actor) throw new AuthorizationError("unauthenticated");
  return actorContextSchema.parse(actor);
}
export function requireCapability(
  actor: ActorContext,
  capability: Capability,
): void {
  if (
    !actor.capabilities.includes(capability) &&
    !actor.capabilities.includes("admin")
  )
    throw new AuthorizationError("denied");
}
export function requireOwnership(
  actor: ActorContext,
  resource: { tenantId: string; subjectId: string },
): void {
  if (
    actor.tenantId !== resource.tenantId ||
    actor.subjectId !== resource.subjectId
  )
    throw new AuthorizationError("denied");
}
