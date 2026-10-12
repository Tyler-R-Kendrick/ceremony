import type {
  AdapterCallContext,
  CapabilityStatus,
  CompletionInput,
  CompletionResult,
  ConfigurationRequirement,
  ConnectorAdapter,
  DisconnectResult,
  DisconnectScope,
} from "../../adapter.js";
import { capabilityStatus } from "../../adapter.js";
import type { BoundOperation } from "../../binding.js";
import type { ConnectorOAuthOptions } from "../../auth/connector-oauth.js";
import { beginSignIn, completeSelection, pollSignIn } from "./ceremony.js";
import {
  VERCEL_ACCOUNT_ADAPTER_ID,
  VERCEL_ACCOUNT_ADAPTER_VERSION,
  VERCEL_ACCOUNT_PROFILE,
  vercelAccountConfigurationNames,
  vercelAccountDestinationIds,
  vercelAccountOperations,
  type VercelAccountOperation,
} from "./contracts.js";
import { invokeAccount, verifyAccount } from "./invoke.js";
import { endSignIn, releaseSignIn } from "./release.js";

export * from "./contracts.js";
export { accountApiDestination } from "./client.js";
export { SELECT_TEAM_INTENT } from "./ceremony.js";
export {
  accountManagementSource,
  type AccountContextSource,
} from "./management.js";

const code = (suffix: string) => `${VERCEL_ACCOUNT_ADAPTER_ID}.${suffix}`;

/** Bound read operations for a host binding; there is no operation that returns the token. */
export function vercelAccountBoundOperations(): BoundOperation[] {
  return (Object.keys(vercelAccountOperations) as VercelAccountOperation[]).map(
    (name) => {
      const operation = vercelAccountOperations[name];
      return {
        operationRef: operation.operationRef,
        nativeId: operation.nativeId,
        destinationId: vercelAccountDestinationIds.api,
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
        targetParameters: [],
        description: operation.summary,
      };
    },
  );
}

const configuration: readonly ConfigurationRequirement[] = [
  {
    name: vercelAccountConfigurationNames.clientId,
    source: "host",
    classification: "public",
    required: true,
    description:
      "Client id of a Sign in with Vercel application whose client authentication is none; the device grant is presented as that client.",
  },
];

export type VercelAccountAdapterOptions = {
  /** Host seams for the OAuth grant: where discovery is cached; registrations are not used. */
  oauth?: ConnectorOAuthOptions;
};

export function createVercelAccountAdapter(
  options: VercelAccountAdapterOptions = {},
): ConnectorAdapter {
  const oauth: ConnectorOAuthOptions = options.oauth ?? {};
  const complete = (
    ctx: AdapterCallContext,
    input: CompletionInput,
  ): Promise<CompletionResult> => {
    switch (input.kind) {
      case "poll":
        return pollSignIn(ctx, oauth);
      case "input":
        return completeSelection(ctx, input.values, oauth);
      default:
        return Promise.resolve({
          state: "denied",
          claims: [],
          code: code("completion.unsupported"),
        });
    }
  };
  const disconnect = async (
    ctx: AdapterCallContext,
    scope: DisconnectScope,
  ): Promise<DisconnectResult> => ({
    local: "not-attempted",
    broker: scope === "broker" ? "unsupported" : "not-attempted",
    upstream:
      scope === "upstream" ? await endSignIn(ctx, oauth) : "not-attempted",
  });
  const adapter: ConnectorAdapter = {
    id: VERCEL_ACCOUNT_ADAPTER_ID,
    ecosystem: VERCEL_ACCOUNT_ADAPTER_ID,
    adapterVersion: VERCEL_ACCOUNT_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "Vercel account sign-in",
    description:
      "A person signs in to their Vercel account with the device authorization grant and picks a team; the host holds the session and the management leg of Vercel Connect can use it in place of a pasted token.",
    service: "vercel",
    support: "provider-backed",
    custody: ["host-owned"],
    configuration,
    profiles: [VERCEL_ACCOUNT_PROFILE],
    capabilities(present) {
      const ready = present.has(vercelAccountConfigurationNames.clientId)
        ? "ready"
        : "missing";
      const status = (
        dimension: CapabilityStatus["dimension"],
        configurationState: CapabilityStatus["configuration"],
        limitations: string[] = [],
        implementation: CapabilityStatus["implementation"] = "implemented",
      ) =>
        capabilityStatus(adapter, {
          dimension,
          profile: VERCEL_ACCOUNT_PROFILE,
          implementation,
          configuration: configurationState,
          evidence:
            implementation === "implemented"
              ? "protocol-fixture"
              : "not-tested",
          limitations,
        });
      return [
        status("discover", "not-applicable", [], "unsupported"),
        status("import", "not-applicable", [], "unsupported"),
        status("configure", "not-applicable", [], "unsupported"),
        status("authorize", ready, [
          "The person signs in and approves on Vercel's own page; this adapter never sees the sign-in.",
          "Then GET /v2/user and GET /v2/teams name who signed in and which teams the binding permits; one permitted team binds without asking, otherwise the person types a slug that Vercel's own list must contain.",
          "Written from Vercel's discovery document and published pages and run only against a loopback double; whether a dashboard-made client may use the device grant is an assumption listed in contracts.ts.",
          "Authorization code with PKCE is not implemented here: it is the generic authorization-code family under another issuer policy, not a second mechanism.",
        ]),
        status("verify", ready, [
          "Renews the access token with its single-use refresh token when it is about to lapse, then re-reads the user and teams.",
        ]),
        status("invoke", ready, [
          "Read-only: GET /v2/user and GET /v2/teams. The token is never an output; the management leg of Vercel Connect reaches it through a lease the host wires.",
        ]),
        status("events", "not-applicable", [], "unsupported"),
        status("reconnect", ready, [
          "Reconnecting is a new sign-in; a different team needs an explicit switch.",
        ]),
        status("disconnect", ready, [
          "A local disconnect first presents the held refresh and access tokens to Vercel's revocation endpoint, best effort: the result says whether Vercel acknowledged (`release`), and a failure never stops the disconnect. The upstream scope does the same and reports it as the upstream outcome. Both are off when the reviewed issuer policy says `revocation: disabled`.",
        ]),
        status("revoke", ready, [
          "RFC 7009 revocation of the refresh and access tokens, on unless the issuer policy says disabled.",
        ]),
        status("export", "not-applicable", [], "unsupported"),
        status("delegate", "not-applicable", [], "unsupported"),
      ];
    },
    authorize: (ctx, intent) => beginSignIn(ctx, intent, oauth),
    complete,
    verify: (ctx) => verifyAccount(ctx, oauth),
    invoke: (ctx, request) => invokeAccount(ctx, request, oauth),
    reconnect: (ctx, intent) => beginSignIn(ctx, intent, oauth),
    disconnect,
    releaseSession: (ctx) => releaseSignIn(ctx, oauth),
    revoke: async (ctx) => ({
      local: "not-attempted",
      broker: "unsupported",
      upstream: await endSignIn(ctx, oauth),
    }),
  };
  return adapter;
}
