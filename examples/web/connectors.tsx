import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  BindingReference,
  CatalogEntry,
  NormalizedDefinition,
} from "../../src/core/connectors/index.js";
// The typed browser client is imported directly: the core barrel does not
// export it yet, and that addition is the integrator's to make.
import {
  createConnectorClient,
  readConnectorReturn,
  type ConnectorClient,
  type ConnectorViewer,
} from "../../src/core/connectors/client.js";
import { ConnectorDirectory } from "../../src/react/connector-directory.js";
import { ConnectorDrawer } from "../../src/react/connector-drawer.js";
import { ConnectorConnection } from "../../src/react/connector-connection.js";
import "../../src/react/connectors.css";

/**
 * The connector workspace: a directory, and a drawer that connects one thing.
 *
 * The page keeps the deep links the application already had. `/` opens on the
 * directory; a link that names a connector opens the drawer on it, because
 * that link is somebody returning to work they started, and landing inside a
 * modal they did not ask for puts a scrim over the navigation. `?connection=`
 * — what the server's callback route sends back — reopens that connection and
 * reads its status from the server before showing anything.
 *
 * The import and review surfaces are loaded on demand. Most people never open
 * them, and they are the largest part of this feature; making the directory
 * pay for them on every visit would be the wrong trade.
 */
const ConnectorImport = lazy(async () => ({
  default: (await import("../../src/react/connector-review.js"))
    .ConnectorImport,
}));

export interface ConnectorWorkspaceProps {
  /** Supplied by tests and hosts; otherwise the same-origin command surface. */
  client?: ConnectorClient;
  base?: string;
  /** Host-owned window management, so a test can model a blocked popup. */
  openWindow?(url: string, name: string): Window | null;
  pollIntervalMs?: number;
  /** Read once on mount; defaults to the page's own query string. */
  search?: string;
}

function keepQuery(next: URLSearchParams, current: URLSearchParams) {
  for (const name of ["mode", "section"]) {
    const value = current.get(name);
    if (value) next.set(name, value);
  }
  return next;
}

/** Drops one key, so a read that succeeded stops reporting the one that failed. */
const forget =
  (ref: string) =>
  (current: Record<string, string>): Record<string, string> => {
    if (!(ref in current)) return current;
    const next = { ...current };
    delete next[ref];
    return next;
  };

export function ConnectorWorkspace({
  client: supplied,
  base,
  openWindow,
  pollIntervalMs,
  search,
}: ConnectorWorkspaceProps) {
  const client = useMemo(
    () => supplied ?? createConnectorClient(base ? { base } : {}),
    [supplied, base],
  );
  const initial = useMemo(() => {
    const query =
      search ?? (typeof location === "undefined" ? "" : location.search);
    const params = new URLSearchParams(query);
    return {
      params,
      connector: params.get("connector") ?? "",
      ...readConnectorReturn(query),
    };
  }, [search]);

  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [viewer, setViewer] = useState<ConnectorViewer>();
  const [bindings, setBindings] = useState<BindingReference[]>([]);
  const [definitions, setDefinitions] = useState<
    Record<string, NormalizedDefinition>
  >({});
  const [definitionErrors, setDefinitionErrors] = useState<
    Record<string, string>
  >({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [openId, setOpenId] = useState(initial.connector);
  /*
   * Only the connection this page was *opened* on is a resume. A connection
   * created here must not become one: feeding it back as the drawer's key
   * would remount the surface mid-flow and throw away what it knows about the
   * window it just opened.
   */
  const [resumeRef, setResumeRef] = useState(initial.connection ?? "");
  const [importing, setImporting] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setBusy(true);
    Promise.all([
      client.catalog(abort.signal),
      client.bindings(abort.signal).catch(() => ({ bindings: [] })),
    ])
      .then(([catalog, bound]) => {
        if (abort.signal.aborted) return;
        setEntries(catalog.entries);
        setViewer(catalog.viewer);
        setBindings(bound.bindings);
        setError("");
      })
      .catch((failure: unknown) => {
        if (abort.signal.aborted) return;
        setError(
          failure instanceof Error
            ? failure.message
            : "The connector inventory could not be loaded.",
        );
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [client, reload]);

  const entry = entries.find((item) => item.id === openId);

  // The description behind an entry is fetched only when its drawer opens: it
  // carries the authentication profiles and the diagnostics that decide
  // whether connecting is possible at all.
  useEffect(() => {
    const ref = entry?.definitionRef;
    if (!ref || definitions[ref]) return;
    const abort = new AbortController();
    client
      .definition(ref, abort.signal)
      .then((review) => {
        if (abort.signal.aborted) return;
        setDefinitions((current) => ({
          ...current,
          [ref]: review.definition,
        }));
        setDefinitionErrors(forget(ref));
      })
      .catch((failure: unknown) => {
        if (abort.signal.aborted) return;
        // The rest of the drawer works without it, but connecting must not:
        // the diagnostics that decide whether this connector can be authorized
        // at all are in the description, so a failed read is reported to the
        // surface instead of leaving it to assume there was nothing to report.
        setDefinitionErrors((current) => ({
          ...current,
          [ref]:
            failure instanceof Error
              ? failure.message
              : "This connector's description could not be read.",
        }));
      });
    return () => abort.abort();
  }, [entry?.definitionRef, client, definitions]);

  const rewrite = useCallback(
    (patch: { connector?: string; connection?: string }) => {
      if (typeof location === "undefined" || typeof history === "undefined")
        return;
      const next = keepQuery(
        new URLSearchParams(),
        new URLSearchParams(location.search),
      );
      if (patch.connector) next.set("connector", patch.connector);
      if (patch.connection) next.set("connection", patch.connection);
      const query = next.toString();
      history.replaceState(null, "", query ? `/?${query}` : "/");
    },
    [],
  );

  const close = useCallback(() => {
    setOpenId("");
    setResumeRef("");
    rewrite({});
  }, [rewrite]);

  return (
    <div className="connector-workspace">
      <ConnectorDirectory
        entries={entries}
        {...(viewer ? { viewer } : {})}
        busy={busy}
        error={error}
        onRetry={() => setReload((value) => value + 1)}
        onOpen={(chosen) => {
          setOpenId(chosen.id);
          setResumeRef("");
          rewrite({ connector: chosen.id });
        }}
        toolbar={
          <button
            type="button"
            data-connector-import-toggle=""
            onClick={() => setImporting((value) => !value)}
          >
            {importing ? "Hide import" : "Import a description"}
          </button>
        }
      />
      {importing && (
        <Suspense fallback={<p role="status">Loading the import review…</p>}>
          <ConnectorImport
            client={client}
            {...(viewer ? { viewer } : {})}
            onBound={() => setReload((value) => value + 1)}
          />
        </Suspense>
      )}
      <ConnectorDrawer
        open={Boolean(entry)}
        title={entry ? `Connect ${entry.displayName}` : "Connect"}
        subtitle={entry ? `${entry.ecosystem} · ${entry.service}` : undefined}
        onClose={close}
        footer={
          <p>
            Setup is kept between steps, and only verified provider access
            completes a connection. Closing this drawer changes nothing at the
            provider.
          </p>
        }
      >
        {entry && (
          <ConnectorConnection
            key={`${entry.id}:${resumeRef}`}
            client={client}
            entry={entry}
            bindings={bindings}
            {...(entry.definitionRef && definitions[entry.definitionRef]
              ? { definition: definitions[entry.definitionRef] }
              : {})}
            {...(entry.definitionRef && definitionErrors[entry.definitionRef]
              ? { definitionError: definitionErrors[entry.definitionRef] }
              : {})}
            {...(viewer ? { viewer } : {})}
            {...(resumeRef ? { connectionRef: resumeRef } : {})}
            {...(openWindow ? { openWindow } : {})}
            {...(pollIntervalMs ? { pollIntervalMs } : {})}
            readOperations={[
              {
                operationRef: "operation:listRepositories",
                label: "Read something with it",
              },
            ]}
            onConnectionChange={(connection) => {
              // The address is updated so a reload or a provider round trip
              // comes back to this connection; the surface keeps running.
              rewrite({
                connector: entry.id,
                connection: connection.connectionRef,
              });
            }}
          />
        )}
      </ConnectorDrawer>
    </div>
  );
}

export default ConnectorWorkspace;
