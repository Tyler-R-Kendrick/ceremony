import { z } from "zod";
import type { RuntimeBinding } from "../../binding.js";
import { ConnectorError } from "../../errors.js";

/*
 * What this module sends to AWS IAM Identity Center and what it accepts back.
 *
 * Written from the published API references, retrieved 2026-10-12:
 *   - OIDC API Reference: RegisterClient, StartDeviceAuthorization, CreateToken
 *     (https://docs.aws.amazon.com/singlesignon/latest/OIDCAPIReference/)
 *   - Portal API Reference: ListAccounts, ListAccountRoles, GetRoleCredentials,
 *     Logout, and the RoleCredentials / AccountInfo / RoleInfo data types
 *     (https://docs.aws.amazon.com/singlesignon/latest/PortalAPIReference/)
 *   - AWS General Reference, IAM Identity Center endpoints and quotas, for the
 *     `oidc.<region>.amazonaws.com` host.
 *
 * Every claim that is NOT in those pages is named in `AWS_ASSUMPTIONS` below so
 * a reader (and the generated support matrix) can see the difference between
 * what was read and what was inferred. Nothing here has been run against AWS.
 */

export const AWS_IDENTITY_CENTER_ADAPTER_ID = "aws-identity-center";
export const AWS_IDENTITY_CENTER_ADAPTER_VERSION = "1.0.0";
/** The source profile the ledger and the source lock cite. */
export const AWS_IDENTITY_CENTER_PROFILE = "aws-identity-center-device-2026-10";
/** Binding settings key; inert, reviewed, never caller-supplied. */
export const AWS_SETTINGS_KEY = "aws-identity-center";

export const awsDestinationIds = Object.freeze({
  oidc: "oidc",
  portal: "portal",
});
export const awsTargetKinds = Object.freeze({
  account: "aws-account",
  role: "aws-role",
});

/** RFC 8628 grant name and the refresh grant, as CreateToken documents them. */
export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const REFRESH_TOKEN_GRANT = "refresh_token";
/** The registration scope the AWS CLI guide names for refreshable sessions. */
export const DEFAULT_REGISTRATION_SCOPES = Object.freeze([
  "sso:account:access",
]);

export const AWS_REQUEST_TIMEOUT_MS = 15_000;
export const AWS_RESPONSE_LIMIT_BYTES = 1_048_576;
/** Documented portal page size ceiling (`max_result`: 1 to 100). */
export const PORTAL_PAGE_SIZE = 100;
export const MAX_PORTAL_PAGES = 5;
/** Role credentials are renewed when fewer than this many ms remain. */
export const ROLE_CREDENTIAL_RENEW_BUFFER_MS = 300_000;
/** RFC 8628 section 3.5: a slow_down response grows the interval by five seconds. */
export const SLOW_DOWN_INCREMENT_S = 5;
export const MAX_DEVICE_EXPIRY_MS = 3_600_000;
export const SELECTION_TTL_MS = 600_000;

/**
 * Behaviour this module relies on that the published references above do not
 * state. Each is exercised by the loopback double with the value written here;
 * none is confirmed against AWS.
 */
export const AWS_ASSUMPTIONS = Object.freeze([
  "portal.sso.<region>.amazonaws.com is the Portal API host (not on any page read)",
  "RoleCredentials.expiration is epoch milliseconds (the reference says only Long)",
  "clientSecretExpiresAt is epoch seconds, as RFC 7591 defines it (the reference says only Long)",
  "slow_down grows the polling interval by five seconds (RFC 8628 section 3.5; the reference does not say)",
  "a wrong or already-used deviceCode is answered invalid_grant (the reference lists InvalidGrantException without saying when)",
  "a refresh token is issued only when the client registered the refresh_token grant and a scope",
  "a refresh token is single use and CreateToken rotates it on use (the CreateToken page says only that a refreshToken is returned 'if present'); the adapter treats a presented token as spent and never presents it twice, and drops one an answer does not replace",
  "an unassigned role is answered ResourceNotFoundException, HTTP 404",
  "a Portal API call with a lapsed access token is answered UnauthorizedException, HTTP 401",
  "a Portal API call with an access token issued to another client is answered 401; this is the double's own rule and is in tension with the OIDC Welcome page, which says the tokens grant access to all of a person's account entitlements, not a particular application, so it is not a protection the adapter can rely on",
]);

// ---------------------------------------------------------------------------
// Binding settings
// ---------------------------------------------------------------------------

const regionPattern = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;

export const awsSettingsSchema = z.strictObject({
  /** The Region that hosts the IAM Identity Center instance. */
  region: z.string().regex(regionPattern),
  /** The AWS access portal URL, sent only to StartDeviceAuthorization. */
  startUrl: z
    .url()
    .max(512)
    .refine((value) => new URL(value).protocol === "https:", "HTTPS only"),
  /** Friendly name RegisterClient shows to the approving person. */
  clientName: z.string().min(1).max(80).default("Ceremony"),
  /** Registration scopes; refresh tokens need one (see AWS_ASSUMPTIONS). */
  scopes: z
    .array(z.string().min(1).max(200))
    .max(8)
    .default([...DEFAULT_REGISTRATION_SCOPES]),
  requestTimeoutMs: z.number().int().min(100).max(120_000).optional(),
});
export type AwsSettings = z.infer<typeof awsSettingsSchema>;

export function awsSettings(binding: RuntimeBinding): AwsSettings {
  const parsed = awsSettingsSchema.safeParse(
    binding.settings[AWS_SETTINGS_KEY],
  );
  if (!parsed.success)
    throw new ConnectorError("configuration-required", {
      detail: "aws-identity-center.settings.invalid",
    });
  return parsed.data;
}

/** Exact hosts a public-network destination may use for a Region. */
export function expectedHost(
  role: keyof typeof awsDestinationIds,
  region: string,
): string {
  return role === "oidc"
    ? `oidc.${region}.amazonaws.com`
    : `portal.sso.${region}.amazonaws.com`;
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export const accountIdSchema = z.string().regex(/^\d{12}$/);
/** IAM role names: letters, digits and `+=,.@_-`, at most 64 characters. */
export const roleNameSchema = z.string().regex(/^[\w+=,.@-]{1,64}$/);

export function roleTargetId(accountId: string, roleName: string): string {
  return `${accountId}:${roleName}`;
}

export function permitsTarget(
  binding: RuntimeBinding,
  kind: string,
  id: string,
): boolean {
  return binding.permittedTargets.some(
    (target) => target.kind === kind && target.id === id,
  );
}

/** Accounts the binding names; an unlisted account is never reachable. */
export function permittedAccounts(binding: RuntimeBinding): string[] {
  return binding.permittedTargets
    .filter((target) => target.kind === awsTargetKinds.account)
    .map((target) => target.id);
}

/** Role restrictions, when the binding lists any; absent means every role of a permitted account. */
export function permittedRoles(binding: RuntimeBinding): string[] | undefined {
  const roles = binding.permittedTargets
    .filter((target) => target.kind === awsTargetKinds.role)
    .map((target) => target.id);
  return roles.length ? roles : undefined;
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

const nonEmpty = z.string().min(1).max(8192);
const seconds = z.number().int().nonnegative();

export const registerClientResponseSchema = z.object({
  clientId: nonEmpty,
  clientSecret: nonEmpty,
  clientIdIssuedAt: z.number().int().nonnegative().optional(),
  clientSecretExpiresAt: z.number().int().nonnegative(),
});

export const deviceAuthorizationResponseSchema = z.object({
  deviceCode: nonEmpty,
  userCode: z.string().min(1).max(64),
  verificationUri: z.string().min(1).max(2048),
  verificationUriComplete: z.string().min(1).max(2048).optional(),
  expiresIn: seconds,
  interval: seconds.optional(),
});

export const tokenResponseSchema = z.object({
  accessToken: nonEmpty,
  tokenType: z.string().max(32).optional(),
  expiresIn: seconds,
  refreshToken: nonEmpty.optional(),
});

/** The OIDC error body: `{ error, error_description }`, per each operation's Errors section. */
export const oidcErrorSchema = z.object({
  error: z.string().min(1).max(64),
  error_description: z.string().max(2048).optional(),
});

export const accountsResponseSchema = z.object({
  accountList: z
    .array(
      z.object({
        accountId: accountIdSchema,
        accountName: z.string().max(256).optional(),
        emailAddress: z.string().max(254).optional(),
      }),
    )
    .max(PORTAL_PAGE_SIZE),
  nextToken: z.string().min(1).max(2048).nullish(),
});

export const rolesResponseSchema = z.object({
  roleList: z
    .array(
      z.object({
        accountId: accountIdSchema.optional(),
        roleName: roleNameSchema,
      }),
    )
    .max(PORTAL_PAGE_SIZE),
  nextToken: z.string().min(1).max(2048).nullish(),
});

const accessKeyPattern = /^[A-Z0-9]{16,128}$/;
const printable = /^[\x21-\x7e]{1,8192}$/;
export const roleCredentialsResponseSchema = z.object({
  roleCredentials: z.object({
    accessKeyId: z.string().regex(accessKeyPattern),
    secretAccessKey: z.string().regex(printable),
    sessionToken: z.string().regex(printable),
    expiration: z.number().int().positive(),
  }),
});
export type RoleCredentialsWire = z.infer<
  typeof roleCredentialsResponseSchema
>["roleCredentials"];

// ---------------------------------------------------------------------------
// Failure vocabulary
// ---------------------------------------------------------------------------

/**
 * The OIDC `error` codes the references list, each mapped to a fixed detail.
 * Anything else collapses to one code: a provider's words are not ours to
 * repeat, and a made-up code must not become a new detail string.
 */
const oidcErrors: Readonly<Record<string, string>> = Object.freeze({
  access_denied: "access-denied",
  authorization_pending: "authorization-pending",
  expired_token: "expired-token",
  invalid_client: "invalid-client",
  invalid_client_metadata: "invalid-client-metadata",
  invalid_grant: "invalid-grant",
  invalid_redirect_uri: "invalid-redirect-uri",
  invalid_request: "invalid-request",
  invalid_scope: "invalid-scope",
  server_error: "server-error",
  slow_down: "slow-down",
  unauthorized_client: "unauthorized-client",
  unsupported_grant_type: "unsupported-grant-type",
});

export function oidcErrorCode(error: string): string {
  return oidcErrors[error] ?? "rejected";
}

export function oidcDetail(error: string): string {
  return `aws-identity-center.oidc.${oidcErrorCode(error)}`;
}

/** Portal statuses the references document, by name. */
export function portalFailure(status: number): ConnectorError {
  if (status === 401)
    return new ConnectorError("upstream-rejected", {
      detail: "aws-identity-center.portal.unauthorized",
    });
  if (status === 404)
    return new ConnectorError("not-found", {
      detail: "aws-identity-center.portal.not-found",
    });
  if (status === 429)
    return new ConnectorError("rate-limited", {
      detail: "aws-identity-center.portal.throttled",
    });
  if (status === 400)
    return new ConnectorError("invalid-request", {
      detail: "aws-identity-center.portal.invalid-request",
    });
  if (status >= 500)
    return new ConnectorError("upstream-unavailable", {
      detail: "aws-identity-center.portal.unavailable",
    });
  return new ConnectorError("upstream-rejected", {
    detail: "aws-identity-center.portal.rejected",
  });
}

// ---------------------------------------------------------------------------
// Operations a caller may name (read-only; role credentials are never one)
// ---------------------------------------------------------------------------

export const awsPortalOperations = Object.freeze({
  listAccounts: {
    operationRef: "aws-identity-center.list-accounts",
    nativeId: "ListAccounts",
    pathTemplate: "/assignment/accounts",
    summary: "Lists the AWS accounts assigned to the signed-in person.",
  },
  listAccountRoles: {
    operationRef: "aws-identity-center.list-account-roles",
    nativeId: "ListAccountRoles",
    pathTemplate: "/assignment/roles",
    summary: "Lists the roles the signed-in person holds in one account.",
  },
});
export type AwsPortalOperation = keyof typeof awsPortalOperations;
