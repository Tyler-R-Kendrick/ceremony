"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { z } from "zod";
import type {
  BindingReference,
  CatalogEntry,
  ConnectionLifecycle,
  ConnectionSummary,
  NormalizedDefinition,
  OwnerKind,
} from "../core/connectors/index.js";
import {
  canPublish,
  connectBlockers,
  isTrustedHandoffMessage,
  isUnauthenticated,
  ownerKindPermitted,
  type ConnectionView,
  type ConnectorClient,
  type ConnectorViewer,
  type DisconnectResult,
  type DisconnectScope,
  type FieldDescriptor,
  type FieldOption,
  type InvokeOutcome,
} from "../core/connectors/client.js";
import {
  CapabilityReport,
  Chip,
  EvidenceChip,
  custodyPresentation,
  runtimePresentation,
  supportPresentation,
} from "./connector-directory.js";
import { HandoffMeter, StatusChip } from "./connectors.js";

/**
 * One connection, from the decision to make it to the decision to end it.
 *
 * Every control here is an input to a server command or it does not exist.
 * There is no capability switch, because the browser cannot grant a capability;
 * there is no "skip verification", because verified is a claim the server makes
 * after reading something real; and there is no shared-key toggle, because a
 * radio button cannot change who owns a grant. What the server reports is
 * displayed; what the server decides is asked for.
 *
 * Status never comes from this file's own optimism. A closed popup, a
 * postMessage and a person clicking "I finished" all do exactly one thing:
 * ask the server. What comes back is what is shown.
 */

export const lifecyclePresentation: Record<
  ConnectionLifecycle,
  {
    label: string;
    tone: "connected" | "attention" | "available";
    detail: string;
  }
> = {
  "configuration-required": {
    label: "Needs configuration",
    tone: "attention",
    detail:
      "The server is missing configuration this connector requires. An operator supplies it; it is never entered here.",
  },
  "authorization-required": {
    label: "Not connected",
    tone: "available",
    detail: "Authorization has not been completed yet.",
  },
  "human-required": {
    label: "Your participation is needed",
    tone: "attention",
    detail:
      "The provider needs a person. This is a constraint of the provider's flow, not something this app can route around.",
  },
  verifying: {
    label: "Verifying",
    tone: "available",
    detail: "The server is checking provider evidence.",
  },
  active: {
    label: "Connected",
    tone: "connected",
    detail: "Verified against the target named below.",
  },
  degraded: {
    label: "Degraded",
    tone: "attention",
    detail:
      "Some capabilities are unavailable. Existing evidence still stands.",
  },
  expired: {
    label: "Expired",
    tone: "attention",
    detail:
      "The grant or its evidence is no longer valid. Reconnect to renew it.",
  },
  "reconnect-required": {
    label: "Reconnect required",
    tone: "attention",
    detail: "The provider needs this connection re-authorized.",
  },
  "locally-disconnected": {
    label: "Unlinked here",
    tone: "available",
    detail:
      "This deployment no longer holds the connection. Any grant at the provider is unaffected unless it was separately revoked.",
  },
  "upstream-revoked": {
    label: "Revoked upstream",
    tone: "attention",
    detail: "The provider reports the grant as revoked.",
  },
  indeterminate: {
    label: "Outcome unknown",
    tone: "attention",
    detail:
      "An operation was interrupted and the server cannot yet say whether it took effect. It is being reconciled; nothing is retried blindly.",
  },
};

const settled: ConnectionLifecycle[] = [
  "active",
  "degraded",
  "expired",
  "reconnect-required",
  "locally-disconnected",
  "upstream-revoked",
  "indeterminate",
  "configuration-required",
];

export function isWaiting(connection: ConnectionView | undefined): boolean {
  if (!connection) return false;
  if (settled.includes(connection.lifecycle)) return false;
  return (
    connection.lifecycle === "verifying" ||
    connection.lifecycle === "human-required" ||
    connection.lifecycle === "authorization-required"
  );
}

const disconnectScopeCopy: Record<
  DisconnectScope,
  { label: string; detail: string }
> = {
  local: {
    label: "Unlink here only",
    detail:
      "This deployment forgets the connection and its stored references. Your grant at the provider keeps existing until you revoke it there.",
  },
  broker: {
    label: "Unlink here and delete at the broker",
    detail:
      "Also asks the external broker to delete its connection. The provider grant the broker held may still exist.",
  },
  upstream: {
    label: "Unlink here and revoke at the provider",
    detail:
      "Also asks the provider to revoke the grant. Anything else using that same grant stops working.",
  },
};

/**
 * Each hand-off gets a window of its own name. Reusing one name looked like
 * a way not to stack windows, but a window by that name can still be showing
 * the last hand-off's return page, about to relay and close itself: a new
 * hand-off opened by name lands in that window and closes with it. Stacking is
 * prevented instead by closing the previous hand-off's window once the new
 * one is presented; a refused attempt leaves it alone.
 */
const HANDOFF_WINDOW = "ceremony-connector-handoff";
let handoffWindows = 0;

const outcomeCopy: Record<string, string> = {
  applied: "Done",
  unsupported: "Not offered by this provider",
  failed: "Failed",
  "not-attempted": "Not attempted",
  indeterminate: "Unknown — being reconciled",
};

function relativeTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  const seconds = Math.round((now - at) / 1000);
  const future = seconds < 0;
  const magnitude = Math.abs(seconds);
  const [value, unit]: [number, string] =
    magnitude < 60
      ? [magnitude, "second"]
      : magnitude < 3600
        ? [Math.round(magnitude / 60), "minute"]
        : magnitude < 86400
          ? [Math.round(magnitude / 3600), "hour"]
          : [Math.round(magnitude / 86400), "day"];
  const phrase = `${value} ${unit}${value === 1 ? "" : "s"}`;
  return future ? `in ${phrase}` : `${phrase} ago`;
}

/** A field whose options the server computes from other fields' values. */
function DynamicField({
  field,
  values,
  loadOptions,
}: {
  field: FieldDescriptor;
  values: Record<string, string>;
  loadOptions(
    field: FieldDescriptor,
    values: Record<string, string>,
  ): Promise<FieldOption[]>;
}) {
  const [options, setOptions] = useState<FieldOption[] | undefined>(
    field.options,
  );
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  // Length-prefixed rather than separated: a dependency value may contain any
  // character, so no separator is safe on its own, and a control byte has no
  // business being in a source file.
  const dependency = (field.dynamic?.dependsOn ?? [])
    .map((name) => {
      const value = values[name] ?? "";
      return `${value.length}:${value}`;
    })
    .join("|");
  const missing = (field.dynamic?.dependsOn ?? []).filter(
    (name) => !values[name],
  );
  useEffect(() => {
    if (!field.dynamic || missing.length) return;
    let live = true;
    setState("loading");
    loadOptions(field, values)
      .then((next) => {
        if (!live) return;
        setOptions(next);
        setState("idle");
      })
      .catch(() => {
        if (live) setState("error");
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field.name, dependency]);
  const id = `connector-field-${field.name}`;
  // The label is the field's name and nothing else; hints and states are
  // described separately, so a screen reader announces "Project" rather than
  // "Project required choose region first loading choices".
  const described = [
    missing.length > 0 || state !== "idle" ? `${id}-hint` : "",
    field.description ? `${id}-description` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="connector-field">
      <label htmlFor={id}>
        {field.label}
        {field.required ? " (required)" : ""}
      </label>
      {missing.length > 0 ? (
        <p className="connector-muted" id={`${id}-hint`}>
          Choose {missing.join(", ")} first; this list depends on it.
        </p>
      ) : state === "loading" ? (
        <p role="status" id={`${id}-hint`}>
          Loading choices…
        </p>
      ) : state === "error" ? (
        <p role="alert" id={`${id}-hint`}>
          The choices could not be loaded. The server declined or was
          unreachable; nothing was cached.
        </p>
      ) : null}
      <select
        id={id}
        name={field.name}
        required={field.required}
        disabled={state === "loading" || missing.length > 0}
        defaultValue=""
        {...(described ? { "aria-describedby": described } : {})}
      >
        <option value="">Select…</option>
        {(options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label ?? option.value}
          </option>
        ))}
      </select>
      {field.description && (
        <p className="connector-muted" id={`${id}-description`}>
          {field.description}
        </p>
      )}
    </div>
  );
}

function HandoffInputForm({
  fields,
  busy,
  error,
  onSubmit,
  loadOptions,
}: {
  fields: readonly FieldDescriptor[];
  busy: boolean;
  error: string;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  loadOptions(
    field: FieldDescriptor,
    values: Record<string, string>,
  ): Promise<FieldOption[]>;
}) {
  // Plain values are mirrored so dependent lists can be fetched; a secret
  // never is. Secrets are read from the form once, on submit, and handed
  // straight to private collection.
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <form
      className="connector-handoff-form"
      onSubmit={onSubmit}
      onInput={(event) => {
        const target = event.target as unknown as
          HTMLInputElement | HTMLSelectElement;
        const field = fields.find((item) => item.name === target.name);
        if (!field || field.classification === "secret") return;
        setValues((current) => ({ ...current, [target.name]: target.value }));
      }}
      onChange={(event) => {
        const target = event.target as unknown as
          HTMLInputElement | HTMLSelectElement;
        const field = fields.find((item) => item.name === target.name);
        if (!field || field.classification === "secret") return;
        setValues((current) => ({ ...current, [target.name]: target.value }));
      }}
    >
      {fields.map((field) =>
        field.dynamic || field.options ? (
          <DynamicField
            key={field.name}
            field={field}
            values={values}
            loadOptions={loadOptions}
          />
        ) : (
          <div key={field.name} className="connector-field">
            <label htmlFor={`connector-field-${field.name}`}>
              {field.label}
              {field.required ? " (required)" : ""}
            </label>
            <input
              id={`connector-field-${field.name}`}
              name={field.name}
              type={field.type === "select" ? "text" : field.type}
              required={field.required}
              autoComplete={
                field.classification === "secret" ? "off" : undefined
              }
              spellCheck={false}
              maxLength={1024}
              aria-describedby={`connector-field-${field.name}-description`}
            />
            <p
              className="connector-muted"
              id={`connector-field-${field.name}-description`}
            >
              {field.description ? `${field.description} ` : ""}
              {field.classification === "secret"
                ? "Sent straight to the private collector and replaced by a reference. It is never kept in this page, its address or its history."
                : ""}
            </p>
          </div>
        ),
      )}
      {error && (
        <p role="alert" className="connector-error">
          {error}
        </p>
      )}
      <button type="submit" className="primary" disabled={busy}>
        Submit securely
      </button>
    </form>
  );
}

function VerificationReport({
  connection,
  now,
}: {
  connection: ConnectionView;
  now: number;
}) {
  const verification = connection.verification;
  if (!verification)
    return (
      <p className="connector-muted">
        Nothing has been verified yet. A completed provider page is not
        verification; the server has to read something this grant is for.
      </p>
    );
  const expiresAt = verification.validUntil;
  const expired = expiresAt ? Date.parse(expiresAt) <= now : false;
  return (
    <dl className="connector-facts" data-connector-verification="">
      <dt>Verified target</dt>
      <dd>
        {connection.target ? (
          <>
            <code>{connection.target.id}</code>{" "}
            <span className="connector-muted">({connection.target.kind})</span>
          </>
        ) : (
          "No exact target was established. Flows that need an exact account match stay blocked."
        )}
      </dd>
      <dt>What was checked</dt>
      <dd>
        <ul>
          {verification.kinds.map((kind) => (
            <li key={kind}>{kind.replaceAll("-", " ")}</li>
          ))}
        </ul>
      </dd>
      <dt>Observed</dt>
      <dd>
        <time dateTime={verification.observedAt}>
          {relativeTime(verification.observedAt, now)}
        </time>
      </dd>
      <dt>Valid until</dt>
      <dd>
        {expiresAt ? (
          <time dateTime={expiresAt} data-expired={expired ? "" : undefined}>
            {expired ? "Expired " : ""}
            {relativeTime(expiresAt, now)}
          </time>
        ) : (
          "The provider did not state an expiry. Treat it as unknown, not unlimited."
        )}
      </dd>
      {verification.limitations.length > 0 && (
        <>
          <dt>What this does not establish</dt>
          <dd>
            <ul>
              {verification.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          </dd>
        </>
      )}
    </dl>
  );
}

function DisconnectReport({ result }: { result: DisconnectResult }) {
  return (
    <div className="connector-notice" role="status">
      <dl className="connector-facts" data-connector-disconnect-result="">
        <dt>This deployment</dt>
        <dd>{outcomeCopy[result.local] ?? result.local}</dd>
        <dt>External broker</dt>
        <dd>{outcomeCopy[result.broker] ?? result.broker}</dd>
        <dt>Provider grant</dt>
        <dd>{outcomeCopy[result.upstream] ?? result.upstream}</dd>
      </dl>
      {result.upstream !== "applied" && (
        <p>
          The grant at the provider was not revoked. Revoking it is a separate
          decision, and it is made at the provider or with the upstream scope.
        </p>
      )}
      {result.sharedWith && result.sharedWith.length > 0 && (
        <div data-connector-shared-with="">
          <p>
            {result.sharedWith.length} other{" "}
            {result.sharedWith.length === 1
              ? "connection uses"
              : "connections use"}{" "}
            the same upstream grant:
          </p>
          <ul>
            {result.sharedWith.map((ref) => (
              <li key={ref}>
                <code>{ref}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export interface ReadOperation {
  operationRef: string;
  label: string;
  input?: unknown;
}

export interface ConnectorConnectionProps {
  client: ConnectorClient;
  entry: CatalogEntry;
  /** Approved bindings; the authority is chosen from these, never typed. */
  bindings?: readonly BindingReference[];
  /** The description behind this entry: authentication profiles and diagnostics. */
  definition?: NormalizedDefinition;
  /**
   * Why the description could not be read, when the host tried and failed. It
   * is not the same as not having one: a connector whose entry names a
   * description and whose description is missing has unknown diagnostics, and
   * unknown is not the same as clean.
   */
  definitionError?: string;
  viewer?: ConnectorViewer;
  /** Reopen an existing connection, e.g. after a callback returns. */
  connectionRef?: string;
  /** Read-only operations offered as proof that the connection works. */
  readOperations?: readonly ReadOperation[];
  onConnectionChange?(connection: ConnectionSummary): void;
  /** A host's own sign-in. Without one, this application's own route is used. */
  onSignIn?(): void | Promise<void>;
  /** Injected by tests and hosts that own window management. */
  openWindow?(url: string, name: string): Window | null;
  pollIntervalMs?: number;
  autoFocus?: boolean;
}

export function ConnectorConnection({
  client,
  entry,
  bindings = [],
  definition,
  definitionError,
  viewer,
  connectionRef,
  readOperations = [],
  onConnectionChange,
  onSignIn,
  openWindow,
  pollIntervalMs = 1500,
  autoFocus = true,
}: ConnectorConnectionProps) {
  const [connection, setConnection] = useState<ConnectionView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [signInNeeded, setSignInNeeded] = useState(false);
  const [offline, setOffline] = useState(
    typeof navigator !== "undefined" && navigator.onLine === false,
  );
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [popupClosed, setPopupClosed] = useState(false);
  const [ignoredMessages, setIgnoredMessages] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [invokeResult, setInvokeResult] = useState<InvokeOutcome>();
  const [disconnectResult, setDisconnectResult] = useState<DisconnectResult>();
  const [scope, setScope] = useState<DisconnectScope>("local");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [confirmReconnect, setConfirmReconnect] = useState(false);
  const [accountSwitch, setAccountSwitch] = useState(false);

  const candidateBindings = useMemo(
    () =>
      bindings.filter(
        (binding) =>
          binding.status === "approved" &&
          (!entry.definitionRef ||
            binding.definitionRef === entry.definitionRef),
      ),
    [bindings, entry.definitionRef],
  );
  const profiles = definition?.authentication ?? [];
  const [profileId, setProfileId] = useState("");
  const [bindingRef, setBindingRef] = useState("");
  const [ownerKind, setOwnerKind] = useState<OwnerKind>("user");
  const [interruption, setInterruption] = useState<"allowed" | "none">(
    "allowed",
  );
  const [targetId, setTargetId] = useState("");
  const chosenBinding =
    candidateBindings.find((binding) => binding.bindingRef === bindingRef) ??
    candidateBindings[0];
  const chosenProfile =
    profiles.find((profile) => profile.id === profileId) ?? profiles[0];
  const requestedPermissions = useMemo(() => {
    const profile = chosenProfile as { scopes?: string[] } | undefined;
    return [...(profile?.scopes ?? [])];
  }, [chosenProfile]);
  const blockers = useMemo(
    () => connectBlockers(definition?.compatibility.issues ?? []),
    [definition],
  );
  /*
   * A description that could not be read is not a description with nothing
   * blocking. `blockers` comes from the description's own diagnostics, so
   * without one it is empty for the reason an unasked question has no answer:
   * the very list that decides whether this connector may be authorized is
   * what is missing. So an entry that names a description and has not got one
   * cannot be connected, and the panel below says which of the two it is —
   * still being read, or unreadable.
   */
  const definitionKnown = !entry.definitionRef || Boolean(definition);
  const organizationAllowed = ownerKindPermitted(viewer, "organization");

  const popup = useRef<Window | null>(null);
  const mounted = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const current = useRef<ConnectionView | undefined>(undefined);
  current.current = connection;
  const seenHandoffs = useRef(new Set<string>());

  const remember = useCallback(
    (next: ConnectionView) => {
      if (!mounted.current) return;
      setConnection(next);
      current.current = next;
      // One handoff, however many times a poll reports it still open.
      if (next.handoff) seenHandoffs.current.add(next.handoff.handoffRef);
      onConnectionChange?.(next);
    },
    [onConnectionChange],
  );

  const act = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (failure) {
      if (!mounted.current) return;
      if (isUnauthenticated(failure)) {
        // Nothing stale survives an expired session: what was on screen was
        // read with a session that no longer exists.
        setSignInNeeded(true);
        setConnection(undefined);
        current.current = undefined;
      }
      setError(
        failure instanceof Error
          ? failure.message
          : "That action could not finish. Refresh the status and try again.",
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setOffline(navigator.onLine === false);
    addEventListener("online", update);
    addEventListener("offline", update);
    return () => {
      removeEventListener("online", update);
      removeEventListener("offline", update);
    };
  }, []);

  // Resume: a callback sent the person back with a connection reference, so
  // the authoritative record is read again before anything is shown.
  useEffect(() => {
    if (!connectionRef) return;
    const abort = new AbortController();
    void act(async () => {
      const resumed = await client.connection(connectionRef, abort.signal);
      if (!abort.signal.aborted) remember(resumed);
    });
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionRef, client]);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const ref = current.current?.connectionRef;
      if (!ref) return;
      const next = await client.poll(ref, signal);
      if (!signal?.aborted) remember(next);
    },
    [client, remember],
  );

  // Polling is the only thing that changes status while a handoff is open.
  const connectionRefValue = connection?.connectionRef;
  const waiting = isWaiting(connection);
  useEffect(() => {
    if (!connectionRefValue || !waiting || offline) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const tick = () => {
      timer = setTimeout(() => {
        client
          .poll(connectionRefValue, abort.signal)
          .then((next) => {
            if (abort.signal.aborted) return;
            remember(next);
            setNow(Date.now());
            if (isWaiting(next)) tick();
          })
          .catch((failure: unknown) => {
            if (abort.signal.aborted) return;
            if (isUnauthenticated(failure)) {
              setSignInNeeded(true);
              setConnection(undefined);
              current.current = undefined;
              return;
            }
            tick();
          });
      }, pollIntervalMs);
    };
    tick();
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
    };
  }, [connectionRefValue, waiting, offline, client, pollIntervalMs, remember]);

  /*
   * A popup may tell its opener it is finished. That message is a nudge to ask
   * the server, and it is only accepted from this origin, from the exact window
   * this component opened, carrying this connection's reference. Anything else
   * is counted and dropped: an unexpected origin is not evidence of anything.
   */
  const handoffRefValue = connection?.handoff?.handoffRef;
  useEffect(() => {
    if (typeof window === "undefined" || !connectionRefValue) return;
    const onMessage = (event: MessageEvent) => {
      const expectedSource = popup.current;
      if (
        !isTrustedHandoffMessage(
          { origin: event.origin, source: event.source, data: event.data },
          {
            origin: location.origin,
            source: expectedSource,
            connectionRef: connectionRefValue,
            ...(handoffRefValue ? { handoffRef: handoffRefValue } : {}),
          },
        )
      ) {
        setIgnoredMessages((value) => value + 1);
        return;
      }
      void act(() => refresh());
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [connectionRefValue, handoffRefValue, act, refresh]);

  // A closed window is not a result. It only means it is worth asking again.
  useEffect(() => {
    if (!connectionRefValue || !waiting) return;
    const timer = setInterval(() => {
      if (popup.current && popup.current.closed) {
        popup.current = null;
        setPopupClosed(true);
        void act(() => refresh());
      }
    }, 250);
    return () => clearInterval(timer);
  }, [connectionRefValue, waiting, act, refresh]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (autoFocus && connection?.connectionRef) heading.current?.focus();
  }, [connection?.connectionRef, autoFocus]);

  /*
   * The window is opened on the click, before the server is asked, and
   * navigated once there is somewhere to go. A browser only lets a page open
   * a window while a person's click is still fresh, so opening it after a
   * round trip is how a working flow turns into a blocked one on a slow
   * network. An opened window with nowhere to go is closed again.
   */
  const openPlaceholder = useCallback((): Window | null => {
    const name = `${HANDOFF_WINDOW}-${++handoffWindows}`;
    try {
      if (openWindow) return openWindow("about:blank", name);
      if (typeof window === "undefined") return null;
      return window.open("about:blank", name, "noopener=no");
    } catch {
      return null;
    }
  }, [openWindow]);

  /*
   * A window opened for a handoff that is not going to happen is closed here
   * and nowhere else. Every path that stops before `present` — a refused
   * connect, an expired session, a dropped network — comes through this, so
   * nobody is left with a blank popup over their application to close by hand.
   */
  const dismiss = useCallback((placeholder: Window | null) => {
    try {
      placeholder?.close();
    } catch {
      /* Already gone. */
    }
  }, []);

  const present = useCallback(
    (view: ConnectionView, placeholder: Window | null) => {
      const url = view.presentation?.url;
      const presentation = view.handoff?.presentation;
      if (!url || presentation !== "popup") {
        dismiss(placeholder);
        popup.current = null;
        return;
      }
      setPopupClosed(false);
      if (placeholder) {
        setPopupBlocked(false);
        // The new hand-off supersedes one whose window is still open; the
        // poll, not that window, decides what the earlier one achieved.
        const previous = popup.current;
        popup.current = placeholder;
        if (previous && previous !== placeholder) dismiss(previous);
        try {
          placeholder.location.replace(url);
        } catch {
          /* A window that closed in the meantime needs nothing further. */
        }
        return;
      }
      // A blocked popup is a normal browser configuration, not a failure. The
      // same authorization continues in this window instead.
      popup.current = null;
      setPopupBlocked(true);
    },
    [dismiss],
  );

  const connect = (placeholder: Window | null) =>
    act(async () => {
      try {
        if (!chosenBinding)
          throw new Error(
            "No approved binding is available for this connector in this deployment.",
          );
        const view = await client.connect({
          bindingRef: chosenBinding.bindingRef,
          ownerKind,
          intent: {
            ...(chosenProfile ? { profileId: chosenProfile.id } : {}),
            requestedPermissions,
            ...(targetId
              ? { target: { kind: entry.service || "account", id: targetId } }
              : {}),
            accountSwitch: false,
            interruption,
          },
        });
        remember(view);
        present(view, placeholder);
      } catch (failure) {
        // The refusal is `act`'s to report; the window is this line's to close.
        dismiss(placeholder);
        throw failure;
      }
    });

  const submitHandoff = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = connection?.presentation?.fields ?? [];
    // Read by name from the form's own controls: a field name is a bounded
    // identifier, so the lookup needs no escaping, and this works the same
    // whether or not the host's DOM implements FormData.
    const read = (name: string) => {
      const control = form.querySelector(`[name="${name}"]`) as {
        value?: string;
      } | null;
      return control?.value ?? "";
    };
    const secrets: Record<string, string> = {};
    const values: Record<string, string> = {};
    for (const field of fields) {
      const value = read(field.name);
      if (field.classification === "secret") secrets[field.name] = value;
      else values[field.name] = value;
    }
    // The form is the only place a secret exists in this page, and it is
    // cleared before the network call settles.
    form.reset?.();
    void act(async () => {
      const view = current.current;
      const handoff = view?.handoff;
      if (!view || !handoff) throw new Error("This handoff is no longer open.");
      if (Object.keys(secrets).length) {
        const { secretRef } = await client.collect(view.connectionRef, secrets);
        values.secretRef = secretRef;
      }
      const next = await client.handoffInput(
        view.connectionRef,
        handoff.handoffRef,
        values,
      );
      remember(next);
    });
  };

  const loadOptions = useCallback(
    async (
      field: FieldDescriptor,
      values: Record<string, string>,
    ): Promise<FieldOption[]> => {
      const view = current.current;
      if (!view || !field.dynamic) return field.options ?? [];
      // The values come from the form's own mirror of its non-secret fields,
      // so a dependent lookup never reads the DOM and a secret never becomes
      // an argument to one.
      const outcome = await client.invoke(view.connectionRef, {
        operationRef: field.dynamic.operationRef,
        input: Object.fromEntries(
          (field.dynamic.dependsOn ?? []).map((name) => [
            name,
            values[name] ?? "",
          ]),
        ),
      });
      if (outcome.state !== "complete")
        throw new Error("The server did not return choices for this field.");
      const parsed = (outcome.output ?? {}) as { options?: FieldOption[] };
      return parsed.options ?? [];
    },
    [client],
  );

  /*
   * Signing in again is a route somewhere, not a state this component can
   * clear. A host that owns sign-in is asked to do it; otherwise the same
   * command the rest of this application uses is asked for an authorization
   * URL and the browser goes there. Clearing the panel without either put a
   * person back on a connect form whose next attempt expired again.
   */
  const signIn = useCallback(async () => {
    if (onSignIn) {
      await onSignIn();
      if (mounted.current) setSignInNeeded(false);
      return;
    }
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok)
      throw new Error(
        "Sign-in is unavailable in this deployment. Ask this host's administrator how to sign in again.",
      );
    const { authorizationUrl } = z
      .strictObject({ authorizationUrl: z.url() })
      .parse(await response.json());
    location.assign(authorizationUrl);
  }, [onSignIn]);

  const lifecycle = connection
    ? lifecyclePresentation[connection.lifecycle]
    : undefined;
  const support = supportPresentation[entry.support];
  const canConnect =
    !offline &&
    !busy &&
    Boolean(chosenBinding) &&
    blockers.length === 0 &&
    definitionKnown &&
    entry.support !== "catalog-only" &&
    entry.support !== "unconfigured";

  if (signInNeeded)
    return (
      <div
        data-connector=""
        data-connector-connection=""
        className="connector-panel"
      >
        <h3>Your session expired</h3>
        <p role="alert">
          Sign in again to see this connection. Nothing from the previous
          session is shown, because it was read with a session that no longer
          exists.
        </p>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void act(signIn)}
        >
          Sign in
        </button>
        {error && (
          <p role="alert" className="connector-error">
            {error}
          </p>
        )}
      </div>
    );

  return (
    <div
      data-connector=""
      data-connector-connection={entry.id}
      data-lifecycle={connection?.lifecycle ?? "none"}
      data-ignored-messages={ignoredMessages}
      className="connector-panel"
    >
      <div className="connector-panel-head">
        <h3 ref={heading} tabIndex={-1}>
          {entry.displayName}
        </h3>
        <StatusChip status={lifecycle?.tone ?? "available"}>
          {lifecycle?.label ?? "Not connected"}
        </StatusChip>
      </div>
      <ul
        className="connector-methods"
        aria-label="How this connector is reached"
      >
        <li>
          <Chip tone={support.tone} title={support.detail}>
            {support.label}
          </Chip>
        </li>
        {entry.custody.map((custody) => (
          <li key={custody}>
            <Chip title="Credential custody is decided by the server's binding; this app cannot move a secret between authorities.">
              {custodyPresentation[custody]}
            </Chip>
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
        <li>
          <HandoffMeter count={seenHandoffs.current.size} />
        </li>
      </ul>
      {lifecycle && <p className="connector-muted">{lifecycle.detail}</p>}

      {offline && (
        <p className="connector-notice" role="status" data-connector-offline="">
          You are offline. Connecting and running operations are unavailable and
          nothing is queued; no connection status is served from a cache, so
          what you last saw may already be out of date.
        </p>
      )}
      {error && (
        <p role="alert" className="connector-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}

      {!definitionKnown &&
        (definitionError ? (
          <div
            className="connector-notice"
            role="alert"
            data-connector-definition-unread=""
          >
            <h4>This connector's description could not be read</h4>
            <p>{definitionError}</p>
            <p>
              Connecting stays unavailable until it can be: the diagnostics that
              say whether this connector may be authorized at all are part of
              that description, and an unread one is unknown rather than clean.
              Everything else on this page is what the server already reported
              about the entry itself.
            </p>
          </div>
        ) : (
          <p
            className="connector-notice"
            role="status"
            data-connector-definition-pending=""
          >
            Reading this connector's description. It carries the authentication
            methods and the diagnostics that decide whether connecting is
            possible, so connecting waits for it.
          </p>
        ))}

      {blockers.length > 0 && (
        <div
          className="connector-notice"
          role="alert"
          data-connector-blockers=""
        >
          <h4>This connector cannot be authorized as imported</h4>
          <ul>
            {blockers.map((issue) => (
              <li key={`${issue.code}:${issue.sourcePointer}`}>
                <code>{issue.code}</code> — {issue.message}
                {issue.remediation ? ` ${issue.remediation}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!connection && (
        <form
          className="connector-intent"
          onSubmit={(event) => {
            event.preventDefault();
            void connect(openPlaceholder());
          }}
        >
          {/*
            A field's label is its name and nothing else, the way DynamicField
            above does it: the help below is referenced with aria-describedby
            instead of being wrapped in the label, where it would become part of
            the control's name and be read out in full every time the control is
            reached.
          */}
          {profiles.length > 1 && (
            <div className="connector-field">
              <label htmlFor="connector-profile">Authentication method</label>
              <select
                id="connector-profile"
                value={chosenProfile?.id ?? ""}
                aria-describedby="connector-profile-description"
                onChange={(event) => setProfileId(event.target.value)}
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label}
                  </option>
                ))}
              </select>
              <p className="connector-muted" id="connector-profile-description">
                Sent as the authorization profile. The server decides whether it
                is permitted for this binding.
              </p>
            </div>
          )}
          {candidateBindings.length > 1 && (
            <div className="connector-field">
              <label htmlFor="connector-binding">
                Environment and authority
              </label>
              <select
                id="connector-binding"
                value={chosenBinding?.bindingRef ?? ""}
                aria-describedby="connector-binding-description"
                onChange={(event) => setBindingRef(event.target.value)}
              >
                {candidateBindings.map((binding) => (
                  <option key={binding.bindingRef} value={binding.bindingRef}>
                    {binding.authorityInstance || binding.adapterId} ·{" "}
                    {binding.adapterId}@{binding.adapterVersion}
                  </option>
                ))}
              </select>
              <p className="connector-muted" id="connector-binding-description">
                Only authorities the server has approved appear here.
              </p>
            </div>
          )}
          <div className="connector-field">
            <label htmlFor="connector-target">
              Account or workspace (optional)
            </label>
            <input
              id="connector-target"
              name="connector-target"
              type="text"
              value={targetId}
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
              aria-describedby="connector-target-description"
              onInput={(event) => setTargetId(event.currentTarget.value.trim())}
              onChange={(event) => setTargetId(event.target.value.trim())}
            />
            <p className="connector-muted" id="connector-target-description">
              The server must observe this exact account or workspace before the
              connection counts as working. Where the provider offers a list,
              you are asked to pick from it after signing in.
            </p>
          </div>
          <fieldset className="connector-field">
            <legend>Whose access this is</legend>
            <label>
              <input
                type="radio"
                name="connector-owner"
                value="user"
                checked={ownerKind === "user"}
                onChange={() => setOwnerKind("user")}
              />
              My own account
            </label>
            <label>
              <input
                type="radio"
                name="connector-owner"
                value="organization"
                checked={ownerKind === "organization"}
                disabled={!organizationAllowed}
                onChange={() => setOwnerKind("organization")}
              />
              The organization
              {!organizationAllowed && (
                <span className="connector-muted">
                  {" "}
                  — requires administrator policy
                </span>
              )}
            </label>
          </fieldset>
          <div className="connector-field">
            <label htmlFor="connector-interruption">Interruption budget</label>
            <select
              id="connector-interruption"
              value={interruption}
              aria-describedby="connector-interruption-description"
              onChange={(event) =>
                setInterruption(event.target.value as "allowed" | "none")
              }
            >
              <option value="allowed">Ask me when the provider needs me</option>
              <option value="none">Do not interrupt anyone</option>
            </select>
            <p
              className="connector-muted"
              id="connector-interruption-description"
            >
              A constraint, not a bypass. If the provider requires consent or a
              second factor, choosing “do not interrupt” stops the connection as
              needing a person rather than finding another way in.
            </p>
          </div>
          <div className="connector-field" data-connector-custody="">
            <span>Credential custody</span>
            <p className="connector-muted">
              {entry.custody
                .map((custody) => custodyPresentation[custody])
                .join(", ")}
              . Whether a credential is shared for the workspace or held per
              person is set by server policy for this binding; it cannot be
              changed from here.
            </p>
          </div>
          {requestedPermissions.length > 0 && (
            <div className="connector-field">
              <span>Permissions this will request</span>
              <ul className="connector-scopes">
                {requestedPermissions.map((permission) => (
                  <li key={permission}>
                    <code>{permission}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button type="submit" className="primary" disabled={!canConnect}>
            Connect {entry.displayName}
          </button>
          {!chosenBinding && (
            <p className="connector-muted">
              This deployment has no approved binding for this connector yet. An
              operator reviews and approves one before it can be connected.
            </p>
          )}
        </form>
      )}

      {connection?.handoff && isWaiting(connection) && (
        <div
          className="connector-handoff"
          data-connector-handoff={connection.handoff.kind}
        >
          <h4>Continue with the provider</h4>
          {connection.presentation?.instructions && (
            <p>{connection.presentation.instructions}</p>
          )}
          {connection.presentation?.userCode && (
            <p className="connector-code">
              <span className="connector-muted">Enter this code:</span>{" "}
              <output>{connection.presentation.userCode}</output>
            </p>
          )}
          {connection.presentation?.url && (
            <p>
              <a
                className="button primary"
                href={connection.presentation.url}
                {...(connection.handoff.presentation === "popup" &&
                !popupBlocked
                  ? { target: "_blank", rel: "noreferrer" }
                  : {})}
                data-connector-continue=""
              >
                {popupBlocked
                  ? "Continue in this window"
                  : `Continue to ${entry.displayName}`}
              </a>
            </p>
          )}
          {popupBlocked && (
            <p role="status" data-connector-popup-blocked="">
              Your browser blocked the new window. The same authorization
              continues here instead; you will come back to this page when it is
              done.
            </p>
          )}
          {popupClosed && (
            <p role="status" data-connector-popup-closed="">
              That window closed. Closing it does not complete anything, so the
              status below is whatever the server says.
            </p>
          )}
          {connection.presentation?.fields &&
          connection.presentation.fields.length > 0 ? (
            <HandoffInputForm
              fields={connection.presentation.fields}
              busy={busy}
              error=""
              onSubmit={submitHandoff}
              loadOptions={loadOptions}
            />
          ) : null}
          <div className="connector-actions">
            <button
              type="button"
              disabled={busy || offline}
              onClick={() => void act(() => refresh())}
            >
              I finished in the provider — check status
            </button>
          </div>
          <p className="connector-muted">
            Finishing at the provider, closing the window, or this page being
            told it is done are all just reasons to ask the server again. Only
            the server's answer changes the status above.
          </p>
        </div>
      )}

      {connection && (
        <>
          <section aria-label="Verification">
            <h4>What has actually been verified</h4>
            <VerificationReport connection={connection} now={now} />
            {connection.lastOutcome && (
              <p className="connector-muted">
                Last outcome: <code>{connection.lastOutcome}</code>
              </p>
            )}
          </section>

          {connection.lifecycle === "indeterminate" && (
            <p className="connector-notice" role="alert">
              An operation was interrupted and the server cannot yet say whether
              it took effect. It will not be retried until reconciliation says
              it is safe.
            </p>
          )}

          {readOperations.length > 0 && (
            <section aria-label="Use this connection">
              <h4>Use this connection</h4>
              <div className="connector-actions">
                {readOperations.map((operation) => (
                  <button
                    key={operation.operationRef}
                    type="button"
                    disabled={
                      busy || offline || connection.lifecycle !== "active"
                    }
                    onClick={() =>
                      void act(async () => {
                        const outcome = await client.invoke(
                          connection.connectionRef,
                          {
                            operationRef: operation.operationRef,
                            input: operation.input ?? {},
                          },
                        );
                        if (mounted.current) setInvokeResult(outcome);
                      })
                    }
                  >
                    {operation.label}
                  </button>
                ))}
              </div>
              {invokeResult && (
                <div data-connector-invoke-result={invokeResult.state}>
                  <p role="status">
                    {invokeResult.state === "complete"
                      ? `Read succeeded (${invokeResult.effect}, ${invokeResult.outputClassification}).`
                      : invokeResult.state === "indeterminate"
                        ? "The outcome is unknown and is being reconciled."
                        : invokeResult.state === "human-required"
                          ? "The provider needs a person before this can finish."
                          : invokeResult.state === "denied"
                            ? "Policy declined this operation."
                            : "The operation failed."}
                    {invokeResult.code ? ` (${invokeResult.code})` : ""}
                  </p>
                  {invokeResult.state === "complete" &&
                    invokeResult.outputClassification === "public" && (
                      <pre className="connector-output">
                        {JSON.stringify(invokeResult.output, null, 2)}
                      </pre>
                    )}
                </div>
              )}
            </section>
          )}

          <section aria-label="Manage this connection">
            <h4>Manage</h4>
            <div className="connector-actions">
              <button
                type="button"
                disabled={busy || offline}
                onClick={() => void act(() => refresh())}
              >
                Refresh status
              </button>
              <button
                type="button"
                disabled={busy || offline}
                onClick={() =>
                  void act(async () => {
                    const next = await client.verify(connection.connectionRef);
                    remember(next);
                  })
                }
              >
                Re-verify access
              </button>
              <button
                type="button"
                disabled={busy || offline}
                onClick={() => setConfirmReconnect(true)}
              >
                Reconnect
              </button>
              <button
                type="button"
                className="quiet"
                disabled={busy || offline}
                onClick={() => setConfirmDisconnect(true)}
              >
                Disconnect…
              </button>
            </div>

            {confirmReconnect && (
              <div className="connector-confirm" data-connector-reconnect="">
                <h5>Reconnect this connection</h5>
                <p>
                  Reconnecting reuses the same connection record. If the
                  provider signs you in as somebody else, that is a different
                  account and the server refuses it unless you say so here.
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={accountSwitch}
                    onChange={(event) => setAccountSwitch(event.target.checked)}
                  />
                  I intend to connect a different account
                  {connection.target ? ` than ${connection.target.id}` : ""}
                </label>
                <div className="connector-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => {
                      const placeholder = openPlaceholder();
                      // `act` reports every refusal itself and never rejects,
                      // so the window is closed where the refusal is seen.
                      void act(async () => {
                        try {
                          const next = await client.reconnect(
                            connection.connectionRef,
                            {
                              expectedRevision: connection.revision,
                              accountSwitch,
                            },
                          );
                          remember(next);
                          setConfirmReconnect(false);
                          setAccountSwitch(false);
                          present(next, placeholder);
                        } catch (failure) {
                          dismiss(placeholder);
                          throw failure;
                        }
                      });
                    }}
                  >
                    Start reconnect
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => {
                      setConfirmReconnect(false);
                      setAccountSwitch(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {confirmDisconnect && (
              <div className="connector-confirm" data-connector-disconnect="">
                <h5>What should happen to this connection?</h5>
                <fieldset>
                  <legend className="connector-muted">
                    These are different effects, and the wider ones cannot be
                    undone from here.
                  </legend>
                  {(Object.keys(disconnectScopeCopy) as DisconnectScope[]).map(
                    (value) => (
                      <label key={value}>
                        <input
                          type="radio"
                          name="connector-disconnect-scope"
                          value={value}
                          checked={scope === value}
                          onChange={() => setScope(value)}
                        />
                        <span>
                          <strong>{disconnectScopeCopy[value].label}</strong>
                          <span className="connector-muted">
                            {" "}
                            {disconnectScopeCopy[value].detail}
                          </span>
                        </span>
                      </label>
                    ),
                  )}
                </fieldset>
                <div className="connector-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const result = await client.disconnect(
                          connection.connectionRef,
                          {
                            expectedRevision: connection.revision,
                            scope,
                          },
                        );
                        remember(result.connection);
                        if (mounted.current) {
                          setDisconnectResult(result.result);
                          setConfirmDisconnect(false);
                        }
                      })
                    }
                  >
                    {disconnectScopeCopy[scope].label}
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => setConfirmDisconnect(false)}
                  >
                    Keep the connection
                  </button>
                </div>
              </div>
            )}
            {disconnectResult && <DisconnectReport result={disconnectResult} />}
          </section>
        </>
      )}

      <details className="connector-report">
        <summary>What this deployment can do with {entry.displayName}</summary>
        <CapabilityReport
          capabilities={entry.capabilities}
          aria-label={`${entry.displayName} capabilities reported by the server`}
        />
        <p className="connector-muted">
          These are reports, not switches. Capabilities are decided by the
          server's approved binding; nothing here can turn one on.
        </p>
        {entry.configuration.length > 0 && (
          <ul className="connector-configuration">
            {entry.configuration.map((item) => (
              <li key={item.name} data-present={item.present ? "" : undefined}>
                <code>{item.name}</code> — {item.classification},{" "}
                {item.required ? "required" : "optional"},{" "}
                {item.present ? "present" : "missing"}
              </li>
            ))}
          </ul>
        )}
        {viewer && canPublish(viewer) && (
          <p className="connector-muted" data-connector-operator="">
            You hold an operator role, so binding and activation controls are
            available in the import review.
          </p>
        )}
      </details>
    </div>
  );
}

export type { ConnectionView } from "../core/connectors/client.js";
