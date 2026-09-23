import * as oauth from "oauth4webapi";
import type { AdapterCallContext, CompletionResult } from "../adapter.js";
import { ConnectorError } from "../errors.js";
import type { CredentialMaterial, CredentialScope } from "../ports.js";
import type { ResolvedClient } from "./client.js";
import type { ResolvedAuthorizationServer } from "./discovery.js";
import type { IssuerPolicy } from "./policy.js";
import {
  credentialAcceptedClaim,
  permissionRecord,
  resourceParameters,
  scopeEnforcement,
  type PermissionRecord,
} from "./permissions.js";
import {
  joinScope,
  neverSent,
  requestOptions,
  sha256Hex,
  splitScope,
  tokenErrorDetail,
  wireError,
  wireFetch,
  type WireOptions,
} from "./wire.js";

/*
 * Client credentials (RFC 6749 §4.4), built on oauth4webapi like the other
 * grants here. There is no person in this grant: the client authenticates as
 * itself and receives a token for itself, so it is only ever run for a
 * confidential client the host configured (a secret or a private key), never
 * for a public one, and the token it yields names no account.
 *
 * The grant presents no single-use material -- no code, no refresh token -- so
 * running it twice mints two tokens and harms nothing. It is still journaled,
 * once per attempt, so an audit sees every token request that left the
 * process; the journal is not used to refuse a repeat here the way it is for a
 * code or a rotating refresh token. Renewal is a fresh grant under the custody
 * port's single-flight refresh, so concurrent workers mint one token, not one
 * each, and a result computed against an older credential generation cannot
 * overwrite a newer one.
 */

export const CLIENT_CREDENTIALS_GRANT = "client_credentials";
export const OAUTH_CLIENT_CREDENTIALS_OPERATION =
  "oauth.client-credentials.grant";

export type ClientCredentialsInput = {
  server: ResolvedAuthorizationServer;
  client: ResolvedClient;
  policy: Pick<IssuerPolicy, "resource">;
  scopes: readonly string[];
  /** The custody scope the token is stored under; the connection's own. */
  scope: CredentialScope;
  /**
   * Extra token-request parameters a reviewed definition names (an
   * `audience`, say). Host-authored inert values only; a parameter the grant
   * itself owns -- grant type, client authentication, scope, resource -- is
   * never taken from here.
   */
  parameters?: Readonly<Record<string, string>> | undefined;
  /** How this issuer separates scopes; RFC 6749 says a space, some providers use a comma. */
  scopeSeparator?: " " | "," | undefined;
  /**
   * How the token request body is encoded. `form`, the default, is RFC 6749
   * section 4.4.2. `json` sends the very same parameters - built by
   * oauth4webapi exactly as for `form`, client authentication included - as
   * one JSON object under `content-type: application/json`, for a provider
   * whose token endpoint documents only that.
   *
   * A property of the provider, set in its reviewed definition or adapter
   * code. No caller, request or model chooses it: it changes how a client
   * secret travels, which is a review decision, not an option.
   */
  requestEncoding?: "form" | "json" | undefined;
};

export type ClientCredentialsGrant = {
  material: Record<string, string>;
  expiresAt?: number;
  permissions: PermissionRecord;
};

/**
 * The engine's fetch, re-encoding the form body oauth4webapi built as JSON.
 *
 * Only the encoding changes: every parameter, and whatever client
 * authentication put into the body, is carried across one for one. A
 * parameter that appears twice cannot be one JSON member, so the request is
 * refused before anything is sent rather than silently dropping a value.
 */
function jsonBodyFetch(options: WireOptions) {
  const send = wireFetch(options);
  return <M extends string, B>(
    url: string,
    init: oauth.CustomFetchOptions<M, B>,
  ): Promise<Response> => {
    const form = new URLSearchParams(
      init.body instanceof URLSearchParams
        ? init.body
        : String(init.body ?? ""),
    );
    const members: Record<string, string> = {};
    for (const [name, value] of form) {
      if (Object.hasOwn(members, name))
        throw new ConnectorError("configuration-required", {
          detail: "oauth.client-credentials.json-duplicate",
        });
      members[name] = value;
    }
    const headers = new Headers(init.headers as HeadersInit);
    headers.set("content-type", "application/json");
    return send(url, {
      ...init,
      headers: Object.fromEntries(headers) as never,
      body: JSON.stringify(members) as never,
    });
  };
}

/** Parameters the grant sets itself; a definition's extra parameters cannot replace them. */
const RESERVED_PARAMETERS = new Set([
  "grant_type",
  "scope",
  "resource",
  "client_id",
  "client_secret",
  "client_assertion",
  "client_assertion_type",
]);

function scopesOf(value: string | undefined, separator: " " | ","): string[] {
  return separator === ","
    ? splitScope(value?.replace(/,/g, " "))
    : splitScope(value);
}

function assertConfidential(client: ResolvedClient): void {
  // A public client has nothing to authenticate with; a token endpoint that
  // issued one a client-credentials token would be issuing it to anyone.
  if (client.method === "none")
    throw new ConnectorError("configuration-required", {
      detail: "oauth.client-credentials.public-client",
    });
}

/**
 * One client-credentials token request, journaled, returning the material to
 * store and the permissions the issuer reported. `acquireClientCredentials`
 * stores it for a connection; an adapter with its own storage and claims (a
 * data-defined catalog entry, say) may call this directly.
 */
export async function grantClientCredentials(
  ctx: AdapterCallContext,
  input: ClientCredentialsInput,
): Promise<ClientCredentialsGrant> {
  const as = input.server.metadata;
  if (typeof as.token_endpoint !== "string")
    throw new ConnectorError("unsupported", {
      detail: "oauth.token-endpoint.missing",
    });
  assertConfidential(input.client);
  const separator = input.scopeSeparator ?? " ";
  const requested = [...new Set(input.scopes)];
  const scope =
    separator === " " ? joinScope(requested) : requested.join(separator);
  const extra: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.parameters ?? {}))
    if (!RESERVED_PARAMETERS.has(name)) extra[name] = value;
  const clientId = input.client.client.client_id;
  const begun = await ctx.environment.effects.begin({
    actor: ctx.actor,
    connectionRef: input.scope.connectionRef,
    bindingRef: input.scope.bindingRef,
    operation: OAUTH_CLIENT_CREDENTIALS_OPERATION,
    // One entry per attempt: the grant is safe to repeat, so the digest is
    // an audit identity rather than a deduplication key.
    digest: sha256Hex(
      "client-credentials",
      input.server.issuer,
      clientId,
      scope,
      ctx.environment.random.uuid(),
    ),
  });
  const now = () => ctx.environment.now();
  const settle = (
    status: "applied" | "not-applied" | "failed" | "indeterminate",
    code?: string,
  ) =>
    ctx.environment.effects.complete(begun.effectRef, {
      status,
      ...(code ? { code } : {}),
      at: now(),
    });
  let tokens: oauth.TokenEndpointResponse;
  const wire: WireOptions = {
    fetch: ctx.environment.fetch,
    signal: ctx.signal,
    allowLoopbackHttp: input.server.allowLoopbackHttp,
  };
  try {
    const response = await oauth.clientCredentialsGrantRequest(
      as,
      input.client.client,
      input.client.authentication(),
      {
        ...extra,
        ...(scope ? { scope } : {}),
        ...resourceParameters(input.policy.resource),
      },
      input.requestEncoding === "json"
        ? {
            ...requestOptions(wire),
            [oauth.customFetch]: jsonBodyFetch(wire),
          }
        : requestOptions(wire),
    );
    tokens = await oauth.processClientCredentialsResponse(
      as,
      input.client.client,
      response,
    );
  } catch (failure) {
    // Refused by this engine before a byte was sent: nothing to be unsure of.
    if (failure instanceof ConnectorError) {
      await settle("not-applied", failure.detail);
      throw failure;
    }
    if (neverSent(failure)) {
      await settle("not-applied", "oauth.client-credentials.unreachable");
      throw wireError(failure, "oauth.client-credentials");
    }
    if (failure instanceof oauth.ResponseBodyError) {
      await settle("failed", tokenErrorDetail(failure.error));
      throw wireError(failure, "oauth.client-credentials");
    }
    if (
      failure instanceof oauth.OperationProcessingError ||
      failure instanceof oauth.UnsupportedOperationError
    ) {
      await settle("failed", "oauth.client-credentials.invalid-response");
      throw wireError(failure, "oauth.client-credentials");
    }
    // A token may have been minted and lost. Nothing single-use was spent, so
    // this is reported as unknown rather than retried behind the caller.
    await settle("indeterminate", "oauth.client-credentials.indeterminate");
    throw new ConnectorError("indeterminate", {
      detail: "oauth.client-credentials.indeterminate",
      cause: failure,
    });
  }
  await settle("applied");
  const expiresAt =
    typeof tokens.expires_in === "number" && tokens.expires_in > 0
      ? now() + tokens.expires_in * 1000
      : undefined;
  return {
    material: {
      access_token: tokens.access_token,
      token_type: tokens.token_type,
      grant: CLIENT_CREDENTIALS_GRANT,
      ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
      issuer: input.server.issuer,
      client_id: clientId,
      ...(input.policy.resource !== undefined
        ? { resource: input.policy.resource }
        : {}),
      ...(expiresAt !== undefined ? { expires_at: String(expiresAt) } : {}),
    },
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    permissions: permissionRecord({
      requested,
      reported: scopesOf(tokens.scope, separator),
      source: tokens.scope !== undefined ? "token-response" : "none",
    }),
  };
}

/**
 * Runs the grant and stores the token under the connection's custody scope.
 * The result is a completion the command layer applies like any other: a
 * credential reference and a claim that the issuer accepted this client --
 * never an account identity, because there is none.
 */
export async function acquireClientCredentials(
  ctx: AdapterCallContext,
  input: ClientCredentialsInput,
): Promise<CompletionResult> {
  const granted = await grantClientCredentials(ctx, input);
  const credentialRef = await ctx.environment.credentials.store(
    input.scope,
    granted.material,
    granted.expiresAt !== undefined ? { expiresAt: granted.expiresAt } : {},
  );
  return {
    state: "complete",
    claims: [
      credentialAcceptedClaim(ctx, {
        issuer: input.server.issuer,
        permissions: granted.permissions,
        validUntil: granted.expiresAt,
        limitations: [
          "A client-credentials token proves the issuer accepted this client; it names no account.",
        ],
      }),
    ],
    credentialRef,
    adapterState: {
      grant: CLIENT_CREDENTIALS_GRANT,
      ...(granted.expiresAt !== undefined
        ? { expiresAt: granted.expiresAt }
        : {}),
      enforcement: scopeEnforcement(granted.permissions).enforcement,
    },
  };
}

/**
 * Replaces an expired or rejected client-credentials token with a fresh one,
 * in place, under the single-flight lock. The stored token must have come from
 * this issuer and this client; a credential minted for another association is
 * refused rather than silently replaced.
 */
export async function renewClientCredentials(
  ctx: AdapterCallContext,
  input: ClientCredentialsInput & {
    credentialRef: string;
    /** As for `refreshAccessToken`: false keeps a token another worker already renewed. */
    stillStale?: ((current: CredentialMaterial) => boolean) | undefined;
  },
): Promise<{
  credentialRef: string;
  expiresAt?: number;
  /** What the issuer reported, when this call ran the grant (not when another worker had). */
  permissions?: PermissionRecord;
}> {
  assertConfidential(input.client);
  let result: { ref: string; expiresAt?: number };
  let permissions: PermissionRecord | undefined;
  try {
    result = await ctx.environment.credentials.refresh(
      input.scope,
      input.credentialRef,
      async (current: CredentialMaterial) => {
        if (current["grant"] !== CLIENT_CREDENTIALS_GRANT)
          throw new ConnectorError("unsupported", {
            detail: "oauth.client-credentials.not-this-grant",
          });
        if (current["issuer"] !== input.server.issuer)
          throw new ConnectorError("denied", {
            detail: "oauth.refresh.issuer-mismatch",
          });
        if (current["client_id"] !== input.client.client.client_id)
          throw new ConnectorError("denied", {
            detail: "oauth.refresh.client-mismatch",
          });
        if (input.stillStale && !input.stillStale(current)) {
          const held = Number(current["expires_at"]);
          return {
            material: current,
            ...(Number.isSafeInteger(held) && held > 0
              ? { expiresAt: held }
              : {}),
          };
        }
        const granted = await grantClientCredentials(ctx, {
          ...input,
          scopes: input.scopes.length
            ? input.scopes
            : scopesOf(current["scope"], input.scopeSeparator ?? " "),
        });
        permissions = granted.permissions;
        return {
          material: granted.material,
          ...(granted.expiresAt !== undefined
            ? { expiresAt: granted.expiresAt }
            : {}),
        };
      },
    );
  } catch (failure) {
    if (failure instanceof ConnectorError) throw failure;
    throw new ConnectorError("conflict", {
      detail: "oauth.refresh.custody",
      cause: failure,
    });
  }
  return {
    credentialRef: result.ref,
    ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
    ...(permissions ? { permissions } : {}),
  };
}
