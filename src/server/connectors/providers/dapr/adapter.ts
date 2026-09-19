import type {
  CapabilityStatus,
  ConfigurationRequirement,
  SupportDimension,
} from "../../../../core/connectors/index.js";
import type { EvidenceLevel } from "../../../../core/connectors/identity.js";
import {
  capabilityStatus,
  type AdapterCallContext,
  type ConnectorAdapter,
  type ImportInput,
  type ImportOutcome,
  type InvokeRequest,
  type InvokeResult,
} from "../../adapter.js";
import { ConnectorError } from "../../errors.js";
import { sha256Hex } from "../../import/parse.js";
import { daprSidecarFromBinding } from "./binding-settings.js";
import { createDaprEventPort, type DaprEventPortOptions } from "./events.js";
import {
  DAPR_IMPORT_LIMITS,
  daprSourceRecord,
  importDaprComponent,
} from "./import.js";
import { invokeDaprOutputBinding, type DaprInvokeOptions } from "./invoke.js";
import {
  DAPR_ADAPTER_VERSION,
  DAPR_BINDINGS_PROFILE,
  DAPR_COMPONENT_PROFILE,
  DAPR_ECOSYSTEM,
  DAPR_HTTP_API_VERSION,
  DAPR_SOURCE,
} from "./schemas.js";

/*
 * The Dapr adapter.
 *
 * It imports component and binding descriptions, invokes output bindings that
 * a runtime binding approved by component name and verb, and authenticates
 * input deliveries with the app API token. It has no discovery: a sidecar
 * cannot be asked what components it has loaded without becoming exactly the
 * unauthenticated inventory endpoint this adapter refuses to be, and Ceremony
 * never guesses one.
 */

export const DAPR_ADAPTER_ID = "dapr";
export const DAPR_API_TOKEN_CONFIGURATION = "DAPR_API_TOKEN";
export const DAPR_APP_API_TOKEN_CONFIGURATION = "DAPR_APP_API_TOKEN";

const configuration: ConfigurationRequirement[] = [
  {
    name: DAPR_API_TOKEN_CONFIGURATION,
    source: "host",
    classification: "secret",
    required: false,
    description:
      "Token sent as dapr-api-token when invoking a sidecar; required unless the binding declares a loopback fixture sidecar explicitly",
  },
  {
    name: DAPR_APP_API_TOKEN_CONFIGURATION,
    source: "host",
    classification: "secret",
    required: false,
    description:
      "Token the sidecar presents as dapr-api-token on input deliveries to this application",
  },
];

export type DaprAdapterOptions = {
  evidence?: EvidenceLevel;
  invoke?: DaprInvokeOptions;
  events?: DaprEventPortOptions;
};

const unsupportedDimensions: SupportDimension[] = [
  "discover",
  "authorize",
  "reconnect",
  "revoke",
  "export",
  "delegate",
];

export function createDaprAdapter(
  options: DaprAdapterOptions = {},
): ConnectorAdapter {
  const evidence = options.evidence ?? "protocol-fixture";
  const identity = {
    adapterVersion: DAPR_ADAPTER_VERSION,
    runtime: "hosted-server" as const,
  };
  const events = createDaprEventPort(options.events ?? {});

  const adapter: ConnectorAdapter = {
    id: DAPR_ADAPTER_ID,
    ecosystem: DAPR_ECOSYSTEM,
    adapterVersion: DAPR_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "Dapr bindings",
    description: `Imports Dapr component and binding descriptions and invokes approved output bindings on a configured sidecar over the ${DAPR_HTTP_API_VERSION} HTTP API. The sidecar is never exposed as a generic proxy.`,
    service: "dapr",
    support: "provider-backed",
    custody: ["host-owned", "no-credential"],
    configuration,
    profiles: [DAPR_BINDINGS_PROFILE, DAPR_COMPONENT_PROFILE, "api-key"],
    capabilities(present) {
      const sidecarToken = present.has(DAPR_API_TOKEN_CONFIGURATION);
      const appToken = present.has(DAPR_APP_API_TOKEN_CONFIGURATION);
      const rows: CapabilityStatus[] = [
        capabilityStatus(identity, {
          dimension: "import",
          profile: DAPR_COMPONENT_PROFILE,
          evidence,
          limitations: [
            `Binding directions come from the pinned Dapr component reference (${DAPR_SOURCE.runtimeDocsVersion}); a type that reference does not cover is reported unverified, never guessed.`,
            "Credential-bearing component metadata is imported as a name and a resolution source, never as a value.",
          ],
        }),
        capabilityStatus(identity, {
          dimension: "configure",
          profile: DAPR_BINDINGS_PROFILE,
          evidence,
          limitations: [
            "A binding approves one sidecar destination, an explicit component-name list and the operation verbs allowed for each.",
          ],
        }),
        capabilityStatus(identity, {
          dimension: "invoke",
          profile: DAPR_BINDINGS_PROFILE,
          evidence,
          configuration: sidecarToken ? "ready" : "missing",
          limitations: [
            "Only output bindings the runtime binding named, with the verbs it approved; a caller never supplies a URL, header, component name or sidecar.",
            "An interrupted write is recorded indeterminate; Dapr offers no idempotency key for a binding invocation, so it is never retried blindly.",
            ...(sidecarToken
              ? []
              : [
                  "No sidecar API token is configured; only an explicitly declared loopback fixture sidecar can be invoked.",
                ]),
          ],
        }),
        capabilityStatus(identity, {
          dimension: "events",
          profile: DAPR_BINDINGS_PROFILE,
          evidence,
          configuration: appToken ? "ready" : "missing",
          limitations: [
            "Input deliveries are authenticated by the app API token the sidecar presents; an unauthenticated delivery is never accepted.",
            "A Dapr delivery carries no provider event id, so deduplication uses host-assigned identity.",
            ...(appToken
              ? []
              : [
                  "No app API token is configured, so no input delivery can be authenticated here.",
                ]),
          ],
        }),
        capabilityStatus(identity, {
          dimension: "verify",
          profile: DAPR_BINDINGS_PROFILE,
          implementation: "unsupported",
          limitations: [
            "A sidecar exposes no account or component inventory endpoint that could be read as evidence; connectivity is not identity.",
          ],
        }),
        capabilityStatus(identity, {
          dimension: "disconnect",
          profile: DAPR_BINDINGS_PROFILE,
          evidence: "unit",
          limitations: [
            "Local disconnect only: Ceremony does not delete a component, unload it from a sidecar or revoke a sidecar token.",
          ],
        }),
      ];
      for (const dimension of unsupportedDimensions)
        rows.push(
          capabilityStatus(identity, {
            dimension,
            profile: DAPR_BINDINGS_PROFILE,
            implementation: "unsupported",
            limitations: [
              dimension === "discover"
                ? "A sidecar has no documented component-inventory endpoint; components are imported from their YAML, never enumerated from the sidecar."
                : "Dapr defines no such operation for a binding component.",
            ],
          }),
        );
      return rows;
    },
    async import(
      ctx: AdapterCallContext,
      input: ImportInput,
    ): Promise<ImportOutcome> {
      if (input.bytes.byteLength > DAPR_IMPORT_LIMITS.bytes)
        throw new ConnectorError("invalid-request", {
          detail: "dapr.component.oversized",
        });
      const capturedAt = new Date(ctx.environment.now()).toISOString();
      const mediaType =
        input.mediaType.split(";")[0]?.trim() || "application/yaml";
      const sourceRef = `src:dapr:${sha256Hex(input.bytes)}`;
      const imported = await importDaprComponent(input.bytes, {
        sourceRef,
        origin: input.origin,
        mediaType,
        capturedAt,
      });
      return {
        source: daprSourceRecord({
          sourceRef,
          identity: imported.identity,
          origin: input.origin,
          bytes: input.bytes,
          mediaType,
          capturedAt,
          isBinding: imported.isBinding,
        }),
        definitions: [imported.definition],
        issues: imported.issues,
        executableCandidates: imported.executableCandidates,
      };
    },
    async invoke(
      ctx: AdapterCallContext,
      request: InvokeRequest,
    ): Promise<InvokeResult> {
      return invokeDaprOutputBinding(ctx, request, options.invoke ?? {});
    },
    events,
    async disconnect(ctx: AdapterCallContext, scope) {
      /*
       * Unlinking here removes a local connection. It does not delete a
       * component, unload it from a sidecar or revoke a token: Dapr has no
       * such operation for a platform caller, and pretending otherwise would
       * report an upstream effect that never happened.
       */
      daprSidecarFromBinding(ctx.binding);
      return {
        local: scope === "local" ? "applied" : "not-attempted",
        broker: "unsupported",
        upstream: "unsupported",
      };
    },
  };
  return adapter;
}
