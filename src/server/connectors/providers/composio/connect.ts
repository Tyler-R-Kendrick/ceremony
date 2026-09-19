import type {
  AuthorizationIntent,
  AuthorizationStart,
  CompletionInput,
  CompletionResult,
  HandoffProposal,
} from "../../adapter.js";
import type { VerificationClaim } from "../../adapter-types.js";
import { ConnectorError } from "../../errors.js";
import { expectJson } from "./client.js";
import {
  fetchAuthConfigs,
  fetchConnectedAccounts,
  getConnectedAccount,
} from "./catalog.js";
import {
  deploymentOrigin,
  guardConnection,
  type ComposioCall,
} from "./context.js";
import {
  composioAuthConfigIdSchema,
  composioConnectedAccountIdSchema,
  composioLifecycle,
  isExecutableStatus,
} from "./identity.js";
import { permittedAccounts } from "./settings.js";
import {
  composioHostedAuthSchemes,
  createdConnectedAccountSchema,
  type ComposioConnectedAccount,
} from "./wire.js";

/*
 * Authorization, selection, reconnect and verification.
 *
 * Composio hosts the authorization page and keeps the user's provider
 * credential; Ceremony holds a reference and nothing else. Three rules shape
 * everything here:
 *
 *   1. The Composio user is derived from the authenticated host owner, so an
 *      authorization can only ever create an account for the caller.
 *   2. A user may hold several accounts for one toolkit, so an account is
 *      chosen explicitly or not at all. No heuristic picks the "best" or the
 *      newest one, because the newest one may be the most privileged one.
 *   3. A callback is a routing event, never evidence. The account is read back
 *      from Composio before any state changes, and a callback that names an
 *      account other than the one this handoff created is refused.
 */

export const COMPOSIO_PROFILE_ID = "composio-hosted-authorization";

const denied = (detail: string) => new ConnectorError("denied", { detail });

export type AuthorizeMode = "authorize" | "reconnect";

function targetOf(
  intent: AuthorizationIntent,
  kind: string,
): string | undefined {
  return intent.target?.kind === kind ? intent.target.id : undefined;
}

/** The auth config this authorization runs under; never guessed when ambiguous. */
function selectAuthConfig(
  call: ComposioCall,
  intent: AuthorizationIntent,
): string | { human: string } {
  const requested = targetOf(intent, "auth-config");
  if (requested !== undefined) {
    if (!composioAuthConfigIdSchema.safeParse(requested).success)
      throw new ConnectorError("invalid-request", {
        detail: "composio.auth-config.id-invalid",
      });
    // A requested auth config that this binding did not approve is refused;
    // falling back to an approved one would silently change the blueprint the
    // grant is created under.
    if (!call.settings.authConfigs.includes(requested))
      throw denied("composio.auth-config.unapproved");
    return requested;
  }
  const recorded = call.ctx.connection?.externalIds.authConfigId;
  if (recorded && call.settings.authConfigs.includes(recorded)) return recorded;
  if (call.settings.authConfigs.length === 1)
    return call.settings.authConfigs[0]!;
  return { human: "composio.auth-config.selection-required" };
}

/** Exactly the accounts this binding permits, or all of them when it pins none. */
function permitted(call: ComposioCall, accountId: string): boolean {
  const allowed = permittedAccounts(call.ctx.binding);
  return allowed.length === 0 || allowed.includes(accountId);
}

export type AccountChoice =
  | { kind: "account"; account: ComposioConnectedAccount }
  | { kind: "none" }
  | { kind: "ambiguous"; count: number };

/**
 * Which existing connected account this call may use.
 *
 * A connection that already records one names that one and nothing else. A
 * host that named one in the intent gets that one or an error. Otherwise the
 * only automatic answer is the single active permitted account, and only when
 * the binding asked for that policy; several active accounts are ambiguous by
 * definition, and ambiguity is reported, never resolved.
 */
export async function selectAccount(
  call: ComposioCall,
  intent?: AuthorizationIntent,
): Promise<AccountChoice> {
  const recorded = call.ctx.connection?.externalIds.connectedAccountId;
  const requested = intent ? targetOf(intent, "connected-account") : undefined;
  const pinned = requested ?? recorded;
  if (pinned !== undefined) {
    if (!composioConnectedAccountIdSchema.safeParse(pinned).success)
      throw new ConnectorError("invalid-request", {
        detail: "composio.account.id-invalid",
      });
    if (
      recorded !== undefined &&
      requested !== undefined &&
      requested !== recorded
    ) {
      // Switching the account behind an existing connection is an explicit
      // human intent, never a side effect of naming a different target.
      if (!intent?.accountSwitch)
        throw denied("composio.account.switch-required");
    }
    if (!permitted(call, pinned))
      throw denied("composio.account.not-permitted");
    return {
      kind: "account",
      account: await getConnectedAccount(call, pinned),
    };
  }
  const { accounts } = await fetchConnectedAccounts(call);
  const usable = accounts.filter(
    (account) =>
      isExecutableStatus(account.status) && permitted(call, account.id),
  );
  if (usable.length === 0) return { kind: "none" };
  if (usable.length === 1 && call.settings.accountSelection === "single-active")
    return { kind: "account", account: usable[0]! };
  return { kind: "ambiguous", count: usable.length };
}

/**
 * The exact origins a hosted authorization URL may have: the binding's
 * `connect` destination when it names one, plus any origin the deployment
 * configured. Both are optional, so this list can be empty — and an empty list
 * is the absence of an approval, which `checkAuthorizationUrl` treats as one.
 */
function authorizationOrigins(call: ComposioCall): string[] {
  const connect = call.ctx.binding.destinations.find(
    (item) => item.id === "connect",
  );
  return [
    ...(connect ? [connect.origin] : []),
    ...call.options.authorizationOrigins,
  ];
}

/**
 * The hosted authorization URL Composio returned, checked before it is stored.
 * It is protected transient material: it goes into the handoff's private bag
 * and is rendered only to the initiating human, never into a result, a log, a
 * catalog or a model-visible continuation.
 *
 * Composio chooses this URL, so the origin check is the only thing standing
 * between the response and a page a person will sign in on. An empty allowlist
 * therefore refuses: nothing has approved where the initiating human may be
 * sent, and "no approved origin" is not "every origin". This is deliberately
 * the opposite of `permittedAccounts`, where an empty list means the binding
 * pinned no account and the connection's own account decides — there the
 * absence of a pin is a policy the host wrote, here it is a policy nobody
 * wrote.
 */
function checkAuthorizationUrl(call: ComposioCall, value: string): string {
  if (!URL.canParse(value))
    throw new ConnectorError("upstream-rejected", {
      detail: "composio.redirect.invalid",
    });
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
  )
    throw new ConnectorError("upstream-rejected", {
      detail: "composio.redirect.invalid",
    });
  const allowed = authorizationOrigins(call);
  if (!allowed.length)
    throw new ConnectorError("network-policy", {
      detail: "composio.redirect.origin-unapproved",
    });
  if (!allowed.includes(url.origin))
    throw new ConnectorError("network-policy", {
      detail: "composio.redirect.origin",
    });
  return url.toString();
}

function correlation(call: ComposioCall): string {
  return Array.from(call.ctx.environment.random.bytes(18), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** The return route, built from the deployment origin and never from input. */
function callbackUrl(call: ComposioCall, state: string): string {
  const origin = deploymentOrigin(call.ctx.environment.origin);
  const url = new URL(call.options.returnPath, origin);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function composioAuthorize(
  call: ComposioCall,
  intent: AuthorizationIntent,
  mode: AuthorizeMode,
): Promise<AuthorizationStart> {
  if (intent.ownerKind !== "user")
    return { kind: "unsupported", code: "composio.owner.unsupported" };
  const authConfig = selectAuthConfig(call, intent);
  if (typeof authConfig !== "string")
    return { kind: "human-required", code: authConfig.human };

  const choice = await selectAccount(call, intent);
  if (choice.kind === "ambiguous")
    // Several active accounts for one toolkit. The host picks; a heuristic here
    // could hand the agent the account with the widest grant.
    return {
      kind: "human-required",
      code: "composio.account.selection-required",
    };
  if (
    choice.kind === "account" &&
    mode === "authorize" &&
    !intent.accountSwitch
  )
    // Already connected and usable: verification, not a new grant.
    return { kind: "verify" };
  if (intent.interruption === "none")
    // Composio's connection flow is a hosted page a person completes. A policy
    // that forbids interruption blocks it; it does not unlock another route.
    return { kind: "human-required", code: "composio.human.required" };

  // The blueprint decides how the grant is created, so its scheme is read
  // from Composio rather than assumed: an API-key auth config would require
  // submitting the user's credential, which this adapter never does.
  const configs = await fetchAuthConfigs(call);
  const selected = configs.find((config) => config.id === authConfig);
  if (!selected)
    throw new ConnectorError("not-found", {
      detail: "composio.auth-config.absent",
    });
  if (selected.is_disabled === true)
    throw denied("composio.auth-config.disabled");
  const scheme = selected.auth_scheme ?? "";
  if (!composioHostedAuthSchemes.has(scheme))
    return { kind: "unsupported", code: "composio.auth-scheme.not-hosted" };

  const state = correlation(call);

  // A binding that pins the connected accounts it may use approved those exact
  // accounts. A new authorization mints an id that no earlier approval could
  // name, so it is refused rather than quietly creating an unapproved account.
  if (permittedAccounts(call.ctx.binding).length)
    throw denied("composio.account.pin-blocks-new");

  const intentCode =
    mode === "reconnect" ? "composio.reconnect" : "composio.authorize";
  const effect = await call.ctx.environment.effects.begin({
    actor: call.ctx.actor,
    ...(call.ctx.connection
      ? { connectionRef: call.ctx.connection.connectionRef }
      : {}),
    bindingRef: call.ctx.binding.bindingRef,
    operation: "composio.connected-account.create",
    digest: state,
  });
  let created;
  try {
    const response = await call.client.send({
      method: "POST",
      path: call.client.path("/connected_accounts"),
      body: {
        auth_config: { id: authConfig },
        connection: {
          user_id: call.userId,
          callback_url: callbackUrl(call, state),
          // `val` carries per-scheme dynamic fields. This adapter collects no
          // provider credential, so it sends none.
          state: { authScheme: scheme, val: {} },
        },
      },
      timeoutMs: call.options.timeouts.write,
      consequential: true,
    });
    created = expectJson(response, createdConnectedAccountSchema);
  } catch (error) {
    await call.ctx.environment.effects.complete(effect.effectRef, {
      status:
        error instanceof ConnectorError && error.code === "indeterminate"
          ? "indeterminate"
          : "failed",
      at: call.ctx.environment.now(),
    });
    throw error;
  }
  await call.ctx.environment.effects.complete(effect.effectRef, {
    status: "applied",
    at: call.ctx.environment.now(),
  });

  if (!composioConnectedAccountIdSchema.safeParse(created.id).success)
    throw new ConnectorError("upstream-rejected", {
      detail: "composio.account.id-invalid",
    });
  const raw = created.redirect_url ?? created.redirect_uri;
  if (!raw)
    // No hosted URL means no way for the person to authorize. Reporting that
    // is the answer; inventing a provider authorization URL is not.
    return { kind: "human-required", code: "composio.redirect.absent" };

  const handoff: HandoffProposal = {
    kind: "provider-browser",
    presentation: call.settings.presentation ?? "popup",
    expiresAt: call.ctx.environment.now() + call.options.handoffTtlMs,
    intent: intentCode,
    correlationKey: state,
    private: {
      url: checkAuthorizationUrl(call, raw),
      connectedAccountId: created.id,
      authConfigId: authConfig,
      authScheme: scheme,
      toolkitSlug: call.settings.toolkit.slug,
      userId: call.userId,
    },
  };
  return { kind: "handoff", handoff };
}

function claim(
  call: ComposioCall,
  account: ComposioConnectedAccount,
  kind: VerificationClaim["kind"],
  limitations: string[],
): VerificationClaim {
  return {
    kind,
    evidenceRef: `evidence:${call.ctx.environment.random.uuid()}`,
    issuer: "external-broker",
    target: { kind: "connected-account", id: account.id },
    observedAt: new Date(call.ctx.environment.now()).toISOString(),
    verifierVersion: call.adapterVersion,
    bindingRevision: call.ctx.binding.revision,
    policyRevision: call.ctx.binding.policyRevision,
    limitations,
  };
}

const dottedCode = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,11}$/;

/** A sanitized outcome code for a native status; never the raw status text. */
export function statusCode(status: string): string {
  const candidate = `composio.account.${status.toLowerCase().replaceAll("_", "-")}`;
  return dottedCode.test(candidate)
    ? candidate
    : "composio.account.unrecognized";
}

const brokerLimitation =
  "Composio reports this account; the provider account behind it is not observed by Ceremony.";

/** Reads the authoritative account record and turns its status into an outcome. */
export function completionFor(
  call: ComposioCall,
  account: ComposioConnectedAccount,
): CompletionResult {
  const lifecycle = composioLifecycle(account.status);
  const externalIds: Record<string, string> = {
    connectedAccountId: account.id,
    authConfigId: account.auth_config.id,
    toolkitSlug: account.toolkit.slug,
    toolkitVersion: call.settings.toolkit.version,
    userId: call.userId,
    authority: call.authority,
    ...(account.auth_config.auth_scheme
      ? { authScheme: account.auth_config.auth_scheme }
      : {}),
  };
  const adapterState = {
    composioStatus: account.status,
    composioLifecycle: lifecycle,
    toolkitVersion: call.settings.toolkit.version,
    observedAt: call.ctx.environment.now(),
  };
  if (isExecutableStatus(account.status))
    return {
      state: "complete",
      claims: [
        claim(call, account, "account-identity", [brokerLimitation]),
        claim(call, account, "credential-accepted", [
          brokerLimitation,
          "Acceptance is Composio's; no provider call was made to prove the grant.",
        ]),
      ],
      externalIds,
      target: { kind: "connected-account", id: account.id },
      adapterState,
    };
  const state: CompletionResult["state"] =
    account.status === "INITIATED" || account.status === "INITIALIZING"
      ? "pending"
      : account.status === "EXPIRED"
        ? "expired"
        : account.status === "FAILED" ||
            account.status === "REVOKED" ||
            account.status === "DELETED" ||
            account.status === "INACTIVE"
          ? "denied"
          : "indeterminate";
  return {
    state,
    claims: [claim(call, account, "account-identity", [brokerLimitation])],
    externalIds,
    code: statusCode(account.status),
    adapterState,
  };
}

export async function composioComplete(
  call: ComposioCall,
  input: CompletionInput,
): Promise<CompletionResult> {
  const handoff = call.ctx.handoff;
  let accountId: string | undefined =
    call.ctx.connection?.externalIds.connectedAccountId;
  if (input.kind === "redirect") {
    if (!handoff)
      // Without the private correlation there is nothing to continue; the
      // adapter waits rather than trusting the query string it was handed.
      return { state: "pending", claims: [], code: "composio.handoff.absent" };
    if (handoff.generation !== call.ctx.generation)
      throw denied("composio.handoff.stale-generation");
    const state = input.url.searchParams.get("state");
    if (!state || state !== handoff.correlationKey)
      throw denied("composio.callback.correlation");
    const issued = handoff.private.connectedAccountId;
    const named = input.url.searchParams.get("connected_account_id");
    if (named && named !== issued)
      // The callback names another account than the one this handoff created.
      // That is a substitution attempt, not a reconnect.
      throw denied("composio.account.substituted");
    accountId = issued;
  } else if (input.kind === "poll") {
    accountId = handoff?.private.connectedAccountId ?? accountId;
  } else if (input.kind === "input" || input.kind === "event")
    throw new ConnectorError("unsupported", {
      detail: "composio.completion.unsupported",
    });
  if (!accountId)
    throw new ConnectorError("not-found", {
      detail: "composio.account.unknown",
    });
  // The callback's own `status` parameter is never read as evidence: the
  // account is fetched from Composio and that record decides.
  const account = await getConnectedAccount(call, accountId);
  if (!permitted(call, account.id))
    throw denied("composio.account.not-permitted");
  const recorded = call.ctx.connection?.externalIds.connectedAccountId;
  if (recorded && recorded !== account.id)
    throw denied("composio.account.substituted");
  return completionFor(call, account);
}

export async function composioVerify(
  call: ComposioCall,
): Promise<CompletionResult> {
  const connection = guardConnection(call);
  const accountId = connection.externalIds.connectedAccountId;
  if (!accountId) {
    const choice = await selectAccount(call);
    if (choice.kind === "ambiguous")
      return {
        state: "human-required",
        claims: [],
        code: "composio.account.selection-required",
      };
    if (choice.kind === "none")
      return {
        state: "denied",
        claims: [],
        code: "composio.account.absent",
      };
    return completionFor(call, choice.account);
  }
  if (!permitted(call, accountId))
    throw denied("composio.account.not-permitted");
  return completionFor(call, await getConnectedAccount(call, accountId));
}
