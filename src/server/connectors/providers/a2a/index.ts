import type {
  AdapterCallContext,
  CapabilityStatus,
  ConnectorAdapter,
} from "../../adapter.js";
import { capabilityStatus } from "../../adapter.js";
import type { ApprovedDestination } from "../../binding.js";
import { importAgentCard } from "./card.js";
import { type A2aAdapterOptions } from "./context.js";
import {
  delegateA2a,
  retrieveA2aArtifact,
  type ArtifactRetrieval,
} from "./delegate.js";
import {
  authorizeA2a,
  completeA2a,
  disconnectA2a,
  reconnectA2a,
  revokeA2a,
  verifyA2a,
} from "./sessions.js";
import {
  A2A_ADAPTER_ID,
  A2A_ADAPTER_VERSION,
  A2A_CONFIGURATION,
  A2A_CONFIGURATION_NAMES,
  A2A_PROFILE_0_3,
  A2A_PROFILE_1_0,
} from "./schemas.js";

export * from "./schemas.js";
export {
  A2A_IMPORTER_ID,
  A2A_IMPORTER_VERSION,
  classifyDeclaredUrl,
  importAgentCard,
  readAgentCardBytes,
  type AgentCardImport,
  type UrlExposure,
} from "./card.js";
export { A2aClient, a2aFailure, type A2aCredential } from "./client.js";
export {
  authorityInstanceFor,
  resolveA2a,
  type A2aAdapterOptions,
  type ResolvedA2a,
} from "./context.js";
export {
  delegateA2a,
  projectTask,
  resolveTaskHandle,
  retrieveA2aArtifact,
  taskReferenceFor,
  TASK_REF_PREFIX,
  type A2aDelegationOutput,
  type ArtifactRetrieval,
} from "./delegate.js";
export {
  authorizeA2a,
  completeA2a,
  disconnectA2a,
  reconnectA2a,
  revokeA2a,
  verifyA2a,
} from "./sessions.js";

/**
 * The A2A adapter plus its privileged-internal surface. Everything on
 * `ConnectorAdapter` is reachable through the shared commands; artifact
 * retrieval is deliberately not, because following a URL another agent chose
 * is a decision a person makes, not a step a delegation performs.
 */
export interface A2aAdapter extends ConnectorAdapter {
  /** Privileged-internal, explicitly approved, one artifact at a time. */
  retrieveArtifact(
    ctx: AdapterCallContext,
    input: {
      taskRef: string;
      artifactId: string;
      partIndex: number;
      approval: { approvedBy: string; approvedAt: number };
    },
  ): Promise<ArtifactRetrieval>;
}

/** Approved destinations for an A2A binding; a host builds its binding from these, never from a card. */
export function a2aDestinations(options: {
  agentOrigin: string;
  network?: ApprovedDestination["network"];
  pathPrefix?: string;
  artifactOrigin?: string;
  artifactNetwork?: ApprovedDestination["network"];
}): ApprovedDestination[] {
  const network = options.network ?? "public";
  return [
    {
      id: "agent",
      origin: options.agentOrigin,
      ...(options.pathPrefix ? { pathPrefix: options.pathPrefix } : {}),
      network,
    },
    ...(options.artifactOrigin
      ? [
          {
            id: "artifacts",
            origin: options.artifactOrigin,
            network: options.artifactNetwork ?? network,
          } satisfies ApprovedDestination,
        ]
      : []),
  ];
}

export function createA2aAdapter(options: A2aAdapterOptions = {}): A2aAdapter {
  void options;
  const identity = {
    adapterVersion: A2A_ADAPTER_VERSION,
    runtime: "hosted-server" as const,
  };
  return {
    id: A2A_ADAPTER_ID,
    ecosystem: "a2a",
    adapterVersion: A2A_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "A2A agent",
    description:
      "Delegates approved skills to a configured Agent2Agent peer: bounded Agent Card import, authenticated task delegation, status, cancellation and input-required continuation. A card is a description; the binding decides what may be delegated and where.",
    service: "a2a",
    support: "provider-backed",
    custody: ["host-owned"],
    configuration: A2A_CONFIGURATION,
    profiles: [A2A_PROFILE_1_0, A2A_PROFILE_0_3],
    capabilities(present) {
      const configured = present.has(A2A_CONFIGURATION_NAMES.credential);
      const configuration = configured
        ? ("ready" as const)
        : ("missing" as const);
      const row = (
        dimension: CapabilityStatus["dimension"],
        input: Partial<
          Pick<
            CapabilityStatus,
            | "implementation"
            | "configuration"
            | "limitations"
            | "evidence"
            | "profile"
          >
        > = {},
      ) => {
        const { profile, ...rest } = input;
        return capabilityStatus(identity, {
          dimension,
          profile: profile ?? A2A_PROFILE_1_0,
          configuration,
          evidence: "protocol-fixture",
          ...rest,
        });
      };
      return [
        row("import", {
          configuration: "not-applicable",
          limitations: [
            "Agent Card only; both the 1.0 (supportedInterfaces) and 0.3 (url/preferredTransport) card shapes are read. Nothing a card names is fetched during import.",
            "Card signatures are preserved and are not verified.",
          ],
        }),
        row("import", {
          profile: A2A_PROFILE_0_3,
          configuration: "not-applicable",
          limitations: [
            "0.3 cards are read into the same description; delegation still requires an interface on a supported version.",
          ],
        }),
        row("configure", { configuration: "not-applicable", evidence: "unit" }),
        row("authorize", {
          limitations: [
            "A configured service credential, not a human sign-in: there is no A2A authorization flow to run on a person's behalf.",
          ],
        }),
        row("verify", {
          limitations: [
            "Verification compares the served card with the reviewed card and confirms the agent accepted this deployment's credential; it establishes no operator identity and no scope.",
          ],
        }),
        row("delegate", {
          limitations: [
            "JSON-RPC binding only: gRPC and HTTP+JSON interfaces are reported unsupported rather than approximated.",
            "Only skills listed in the binding may be delegated, whatever the card advertises.",
            "Task identity is owner-bound and generation-fenced; a reference from another principal or an older generation is not found.",
            "Artifacts are described, never fetched; retrieval is a separate approved operation against an approved destination.",
          ],
        }),
        row("delegate", {
          profile: A2A_PROFILE_0_3,
          limitations: [
            "0.3 method names (message/send, tasks/get, tasks/cancel), lower-hyphen task states and kind-tagged parts; never mixed with the 1.0 wire.",
          ],
        }),
        row("reconnect", {
          limitations: [
            "Reconnect re-reads configuration and re-verifies the card; the command layer advances the generation, which fences every task issued before it.",
          ],
        }),
        row("disconnect", {
          limitations: [
            "Local disconnect only: A2A publishes no connection resource to delete and no grant to revoke.",
          ],
        }),
        row("revoke", {
          implementation: "unsupported",
          configuration: "not-applicable",
          limitations: [
            "A2A documents no revocation operation; a local disconnect is not upstream revocation.",
          ],
        }),
        row("discover", {
          implementation: "unsupported",
          configuration: "not-applicable",
          limitations: [
            "A2A defines no agent directory; cards arrive by upload, by registry import or from a configured URL fetched by the host importer.",
          ],
        }),
        row("invoke", {
          implementation: "unsupported",
          configuration: "not-applicable",
          limitations: [
            "A2A work is delegation, not invocation: use the delegate dimension so task identity, cancellation and input-required are modelled.",
          ],
        }),
        row("events", {
          implementation: "unsupported",
          configuration: "not-applicable",
          limitations: [
            "Push notification configuration is not registered; task progress is polled through an approved status operation.",
          ],
        }),
        row("export", {
          implementation: "unsupported",
          configuration: "not-applicable",
          limitations: [
            "This deployment publishes no Agent Card of its own, so there is nothing to export as one.",
          ],
        }),
      ];
    },
    import: (ctx, input) => importAgentCard(ctx, input),
    authorize: (ctx, intent) => authorizeA2a(ctx, intent),
    complete: (ctx, input) => completeA2a(ctx, input),
    verify: (ctx) => verifyA2a(ctx),
    reconnect: (ctx, intent) => reconnectA2a(ctx, intent),
    disconnect: (ctx, scope) => disconnectA2a(ctx, scope),
    revoke: () => revokeA2a(),
    delegate: (ctx, request) => delegateA2a(ctx, request),
    retrieveArtifact: (ctx, input) => retrieveA2aArtifact(ctx, input),
  };
}
