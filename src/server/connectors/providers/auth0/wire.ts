import { z } from "zod";
import { auth0SubjectTokenTypes } from "./ports.js";

/*
 * The Auth0 Token Vault and My Account API wire contract, as documented at
 * https://auth0.com/docs/secure/tokens/token-vault (refresh-token exchange,
 * access-token exchange, privileged worker exchange, connected accounts) and
 * in the My Account API OpenAPI document
 * https://auth0.com/docs/oas/myaccount/myaccount-api-oas.json, retrieved
 * 2026-09-18. Values the adapter *sends* are these constants plus
 * host-approved settings; nothing here is taken from a caller.
 */

export const AUTH0_ADAPTER_ID = "auth0-token-vault";
export const AUTH0_ADAPTER_VERSION = "2026.09.18";
export const AUTH0_DESTINATION_ID = "tenant";
export const AUTH0_TOKEN_PATH = "/oauth/token";
export const AUTH0_JWKS_PATH = "/.well-known/jwks.json";
export const AUTH0_MY_ACCOUNT_BASE = "/me/v1";
export const AUTH0_CONNECT_PATH = `${AUTH0_MY_ACCOUNT_BASE}/connected-accounts/connect`;
export const AUTH0_COMPLETE_PATH = `${AUTH0_MY_ACCOUNT_BASE}/connected-accounts/complete`;
export const AUTH0_ACCOUNTS_PATH = `${AUTH0_MY_ACCOUNT_BASE}/connected-accounts/accounts`;
export const AUTH0_CONNECTIONS_PATH = `${AUTH0_MY_ACCOUNT_BASE}/connected-accounts/connections`;
export const AUTH0_DEFAULT_RETURN_PATH = "/api/v1/connectors/auth0/return";

/** The documented Token Vault grant and token-type URNs. */
export const AUTH0_TOKEN_VAULT_GRANT =
  "urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token";
export const AUTH0_FEDERATED_TOKEN_TYPE =
  "http://auth0.com/oauth/token-type/federated-connection-access-token";
export const AUTH0_PRIVILEGED_TOKEN_TYPE =
  "http://auth0.com/oauth/token-type/token-vault-access-token";

/** Broker action a token-exchange operation names in its binding. */
export const AUTH0_EXCHANGE_ACTION = "auth0.token-vault.exchange";
/** Broker action the linked-account inventory operation names. */
export const AUTH0_INVENTORY_ACTION = "auth0.token-vault.accounts";

export const auth0Profiles = Object.freeze({
  tokenVault: "auth0-token-vault-exchange",
});

/** The My Account API audience for this tenant; the scopes are documented per operation. */
export function myAccountAudience(origin: string): string {
  return `${origin}/me/`;
}
/** Auth0 issuers carry a trailing slash; comparison is exact, not canonicalized for display. */
export function tenantIssuer(origin: string): string {
  return `${origin}/`;
}

const connectionNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/**
 * Host-approved binding settings. `connection` is the upstream connection the
 * exchange is bound to, `subjectTokenTypes` the types this binding accepts,
 * and `expectedAudience` the Auth0 audience an access-token subject must have
 * been issued for. None of them can be influenced by a caller.
 */
export const auth0SettingsSchema = z.strictObject({
  connection: connectionNameSchema,
  /** Which subject-token types this binding permits; an unlisted type is refused. */
  subjectTokenTypes: z
    .array(z.enum(auth0SubjectTokenTypes))
    .min(1)
    .max(3)
    .default(["urn:ietf:params:oauth:token-type:refresh_token"]),
  /** Required for an access-token exchange: the audience the subject token must name. */
  expectedAudience: z.string().min(1).max(512).optional(),
  /** Documented requested token type; the privileged-worker profile uses its own. */
  requestedTokenType: z
    .enum([AUTH0_FEDERATED_TOKEN_TYPE, AUTH0_PRIVILEGED_TOKEN_TYPE])
    .default(AUTH0_FEDERATED_TOKEN_TYPE),
  /** Optional subset of the granted scopes (Auth0 early access `scope` parameter). */
  requestedScopes: z.array(z.string().min(1).max(200)).max(64).default([]),
  /** Scopes the connect flow asks the external provider for. */
  connectScopes: z.array(z.string().min(1).max(255)).max(100).default([]),
  /** Seconds a linked-account observation counts as verification. */
  verificationTtlSeconds: z.number().int().min(60).max(86400).default(3600),
  /** Lease applied when Auth0 returns no `expires_in`. */
  tokenLeaseSeconds: z.number().int().min(60).max(3600).default(300),
  /** Pass the selected account's login hint so a user with several accounts is unambiguous. */
  useLoginHint: z.boolean().default(false),
});
export type Auth0Settings = z.infer<typeof auth0SettingsSchema>;

/** POST /oauth/token, Token Vault success. */
export const auth0ExchangeResponseSchema = z.object({
  access_token: z.string().min(1),
  issued_token_type: z.string().max(200).optional(),
  token_type: z.string().max(64).optional(),
  expires_in: z.number().int().nonnegative().optional(),
  scope: z.string().max(4096).optional(),
});

/** The documented OAuth error body. `error_description` is never echoed to a caller. */
export const auth0ErrorSchema = z.object({
  error: z.string().max(120).optional(),
  error_description: z.string().max(2000).optional(),
});

/** GET /me/v1/connected-accounts/accounts. */
export const auth0ConnectedAccountSchema = z.object({
  id: z.string().min(1).max(200),
  connection: z.string().min(1).max(128),
  access_type: z.string().max(32).optional(),
  scopes: z.array(z.string().max(500)).max(256).optional(),
  created_at: z.string().max(64).optional(),
  expires_at: z.string().max(64).optional(),
  /** Present only for accounts bound to an organization. */
  org_id: z.string().max(200).optional(),
});
export const auth0AccountsResponseSchema = z.object({
  accounts: z.array(auth0ConnectedAccountSchema).max(100),
  next: z.string().max(4096).optional(),
});

/** GET /me/v1/connected-accounts/connections. */
export const auth0ConnectionsResponseSchema = z.object({
  connections: z
    .array(
      z.object({
        name: z.string().min(1).max(128),
        strategy: z.string().max(64).optional(),
        scopes: z.array(z.string().max(500)).max(256).optional(),
      }),
    )
    .max(100),
  next: z.string().max(4096).optional(),
});

/** POST /me/v1/connected-accounts/connect. */
export const auth0ConnectResponseSchema = z.object({
  auth_session: z.string().min(1).max(64),
  connect_uri: z.string().min(1).max(2048),
  connect_params: z.object({ ticket: z.string().min(1).max(200) }),
  expires_in: z.number().int().positive(),
});

/** POST /me/v1/connected-accounts/complete. */
export const auth0CompleteResponseSchema = z.object({
  id: z.string().min(1).max(200),
  connection: z.string().min(1).max(128),
  access_type: z.string().max(32).optional(),
  scopes: z.array(z.string().max(500)).max(256).optional(),
  created_at: z.string().max(64).optional(),
  expires_at: z.string().max(64).optional(),
});

/** JSON Web Key Set, enough for `createLocalJWKSet`. */
export const auth0JwksSchema = z.object({
  keys: z.array(z.record(z.string().max(64), z.unknown())).max(32),
});

/**
 * Documented Auth0 error codes this adapter recognises. Anything else is an
 * upstream rejection with no interpretation attached; a description string is
 * attacker-influencable text and never becomes a Ceremony code.
 */
export const auth0ReconnectErrors = new Set([
  "invalid_grant",
  "login_required",
  "consent_required",
  "interaction_required",
  "unmet_authentication_requirements",
]);
export const auth0DeniedErrors = new Set([
  "invalid_client",
  "unauthorized_client",
  "access_denied",
]);
