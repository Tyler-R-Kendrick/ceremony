import type { ActorContext } from "../../../core/operation-contracts.js";
import {
  manifestSchema,
  type AuthMethod,
  type AuthOutcome,
  type ConnectorManifest,
  type Field,
} from "../../../core/schema.js";
import {
  isLiveSupportLabel,
  type AuthenticationProfile,
  type NormalizedDefinition,
  type OwnerKind,
} from "../../../core/connectors/index.js";
import {
  CeremonyError,
  type AdapterUpdate,
  type AuthAdapter,
  type ConnectorRegistration,
} from "../../controller.js";
import { ConnectorError, explainConnectorError } from "../errors.js";
import type {
  ConnectionView,
  ConnectorCommandService,
  HumanConnectionView,
} from "./service.js";

/*
 * Bridges a reviewed connector into the existing Ceremony lifecycle. The v1
 * manifest is derived from the definition's authentication profiles: only the
 * profiles the v1 runtime can actually drive become methods, and nothing is
 * fabricated for the rest. The AuthAdapter drives the same command service the
 * HTTP routes use, so the existing UI, `createProtocolAdapter`-style hosts and
 * the MCP `ceremony_connect` tool all reach connector authorizations through
 * one policy. The factory is configured by the host; a client argument never
 * selects an adapter, a binding, a destination or a credential store.
 */

export const profileFlowKinds: Partial<
  Record<AuthenticationProfile["kind"], AuthMethod["kind"]>
> = {
  "oauth-authorization-code": "oauth-code",
  "api-key": "api-key",
  "http-basic": "basic",
  "oauth-device": "device",
};

export interface ConnectorRegistrationOptions {
  /** v1 connector id this registration appears under. */
  connectorId: string;
  definition: NormalizedDefinition;
  /** The approved binding every ceremony under this registration connects through. */
  bindingRef: string;
  /** Trusted host mapping from the controller's owner token to the authenticated actor. */
  actorFor(owner: string): ActorContext | undefined;
  ownerKind?: OwnerKind;
  /** Restrict the manifest to these profile ids; default is every drivable profile. */
  profiles?: readonly string[];
  name?: string;
  description?: string;
}

const methodId = (profileId: string, used: Set<string>): string => {
  let base = profileId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!base) base = "method";
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
  used.add(candidate);
  return candidate;
};

const fieldsFor = (kind: AuthMethod["kind"]): Field[] =>
  kind === "api-key"
    ? [
        {
          name: "token",
          label: "API key",
          type: "password",
          required: true,
          classification: "secret",
        },
      ]
    : kind === "basic"
      ? [
          {
            name: "username",
            label: "Username",
            type: "text",
            required: true,
            classification: "personal",
          },
          {
            name: "password",
            label: "Password",
            type: "password",
            required: true,
            classification: "secret",
          },
        ]
      : [];

/** The v1 methods a definition can honestly offer, with the profile each one drives. */
export function manifestMethodsFor(
  definition: NormalizedDefinition,
  profiles?: readonly string[],
): { methods: AuthMethod[]; profileByMethod: Map<string, string> } {
  const used = new Set<string>();
  const profileByMethod = new Map<string, string>();
  const methods: AuthMethod[] = [];
  for (const profile of definition.authentication) {
    if (profiles && !profiles.includes(profile.id)) continue;
    const kind = profileFlowKinds[profile.kind];
    if (!kind) continue;
    const id = methodId(profile.id, used);
    profileByMethod.set(id, profile.id);
    methods.push({
      id,
      label: profile.label.slice(0, 100) || profile.id,
      kind,
      fields: fieldsFor(kind),
      scopes:
        "scopes" in profile
          ? profile.scopes.filter((scope) => scope.length <= 100).slice(0, 30)
          : [],
      templateId: `connector-${kind}`,
    });
  }
  return { methods: methods.slice(0, 12), profileByMethod };
}

function ceremonyError(error: unknown): CeremonyError {
  if (error instanceof CeremonyError) return error;
  const explained = explainConnectorError(error);
  return new CeremonyError(explained.message, explained.status);
}

const isHuman = (view: ConnectionView): view is HumanConnectionView =>
  "displayName" in view;

export function createConnectorRegistration(
  service: ConnectorCommandService,
  adapterId: string,
  options: ConnectorRegistrationOptions,
): ConnectorRegistration {
  const adapter = service.registry.get(adapterId);
  if (!adapter) throw new Error("Unknown connector adapter");
  const { methods, profileByMethod } = manifestMethodsFor(
    options.definition,
    options.profiles,
  );
  if (!methods.length)
    throw new ConnectorError("unsupported", {
      detail: "manifest.no-executable-method",
    });
  // A fixture-family adapter (the generic OpenAPI and catalog adapters)
  // registers as a live adapter only when its dated evidence earns a live
  // label; the family alone keeps it `fixture`, as the manifest profile
  // requires. The owner's configuration is unknown here, so an adapter that
  // needs configuration is judged without it: live evidence it cannot
  // present does not count. The label is this definition's: a generic
  // adapter's own suites never make an imported description live.
  const configured = adapter.configuration.every((item) => !item.required);
  const live = isLiveSupportLabel(
    service.support.label(adapter, configured, [
      options.definition.definitionRef,
      `sha256:${options.definition.normalizedDigest}`,
    ]),
  );
  const manifest: ConnectorManifest = manifestSchema.parse({
    support:
      adapter.support === "fixture" && !live ? "fixture" : "live-adapter",
    id: options.connectorId,
    name: (options.name ?? options.definition.display.name).slice(0, 100),
    description: (
      options.description ?? options.definition.display.description
    ).slice(0, 500),
    methods,
  });
  const ownerKind = options.ownerKind ?? "user";

  return {
    manifest,
    recoverable: false,
    availability: (owner) =>
      options.actorFor(owner) ? "available" : "unavailable",
    createAdapter({ owner, method }): AuthAdapter {
      const profileId = profileByMethod.get(method.id);
      let connectionRef: string | undefined;
      let stopped = false;
      const actor = (): ActorContext => {
        const found = options.actorFor(owner);
        if (!found)
          throw new CeremonyError("Session is not authenticated", 401);
        return found;
      };
      const outcome = (view: ConnectionView): AuthOutcome => ({
        connectionRef: view.connectionRef,
        ownership: "authenticated",
        scopes: method.scopes,
      });
      const translate = (view: ConnectionView): AdapterUpdate | undefined => {
        connectionRef = view.connectionRef;
        if (view.lifecycle === "active")
          return { step: "complete", outcome: outcome(view) };
        if (view.lifecycle === "configuration-required")
          return {
            step: "error",
            message:
              "Required configuration is missing. Complete setup before connecting.",
          };
        if (
          view.lifecycle === "indeterminate" ||
          view.lifecycle === "reconnect-required"
        )
          return {
            step: "error",
            message: "Authentication could not be completed. Please retry.",
          };
        const handoff = isHuman(view) ? view.handoff : undefined;
        const presentation = isHuman(view) ? view.presentation : undefined;
        if (
          handoff &&
          (handoff.state === "issued" || handoff.state === "waiting")
        ) {
          const expiresAt = Date.parse(handoff.expiresAt);
          if (handoff.kind === "device-code" && presentation?.url)
            return {
              step: "waiting",
              verificationUri: presentation.url,
              ...(presentation.userCode
                ? { userCode: presentation.userCode }
                : {}),
              expiresAt,
            };
          if (
            handoff.kind === "input-required" ||
            handoff.kind === "private-collector"
          )
            return {
              step: "input",
              ...(presentation?.instructions
                ? { message: presentation.instructions }
                : {}),
            };
          if (presentation?.url)
            return {
              step: "redirect",
              authorizationUrl: presentation.url,
              expiresAt,
            };
        }
        if (view.lifecycle === "human-required")
          return {
            step: "error",
            message: "A person must complete this step in the application.",
          };
        return undefined;
      };
      const begin = async (): Promise<ConnectionView> =>
        service.connect(actor(), {
          bindingRef: options.bindingRef,
          ownerKind,
          intent: {
            ...(profileId ? { profileId } : {}),
            requestedPermissions: method.scopes,
            accountSwitch: false,
            interruption: "allowed",
          },
        });
      return {
        async begin() {
          stopped = false;
          try {
            const view = await begin();
            const update = translate(view);
            if (update) return update;
            return method.kind === "api-key" || method.kind === "basic"
              ? { step: "input" }
              : { step: "error", message: "Authentication is unavailable." };
          } catch (error) {
            throw ceremonyError(error);
          }
        },
        async submit(values) {
          try {
            if (stopped) throw new CeremonyError("Attempt cancelled");
            let view = connectionRef
              ? await service.status(actor(), connectionRef)
              : await begin();
            connectionRef = view.connectionRef;
            if (view.lifecycle === "active")
              return { step: "complete", outcome: outcome(view) };
            const handoff = isHuman(view) ? view.handoff : undefined;
            if (
              !handoff ||
              (handoff.kind !== "input-required" &&
                handoff.kind !== "private-collector") ||
              (handoff.state !== "issued" && handoff.state !== "waiting")
            )
              throw new CeremonyError("Unexpected credential submission");
            view = await service.provideInput(
              actor(),
              view.connectionRef,
              handoff.handoffRef,
              values,
            );
            return (
              translate(view) ?? {
                step: "error",
                message: "The credentials were rejected.",
              }
            );
          } catch (error) {
            throw ceremonyError(error);
          }
        },
        async callback(url) {
          try {
            if (stopped) throw new CeremonyError("Callback is no longer valid");
            const view = await service.callback(actor(), url);
            return (
              translate(view) ?? {
                step: "error",
                message: "Authentication could not be completed. Please retry.",
              }
            );
          } catch (error) {
            throw ceremonyError(error);
          }
        },
        async poll() {
          if (stopped || !connectionRef) return undefined;
          try {
            const view = await service.poll(actor(), connectionRef);
            const update = translate(view);
            return update?.step === "waiting" || update?.step === "redirect"
              ? undefined
              : update;
          } catch (error) {
            throw ceremonyError(error);
          }
        },
        cancel() {
          stopped = true;
          if (!connectionRef) return;
          const ref = connectionRef;
          const who = options.actorFor(owner);
          if (who) void service.cancelPending(who, ref).catch(() => {});
        },
      };
    },
  };
}
