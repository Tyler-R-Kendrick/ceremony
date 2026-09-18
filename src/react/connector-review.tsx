"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CompatibilityIssue,
  ConnectorImportResult,
  MappingDisposition,
  NormalizedDefinition,
  SupportDimension,
} from "../core/connectors/index.js";
import {
  canPublish,
  groupIssues,
  sortIssues,
  type ConnectorClient,
  type ConnectorViewer,
  type DefinitionReview,
  type ImportInput,
} from "../core/connectors/client.js";
import { Chip, dimensionLabels } from "./connector-directory.js";

/**
 * Import review: what actually arrived, and what it costs.
 *
 * An importer's real output is not a connector, it is a description plus a list
 * of everything the runtime could not honour. This surface is built around that
 * list. Blocking issues come first and are grouped by category, because a
 * security requirement nobody can execute decides whether this connector may be
 * bound at all, while a serialization quirk decides one operation.
 *
 * Nothing here echoes the source document. A description may contain a key in
 * an example, a signed URL, or an embedded header; so the page renders the
 * issue's code, its pointer and the sanitized message the importer wrote, and
 * never the bytes those point at.
 *
 * Binding and activation appear only when the server says this viewer holds the
 * role. When it says nothing, they are hidden — a control that is offered and
 * then refused teaches somebody that the refusal is a bug.
 */

const dispositionCopy: Record<MappingDisposition, string> = {
  exact: "Carried across exactly",
  adapted: "Adapted to an equivalent this runtime can execute",
  "native-extension": "Kept as a native extension; inert here",
  "requires-configuration": "Needs configuration before it can run",
  unsupported: "Not supported by this runtime",
  rejected: "Refused",
};

const severityTone = {
  blocking: "stop",
  warning: "human",
  info: "muted",
} as const;

export function IssueList({
  issues,
  "aria-label": label = "Import diagnostics",
}: {
  issues: readonly CompatibilityIssue[];
  "aria-label"?: string;
}) {
  const groups = useMemo(() => groupIssues(issues), [issues]);
  if (!issues.length)
    return (
      <p className="connector-muted">
        The importer reported nothing it could not carry across.
      </p>
    );
  return (
    <div data-connector-issues="" aria-label={label} role="group">
      {groups.map((group) => (
        <section key={group.category} data-connector-issue-group={group.category}>
          <h5>
            {group.category}
            {group.blocking > 0 && (
              <>
                {" "}
                <Chip tone="stop">{group.blocking} blocking</Chip>
              </>
            )}
          </h5>
          <ul className="connector-issue-list">
            {group.issues.map((issue) => (
              <li
                key={`${issue.code}:${issue.sourcePointer}:${issue.dimension}`}
                data-severity={issue.severity}
              >
                <p>
                  <Chip tone={severityTone[issue.severity]}>
                    {issue.severity}
                  </Chip>{" "}
                  <code>{issue.code}</code>
                </p>
                <p>{issue.message}</p>
                {issue.remediation && (
                  <p className="connector-muted">{issue.remediation}</p>
                )}
                <p className="connector-muted">
                  {dimensionLabels[issue.dimension]} ·{" "}
                  {dispositionCopy[issue.disposition]} ·{" "}
                  {issue.executionImpact === "none"
                    ? "blocks nothing"
                    : issue.executionImpact.replaceAll("-", " ")}{" "}
                  · at <code>{issue.sourcePointer || "/"}</code>
                </p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function DimensionTable({
  dimensions,
}: {
  dimensions: Partial<Record<SupportDimension, MappingDisposition>>;
}) {
  const rows = Object.entries(dimensions) as Array<
    [SupportDimension, MappingDisposition]
  >;
  return (
    <table className="connector-capabilities" aria-label="Mapped dimensions">
      <thead>
        <tr>
          <th scope="col">Dimension</th>
          <th scope="col">How it mapped</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([dimension, disposition]) => (
          <tr key={dimension} data-disposition={disposition}>
            <th scope="row">{dimensionLabels[dimension] ?? dimension}</th>
            <td>{dispositionCopy[disposition]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProfileSummary({ definition }: { definition: NormalizedDefinition }) {
  return (
    <ul className="connector-profile-list" aria-label="Proposed authentication">
      {definition.authentication.map((profile) => {
        const scopes = (profile as { scopes?: string[] }).scopes ?? [];
        const endpoints = Object.entries(profile)
          .filter(
            ([key, value]) =>
              typeof value === "string" &&
              /Endpoint$|^issuer$/.test(key) &&
              value.length > 0,
          )
          .map(([key, value]) => `${key}: ${String(value)}`);
        return (
          <li key={profile.id} data-profile-kind={profile.kind}>
            <p>
              <strong>{profile.label}</strong>{" "}
              <Chip>{profile.kind}</Chip>
              {profile.kind === "unsupported" && (
                <>
                  {" "}
                  <Chip tone="stop">not executable</Chip>
                </>
              )}
            </p>
            {endpoints.length > 0 && (
              <ul className="connector-scopes">
                {endpoints.map((endpoint) => (
                  <li key={endpoint}>
                    <code>{endpoint}</code>
                  </li>
                ))}
              </ul>
            )}
            {scopes.length > 0 && (
              <p className="connector-muted">
                Requests: {scopes.map((scope) => scope).join(", ")}
              </p>
            )}
            <p className="connector-muted">
              Declared by the source. Nothing here is approved until a binding
              pins it.
            </p>
          </li>
        );
      })}
    </ul>
  );
}

export function DefinitionReviewPanel({
  review,
  viewer,
  busy,
  onBind,
}: {
  review: DefinitionReview;
  viewer?: ConnectorViewer;
  busy?: boolean;
  onBind?(review: DefinitionReview, profileId?: string): void;
}) {
  const { definition, source } = review;
  const [profileId, setProfileId] = useState(
    definition.authentication[0]?.id ?? "",
  );
  const blocking = sortIssues(definition.compatibility.issues).filter(
    (issue) => issue.severity === "blocking",
  );
  const operator = canPublish(viewer);
  return (
    <section
      data-connector-definition={definition.definitionRef}
      className="connector-panel"
      aria-label={`Review ${definition.display.name}`}
    >
      <h4>{definition.display.name}</h4>
      <p>{definition.display.description}</p>

      <h5>Where this came from</h5>
      <dl className="connector-facts" data-connector-provenance="">
        <dt>Format</dt>
        <dd>
          {source.format.name} {source.format.version}
          {source.format.dialect ? ` · ${source.format.dialect}` : ""}
        </dd>
        <dt>Origin</dt>
        <dd>
          {source.origin.kind}
          {source.origin.location ? (
            <>
              {" · "}
              <code>{source.origin.location}</code>
            </>
          ) : null}
        </dd>
        <dt>Captured</dt>
        <dd>
          <time dateTime={source.capturedAt}>{source.capturedAt}</time>
        </dd>
        <dt>Exact bytes</dt>
        <dd>
          <code>
            {source.digest.algorithm}:{source.digest.value.slice(0, 16)}…
          </code>{" "}
          ({source.byteLength} bytes)
        </dd>
        <dt>Normalized document</dt>
        <dd>
          <code>sha256:{definition.normalizedDigest.slice(0, 16)}…</code>
        </dd>
        <dt>Identity</dt>
        <dd>
          <code>{definition.identity.nativeId}</code> version{" "}
          <code>{definition.identity.nativeVersion}</code>
          {definition.identity.authorityNamespace ? (
            <>
              {" "}
              in <code>{definition.identity.authorityNamespace}</code>
            </>
          ) : null}
        </dd>
        <dt>Importer</dt>
        <dd>
          {definition.importer.id} {definition.importer.version}
        </dd>
        <dt>Licence</dt>
        <dd>
          {source.license
            ? `${source.license.spdx ?? "unstated"} · redistributable: ${String(source.license.redistributable)}`
            : "Not stated by the source. Treat redistribution as unknown."}
        </dd>
        {source.overlays.length > 0 && (
          <>
            <dt>Overlays applied</dt>
            <dd>
              <ul>
                {source.overlays.map((overlay) => (
                  <li key={overlay.sourceRef}>
                    <code>{overlay.sourceRef}</code> ·{" "}
                    <code>{overlay.digest.slice(0, 16)}…</code>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>

      {blocking.length > 0 && (
        <div className="connector-notice" role="alert" data-connector-blocking="">
          <h5>
            {blocking.length} security-relevant{" "}
            {blocking.length === 1 ? "loss" : "losses"} block execution
          </h5>
          <p>
            These are shown before anything can be connected, because they
            decide whether it can be. Nothing from the source document itself is
            reproduced here.
          </p>
        </div>
      )}

      <h5>What the importer could not carry across</h5>
      <IssueList
        issues={definition.compatibility.issues}
        aria-label={`${definition.display.name} diagnostics`}
      />

      <h5>How each dimension mapped</h5>
      <DimensionTable dimensions={definition.compatibility.dimensions} />

      <h5>Proposed authentication</h5>
      <ProfileSummary definition={definition} />

      <h5>Endpoints the source declares</h5>
      {definition.declaredServers.length ? (
        <ul className="connector-scopes">
          {definition.declaredServers.map((server) => (
            <li key={server.url}>
              <code>{server.url}</code>
              {server.description ? ` — ${server.description}` : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p className="connector-muted">The source declares no servers.</p>
      )}
      <p className="connector-muted">
        Declared, not approved. A binding decides what may actually be
        contacted, and an imported URL never becomes one on its own.
      </p>

      <h5>Runtime requirements</h5>
      {definition.configuration.length ? (
        <ul className="connector-configuration">
          {definition.configuration.map((item) => (
            <li key={item.name}>
              <code>{item.name}</code> — {item.classification},{" "}
              {item.required ? "required" : "optional"}, supplied by{" "}
              {item.source.replaceAll("-", " ")}
              {item.description ? ` — ${item.description}` : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p className="connector-muted">No configuration is required.</p>
      )}

      <h5>Capabilities described</h5>
      <p className="connector-muted">
        {definition.capabilities.length} described;{" "}
        {
          definition.capabilities.filter(
            (capability) => capability.effect === "write",
          ).length
        }{" "}
        declare a write effect. A described capability is not an approved
        operation.
      </p>

      {operator ? (
        <div className="connector-actions" data-connector-publish="">
          {definition.authentication.length > 1 && (
            <label className="connector-field" htmlFor="connector-bind-profile">
              <span>Bind with</span>
              <select
                id="connector-bind-profile"
                value={profileId}
                onChange={(event) => setProfileId(event.target.value)}
              >
                {definition.authentication.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className="primary"
            disabled={busy || blocking.length > 0 || !onBind}
            onClick={() => onBind?.(review, profileId || undefined)}
          >
            Propose a runtime binding
          </button>
          {blocking.length > 0 && (
            <p className="connector-muted">
              Binding stays unavailable while a blocking issue stands. The
              server refuses it too; this is not only a screen.
            </p>
          )}
        </div>
      ) : (
        <p className="connector-muted" data-connector-readonly="">
          Reviewing only. Binding and activation need an operator role, which
          this session does not hold.
        </p>
      )}
    </section>
  );
}

export interface ConnectorImportProps {
  client: ConnectorClient;
  viewer?: ConnectorViewer;
  onImported?(result: ConnectorImportResult): void;
  onBound?(definitionRef: string): void;
}

export function ConnectorImport({
  client,
  viewer,
  onImported,
  onBound,
}: ConnectorImportProps) {
  const [kind, setKind] = useState<"upload" | "url">("upload");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [mediaType, setMediaType] = useState("application/json");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issues, setIssues] = useState<CompatibilityIssue[]>([]);
  const [result, setResult] = useState<ConnectorImportResult>();
  const [reviews, setReviews] = useState<DefinitionReview[]>([]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (input: ImportInput) => {
      setBusy(true);
      setError("");
      setIssues([]);
      setResult(undefined);
      setReviews([]);
      try {
        const imported = await client.import(input);
        if (!mounted.current) return;
        setResult(imported);
        setIssues(imported.issues);
        onImported?.(imported);
        const loaded: DefinitionReview[] = [];
        for (const ref of imported.definitions)
          loaded.push(await client.definition(ref));
        if (mounted.current) setReviews(loaded);
      } catch (failure) {
        if (!mounted.current) return;
        // A rejected document reports codes, pointers and the importer's own
        // message. The document is not echoed, so a key in an example value
        // cannot arrive on screen with the error that found it.
        const withIssues = failure as { issues?: CompatibilityIssue[] };
        setIssues(withIssues.issues ?? []);
        setError(
          failure instanceof Error
            ? failure.message
            : "That document could not be imported.",
        );
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [client, onImported],
  );

  return (
    <div data-connector="" data-connector-import="" className="connector-panel">
      <h3>Import a connector description</h3>
      <p className="connector-muted">
        An imported description is not a runtime binding. It is reviewed here,
        and an operator binds it afterwards if the review says it can be.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            kind === "url"
              ? { kind: "url", url }
              : { kind: "upload", mediaType, text },
          );
        }}
      >
        <fieldset className="connector-field">
          <legend>Where it comes from</legend>
          <label>
            <input
              type="radio"
              name="connector-import-kind"
              value="upload"
              checked={kind === "upload"}
              onChange={() => setKind("upload")}
            />
            A document I have
          </label>
          <label>
            <input
              type="radio"
              name="connector-import-kind"
              value="url"
              checked={kind === "url"}
              onChange={() => setKind("url")}
            />
            A URL the server should fetch
          </label>
        </fieldset>
        {kind === "url" ? (
          <label className="connector-field" htmlFor="connector-import-url">
            <span>Document URL</span>
            <input
              id="connector-import-url"
              type="url"
              value={url}
              required
              onChange={(event) => setUrl(event.target.value)}
            />
            <span className="connector-muted">
              The server fetches it under its own network policy. Private and
              metadata addresses are refused unless an administrator approved
              that exact destination.
            </span>
          </label>
        ) : (
          <>
            <label
              className="connector-field"
              htmlFor="connector-import-media-type"
            >
              <span>Media type</span>
              <select
                id="connector-import-media-type"
                value={mediaType}
                onChange={(event) => setMediaType(event.target.value)}
              >
                <option value="application/json">application/json</option>
                <option value="application/yaml">application/yaml</option>
                <option value="application/vnd.oai.openapi+json">
                  application/vnd.oai.openapi+json
                </option>
              </select>
            </label>
            <label className="connector-field" htmlFor="connector-import-text">
              <span>Document</span>
              <textarea
                id="connector-import-text"
                value={text}
                required
                rows={8}
                spellCheck={false}
                onChange={(event) => setText(event.target.value)}
              />
            </label>
          </>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Importing…" : "Import and review"}
        </button>
      </form>

      {error && (
        <p role="alert" className="connector-error">
          {error}
        </p>
      )}
      {issues.length > 0 && (
        <>
          <h4>Diagnostics</h4>
          <IssueList issues={issues} />
        </>
      )}
      {result && (
        <p role="status">
          {result.definitions.length}{" "}
          {result.definitions.length === 1 ? "description" : "descriptions"} read
          from <code>{result.sourceRef}</code>;{" "}
          {result.executableCandidates.length} capability
          {result.executableCandidates.length === 1 ? "" : "s"} a reviewer may
          bind. Nothing executable was registered by this import.
        </p>
      )}
      {reviews.map((review) => (
        <DefinitionReviewPanel
          key={review.definition.definitionRef}
          review={review}
          {...(viewer ? { viewer } : {})}
          busy={busy}
          onBind={(chosen, profileId) => {
            setBusy(true);
            setError("");
            client
              .createBinding({
                definitionRef: chosen.definition.definitionRef,
                ...(profileId ? { profileId } : {}),
              })
              .then((binding) => {
                if (!mounted.current) return;
                onBound?.(binding.definitionRef);
              })
              .catch((failure: unknown) => {
                if (mounted.current)
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : "The server declined this binding.",
                  );
              })
              .finally(() => {
                if (mounted.current) setBusy(false);
              });
          }}
        />
      ))}
    </div>
  );
}

export default ConnectorImport;
