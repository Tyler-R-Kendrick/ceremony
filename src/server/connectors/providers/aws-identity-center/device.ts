import { presentationUrlSchema } from "../../../../core/connectors/index.js";
import type {
  AdapterCallContext,
  AuthorizationIntent,
  AuthorizationStart,
  CompletionResult,
} from "../../adapter.js";
import {
  assertHandoffCurrent,
  DEVICE_CODE_INTENT,
  type DevicePollState,
} from "../../auth/index.js";
import { sha256Hex } from "../../auth/wire.js";
import { ConnectorError } from "../../errors.js";
import { awsDestination, callAws, oidcFailure, sentNothing } from "./client.js";
import {
  AWS_IDENTITY_CENTER_ADAPTER_ID,
  awsSettings,
  DEVICE_CODE_GRANT,
  MAX_DEVICE_EXPIRY_MS,
  permittedAccounts,
  REFRESH_TOKEN_GRANT,
  registerClientResponseSchema,
  deviceAuthorizationResponseSchema,
  tokenResponseSchema,
  type AwsSettings,
} from "./contracts.js";
import {
  rotateSession,
  serializeMaterial,
  sessionScope,
  signedIn,
  type SessionMaterial,
} from "./material.js";
import {
  devicePollState,
  discardRegistration,
  indeterminate,
  pending,
  PollEnded,
  Refusal,
  refused,
  settleHandoff,
} from "./device-poll.js";
import { continueAfterSignIn } from "./selection.js";

/*
 * The device authorization ceremony against the IAM Identity Center OIDC
 * service: RegisterClient, StartDeviceAuthorization, then CreateToken polled
 * with the device-code grant. The shapes are the OIDC API Reference's, which
 * is JSON with camelCase members rather than RFC 8628's form encoding, and the
 * handoff is the same `device-code` handoff every other device grant here
 * issues, so the person sees the same link and code and nothing else.
 */

/** Digest slot for one poll of one device code; see `OAUTH_DEVICE_EXCHANGE_OPERATION`. */
export const AWS_DEVICE_EXCHANGE_OPERATION =
  "aws-identity-center.device.exchange";
const MIN_REGISTRATION_LIFETIME_MS = 900_000;
const REGISTRATION_GRACE_MS = 60_000;

const code = (suffix: string) => `${AWS_IDENTITY_CENTER_ADAPTER_ID}.${suffix}`;

type Registration = {
  clientId: string;
  clientSecret: string;
  /** Epoch milliseconds. */
  expiresAt: number;
};

async function registerClient(
  ctx: AdapterCallContext,
  settings: AwsSettings,
): Promise<Registration> {
  const reply = await callAws(ctx, {
    role: "oidc",
    method: "POST",
    path: "/client/register",
    body: {
      clientName: settings.clientName,
      clientType: "public",
      grantTypes: [DEVICE_CODE_GRANT, REFRESH_TOKEN_GRANT],
      scopes: settings.scopes,
    },
    schema: registerClientResponseSchema,
  });
  if (!reply.ok) throw oidcFailure(reply);
  const expiresAt = reply.body.clientSecretExpiresAt * 1000;
  if (expiresAt < ctx.environment.now() + MIN_REGISTRATION_LIFETIME_MS)
    throw new ConnectorError("upstream-rejected", {
      detail: code("registration.expired"),
    });
  return {
    clientId: reply.body.clientId,
    clientSecret: reply.body.clientSecret,
    expiresAt,
  };
}

export async function beginSignIn(
  ctx: AdapterCallContext,
  intent: Pick<AuthorizationIntent, "ownerKind">,
): Promise<AuthorizationStart> {
  const settings = awsSettings(ctx.binding);
  if (intent.ownerKind !== "user")
    return { kind: "unsupported", code: code("owner-kind") };
  // A binding that names no account lets nobody pick one; refuse up front
  // rather than after a person has approved a sign-in for nothing.
  if (!permittedAccounts(ctx.binding).length)
    return { kind: "unsupported", code: code("targets-missing") };
  awsDestination(ctx, "oidc");
  awsDestination(ctx, "portal");
  const registration = await registerClient(ctx, settings);
  const reply = await callAws(ctx, {
    role: "oidc",
    method: "POST",
    path: "/device_authorization",
    body: {
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      startUrl: settings.startUrl,
    },
    schema: deviceAuthorizationResponseSchema,
  });
  if (!reply.ok) throw oidcFailure(reply);
  const device = reply.body;
  const verificationUri = presentationUrlSchema.safeParse(
    device.verificationUri,
  );
  const complete =
    device.verificationUriComplete !== undefined
      ? presentationUrlSchema.safeParse(device.verificationUriComplete)
      : undefined;
  if (!verificationUri.success)
    throw new ConnectorError("upstream-rejected", {
      detail: code("device.verification-uri"),
    });
  const now = ctx.environment.now();
  const expiresAt =
    now + Math.min(Math.max(1, device.expiresIn) * 1000, MAX_DEVICE_EXPIRY_MS);
  const interval = Math.max(1, Math.floor(device.interval ?? 5));
  const material: SessionMaterial = {
    phase: "registered",
    clientId: registration.clientId,
    clientSecret: registration.clientSecret,
    clientSecretExpiresAt: registration.expiresAt,
  };
  const registrationRef = await ctx.environment.credentials.store(
    sessionScope(ctx),
    serializeMaterial(material),
    {
      expiresAt: Math.min(
        registration.expiresAt,
        expiresAt + REGISTRATION_GRACE_MS,
      ),
    },
  );
  return {
    kind: "handoff",
    handoff: {
      kind: "device-code",
      presentation: "second-device",
      expiresAt,
      intent: DEVICE_CODE_INTENT,
      private: {
        deviceCode: device.deviceCode,
        userCode: device.userCode,
        verificationUri: verificationUri.data,
        ...(complete?.success
          ? { verificationUriComplete: complete.data }
          : {}),
        interval: String(interval),
        registrationRef,
        region: settings.region,
      },
    },
  };
}

type PollContext = {
  deviceCode: string;
  registrationRef: string;
  poll: DevicePollState;
  now: number;
};

function pollContext(ctx: AdapterCallContext): PollContext {
  const handoff = ctx.handoff!;
  const deviceCode = handoff.private["deviceCode"];
  const registrationRef = handoff.private["registrationRef"];
  if (!deviceCode || !registrationRef)
    throw new ConnectorError("invalid-request", {
      detail: "oauth.handoff.private-missing",
    });
  const base = Math.max(
    1,
    Math.floor(Number(handoff.private["interval"]) || 5),
  );
  // The first poll is not held back: the interval spaces polls that follow one
  // another (RFC 8628 §3.5; CreateToken says "the number of seconds the client
  // must wait between attempts"), and an early first poll costs one request
  // that is answered authorization_pending. The shared device-grant family
  // starts the same way; every later poll waits `interval` from the last.
  return {
    deviceCode,
    registrationRef,
    poll: devicePollState(ctx) ?? { interval: base, nextPollAt: 0 },
    now: ctx.environment.now(),
  };
}

/**
 * One poll. Returns `pending` with the next allowed poll time (honouring
 * `slow_down`), the selection step once the person approved, `denied` on
 * `access_denied`, `expired` on `expired_token` or the handoff's own expiry,
 * and `indeterminate` when a response was lost. The device code is journaled
 * per poll slot before it is sent, so a repeat is answered from the journal.
 */
export async function pollSignIn(
  ctx: AdapterCallContext,
): Promise<CompletionResult> {
  const handoff = ctx.handoff;
  if (
    !handoff ||
    handoff.kind !== "device-code" ||
    handoff.intent !== DEVICE_CODE_INTENT
  )
    throw new ConnectorError("invalid-request", {
      detail: "oauth.handoff.kind",
    });
  if (assertHandoffCurrent(ctx, handoff) === "expired") {
    await settleHandoff(ctx, "expired", { bestEffort: true });
    await discardRegistration(ctx, handoff.private["registrationRef"]);
    return {
      state: "expired",
      claims: [],
      code: code("device.expired"),
      handoffSettled: true,
    };
  }
  const { deviceCode, registrationRef, poll, now } = pollContext(ctx);
  if (now < poll.nextPollAt) return pending("device.wait", poll);
  const scope = sessionScope(ctx);
  const begun = await ctx.environment.effects.begin({
    actor: ctx.actor,
    connectionRef: scope.connectionRef,
    bindingRef: scope.bindingRef,
    operation: AWS_DEVICE_EXCHANGE_OPERATION,
    digest: sha256Hex(
      "aws-device",
      registrationRef,
      deviceCode,
      String(poll.nextPollAt),
    ),
  });
  if (begun.prior?.status === "applied")
    throw new ConnectorError("conflict", {
      detail: code("device.already-exchanged"),
    });
  if (begun.prior)
    return pending("device.wait", {
      interval: poll.interval,
      nextPollAt: Math.max(poll.nextPollAt, now) + poll.interval * 1000,
    });
  const settle = (
    status: "applied" | "not-applied" | "failed" | "indeterminate",
    outcome: string,
  ) =>
    ctx.environment.effects.complete(begun.effectRef, {
      status,
      code: outcome,
      at: ctx.environment.now(),
    });
  let sent = false;
  try {
    await rotateSession(ctx, registrationRef, async (current) => {
      if (current.phase !== "registered") {
        await settle("not-applied", code("device.wait"));
        throw new PollEnded(pending("device.wait", poll));
      }
      sent = true;
      const reply = await callAws(ctx, {
        role: "oidc",
        method: "POST",
        path: "/token",
        body: {
          clientId: current.clientId,
          clientSecret: current.clientSecret,
          deviceCode,
          grantType: DEVICE_CODE_GRANT,
        },
        schema: tokenResponseSchema,
      });
      if (!reply.ok) throw await refused(ctx, reply, poll, settle);
      await settle("applied", code("device.exchanged"));
      return signedIn(current, reply.body, ctx.environment.now());
    });
  } catch (error) {
    if (error instanceof PollEnded) {
      if (["denied", "expired"].includes(error.result.state))
        await discardRegistration(ctx, registrationRef);
      return error.result;
    }
    if (error instanceof Refusal) {
      await discardRegistration(ctx, registrationRef);
      throw error.failure;
    }
    if (!sent) {
      await settle("not-applied", code("device.not-sent"));
      throw error;
    }
    if (sentNothing(error)) {
      await settle("not-applied", code("device.unreachable"));
      throw error;
    }
    return indeterminate(ctx, poll, settle);
  }
  // The tokens are in custody and nothing points at them yet. If the handoff
  // can no longer be settled (a disconnect or reconnect cancelled it while
  // CreateToken was in flight), they must not wait there for their expiry.
  try {
    await settleHandoff(ctx, "completed");
  } catch (error) {
    await discardRegistration(ctx, registrationRef);
    throw error;
  }
  return continueAfterSignIn(ctx, registrationRef);
}
