import type { AuthenticationProfile } from "../../../../core/connectors/index.js";
import type {
  AdapterCallContext,
  AuthorizationIntent,
  AuthorizationStart,
  CompletionInput,
  CompletionResult,
  HandoffProposal,
} from "../../adapter.js";
import {
  AUTHORIZATION_CODE_INTENT,
  beginAuthorizationCode,
  completeAuthorizationCode,
  refreshAccessToken,
} from "../../auth/authorization-code.js";
import {
  acquireClientCredentials,
  CLIENT_CREDENTIALS_GRANT,
  renewClientCredentials,
} from "../../auth/client-credentials.js";
import {
  connectionCredentialScope,
  missingClientConfiguration,
  optionalIssuerPolicy,
  resolveConnectorOAuth,
  type ConnectorOAuth,
  type ConnectorOAuthOptions,
} from "../../auth/connector-oauth.js";
import {
  beginDeviceAuthorization,
  DEVICE_CODE_INTENT,
  pollDeviceAuthorization,
  type DevicePollState,
} from "../../auth/device.js";
import { assertHandoffCurrent } from "../../auth/handoff.js";
import type { IssuerPolicy } from "../../auth/policy.js";
import type { RuntimeBinding } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import { planSettingsOf, type OperationPlan } from "./plan.js";

/*
 * How an imported OpenAPI connection obtains the credential its bound
 * operations present. The description says which schemes exist; the approved
 * binding says which profile this connection uses and, for OAuth, pins the
 * host-written issuer policy that decides where to go. Nothing the document
 * declares -- an authorization URL, a token URL -- is contacted unless a
 * reviewer put it into that policy.
 *
 * - OAuth authorization code (and OpenID Connect): the grant in
 *   `connectors/auth`, a provider-browser handoff completed on the host's
 *   callback route.
 * - OAuth device authorization: a second-device handoff completed by polling.
 * - OAuth client credentials: no person; the grant runs when the connection is
 *   verified, and again whenever the token expires or is refused.
 * - API key, HTTP basic, HTTP bearer: the person types the value into the
 *   command layer's private input route; it goes to custody and nowhere else.
 *
 * Tokens are refreshed once, under the custody port's single-flight lock, when
 * they are expired or when the destination answers 401; see `renewCredential`.
 */

export const PROFILES_SETTINGS_KEY = "openapi-http-profiles";
/** Per-profile issuer policies, keyed by profile id; `settings.oauth` is the binding-wide fallback. */
export const OAUTH_SETTINGS_KEY = "openapi-http-oauth";
export const CREDENTIAL_ENTRY_INTENT = "openapi.credential-entry";
const CREDENTIAL_ENTRY_TTL_MS = 15 * 60 * 1000;

const OAUTH_KINDS = new Set<AuthenticationProfile["kind"]>([
  "oauth-authorization-code",
  "openid-connect",
  "oauth-device",
  "oauth-client-credentials",
]);

/** Values a person enters for each directly-held profile kind, and where custody keeps them. */
const ENTRY_FIELDS: Partial<
  Record<
    AuthenticationProfile["kind"],
    Array<{ field: string; material: (id: string) => string }>
  >
> = {
  "api-key": [{ field: "apiKey", material: (id) => `apiKey:${id}` }],
  "http-basic": [
    { field: "username", material: (id) => `username:${id}` },
    { field: "password", material: (id) => `password:${id}` },
  ],
  "http-bearer": [{ field: "token", material: (id) => `accessToken:${id}` }],
};

const ENTRY_INSTRUCTIONS: Partial<
  Record<AuthenticationProfile["kind"], string>
> = {
  "api-key": "Enter the API key this connection should use.",
  "http-basic": "Enter the username and password this connection should use.",
  "http-bearer": "Enter the bearer token this connection should use.",
};

export function boundProfiles(
  binding: RuntimeBinding,
): AuthenticationProfile[] {
  const profiles = binding.settings[PROFILES_SETTINGS_KEY];
  if (!Array.isArray(profiles)) return [];
  return profiles.filter(
    (item): item is AuthenticationProfile =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as { id?: unknown }).id === "string" &&
      typeof (item as { kind?: unknown }).kind === "string",
  );
}

export function profileFor(
  binding: RuntimeBinding,
  profileId: string,
): AuthenticationProfile | undefined {
  return boundProfiles(binding).find((item) => item.id === profileId);
}

/** The host issuer policy for one profile: its own entry, else the binding-wide one. */
export function oauthPolicyFor(
  binding: RuntimeBinding,
  profileId: string,
): IssuerPolicy | undefined {
  const map = binding.settings[OAUTH_SETTINGS_KEY];
  if (
    map &&
    typeof map === "object" &&
    !Array.isArray(map) &&
    Object.hasOwn(map, profileId)
  )
    return optionalIssuerPolicy((map as Record<string, unknown>)[profileId]);
  return optionalIssuerPolicy(binding.settings["oauth"]);
}

/** Profile ids the bound plans actually present, in first-seen order. */
function requiredProfileIds(binding: RuntimeBinding): string[] {
  const seen = new Set<string>();
  for (const plan of Object.values(planSettingsOf(binding)?.plans ?? {}))
    for (const entry of plan.security.profiles) seen.add(entry.profileId);
  return [...seen];
}

/** Scopes the bound plans require of one profile; what the reviewer approved the connection to need. */
function planScopes(binding: RuntimeBinding, profileId: string): string[] {
  const scopes = new Set<string>();
  for (const plan of Object.values(planSettingsOf(binding)?.plans ?? {}))
    for (const entry of plan.security.profiles)
      if (entry.profileId === profileId)
        for (const scope of entry.scopes) scopes.add(scope);
  return [...scopes];
}

type Selection =
  | { kind: "profile"; profile: AuthenticationProfile }
  | { kind: "anonymous" }
  | { kind: "refused"; code: string };

/**
 * The profile this connection authorizes: the one the connect intent or the
 * binding names, otherwise the single profile the bound plans present. More
 * than one without a choice is refused rather than guessed.
 */
export function selectProfile(
  binding: RuntimeBinding,
  requested: string | undefined | null,
): Selection {
  const id = requested ?? binding.profileId;
  if (id) {
    const profile = profileFor(binding, id);
    return profile
      ? { kind: "profile", profile }
      : { kind: "refused", code: "openapi.profile-not-bound" };
  }
  const required = requiredProfileIds(binding);
  if (required.length === 0) return { kind: "anonymous" };
  if (required.length > 1)
    return { kind: "refused", code: "openapi.profile-ambiguous" };
  const profile = profileFor(binding, required[0]!);
  return profile
    ? { kind: "profile", profile }
    : { kind: "refused", code: "openapi.profile-not-bound" };
}

/** Whether any bound plan needs a credential at all. */
export function credentialRequired(binding: RuntimeBinding): boolean {
  return requiredProfileIds(binding).length > 0;
}

function requestedScopes(
  binding: RuntimeBinding,
  profile: AuthenticationProfile,
  intent: Pick<AuthorizationIntent, "requestedPermissions">,
): string[] {
  const needed = planScopes(binding, profile.id);
  const declared = "scopes" in profile ? profile.scopes : [];
  const scopes = intent.requestedPermissions.length
    ? [...intent.requestedPermissions]
    : needed.length
      ? needed
      : [...declared];
  // A request may narrow what the description declares, never exceed it: a
  // scope nobody reviewed is not one this connection should hold.
  const known = new Set([...declared, ...needed]);
  if (known.size && scopes.some((scope) => !known.has(scope)))
    throw new ConnectorError("invalid-request", {
      detail: "openapi.scope-undeclared",
    });
  if (profile.kind === "openid-connect" && !scopes.includes("openid"))
    scopes.unshift("openid");
  return scopes;
}

const CLIENT_CONFIGURATION_DETAILS = new Set([
  "oauth.client.missing",
  "oauth.client.secret-missing",
  "oauth.client.private-key-missing",
]);

async function resolveOrMissing(
  ctx: AdapterCallContext,
  policy: IssuerPolicy,
  options: ConnectorOAuthOptions,
  extra: Parameters<typeof resolveConnectorOAuth>[3],
): Promise<ConnectorOAuth | { missing: string[] }> {
  try {
    return await resolveConnectorOAuth(ctx, policy, options, extra);
  } catch (error) {
    if (
      error instanceof ConnectorError &&
      error.code === "configuration-required" &&
      CLIENT_CONFIGURATION_DETAILS.has(error.detail ?? "")
    ) {
      const missing = await missingClientConfiguration(ctx, policy);
      if (missing.length) return { missing };
    }
    throw error;
  }
}

function requireHostCustody(ctx: AdapterCallContext): void {
  if (ctx.connection && ctx.connection.custody !== "host-owned")
    throw new ConnectorError("unsupported", {
      detail: "openapi.custody-no-credential",
    });
}

/** Starts whatever the selected profile needs; see the module note for each kind. */
export async function authorizeOpenApi(
  ctx: AdapterCallContext,
  intent: AuthorizationIntent,
  options: ConnectorOAuthOptions,
): Promise<AuthorizationStart> {
  const selected = selectProfile(ctx.binding, intent.profileId);
  if (selected.kind === "refused")
    return { kind: "unsupported", code: selected.code };
  if (selected.kind === "anonymous") return { kind: "verify" };
  const profile = selected.profile;
  if (profile.kind === "none") return { kind: "verify" };
  requireHostCustody(ctx);
  const fields = ENTRY_FIELDS[profile.kind];
  if (fields) {
    if (profile.kind === "api-key" && profile.placement === "cookie")
      return {
        kind: "unsupported",
        code: "openapi.cookie-credential-unsupported",
      };
    const proposal: HandoffProposal = {
      kind: "input-required",
      presentation: "in-app",
      expiresAt: ctx.environment.now() + CREDENTIAL_ENTRY_TTL_MS,
      intent: CREDENTIAL_ENTRY_INTENT,
      private: {
        profileId: profile.id,
        fields: JSON.stringify(fields.map((item) => item.field)),
        instructions: ENTRY_INSTRUCTIONS[profile.kind]!,
      },
    };
    return { kind: "handoff", handoff: proposal };
  }
  if (!OAUTH_KINDS.has(profile.kind))
    return { kind: "unsupported", code: "openapi.profile-not-executable" };
  const policy = oauthPolicyFor(ctx.binding, profile.id);
  if (!policy)
    return { kind: "unsupported", code: "openapi.oauth-policy-missing" };
  const scopes = requestedScopes(ctx.binding, profile, intent);
  if (profile.kind === "oauth-client-credentials") {
    // No person takes part; the grant runs as the verification step, which
    // is where the command layer binds a credential without a handoff.
    const resolved = await resolveOrMissing(ctx, policy, options, {
      grantTypes: [CLIENT_CREDENTIALS_GRANT],
    });
    if ("missing" in resolved)
      return { kind: "configuration-required", missing: resolved.missing };
    return { kind: "verify" };
  }
  if (profile.kind === "oauth-device") {
    const resolved = await resolveOrMissing(ctx, policy, options, {
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code"],
    });
    if ("missing" in resolved)
      return { kind: "configuration-required", missing: resolved.missing };
    return beginDeviceAuthorization(ctx, {
      server: resolved.server,
      client: resolved.client,
      policy,
      scopes,
      profileId: profile.id,
    });
  }
  const resolved = await resolveOrMissing(ctx, policy, options, {
    scope: scopes.join(" "),
    publish: true,
  });
  if ("missing" in resolved)
    return { kind: "configuration-required", missing: resolved.missing };
  return beginAuthorizationCode(ctx, {
    server: resolved.server,
    client: resolved.client,
    policy,
    scopes,
    profileId: profile.id,
  });
}

/** Whether a grant in `connectors/auth` settled the handoff itself for this result. */
function settled(result: CompletionResult): CompletionResult {
  return ["complete", "denied", "expired"].includes(result.state)
    ? { ...result, handoffSettled: true }
    : result;
}

function devicePollState(ctx: AdapterCallContext): DevicePollState | undefined {
  const raw = ctx.connection?.state["devicePoll"];
  if (!raw || typeof raw !== "object") return undefined;
  const { interval, nextPollAt } = raw as Record<string, unknown>;
  if (
    typeof interval !== "number" ||
    typeof nextPollAt !== "number" ||
    !Number.isFinite(interval) ||
    !Number.isFinite(nextPollAt)
  )
    return undefined;
  return { interval, nextPollAt };
}

async function oauthForHandoff(
  ctx: AdapterCallContext,
  options: ConnectorOAuthOptions,
): Promise<ConnectorOAuth> {
  const profileId = ctx.handoff?.private["profileId"];
  const profile = profileId ? profileFor(ctx.binding, profileId) : undefined;
  const policy = profile ? oauthPolicyFor(ctx.binding, profile.id) : undefined;
  if (!profile || !policy)
    throw new ConnectorError("conflict", {
      detail: "openapi.profile-changed",
    });
  return resolveConnectorOAuth(ctx, policy, options);
}

/**
 * Continues an attempt: a provider redirect, a device poll, or the values a
 * person entered privately. Every branch reads the attempt from the handoff
 * record the command layer resolved, never from the input.
 */
export async function completeOpenApi(
  ctx: AdapterCallContext,
  input: CompletionInput,
  options: ConnectorOAuthOptions,
  verifyWith: (ctx: AdapterCallContext) => Promise<CompletionResult>,
): Promise<CompletionResult> {
  const handoff = ctx.handoff;
  if (!handoff)
    return {
      state: "pending",
      claims: [],
      code: "openapi.handoff-unavailable",
    };
  switch (input.kind) {
    case "redirect": {
      if (handoff.intent !== AUTHORIZATION_CODE_INTENT)
        throw new ConnectorError("invalid-request", {
          detail: "oauth.handoff.kind",
        });
      const oauth = await oauthForHandoff(ctx, options);
      return settled(
        await completeAuthorizationCode(ctx, {
          url: input.url,
          handoff,
          server: oauth.server,
          client: oauth.client,
          policy: oauth.policy,
          scope: connectionCredentialScope(ctx),
        }),
      );
    }
    case "poll": {
      if (handoff.intent !== DEVICE_CODE_INTENT)
        return {
          state: "pending",
          claims: [],
          code: "openapi.handoff-waiting",
        };
      const oauth = await oauthForHandoff(ctx, options);
      return settled(
        await pollDeviceAuthorization(ctx, {
          handoff,
          server: oauth.server,
          client: oauth.client,
          policy: oauth.policy,
          poll: devicePollState(ctx),
          scope: connectionCredentialScope(ctx),
        }),
      );
    }
    case "input":
      return completeCredentialEntry(ctx, input.values, verifyWith);
    case "event":
      return {
        state: "denied",
        claims: [],
        code: "openapi.completion-unsupported",
      };
  }
}

async function completeCredentialEntry(
  ctx: AdapterCallContext,
  values: Record<string, string>,
  verifyWith: (ctx: AdapterCallContext) => Promise<CompletionResult>,
): Promise<CompletionResult> {
  const handoff = ctx.handoff!;
  if (handoff.intent !== CREDENTIAL_ENTRY_INTENT)
    throw new ConnectorError("invalid-request", {
      detail: "openapi.handoff-kind",
    });
  if (assertHandoffCurrent(ctx, handoff) === "expired")
    return {
      state: "expired",
      claims: [],
      code: "openapi.credential-entry-expired",
    };
  const profile = profileFor(ctx.binding, handoff.private["profileId"] ?? "");
  const fields = profile ? ENTRY_FIELDS[profile.kind] : undefined;
  if (!profile || !fields)
    throw new ConnectorError("conflict", { detail: "openapi.profile-changed" });
  const expected = new Set(fields.map((item) => item.field));
  if (Object.keys(values).some((name) => !expected.has(name)))
    throw new ConnectorError("invalid-request", {
      detail: "openapi.credential-fields",
    });
  const material: Record<string, string> = {};
  for (const item of fields) {
    const value = values[item.field];
    // A value lands in a header or query parameter; control characters would
    // let it write a second one.
    if (!value || !/^[^\p{Cc}]+$/u.test(value))
      throw new ConnectorError("invalid-request", {
        detail: "openapi.credential-fields",
      });
    material[item.material(profile.id)] = value;
  }
  const scope = connectionCredentialScope(ctx);
  const credentialRef = await ctx.environment.credentials.store(
    scope,
    material,
  );
  const checked = await verifyWith({
    ...ctx,
    connection: { ...ctx.connection!, credentialRef },
  });
  if (checked.state === "complete") return { ...checked, credentialRef };
  if (checked.state === "pending" && checked.code === "openapi.no-verifier")
    // Nothing to check it against: the credential is held, and the
    // connection carries no claim that it works.
    return { state: "complete", claims: [], credentialRef };
  await ctx.environment.credentials
    .revoke(scope, credentialRef)
    .catch(() => {});
  return {
    state: checked.state === "indeterminate" ? "indeterminate" : "denied",
    claims: [],
    code: "openapi.credential-rejected",
  };
}

/**
 * Client credentials: the grant a verification step runs when the connection
 * holds no token yet. Returns undefined when the selected profile is not this
 * grant, so ordinary verification proceeds.
 */
export async function acquireForVerification(
  ctx: AdapterCallContext,
  options: ConnectorOAuthOptions,
): Promise<CompletionResult | undefined> {
  if (!ctx.connection || ctx.connection.credentialRef) return undefined;
  const requested = ctx.connection.state["profileId"];
  const selected = selectProfile(
    ctx.binding,
    typeof requested === "string" ? requested : undefined,
  );
  if (
    selected.kind !== "profile" ||
    selected.profile.kind !== "oauth-client-credentials"
  )
    return undefined;
  requireHostCustody(ctx);
  const policy = oauthPolicyFor(ctx.binding, selected.profile.id);
  if (!policy)
    return {
      state: "denied",
      claims: [],
      code: "openapi.oauth-policy-missing",
    };
  const oauth = await resolveConnectorOAuth(ctx, policy, options, {
    grantTypes: [CLIENT_CREDENTIALS_GRANT],
  });
  return acquireClientCredentials(ctx, {
    server: oauth.server,
    client: oauth.client,
    policy,
    scopes: requestedScopes(ctx.binding, selected.profile, {
      requestedPermissions: [],
    }),
    scope: connectionCredentialScope(ctx),
  });
}

/**
 * One renewal of the connection's token for a plan, when a profile it
 * presents can be renewed: a refresh-token grant for authorization code,
 * OpenID Connect and device profiles, a fresh grant for client credentials.
 * Returns false when nothing here can renew it (no OAuth profile, no policy,
 * a profile that declares no refresh, no refresh token held), so the caller
 * reports the original failure. Refresh failures themselves propagate as
 * sanitized codes.
 */
export async function renewCredential(
  ctx: AdapterCallContext,
  plan: OperationPlan,
  options: ConnectorOAuthOptions,
  stillStale?: (current: Readonly<Record<string, string>>) => boolean,
): Promise<boolean> {
  const credentialRef = ctx.connection?.credentialRef;
  if (!credentialRef) return false;
  for (const entry of plan.security.profiles) {
    const profile = profileFor(ctx.binding, entry.profileId);
    if (!profile || !OAUTH_KINDS.has(profile.kind)) continue;
    if (
      profile.kind === "oauth-authorization-code" &&
      profile.refresh === "unsupported"
    )
      continue;
    const policy = oauthPolicyFor(ctx.binding, profile.id);
    if (!policy) continue;
    const oauth = await resolveConnectorOAuth(ctx, policy, options);
    const scope = connectionCredentialScope(ctx);
    try {
      if (profile.kind === "oauth-client-credentials")
        await renewClientCredentials(ctx, {
          server: oauth.server,
          client: oauth.client,
          policy,
          scopes: [],
          scope,
          credentialRef,
          stillStale,
        });
      else
        await refreshAccessToken(ctx, {
          server: oauth.server,
          client: oauth.client,
          policy,
          credentialRef,
          scope,
          stillStale,
        });
    } catch (error) {
      if (
        error instanceof ConnectorError &&
        (error.detail === "oauth.refresh.no-refresh-token" ||
          error.detail === "oauth.client-credentials.not-this-grant")
      )
        return false;
      throw error;
    }
    return true;
  }
  return false;
}
