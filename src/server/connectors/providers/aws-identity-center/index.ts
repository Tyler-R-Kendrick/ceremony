import type {
  AdapterCallContext,
  CapabilityStatus,
  CompletionInput,
  CompletionResult,
  ConnectorAdapter,
  DisconnectResult,
  DisconnectScope,
} from "../../adapter.js";
import { capabilityStatus } from "../../adapter.js";
import type { BoundOperation } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import type { AwsCredentials } from "../../aws-credentials.js";
import { beginSignIn, pollSignIn } from "./device.js";
import { roleClaims, roleTarget } from "./evidence.js";
import { endSignIn, invokeAws, releaseSignIn } from "./invoke.js";
import {
  AWS_IDENTITY_CENTER_ADAPTER_ID,
  AWS_IDENTITY_CENTER_ADAPTER_VERSION,
  AWS_IDENTITY_CENTER_PROFILE,
  awsDestinationIds,
  awsPortalOperations,
  awsTargetKinds,
  type AwsPortalOperation,
} from "./contracts.js";
import { parseMaterial, sessionScope } from "./material.js";
import { boundIdentity, ensureCurrent } from "./refresh.js";
import { completeSelection } from "./selection.js";

export * from "./contracts.js";
export { SELECT_ROLE_INTENT } from "./selection.js";
export { AWS_DEVICE_EXCHANGE_OPERATION } from "./device.js";
export { AWS_TOKEN_REFRESH_OPERATION } from "./refresh.js";

const code = (suffix: string) => `${AWS_IDENTITY_CENTER_ADAPTER_ID}.${suffix}`;

/** Bound read operations for a host binding; there is no operation that returns credentials. */
export function awsIdentityCenterBoundOperations(): BoundOperation[] {
  return (Object.keys(awsPortalOperations) as AwsPortalOperation[]).map(
    (name) => {
      const operation = awsPortalOperations[name];
      return {
        operationRef: operation.operationRef,
        nativeId: operation.nativeId,
        destinationId: awsDestinationIds.portal,
        transport: {
          kind: "http",
          method: "GET",
          pathTemplate: operation.pathTemplate,
        },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters:
          name === "listAccountRoles" ? [awsTargetKinds.account] : [],
        description: operation.summary,
      };
    },
  );
}

/**
 * Runs `work` with this connection's role credentials, renewed first when
 * they are about to lapse. For trusted host code that signs a request (the
 * AgentCore adapter's SigV4 signer takes exactly this shape). The request has
 * to be sent inside `work` and only its response returned: custody refuses a
 * result that contains a credential, and a signed request's headers do.
 */
export async function withRoleCredentials<T>(
  ctx: AdapterCallContext,
  work: (credentials: AwsCredentials) => Promise<T>,
): Promise<T> {
  const ref = ctx.connection?.credentialRef;
  if (!ref)
    throw new ConnectorError("invalid-request", {
      detail: code("not-connected"),
    });
  await ensureCurrent(ctx, ref);
  return ctx.environment.credentials.use(
    sessionScope(ctx),
    ref,
    async (raw) => {
      const role = parseMaterial(raw).role;
      if (!role)
        throw new ConnectorError("conflict", {
          detail: code("role.not-bound"),
        });
      return work({
        accessKeyId: role.accessKeyId,
        secretAccessKey: role.secretAccessKey,
        sessionToken: role.sessionToken,
        expiresAt: role.expiresAt,
      });
    },
  );
}

function complete(
  ctx: AdapterCallContext,
  input: CompletionInput,
): Promise<CompletionResult> {
  switch (input.kind) {
    case "poll":
      return pollSignIn(ctx);
    case "input":
      return completeSelection(ctx, input.values);
    default:
      return Promise.resolve({
        state: "denied",
        claims: [],
        code: code("completion.unsupported"),
      });
  }
}

async function verify(ctx: AdapterCallContext): Promise<CompletionResult> {
  const ref = ctx.connection?.credentialRef;
  if (!ref)
    return { state: "human-required", claims: [], code: code("not-connected") };
  try {
    const identity = boundIdentity(ctx);
    const { expiresAt } = await ensureCurrent(ctx, ref);
    const role = { ...identity, expiresAt };
    return {
      state: "complete",
      claims: roleClaims(ctx, role),
      credentialRef: ref,
      target: roleTarget(role),
      adapterState: { aws: { ...identity, expiresAt } },
    };
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "expired")
      return {
        state: "expired",
        claims: [],
        code: error.detail ?? code("session.expired"),
      };
    if (error instanceof ConnectorError && error.code === "denied")
      return {
        state: "denied",
        claims: [],
        code: error.detail ?? code("role.revoked"),
      };
    throw error;
  }
}

async function disconnect(
  ctx: AdapterCallContext,
  scope: DisconnectScope,
): Promise<DisconnectResult> {
  if (scope === "upstream") return endSignIn(ctx);
  return {
    local: "not-attempted",
    broker: scope === "broker" ? "unsupported" : "not-attempted",
    upstream: "not-attempted",
  };
}

export function createAwsIdentityCenterAdapter(): ConnectorAdapter {
  const adapter: ConnectorAdapter = {
    id: AWS_IDENTITY_CENTER_ADAPTER_ID,
    ecosystem: "aws-identity-center",
    adapterVersion: AWS_IDENTITY_CENTER_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "AWS IAM Identity Center sign-in",
    description:
      "A person signs in to an IAM Identity Center instance with the device authorization grant, picks an account and role, and the host holds the role's short-lived credentials; the caller sees the account, the role and the expiry.",
    service: "aws",
    support: "provider-backed",
    custody: ["host-owned"],
    configuration: [],
    profiles: [AWS_IDENTITY_CENTER_PROFILE],
    capabilities() {
      const status = (
        dimension: CapabilityStatus["dimension"],
        limitations: string[] = [],
        implementation: CapabilityStatus["implementation"] = "implemented",
      ) =>
        capabilityStatus(adapter, {
          dimension,
          profile: AWS_IDENTITY_CENTER_PROFILE,
          implementation,
          configuration: "not-applicable",
          evidence:
            implementation === "implemented"
              ? "protocol-fixture"
              : "not-tested",
          limitations,
        });
      return [
        status("discover", [], "unsupported"),
        status("import", [], "unsupported"),
        status("configure", [], "unsupported"),
        status("authorize", [
          "The person signs in and approves on the AWS access portal's own page; this adapter never sees the sign-in.",
          "One client is registered per sign-in (RegisterClient); its secret, every token and the role credentials stay in custody.",
          "Written from the OIDC and Portal API references and run only against a loopback double; the portal host, the credential expiration unit and several error mappings are assumptions listed in contracts.ts.",
        ]),
        status("verify", [
          "Renews role credentials with a new GetRoleCredentials call; the refresh grant is presented only when the access token has lapsed.",
          "Identity is the portal's report for this sign-in; STS is not asked.",
        ]),
        status("invoke", [
          "Read-only: ListAccounts and ListAccountRoles for the accounts the binding permits. Role credentials are never an output.",
        ]),
        status("events", [], "unsupported"),
        status("reconnect", [
          "Reconnecting is a new sign-in; a different account or role needs an explicit account switch.",
        ]),
        status("disconnect", [
          "A local disconnect first calls the portal's Logout, best effort: the result says whether the portal acknowledged (`release`), and a failure never stops the disconnect; then it drops the held tokens and role credentials. The upstream scope calls Logout and reports it as the upstream outcome.",
        ]),
        status("revoke", [
          "Logout ends the sign-in session; role sessions already issued run to their own expiry. The OIDC API has no operation that revokes a refresh token, so that token is dropped with custody and is not known to be ended.",
        ]),
        status("export", [], "unsupported"),
        status("delegate", [], "unsupported"),
      ];
    },
    authorize: (ctx, intent) => beginSignIn(ctx, intent),
    complete,
    verify,
    invoke: invokeAws,
    reconnect: (ctx, intent) => beginSignIn(ctx, intent),
    disconnect,
    releaseSession: releaseSignIn,
    revoke: (ctx) => endSignIn(ctx),
  };
  return adapter;
}
