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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [openId, setOpenId] = useState(initial.connector);
  const [connectionRef, setConnectionRef] = useState(initial.connection ?? "");
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
        if (!abort.signal.aborted)
          setDefinitions((current) => ({
            ...current,
            [ref]: review.definition,
          }));
      })
      .catch(() => {
        /* The drawer works without it; it just offers fewer choices. */
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
    setConnectionRef("");
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
          setConnectionRef("");
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
            key={`${entry.id}:${connectionRef}`}
            client={client}
            entry={entry}
            bindings={bindings}
            {...(entry.definitionRef && definitions[entry.definitionRef]
              ? { definition: definitions[entry.definitionRef] }
              : {})}
            {...(viewer ? { viewer } : {})}
            {...(connectionRef ? { connectionRef } : {})}
            {...(openWindow ? { openWindow } : {})}
            {...(pollIntervalMs ? { pollIntervalMs } : {})}
            readOperations={[
              {
                operationRef: "operation:listRepositories",
                label: "Read something with it",
              },
            ]}
            onConnectionChange={(connection) => {
              setConnectionRef(connection.connectionRef);
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
