import type { ActorContext } from "../../../../core/operation-contracts.js";
import type { OwnerKind } from "../../../../core/connectors/index.js";

/*
 * Token Vault exchanges a token the *host* already holds for the user — an
 * Auth0 refresh token or an Auth0 access token — for an external provider's
 * token. That subject token is the user's identity in this exchange, so it
 * comes from the host's custody through this port and never from an argument.
 * The port hands the adapter a use-callback, the expected subject and, for an
 * access token, the audience it was issued for; the adapter checks those
 * against what the binding approved before the token is sent anywhere.
 */

export const auth0SubjectTokenTypes = [
  "urn:ietf:params:oauth:token-type:refresh_token",
  "urn:ietf:params:oauth:token-type:access_token",
  "urn:ietf:params:oauth:token-type:jwt",
] as const;
export type Auth0SubjectTokenType = (typeof auth0SubjectTokenTypes)[number];

/** A token the host holds; its value is reachable only inside `use`. */
export interface HeldToken {
  use<T>(work: (token: string) => Promise<T>): Promise<T>;
  /** When the host knows it; used to refuse an exchange with a stale token. */
  expiresAt?: number;
}

export type HostSubjectToken = HeldToken & {
  /** The documented `subject_token_type` this token is presented as. */
  tokenType: Auth0SubjectTokenType;
  /** The Auth0 `sub` this token was issued for, as the host recorded it. */
  subject: string;
  /** For an access-token exchange: the Auth0 audience the token was issued for. */
  audience?: string;
};

export interface HostTokenLookup {
  actor: ActorContext;
  tenantId: string;
  ownerKind: OwnerKind;
  ownerId: string;
  connectionRef?: string;
}

export interface HostIdentityTokenPort {
  /** The user's Auth0 refresh or access token, held in host custody. */
  subjectToken(input: HostTokenLookup): Promise<HostSubjectToken | undefined>;
  /**
   * An access token for the My Account API (audience `https://{domain}/me/`)
   * carrying the Connected Accounts scopes. Absent means this deployment
   * cannot list or link accounts, which is reported rather than worked around.
   */
  myAccountToken?(input: HostTokenLookup): Promise<HeldToken | undefined>;
}
