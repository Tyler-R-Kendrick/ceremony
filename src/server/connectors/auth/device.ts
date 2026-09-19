import * as oauth from "oauth4webapi";
import { presentationUrlSchema } from "../../../core/connectors/index.js";
import type {
  AdapterCallContext,
  AuthorizationStart,
  CompletionResult,
} from "../adapter.js";
import { ConnectorError } from "../errors.js";
import type { CredentialScope, HandoffRecord } from "../ports.js";
import {
  credentialScopeFor,
  type BeginAuthorizationCodeInput,
} from "./authorization-code.js";
import type { ResolvedClient } from "./client.js";
import type { ResolvedAuthorizationServer } from "./discovery.js";
import { assertHandoffCurrent } from "./handoff.js";
import type { IssuerPolicy } from "./policy.js";
import {
  credentialAcceptedClaim,
  permissionRecord,
  resourceParameters,
  scopeEnforcement,
} from "./permissions.js";
import {
  joinScope,
  neverSent,
  requestOptions,
  sha256Hex,
  splitScope,
  tokenErrorDetail,
  wireError,
} from "./wire.js";

/*
 * Device authorization (RFC 8628). The device code is private material; the
 * initiating human is shown only the verification URI and the user code. The
 * poll interval lives in adapter state rather than in the handoff record
 * because the handoff port is deliberately write-once: `slow_down` grows the
 * interval by five seconds, `authorization_pending` keeps it, `access_denied`
 * and `expired_token` end the handoff with distinct results.
 */

export const DEVICE_CODE_INTENT = "oauth.device-code";
export const OAUTH_DEVICE_EXCHANGE_OPERATION = "oauth.device.exchange";
const MAX_DEVICE_EXPIRY_MS = 3_600_000;
const SLOW_DOWN_INCREMENT_S = 5;

export type BeginDeviceAuthorizationInput = Pick<
  BeginAuthorizationCodeInput,
  "server" | "client" | "scopes" | "profileId"
> & {
  policy: Pick<IssuerPolicy, "resource">;
  presentation?: "second-device" | "same-window" | undefined;
};

export type DevicePollState = {
  /** Seconds between polls, as the issuer set it and `slow_down` grew it. */
  interval: number;
  /** Earliest time (ms) the next poll may be sent. */
  nextPollAt: number;
};

function wireOf(ctx: AdapterCallContext, server: ResolvedAuthorizationServer) {
  return requestOptions({
    fetch: ctx.environment.fetch,
    signal: ctx.signal,
    allowLoopbackHttp: server.allowLoopbackHttp,
  });
}

/** Requests a device code and proposes a second-device handoff; nothing is shown to anyone here. */
export async function beginDeviceAuthorization(
  ctx: AdapterCallContext,
  input: BeginDeviceAuthorizationInput,
): Promise<AuthorizationStart> {
  const as = input.server.metadata;
  if (typeof as.device_authorization_endpoint !== "string")
    return { kind: "unsupported", code: "oauth.device-endpoint.missing" };
  if (typeof as.token_endpoint !== "string")
    return { kind: "unsupported", code: "oauth.token-endpoint.missing" };
  const scope = joinScope([...new Set(input.scopes)]);
  let data: oauth.DeviceAuthorizationResponse;
  try {
    const response = await oauth.deviceAuthorizationRequest(
      as,
      input.client.client,
      input.client.authentication(),
      {
        ...(scope ? { scope } : {}),
        ...resourceParameters(input.policy.resource),
      },
      wireOf(ctx, input.server),
    );
    data = await oauth.processDeviceAuthorizationResponse(
      as,
      input.client.client,
      response,
    );
  } catch (error) {
    throw wireError(error, "oauth.device");
  }
  const verificationUri = presentationUrlSchema.safeParse(
    data.verification_uri,
  );
  if (!verificationUri.success)
    throw new ConnectorError("upstream-rejected", {
      detail: "oauth.device.verification-uri",
    });
  const complete =
    data.verification_uri_complete !== undefined
      ? presentationUrlSchema.safeParse(data.verification_uri_complete)
      : undefined;
  const interval = Math.max(1, Math.floor(data.interval ?? 5));
  const now = ctx.environment.now();
  const expiresAt =
    now + Math.min(Math.max(1, data.expires_in) * 1000, MAX_DEVICE_EXPIRY_MS);
  return {
    kind: "handoff",
    handoff: {
      kind: "device-code",
      presentation: input.presentation ?? "second-device",
      expiresAt,
      intent: DEVICE_CODE_INTENT,
      private: {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: verificationUri.data,
        ...(complete?.success
          ? { verificationUriComplete: complete.data }
          : {}),
        interval: String(interval),
        issuer: input.server.issuer,
        clientId: input.client.client.client_id,
        scope,
        ...(input.policy.resource !== undefined
          ? { resource: input.policy.resource }
          : {}),
        ...(input.profileId !== undefined
          ? { profileId: input.profileId }
          : {}),
      },
    },
  };
}

export type PollDeviceAuthorizationInput = {
  handoff: HandoffRecord;
  server: ResolvedAuthorizationServer;
  client: ResolvedClient;
  policy: Pick<IssuerPolicy, "resource">;
  /** The poll state persisted from the previous result; absent on the first poll. */
  poll?: DevicePollState | undefined;
  scope?: CredentialScope | undefined;
};

function pending(code: string, poll: DevicePollState): CompletionResult {
  return {
    state: "pending",
    claims: [],
    code,
    adapterState: { devicePoll: poll },
  };
}

/**
 * One poll of the token endpoint for a device handoff. Returns `pending` with
 * the next allowed poll time (respecting `slow_down`), `complete` once the
 * person approved, `denied` on `access_denied`, `expired` on `expired_token`
 * or handoff expiry, and `indeterminate` when a response was lost.
 */
export async function pollDeviceAuthorization(
  ctx: AdapterCallContext,
  input: PollDeviceAuthorizationInput,
): Promise<CompletionResult> {
  const { handoff } = input;
  if (handoff.kind !== "device-code" || handoff.intent !== DEVICE_CODE_INTENT)
    throw new ConnectorError("invalid-request", {
      detail: "oauth.handoff.kind",
    });
  const complete = async (state: "completed" | "denied" | "expired") => {
    try {
      await ctx.environment.handoffs.complete(
        handoff.handoffRef,
        ctx.generation,
        state,
      );
    } catch (error) {
      throw new ConnectorError("conflict", {
        detail: "oauth.handoff.stale-generation",
        cause: error,
      });
    }
  };
  if (assertHandoffCurrent(ctx, handoff) === "expired") {
    await complete("expired");
    return { state: "expired", claims: [], code: "oauth.device.expired" };
  }
  const deviceCode = handoff.private["deviceCode"];
  const issuer = handoff.private["issuer"];
  const clientId = handoff.private["clientId"];
  if (!deviceCode || !issuer || !clientId)
    throw new ConnectorError("invalid-request", {
      detail: "oauth.handoff.private-missing",
    });
  if (
    issuer !== input.server.issuer ||
    clientId !== input.client.client.client_id
  )
    throw new ConnectorError("denied", {
      detail: "oauth.device.binding-mismatch",
    });
  const now = ctx.environment.now();
  const baseInterval = Math.max(
    1,
    Math.floor(Number(handoff.private["interval"]) || 5),
  );
  const poll: DevicePollState = input.poll ?? {
    interval: baseInterval,
    nextPollAt: 0,
  };
  if (now < poll.nextPollAt) return pending("oauth.device.wait", poll);
  const scope = input.scope ?? credentialScopeFor(ctx, handoff);
  const begun = await ctx.environment.effects.begin({
    actor: ctx.actor,
    connectionRef: scope.connectionRef,
    bindingRef: scope.bindingRef,
    operation: OAUTH_DEVICE_EXCHANGE_OPERATION,
    digest: sha256Hex("device", issuer, clientId, deviceCode),
  });
  if (begun.prior?.status === "applied")
    throw new ConnectorError("conflict", {
      detail: "oauth.device.already-exchanged",
    });
  const as = input.server.metadata;
  const at = () => ctx.environment.now();
  const settle = (
    status: "applied" | "not-applied" | "failed" | "indeterminate",
    code: string,
  ) =>
    ctx.environment.effects.complete(begun.effectRef, {
      status,
      code,
      at: at(),
    });
  let tokens: oauth.TokenEndpointResponse;
  try {
    const response = await oauth.deviceCodeGrantRequest(
      as,
      input.client.client,
      input.client.authentication(),
      deviceCode,
      {
        ...wireOf(ctx, input.server),
        additionalParameters: resourceParameters(
          handoff.private["resource"] ?? input.policy.resource,
        ),
      },
    );
    tokens = await oauth.processDeviceCodeResponse(
      as,
      input.client.client,
      response,
    );
  } catch (error) {
    if (error instanceof oauth.ResponseBodyError) {
      const code = tokenErrorDetail(error.error);
      switch (error.error) {
        case "authorization_pending":
          await settle("not-applied", code);
          return pending("oauth.device.pending", {
            interval: poll.interval,
            nextPollAt: now + poll.interval * 1000,
          });
        case "slow_down": {
          const interval = poll.interval + SLOW_DOWN_INCREMENT_S;
          await settle("not-applied", code);
          return pending("oauth.device.slow-down", {
            interval,
            nextPollAt: now + interval * 1000,
          });
        }
        case "access_denied":
          await settle("failed", code);
          await complete("denied");
          return {
            state: "denied",
            claims: [],
            code: "oauth.device.access-denied",
          };
        case "expired_token":
          await settle("failed", code);
          await complete("expired");
          return { state: "expired", claims: [], code: "oauth.device.expired" };
        default:
          await settle("failed", code);
          await complete("denied");
          throw wireError(error, "oauth.device");
      }
    }
    if (neverSent(error)) {
      await settle("not-applied", "oauth.device.unreachable");
      throw wireError(error, "oauth.device");
    }
    await settle("indeterminate", "oauth.device.indeterminate");
    return {
      state: "indeterminate",
      claims: [],
      code: "oauth.device.indeterminate",
      adapterState: {
        devicePoll: {
          interval: poll.interval,
          nextPollAt: now + poll.interval * 1000,
        },
      },
    };
  }
  await complete("completed");
  const expiresAt =
    typeof tokens.expires_in === "number" && tokens.expires_in > 0
      ? at() + tokens.expires_in * 1000
      : undefined;
  const resource = handoff.private["resource"] ?? input.policy.resource;
  const credentialRef = await ctx.environment.credentials.store(
    scope,
    {
      access_token: tokens.access_token,
      token_type: tokens.token_type,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
      issuer,
      client_id: clientId,
      ...(resource !== undefined ? { resource } : {}),
      ...(expiresAt !== undefined ? { expires_at: String(expiresAt) } : {}),
    },
    expiresAt !== undefined ? { expiresAt } : {},
  );
  await settle("applied", "oauth.device.exchanged");
  const permissions = permissionRecord({
    requested: splitScope(handoff.private["scope"]),
    reported: splitScope(tokens.scope),
    source: tokens.scope !== undefined ? "token-response" : "none",
  });
  return {
    state: "complete",
    claims: [
      credentialAcceptedClaim(ctx, {
        issuer,
        permissions,
        validUntil: expiresAt,
      }),
    ],
    credentialRef,
    adapterState: {
      tokenType: tokens.token_type,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      enforcement: scopeEnforcement(permissions).enforcement,
    },
  };
}
