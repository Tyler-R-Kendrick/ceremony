"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  CatalogEntry,
  CapabilityStatus,
  CredentialCustody,
  EvidenceLevel,
  RuntimeClass,
  SupportDimension,
} from "../core/connectors/index.js";
import type { ConnectorViewer } from "../core/connectors/client.js";

/**
 * The directory, bound to the server's inventory.
 *
 * Every row here came from `GET /api/v1/connectors/catalog`, which the server
 * derives from the adapters it has actually registered and the configuration it
 * actually holds. There is no static list in the browser, so nothing on this
 * page can disagree with what the deployment can run: a provider-backed adapter
 * missing its configuration says `unconfigured`, a fixture says `fixture`, and
 * a row that describes a connector nobody implemented says `catalog-only`.
 *
 * Alternatives for one service are grouped and never merged. Two ways to reach
 * GitHub — a native adapter and a brokered one — are different custody,
 * different evidence and different grants, so they stay two cards under one
 * heading. Merging them would be the directory quietly choosing an authority on
 * somebody's behalf.
 */

export type { CatalogEntry } from "../core/connectors/index.js";

export const supportPresentation: Record<
  CatalogEntry["support"],
  { label: string; tone: "ok" | "human" | "stop" | "muted"; detail: string }
> = {
  "provider-backed": {
    label: "Provider-backed",
    tone: "ok",
    detail:
      "A real adapter runs this and the deployment holds the configuration it needs.",
  },
  fixture: {
    label: "Local fixture",
    tone: "human",
    detail:
      "Driven by a deterministic local harness. Never evidence about the vendor's live service.",
  },
  unconfigured: {
    label: "Needs configuration",
    tone: "stop",
    detail:
      "The adapter is implemented, but this deployment is missing configuration it requires.",
  },
  "catalog-only": {
    label: "Described only",
    tone: "muted",
    detail:
      "A description with no implementation here. It can be reviewed and exported, not connected.",
  },
};

export const evidencePresentation: Record<
  EvidenceLevel,
  { label: string; detail: string }
> = {
  "not-tested": { label: "Not tested", detail: "No evidence has been recorded." },
  unit: { label: "Unit", detail: "Exercised by unit tests only." },
  "protocol-fixture": {
    label: "Protocol fixture",
    detail: "Exercised against a local protocol fixture, not the live service.",
  },
  "local-integration": {
    label: "Local integration",
    detail: "Exercised against a locally running dependency.",
  },
  "browser-integration": {
    label: "Browser",
    detail: "Exercised end to end in a real browser against fixtures.",
  },
  "live-authorized": {
    label: "Live authorized",
    detail: "Observed against the real service with authorized credentials.",
  },
  "deployed-authorized": {
    label: "Deployed",
    detail: "Observed in a deployed environment with authorized credentials.",
  },
};

export const custodyPresentation: Record<CredentialCustody, string> = {
  "host-owned": "Host-held credential",
  "external-credential-broker": "Broker vends the credential",
  "external-execution-broker": "Broker executes; no credential here",
  "attended-browser": "Attended browser session",
  "no-credential": "No credential",
};

export const runtimePresentation: Record<RuntimeClass, string> = {
  browser: "Browser",
  "hosted-server": "Hosted server",
  "trusted-local-runner": "Local runner",
};

export const dimensionLabels: Record<SupportDimension, string> = {
  discover: "Discover",
  import: "Import",
  configure: "Configure",
  authorize: "Authorize",
  verify: "Verify",
  invoke: "Invoke",
  events: "Events",
  reconnect: "Reconnect",
  disconnect: "Disconnect",
  revoke: "Revoke",
  export: "Export",
  delegate: "Delegate",
};

export type DirectoryFilters = {
  query: string;
  service: string;
  ecosystem: string;
  custody: string;
  dimension: string;
  runtime: string;
  evidence: string;
  support: string;
};

export const emptyFilters: DirectoryFilters = Object.freeze({
  query: "",
  service: "",
  ecosystem: "",
  custody: "",
  dimension: "",
  runtime: "",
  evidence: "",
  support: "",
});

/** Dimensions this entry reports as implemented, whatever their configuration. */
export function implementedDimensions(entry: CatalogEntry): SupportDimension[] {
  return [
    ...new Set(
      entry.capabilities
        .filter((status) => status.implementation === "implemented")
        .map((status) => status.dimension),
    ),
  ];
}

/** The text a person could plausibly type to find a row. */
function haystack(entry: CatalogEntry): string {
  return [
    entry.displayName,
    entry.description,
    entry.service,
    entry.group,
    entry.ecosystem,
    entry.id,
    ...entry.authentication,
    ...entry.custody.map((value) => custodyPresentation[value]),
    ...entry.runtimes.map((value) => runtimePresentation[value]),
    supportPresentation[entry.support].label,
    evidencePresentation[entry.evidence].label,
    ...implementedDimensions(entry).map((value) => dimensionLabels[value]),
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Search and facets run over the whole inventory, never over the page that
 * happens to be rendered. Paging is a rendering budget; making it a filter
 * would mean a search that silently misses rows further down the list.
 */
export function filterCatalog(
  entries: readonly CatalogEntry[],
  filters: Partial<DirectoryFilters>,
): CatalogEntry[] {
  const needle = (filters.query ?? "").trim().toLowerCase();
  return entries.filter((entry) => {
    if (filters.service && entry.group !== filters.service) return false;
    if (filters.ecosystem && entry.ecosystem !== filters.ecosystem) return false;
    if (filters.support && entry.support !== filters.support) return false;
    if (
      filters.custody &&
      !entry.custody.includes(filters.custody as CredentialCustody)
    )
      return false;
    if (
      filters.runtime &&
      !entry.runtimes.includes(filters.runtime as RuntimeClass)
    )
      return false;
    if (filters.evidence && entry.evidence !== filters.evidence) return false;
    if (
      filters.dimension &&
      !implementedDimensions(entry).includes(
        filters.dimension as SupportDimension,
      )
    )
      return false;
    if (needle && !haystack(entry).includes(needle)) return false;
    return true;
  });
}

export type ServiceGroup = { group: string; entries: CatalogEntry[] };

/**
 * One heading per service, one card per alternative. The heading is a label,
 * not a merge: each entry keeps its own support level, custody badges,
 * evidence and configuration state.
 */
export function groupByService(
  entries: readonly CatalogEntry[],
): ServiceGroup[] {
  const groups = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.group) ?? [];
    list.push(entry);
    groups.set(entry.group, list);
  }
  return [...groups.entries()]
    .map(([group, list]) => ({
      group,
      entries: [...list].sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.group.localeCompare(b.group));
}

function facetValues(
  entries: readonly CatalogEntry[],
  pick: (entry: CatalogEntry) => readonly string[],
): string[] {
  return [...new Set(entries.flatMap((entry) => [...pick(entry)]))].sort();
}

export function Chip({
  tone,
  title,
  children,
}: {
  tone?: "ok" | "human" | "stop" | "muted" | "accent";
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      data-ceremony-chip=""
      className="chip"
      {...(tone && tone !== "muted" ? { "data-tone": tone } : {})}
      {...(title ? { title } : {})}
    >
      {children}
    </span>
  );
}

export function SupportBadge({ entry }: { entry: CatalogEntry }) {
  const support = supportPresentation[entry.support];
  return (
    <Chip tone={support.tone} title={support.detail}>
      {support.label}
    </Chip>
  );
}

export function EvidenceChip({ level }: { level: EvidenceLevel }) {
  const evidence = evidencePresentation[level];
  return (
    <Chip tone="muted" title={evidence.detail}>
      Evidence: {evidence.label}
    </Chip>
  );
}

/**
 * What the server says this entry can do, per dimension. It is a report, never
 * a control: a checkbox here would claim the browser can enable a capability,
 * and the browser cannot. Configuration readiness is shown beside it, because
 * "implemented" and "usable in this deployment" are different facts.
 */
export function CapabilityReport({
  capabilities,
  "aria-label": label = "Reported capabilities",
}: {
  capabilities: readonly CapabilityStatus[];
  "aria-label"?: string;
}) {
  if (!capabilities.length)
    return (
      <p className="connector-muted">
        The server reports no capabilities for this connector.
      </p>
    );
  return (
    <table className="connector-capabilities" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">Dimension</th>
          <th scope="col">Implementation</th>
          <th scope="col">Configuration</th>
          <th scope="col">Evidence</th>
        </tr>
      </thead>
      <tbody>
        {capabilities.map((status) => (
          <tr
            key={`${status.dimension}:${status.profile}:${status.runtime}`}
            data-implementation={status.implementation}
          >
            <th scope="row">
              {dimensionLabels[status.dimension]}
              <span className="connector-muted"> · {status.profile}</span>
            </th>
            <td>
              {status.implementation === "implemented"
                ? "Implemented"
                : "Not supported"}
            </td>
            <td>
              {status.configuration === "ready"
                ? "Ready"
                : status.configuration === "missing"
                  ? "Missing"
                  : "Not applicable"}
            </td>
            <td>
              {evidencePresentation[status.evidence].label}
              {status.limitations.length > 0 && (
                <ul className="connector-limitations">
                  {status.limitations.map((limitation) => (
                    <li key={limitation}>{limitation}</li>
                  ))}
                </ul>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface ConnectorEntryCardProps {
  entry: CatalogEntry;
  /** True when this row is one of several alternatives for the same service. */
  alternative?: boolean;
  busy?: boolean;
  onOpen(entry: CatalogEntry): void;
}

export function ConnectorEntryCard({
  entry,
  alternative = false,
  busy = false,
  onOpen,
}: ConnectorEntryCardProps) {
  const missing = entry.configuration.filter(
    (item) => item.required && !item.present,
  );
  const dimensions = implementedDimensions(entry);
  const connectable =
    entry.support !== "catalog-only" &&
    entry.capabilities.some(
      (status) =>
        status.dimension === "authorize" &&
        status.implementation === "implemented",
    );
  return (
    <article
      data-ceremony-card=""
      data-connector-entry={entry.id}
      data-support={entry.support}
      data-status={entry.support === "catalog-only" ? "unavailable" : "available"}
    >
      <span className="connector-mark" aria-hidden="true">
        {entry.displayName.slice(0, 2).toUpperCase()}
      </span>
      <div className="connector-head">
        <h4 className="connector-name">{entry.displayName}</h4>
        <SupportBadge entry={entry} />
      </div>
      <p className="connector-summary">{entry.description}</p>
      <div className="connector-foot">
        <ul className="connector-methods" aria-label={`How ${entry.displayName} is reached`}>
          {alternative && (
            <li>
              <Chip tone="accent" title="One of several ways to reach this service; each keeps its own custody and evidence.">
                via {entry.ecosystem}
              </Chip>
            </li>
          )}
          {entry.custody.map((custody) => (
            <li key={custody}>
              <Chip>{custodyPresentation[custody]}</Chip>
            </li>
          ))}
          {entry.runtimes.map((runtime) => (
            <li key={runtime}>
              <Chip>{runtimePresentation[runtime]}</Chip>
            </li>
          ))}
          <li>
            <EvidenceChip level={entry.evidence} />
          </li>
          {dimensions.length > 0 && (
            <li>
              <Chip title={dimensions.map((value) => dimensionLabels[value]).join(", ")}>
                {dimensions.length} of 12 dimensions
              </Chip>
            </li>
          )}
        </ul>
        {missing.length > 0 && (
          <p className="connector-blocked">
            Missing configuration: {missing.map((item) => item.name).join(", ")}.
            An operator sets these on the server; they are never entered here.
          </p>
        )}
        <div className="connector-foot-end">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => onOpen(entry)}
          >
            {connectable ? `Connect ${entry.displayName}` : `Review ${entry.displayName}`}
          </button>
        </div>
      </div>
    </article>
  );
}

function Facet({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange(value: string): void;
}) {
  if (!options.length) return null;
  return (
    <label className="connector-facet" htmlFor={id}>
      <span>{label}</span>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Any</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface ConnectorDirectoryProps {
  entries: readonly CatalogEntry[];
  viewer?: ConnectorViewer;
  /** Rendering budget per "show more"; search and facets always run over everything. */
  pageSize?: number;
  busy?: boolean;
  error?: string;
  /** Controls above the grid, such as importing a description. */
  toolbar?: ReactNode;
  onOpen(entry: CatalogEntry): void;
  onRetry?(): void;
  id?: string;
  "aria-label"?: string;
}

export function ConnectorDirectory({
  entries,
  pageSize = 24,
  busy = false,
  error = "",
  toolbar,
  onOpen,
  onRetry,
  id = "connector-directory",
  "aria-label": label = "Connector directory",
}: ConnectorDirectoryProps) {
  const [filters, setFilters] = useState<DirectoryFilters>(emptyFilters);
  const [shown, setShown] = useState(pageSize);
  const set = (patch: Partial<DirectoryFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setShown(pageSize);
  };
  const matches = useMemo(
    () => filterCatalog(entries, filters),
    [entries, filters],
  );
  const groups = useMemo(() => groupByService(matches), [matches]);
  // Paging counts cards, not groups, so a service with several alternatives
  // is never split across the boundary in a way that hides one of them.
  const visible: ServiceGroup[] = [];
  let count = 0;
  for (const group of groups) {
    if (count >= shown) break;
    visible.push(group);
    count += group.entries.length;
  }
  const remaining = matches.length - count;
  useEffect(() => {
    setShown(pageSize);
  }, [pageSize]);
  return (
    <section
      data-connector=""
      data-connector-directory=""
      id={id}
      aria-label={label}
    >
      <div className="connector-directory-head">
        <div className="connector-search">
          <label htmlFor={`${id}-search`}>Search connectors</label>
          <input
            id={`${id}-search`}
            type="search"
            value={filters.query}
            autoComplete="off"
            placeholder="Service, ecosystem, custody or capability"
            onInput={(event) => set({ query: event.currentTarget.value })}
            onChange={(event) => set({ query: event.target.value })}
          />
        </div>
        {toolbar}
      </div>
      <div className="connector-facets" role="group" aria-label="Filter connectors">
        <Facet
          id={`${id}-service`}
          label="Service"
          value={filters.service}
          onChange={(value) => set({ service: value })}
          options={facetValues(entries, (entry) => [entry.group]).map(
            (value) => ({ value, label: value }),
          )}
        />
        <Facet
          id={`${id}-ecosystem`}
          label="Ecosystem"
          value={filters.ecosystem}
          onChange={(value) => set({ ecosystem: value })}
          options={facetValues(entries, (entry) => [entry.ecosystem]).map(
            (value) => ({ value, label: value }),
          )}
        />
        <Facet
          id={`${id}-custody`}
          label="Credential custody"
          value={filters.custody}
          onChange={(value) => set({ custody: value })}
          options={facetValues(entries, (entry) => entry.custody).map(
            (value) => ({
              value,
              label: custodyPresentation[value as CredentialCustody] ?? value,
            }),
          )}
        />
        <Facet
          id={`${id}-dimension`}
          label="Capability"
          value={filters.dimension}
          onChange={(value) => set({ dimension: value })}
          options={facetValues(entries, implementedDimensions).map((value) => ({
            value,
            label: dimensionLabels[value as SupportDimension] ?? value,
          }))}
        />
        <Facet
          id={`${id}-runtime`}
          label="Runtime"
          value={filters.runtime}
          onChange={(value) => set({ runtime: value })}
          options={facetValues(entries, (entry) => entry.runtimes).map(
            (value) => ({
              value,
              label: runtimePresentation[value as RuntimeClass] ?? value,
            }),
          )}
        />
        <Facet
          id={`${id}-evidence`}
          label="Evidence level"
          value={filters.evidence}
          onChange={(value) => set({ evidence: value })}
          options={facetValues(entries, (entry) => [entry.evidence]).map(
            (value) => ({
              value,
              label: evidencePresentation[value as EvidenceLevel]?.label ?? value,
            }),
          )}
        />
        <Facet
          id={`${id}-support`}
          label="Support level"
          value={filters.support}
          onChange={(value) => set({ support: value })}
          options={facetValues(entries, (entry) => [entry.support]).map(
            (value) => ({
              value,
              label:
                supportPresentation[value as CatalogEntry["support"]]?.label ??
                value,
            }),
          )}
        />
      </div>
      {error ? (
        <div className="connector-notice" role="alert">
          <p>{error}</p>
          {onRetry && (
            <button type="button" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      ) : busy ? (
        <p role="status">Loading the connector inventory…</p>
      ) : (
        <>
          <p role="status" className="connector-count">
            {matches.length === entries.length
              ? `${entries.length} ${entries.length === 1 ? "connector" : "connectors"}`
              : `${matches.length} of ${entries.length} connectors match`}
          </p>
          {visible.map((group) => (
            <section
              key={group.group}
              className="connector-group"
              aria-label={`${group.group} connectors`}
              data-connector-group={group.group}
            >
              <h3 className="connector-group-name">
                {group.group}
                {group.entries.length > 1 && (
                  <span className="connector-muted">
                    {" "}
                    · {group.entries.length} alternatives, kept separate
                  </span>
                )}
              </h3>
              <div data-ceremony-grid="" role="list">
                {group.entries.map((entry) => (
                  <div role="listitem" key={entry.id}>
                    <ConnectorEntryCard
                      entry={entry}
                      alternative={group.entries.length > 1}
                      onOpen={onOpen}
                    />
                  </div>
                ))}
              </div>
            </section>
          ))}
          {!matches.length && (
            <p className="connector-empty">
              No connector in this deployment matches that. Clear a filter, or
              import a description to add one.
            </p>
          )}
          {remaining > 0 && (
            <button
              type="button"
              className="connector-more"
              onClick={() => setShown((value) => value + pageSize)}
            >
              Show {Math.min(remaining, pageSize)} more of {remaining}
            </button>
          )}
        </>
      )}
    </section>
  );
}
