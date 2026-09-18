import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  authFamilyLabels,
  categories,
  categoryCounts,
  customEntries,
  entriesInCategory,
  searchEntries,
  type Category,
  type CatalogEntry,
} from "./catalog.js";

/**
 * Browse before commit.
 *
 * The catalogue answers one question — is the thing I need here, and what will
 * connecting it involve — and defers everything else to the drawer. So a card
 * carries the service, one sentence, and the badges that decide whether a
 * person keeps reading; it never carries a protocol picker, because choosing
 * between PKCE and a device code is not a thing anybody browsing a directory
 * has an opinion about.
 */

function initials(name: string): string {
  const words = name.split(/[\s-]+/).filter(Boolean);
  return (
    words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : name.slice(0, 2)
  ).toUpperCase();
}

const supportBadges = {
  "provider-backed": { label: "Provider-backed", tone: "managed" },
  fixture: { label: "Local fixture", tone: "" },
  declared: { label: "Bring your own", tone: "declared" },
} as const;

/** Small, original line glyphs. Icon fonts and brand assets stay out of this app. */
function Glyph({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    spark: (
      <path d="M12 3l2.2 5.4L20 10l-5.8 1.6L12 17l-2.2-5.4L4 10l5.8-1.6z" />
    ),
    chart: <path d="M4 19V9m5 10V5m5 14v-7m5 7V8" />,
    card: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 10h18" />
      </>
    ),
    chat: <path d="M4 5h16v10H9l-5 4z" />,
    image: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 16l5-4 4 3 3-2 6 5" />
      </>
    ),
    database: (
      <>
        <ellipse cx="12" cy="6" rx="8" ry="3" />
        <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
      </>
    ),
    code: <path d="M9 7l-5 5 5 5m6-10l5 5-5 5" />,
    clipboard: (
      <>
        <rect x="5" y="4" width="14" height="17" rx="2" />
        <path d="M9 4h6v3H9z" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="6.5" />
        <path d="M16 16l4.5 4.5" />
      </>
    ),
    back: <path d="M14 6l-6 6 6 6" />,
    next: <path d="M10 6l6 6-6 6" />,
    close: <path d="M6 6l12 12M18 6L6 18" />,
    agent: (
      <>
        <rect x="4" y="8" width="16" height="11" rx="3" />
        <path d="M12 8V4M8.5 13v1.5M15.5 13v1.5" />
      </>
    ),
  };
  return (
    <svg
      className="glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

const categoryGlyphs: Record<Category, string> = {
  AI: "spark",
  Analytics: "chart",
  Commerce: "card",
  Communication: "chat",
  Content: "image",
  Data: "database",
  Developer: "code",
  Productivity: "clipboard",
  Other: "grid",
};

export function ConnectorCard({
  entry,
  onOpen,
}: {
  entry: CatalogEntry;
  onOpen(entry: CatalogEntry): void;
}) {
  const support = supportBadges[entry.support];
  return (
    <article className="connector-card">
      <span
        className="mark"
        aria-hidden="true"
        {...(entry.tint
          ? { style: { background: entry.tint, borderColor: entry.tint } }
          : {})}
      >
        {initials(entry.name)}
      </span>
      <h3>
        {/* The name is the control. Everything else on the card is description,
            so the accessible name of the only button is the service itself. */}
        <button
          type="button"
          className="card-link"
          onClick={() => onOpen(entry)}
        >
          {entry.name}
        </button>
      </h3>
      <p>{entry.summary}</p>
      <ul className="badge-row">
        <li>
          <span className="badge" data-tone={support.tone || undefined}>
            {support.label}
          </span>
        </li>
        {/* Every flow, not a count: "+2" is the two a reader most wanted. */}
        {entry.auth.map((family) => (
          <li key={family}>
            <span className="badge">
              {authFamilyLabels[family].split(" · ")[0]}
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}

/** One page of the featured strip, sized to whatever the grid is showing. */
const featuredPageSize = 3;

export interface ConnectCatalogProps {
  entries: readonly CatalogEntry[];
  workspace: string;
  /** Rendered under the grid: surfaces that belong on the page people open. */
  footer?: ReactNode;
  /** Controls that belong beside the breadcrumb, such as installing the app. */
  topbarExtra?: ReactNode;
  /** Shown under the title: the directory must not look confident when it is not. */
  notice?: ReactNode;
  onOpen(entry: CatalogEntry): void;
  onNavigate(section: "connect" | "studio" | "environment"): void;
}

export function ConnectCatalog({
  entries,
  workspace,
  footer,
  topbarExtra,
  notice,
  onOpen,
  onNavigate,
}: ConnectCatalogProps) {
  const [category, setCategory] = useState<Category | "all">("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const counts = useMemo(() => categoryCounts(entries), [entries]);
  const visible = useMemo(
    () => searchEntries(entriesInCategory(entries, category), query),
    [entries, category, query],
  );
  const featured = useMemo(
    () => entries.filter((entry) => entry.featured),
    [entries],
  );
  const pages = Math.max(1, Math.ceil(featured.length / featuredPageSize));
  const shown = featured.slice(
    page * featuredPageSize,
    page * featuredPageSize + featuredPageSize,
  );
  // "/" is the directory's own shortcut, and must not steal the key from
  // anybody who is already typing into something.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "") ||
        // A modal is open: the directory behind it is not the thing being used.
        document.querySelector('[role="dialog"][aria-modal="true"]')
      )
        return;
      event.preventDefault();
      search.current?.focus();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      <nav className="connect-rail" aria-label="Connect">
        {/* A label, not a control. The hosted product this shell is modelled
            on opens a workspace picker here; this application has exactly one
            workspace, so a chevron and a focus stop would promise a menu that
            never arrives. The name still belongs on screen — it is how a
            person tells the live workspace from the test harness. */}
        <div className="workspace-switch">
          <span className="avatar" />
          <span className="workspace-name">{workspace}</span>
          <span className="plan-badge">Local</span>
        </div>
        <button
          type="button"
          className="rail-find"
          onClick={() => search.current?.focus()}
        >
          <Glyph name="search" />
          <span className="grow">Find</span>
          <kbd>/</kbd>
        </button>
        <div className="rail-section">
          <span className="rail-back" aria-hidden="true">
            <Glyph name="back" />
          </span>
          <h2>Connect</h2>
        </div>
        <div
          className="rail-nav"
          role="group"
          aria-label="Connector categories"
        >
          <button
            type="button"
            className="rail-item"
            aria-pressed={category === "all"}
            onClick={() => setCategory("all")}
          >
            <Glyph name="grid" />
            <span className="label">Any category</span>
            <span className="count">{entries.length}</span>
          </button>
          {categories.map((name) => (
            <button
              key={name}
              type="button"
              className="rail-item"
              aria-pressed={category === name}
              onClick={() => setCategory(name)}
            >
              <Glyph name={categoryGlyphs[name]} />
              <span className="label">{name}</span>
              <span className="count">{counts[name]}</span>
            </button>
          ))}
        </div>
        <div className="rail-section">
          <h2>Workspace</h2>
        </div>
        <div className="rail-nav" role="group" aria-label="Workspace">
          <button
            type="button"
            className="rail-item"
            aria-current="page"
            onClick={() => onNavigate("connect")}
          >
            <Glyph name="grid" />
            <span className="label">Connect</span>
          </button>
          <button
            type="button"
            className="rail-item"
            onClick={() => onNavigate("studio")}
          >
            <Glyph name="code" />
            <span className="label">Workflow studio</span>
          </button>
          <button
            type="button"
            className="rail-item"
            onClick={() => onNavigate("environment")}
          >
            <Glyph name="database" />
            <span className="label">Environment</span>
          </button>
        </div>
      </nav>
      <div className="connect-main">
        <header className="connect-topbar">
          {/* Scope label, for the same reason as the workspace name above. */}
          <span className="project-switch">All Projects</span>
          <div className="crumbs">
            {/* A button, not an href. `/` is not this surface's address once a
                mode is chosen: the test harness runs at `?mode=test`, and a
                crumb that navigated there by URL would drop the harness and
                reload the workspace to reach a page the person is already on. */}
            <button type="button" onClick={() => onNavigate("connect")}>
              Connect
            </button>
            <span className="sep" aria-hidden="true">
              /
            </span>
            <span aria-current="page">Browse Connectors</span>
          </div>
          <div className="topbar-end">
            {topbarExtra}
            <button
              type="button"
              className="ghost-button"
              onClick={() => onNavigate("studio")}
            >
              <Glyph name="agent" />
              Agent
            </button>
          </div>
        </header>
        <main className="connect-body">
          <div className="catalog-title">
            <h1>Connections</h1>
            <p>
              Choose a service. Compatible setup you already completed is
              reused, and only what is missing is asked for.
            </p>
          </div>
          {notice}
          <div className="catalog-search">
            <Glyph name="search" />
            <input
              ref={search}
              type="search"
              value={query}
              aria-label="Search connectors"
              placeholder="Search connectors…"
              onChange={(event) => setQuery(event.target.value)}
            />
            <kbd>/</kbd>
          </div>
          {!query && category === "all" && featured.length > 0 && (
            <section aria-labelledby="featured-heading">
              <div className="section-head">
                <h2 id="featured-heading">Featured</h2>
                <div className="carousel-controls">
                  <button
                    type="button"
                    className="round-button"
                    aria-label="Previous featured connectors"
                    disabled={page === 0}
                    onClick={() => setPage((value) => Math.max(0, value - 1))}
                  >
                    <Glyph name="back" />
                  </button>
                  <button
                    type="button"
                    className="round-button"
                    aria-label="Next featured connectors"
                    disabled={page >= pages - 1}
                    onClick={() =>
                      setPage((value) => Math.min(pages - 1, value + 1))
                    }
                  >
                    <Glyph name="next" />
                  </button>
                </div>
              </div>
              <ul className="card-grid">
                {shown.map((entry) => (
                  <li key={entry.id}>
                    <ConnectorCard entry={entry} onOpen={onOpen} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!query && category === "all" && (
            <section aria-labelledby="byo-heading">
              <div className="section-head">
                <div>
                  <h2 id="byo-heading">Bring your own</h2>
                  <p className="section-note">
                    Every protocol this workspace can run. Point one at a
                    service that is not listed below, or record a sign-in for a
                    service that publishes no API at all.
                  </p>
                </div>
              </div>
              <ul className="card-grid">
                {customEntries.map((entry) => (
                  <li key={entry.id}>
                    <ConnectorCard entry={entry} onOpen={onOpen} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-labelledby="all-heading">
            <div className="section-head">
              <h2 id="all-heading">
                {query
                  ? `Results for “${query}”`
                  : category === "all"
                    ? "All Connectors"
                    : category}
              </h2>
            </div>
            {visible.length ? (
              <ul className="card-grid">
                {visible.map((entry) => (
                  <li key={entry.id}>
                    <ConnectorCard entry={entry} onOpen={onOpen} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="catalog-empty">
                No connector matches that yet. Any OAuth, API key or
                browser-login service can still be added from the Developer
                category.
              </p>
            )}
          </section>
          {footer}
        </main>
      </div>
    </>
  );
}

export { Glyph, initials };
