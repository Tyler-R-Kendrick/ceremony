import {
  catalogEntrySchema,
  publicCatalogProjection,
  strongestEvidence,
  type CatalogEntry,
} from "../../core/connectors/index.js";
import type { ConnectorAdapter, ConnectorAdapterRegistry } from "./adapter.js";

/*
 * The directory is derived from what is registered and what is configured. A
 * provider-backed adapter whose required configuration is absent is shown as
 * unconfigured — implemented, not usable here — and a fixture adapter is shown
 * as a fixture. No static list in the browser can disagree with this, because
 * there is no static list in the browser.
 */

const authenticationKinds = (adapter: ConnectorAdapter) => [
  ...new Set(
    adapter.profiles.flatMap((profile) => profileKinds[profile] ?? []),
  ),
];

/** Which authentication kinds a protocol profile implies, for directory filters. */
const profileKinds: Record<string, CatalogEntry["authentication"]> = {
  "oauth-authorization-code": ["oauth-authorization-code"],
  "oauth-client-credentials": ["oauth-client-credentials"],
  "oauth-device": ["oauth-device"],
  "api-key": ["api-key"],
  "http-basic": ["http-basic"],
  "http-bearer": ["http-bearer"],
  "openid-connect": ["openid-connect"],
  "external-broker": ["external-broker"],
  none: ["none"],
};

export function catalogEntryFor(
  adapter: ConnectorAdapter,
  present: ReadonlySet<string>,
  extra: {
    authentication?: CatalogEntry["authentication"];
    definitionRef?: string;
  } = {},
): CatalogEntry {
  const capabilities = adapter.capabilities(present);
  const missingRequired = adapter.configuration.some(
    (item) => item.required && !present.has(item.name),
  );
  const support: CatalogEntry["support"] =
    adapter.support === "provider-backed" && missingRequired
      ? "unconfigured"
      : adapter.support;
  return publicCatalogProjection(
    catalogEntrySchema.parse({
      id: adapter.id,
      ecosystem: adapter.ecosystem,
      service: adapter.service,
      displayName: adapter.displayName,
      description: adapter.description,
      support,
      custody: [...adapter.custody],
      runtimes: [adapter.runtime],
      authentication: [
        ...new Set([
          ...authenticationKinds(adapter),
          ...(extra.authentication ?? []),
        ]),
      ],
      configuration: adapter.configuration.map((item) => ({
        name: item.name,
        required: item.required,
        classification: item.classification,
        present: present.has(item.name),
      })),
      capabilities,
      evidence: strongestEvidence(
        capabilities.map((status) => status.evidence),
      ),
      group: adapter.service,
      ...(extra.definitionRef ? { definitionRef: extra.definitionRef } : {}),
    }),
  );
}

/** One inventory for HTTP, MCP and the reference UI; `present` is resolved per actor by the caller. */
export function catalogFor(
  registry: ConnectorAdapterRegistry,
  present: (adapter: ConnectorAdapter) => ReadonlySet<string>,
): CatalogEntry[] {
  return registry
    .list()
    .map((adapter) => catalogEntryFor(adapter, present(adapter)))
    .sort((a, b) =>
      a.group === b.group
        ? a.id.localeCompare(b.id)
        : a.group.localeCompare(b.group),
    );
}
