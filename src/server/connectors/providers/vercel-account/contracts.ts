import { z } from "zod";
import type { RuntimeBinding } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import type { IssuerPolicyInput } from "../../auth/policy.js";

/*
 * Vercel account sign-in: what is asked of Vercel, and what is believed of
 * its answers.
 *
 * Read from Vercel's published documentation and its public discovery document,
 * retrieved 2026-10-12:
 *   - https://vercel.com/.well-known/openid-configuration advertises
 *     `device_authorization_endpoint`, `registration_endpoint`, a
 *     `urn:ietf:params:oauth:grant-type:device_code` grant, `refresh_token`,
 *     `revocation_endpoint` and the scopes openid, email, profile and
 *     offline_access;
 *   - "New Vercel CLI login flow" (changelog, September 12, 2025) states that
 *     `vercel login` uses the OAuth 2.0 Device Flow;
 *   - Sign in with Vercel documents the authorization-code grant with PKCE
 *     (S256) at /oauth/authorize, an access token (`vca_`) valid for one hour
 *     that "is used to authenticate requests to Vercel's REST API", and a
 *     refresh token (`vcr_`) valid for 30 days, single use and rotated on
 *     exchange, issued with `offline_access`;
 *   - the REST reference for GET /v2/user and GET /v2/teams.
 *
 * What the pages do not say is named in `VERCEL_ACCOUNT_ASSUMPTIONS`; the
 * loopback double serves each of them as written there. Nothing here has been
 * run against Vercel.
 *
 * The other sign-in Vercel documents, authorization code with PKCE ("Sign in
 * with Vercel"), is not a second implementation here: it is the generic
 * authorization-code family (`connectors/auth`), which an OpenAPI or remote
 * MCP binding already runs against any issuer, and a Vercel binding would
 * differ from it only in an issuer policy. Duplicating that family for one
 * provider is the parallel mechanism this adapter avoids, so it is recorded as
 * a documented non-goal (docs/specifications/auth-catalog.md).
 */

export const VERCEL_ACCOUNT_ADAPTER_ID = "vercel-account";
export const VERCEL_ACCOUNT_ADAPTER_VERSION = "1.0.0";
/** The source profile the ledger and the source lock cite. */
export const VERCEL_ACCOUNT_PROFILE = "vercel-account-device-2026-10";
/** Binding settings key; inert, reviewed, never caller-supplied. */
export const VERCEL_ACCOUNT_SETTINGS_KEY = "vercel-account";
export const VERCEL_ISSUER = "https://vercel.com";
export const VERCEL_API_ORIGIN = "https://api.vercel.com";

export const vercelAccountDestinationIds = Object.freeze({ api: "api" });
export const vercelAccountTargetKinds = Object.freeze({
  team: "vercel-team",
  user: "vercel-user",
});
export const vercelAccountConfigurationNames = Object.freeze({
  clientId: "VERCEL_ACCOUNT_CLIENT_ID",
});

export const VERCEL_DEVICE_GRANT =
  "urn:ietf:params:oauth:grant-type:device_code";
export const DEFAULT_SCOPES = Object.freeze(["openid", "offline_access"]);
export const VERCEL_ACCOUNT_REQUEST_TIMEOUT_MS = 15_000;
export const VERCEL_ACCOUNT_RESPONSE_LIMIT_BYTES = 1_048_576;
export const TEAMS_PAGE_SIZE = 100;
export const MAX_TEAM_PAGES = 5;
export const SELECTION_TTL_MS = 600_000;
/** A held access token is refreshed when fewer than this many ms remain. */
export const TOKEN_RENEW_BUFFER_MS = 120_000;

/**
 * Behaviour this module relies on that the published pages do not state. Each
 * is exercised by the loopback double with the value written here; none is
 * confirmed against Vercel.
 */
export const VERCEL_ACCOUNT_ASSUMPTIONS = Object.freeze([
  "the device authorization endpoint answers RFC 8628 section 3.2 members and takes client_id and scope in a form-encoded body (the discovery document advertises the endpoint and the grant; no page describes either)",
  "an application created on the Sign in with Vercel dashboard page may use the device grant; the discovery document lists the grant, and the Manage-from-dashboard page says Sign-In Access is checked when a user completes the device authorization flow, but no page gives the request or response, and `vercel login` may use a client of Vercel's own",
  "a client whose authentication method is `none` is accepted at the device and token endpoints (the dashboard page lists `none` for CLIs; the discovery document's token_endpoint_auth_methods_supported does not list it)",
  "the verification page is vercel.com/oauth/device (the pages give no verification_uri)",
  "the revocation endpoint accepts a `none` client's client_id in place of a secret",
  "the revocation endpoint answers 200 for a token it does not know and ends only the token it is given: it is not known to end an access token when its refresh token is revoked (RFC 7009 says a server SHOULD), so both are presented, the refresh token first",
  "a refresh token rotates on use and a replayed one is invalid_grant (the tokens page says single use and rotated on exchange; the error code is not stated)",
  "a refresh token is issued only when offline_access was requested (the token response example says 'Present if offline_access scope is requested'; nothing says it is issued under no other condition)",
  "an access token obtained through the device grant is accepted by GET /v2/user and GET /v2/teams; whether it is accepted by the Connect management endpoints is unverified, because the permissions page says API permissions are in private beta",
  "GET /v2/teams pages with `until` set to the previous page's pagination.next; `until` is inclusive and next is the last team's createdAt minus one",
  "GET /v2/user and GET /v2/teams answer their full forms to a token that holds only identity scopes (the REST reference documents `limited: true` forms for a token without enough privileges, which the adapter's schemas do not model)",
  "an application the user removed in their dashboard is answered 401 on the REST reads and invalid_grant at refresh",
  "an unknown scope at the device endpoint is answered invalid_scope",
  "an application restricted to a team is refused access_denied at authorization, device approval and refresh (the dashboard page says so; the adapter ends the session when a refresh is refused that way)",
]);

// ---------------------------------------------------------------------------
// Binding settings
// ---------------------------------------------------------------------------

export const vercelAccountSettingsSchema = z.strictObject({
  /** Scopes requested at the device authorization endpoint. */
  scopes: z
    .array(z.string().min(1).max(100))
    .min(1)
    .max(8)
    .default([...DEFAULT_SCOPES]),
  requestTimeoutMs: z.number().int().min(100).max(120_000).optional(),
});
export type VercelAccountSettings = z.infer<typeof vercelAccountSettingsSchema>;

export function vercelAccountSettings(
  binding: RuntimeBinding,
): VercelAccountSettings {
  const parsed = vercelAccountSettingsSchema.safeParse(
    binding.settings[VERCEL_ACCOUNT_SETTINGS_KEY] ?? {},
  );
  if (!parsed.success)
    throw new ConnectorError("configuration-required", {
      detail: "vercel-account.settings.invalid",
    });
  return parsed.data;
}

/**
 * The issuer policy a host pins under `settings.oauth` for the real Vercel:
 * the issuer is vercel.com, whose metadata places the device, token and
 * revocation endpoints on api.vercel.com, so that origin is trusted
 * explicitly and is the only one besides the issuer's own. An origin the
 * issuer's metadata declares for itself is not accepted
 * (`acceptIssuerDeclaredOrigins: false`): with the default, a substituted
 * discovery document could send the device code and the refresh token to any
 * HTTPS origin, and the explicit one would be decorative.
 *
 * The client is pre-registered: an application made on the Sign in with
 * Vercel dashboard page with client authentication `none`, its id in
 * configuration. RFC 7591 registration is not offered, because the generic
 * client resolution only registers a method the issuer's metadata lists, and
 * Vercel's lists no `none`.
 *
 * Revocation is on by default, best effort: a disconnect (local or upstream)
 * presents the refresh token and then the access token to Vercel's revocation
 * endpoint with the client's `client_id`, and a failure of any kind is reported
 * on the disconnect result without stopping the disconnect. `revoke: false`
 * pins it off, which the result then says (`oauth.revoke.disabled`).
 */
export function vercelAccountIssuerPolicy(
  options: { revoke?: boolean } = {},
): IssuerPolicyInput {
  return {
    issuer: VERCEL_ISSUER,
    trustedOrigins: [VERCEL_API_ORIGIN],
    acceptIssuerDeclaredOrigins: false,
    registration: {
      allowed: ["pre-registered"],
      clientIdConfiguration: vercelAccountConfigurationNames.clientId,
      clientAuthentication: "none",
    },
    revocation:
      options.revoke === false ? "disabled" : "on-upstream-disconnect",
  };
}

// ---------------------------------------------------------------------------
// Wire shapes (REST reference: GET /v2/user, GET /v2/teams)
// ---------------------------------------------------------------------------

const identifier = z.string().min(1).max(256);

export const userResponseSchema = z.object({
  user: z.object({
    id: identifier,
    email: z.string().max(320).optional(),
    name: z.string().max(256).nullish(),
    username: z.string().max(256).optional(),
    defaultTeamId: identifier.nullish(),
  }),
});

export const teamsResponseSchema = z.object({
  teams: z
    .array(
      z.object({
        id: identifier,
        slug: z.string().min(1).max(256),
        name: z.string().max(256).nullish(),
      }),
    )
    .max(TEAMS_PAGE_SIZE),
  pagination: z
    .object({
      count: z.number().int().nonnegative().optional(),
      next: z.number().int().nonnegative().nullish(),
      prev: z.number().int().nonnegative().nullish(),
    })
    .optional(),
});

export function apiFailure(status: number): ConnectorError {
  if (status === 401)
    return new ConnectorError("upstream-rejected", {
      detail: "vercel-account.api.unauthorized",
    });
  if (status === 403)
    return new ConnectorError("denied", {
      detail: "vercel-account.api.forbidden",
    });
  if (status === 404)
    return new ConnectorError("not-found", {
      detail: "vercel-account.api.not-found",
    });
  if (status === 429)
    return new ConnectorError("rate-limited", {
      detail: "vercel-account.api.throttled",
    });
  if (status >= 500)
    return new ConnectorError("upstream-unavailable", {
      detail: "vercel-account.api.unavailable",
    });
  return new ConnectorError("upstream-rejected", {
    detail: "vercel-account.api.rejected",
  });
}

export function permittedTeams(binding: RuntimeBinding): string[] {
  return binding.permittedTargets
    .filter((target) => target.kind === vercelAccountTargetKinds.team)
    .map((target) => target.id);
}

export const vercelAccountOperations = Object.freeze({
  getUser: {
    operationRef: "vercel-account.get-user",
    nativeId: "GetUser",
    pathTemplate: "/v2/user",
    summary: "Reads the signed-in Vercel user.",
  },
  listTeams: {
    operationRef: "vercel-account.list-teams",
    nativeId: "ListTeams",
    pathTemplate: "/v2/teams",
    summary:
      "Lists the teams the signed-in user belongs to and the binding permits.",
  },
});
export type VercelAccountOperation = keyof typeof vercelAccountOperations;
