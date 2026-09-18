import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  authFamilyLabels,
  capabilityDetails,
  type AuthFamily,
  type Capability,
  type CatalogEntry,
} from "./catalog.js";
import { Glyph, initials } from "./connect-catalog.js";
import {
  allEngines,
  compileConnection,
  engineLabels,
  notCarriedBy,
  ownershipLabels,
  projectDraft,
  readBackends,
  type BackendNegotiation,
  type CompileOutcome,
  type ConnectionDraft,
  type KeyScope,
  type Mode,
} from "./connection-plan.js";

/**
 * Add Connection: four steps, only one of them open.
 *
 * The accordion exists because the four questions are answered at different
 * times by different people. Picking a service is a browsing decision;
 * configuring it is an operator decision that may need a console open in
 * another tab; customising it is a policy decision about how much of somebody's
 * attention this connection is allowed to spend; completing it is the only step
 * where a person's own account is involved. Collapsing the three you are not on
 * is what keeps the last one from looking like paperwork.
 *
 * Nothing in this component authorizes anything. It produces a draft, and the
 * server decides what it will actually run.
 */

export type { ConnectionDraft, KeyScope, Mode };

export function emptyDraft(entry: CatalogEntry): ConnectionDraft {
  return {
    entryId: entry.id,
    mode: "managed",
    family: entry.auth[0]!,
    values: {},
    keyScope: "shared",
    // Overwritten by the first browser this host says it actually has. Sending
    // a guess is still honest — the server rejects an engine it does not run
    // by name — but the control below never offers one it has not confirmed.
    engine: "chromium",
    ownership: "managed",
    // A card that exists for one capability starts with it on. Otherwise just
    // verification, which is not opt-in: a connection that never reads
    // anything has not been shown to work, and the toggle says why.
    capabilities: entry.defaultCapabilities
      ? [...entry.defaultCapabilities]
      : entry.capabilities.includes("verification")
        ? ["verification"]
        : [],
    interruptions: "any",
    identity: "either",
  };
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>
        <span>
          {label}
          {required && (
            <>
              {" "}
              <span className="required" aria-hidden="true">
                *
              </span>
              <span className="sr-only">(required)</span>
            </>
          )}
        </span>
      </label>
      {children(id)}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

function Text({
  label,
  value,
  placeholder,
  required,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  required?: boolean;
  hint?: ReactNode;
  onChange(value: string): void;
}) {
  return (
    <Field
      label={label}
      {...(required ? { required } : {})}
      {...(hint ? { hint } : {})}
    >
      {(id) => (
        <input
          id={id}
          type="text"
          value={value}
          {...(placeholder ? { placeholder } : {})}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

/**
 * The credential families, each asking only for what its protocol actually
 * needs. A device flow has no redirect URI and an API key has no scopes worth
 * discovering, so neither is shown one.
 */
function FamilyForm({
  family,
  draft,
  set,
}: {
  family: AuthFamily;
  draft: ConnectionDraft;
  set(patch: Partial<ConnectionDraft>): void;
}) {
  const value = (name: string) => draft.values[name] ?? "";
  const put = (name: string) => (next: string) =>
    set({ values: { ...draft.values, [name]: next } });
  const managed = draft.mode === "managed";
  if (family === "oauth-code" || family === "oauth-client-credentials")
    return managed ? (
      <>
        <p className="step-note">
          Enter the OAuth server URL to auto-discover the provider.
        </p>
        <Text
          label="Server URL"
          required
          value={value("issuer")}
          placeholder="https://example.com"
          hint="Authorization server metadata is read from the origin you enter. Discovery is advisory; the server re-validates every endpoint it is given."
          onChange={put("issuer")}
        />
      </>
    ) : (
      <>
        <p className="step-note">
          Declare the endpoints yourself when a provider publishes no metadata
          document.
        </p>
        <Text
          label="Authorization endpoint"
          required
          value={value("authorizationEndpoint")}
          placeholder="https://example.com/oauth/authorize"
          onChange={put("authorizationEndpoint")}
        />
        <Text
          label="Token endpoint"
          required
          value={value("tokenEndpoint")}
          placeholder="https://example.com/oauth/token"
          onChange={put("tokenEndpoint")}
        />
        <Text
          label="Client ID environment name"
          value={value("clientIdName")}
          placeholder="EXAMPLE_CLIENT_ID"
          hint="Names a session-environment entry. Secrets are never typed into this form; the value stays in the encrypted vault."
          onChange={put("clientIdName")}
        />
        <Text
          label="Scopes"
          value={value("scopes")}
          placeholder="read:user repo"
          onChange={put("scopes")}
        />
      </>
    );
  if (family === "api-key")
    return (
      <>
        <Text
          label="Service"
          value={value("service")}
          placeholder="api.example.com"
          onChange={put("service")}
        />
        <Text
          label="Name"
          value={value("name")}
          placeholder="example-connector"
          onChange={put("name")}
        />
        <Text
          label="UID (Optional)"
          value={value("uid")}
          placeholder="api.example.com/example-service"
          hint="Generated from the service and connector name when empty."
          onChange={put("uid")}
        />
        <fieldset className="choice-grid">
          <legend className="fieldset-legend">API keys</legend>
          <label className="choice">
            <div>
              <span className="choice-title">Shared API keys</span>
              <span className="choice-note">
                Store API keys on this connector for all users.
              </span>
            </div>
            <input
              type="radio"
              name="key-scope"
              checked={draft.keyScope === "shared"}
              onChange={() => set({ keyScope: "shared" })}
            />
          </label>
          <label className="choice">
            <div>
              <span className="choice-title">Per-user API keys</span>
              <span className="choice-note">
                Each user provides their own API key during authorization.
              </span>
            </div>
            <input
              type="radio"
              name="key-scope"
              checked={draft.keyScope === "per-user"}
              onChange={() => set({ keyScope: "per-user" })}
            />
          </label>
        </fieldset>
        {draft.keyScope === "shared" ? (
          <Text
            label="Key environment name"
            value={value("keyName")}
            placeholder="EXAMPLE_API_KEY"
            hint="The key itself is collected privately and held in the encrypted vault. This form stores its name, never its value."
            onChange={put("keyName")}
          />
        ) : (
          <p className="step-note">
            Each person is asked for their own key at connect time, through
            private collection. Nothing is stored on the connector.
          </p>
        )}
        <Text
          label="Scope (Optional)"
          value={value("scope")}
          placeholder="reader"
          onChange={put("scope")}
        />
        <Field label="Expiration (Optional)">
          {(id) => (
            <select
              id={id}
              value={value("expiration") || "none"}
              onChange={(event) => put("expiration")(event.target.value)}
            >
              <option value="none">No expiration</option>
              <option value="30d">30 days</option>
              <option value="90d">90 days</option>
              <option value="365d">1 year</option>
            </select>
          )}
        </Field>
      </>
    );
  if (family === "basic")
    return (
      <>
        <p className="step-note">
          Basic encodes an identifier and a token together. Both are collected
          privately at connect time and sent to the adapter by reference.
        </p>
        <Text
          label="Service origin"
          required
          value={value("service")}
          placeholder="https://example.com"
          hint="The only origin this connection's identifier and token may be sent to. Permission to visit somewhere is not permission to type a credential there."
          onChange={put("service")}
        />
        <Text
          label="Identifier label"
          value={value("identifierLabel")}
          placeholder="Atlassian email"
          onChange={put("identifierLabel")}
        />
        <Text
          label="Token label"
          value={value("tokenLabel")}
          placeholder="API token"
          hint="Ask for a provider-issued token, never an account password."
          onChange={put("tokenLabel")}
        />
      </>
    );
  if (family === "device")
    return (
      <>
        <p className="step-note">
          The person approves on a second device. Nothing is collected here and
          the connection completes only after the provider confirms the code.
        </p>
        <Text
          label="Device authorization endpoint"
          required={!managed}
          value={value("deviceEndpoint")}
          placeholder="https://example.com/device/code"
          onChange={put("deviceEndpoint")}
        />
        <Text
          label="Verification URI shown to the person"
          value={value("verificationUri")}
          placeholder="https://example.com/activate"
          onChange={put("verificationUri")}
        />
      </>
    );
  if (family === "github-app")
    return managed ? (
      <>
        <Field
          label="GitHub namespace"
          hint="App registration, installation and access verification run as one parent ceremony; compatible existing setup is reused."
        >
          {(id) => (
            <select
              id={id}
              value={value("namespace")}
              onChange={(event) => put("namespace")(event.target.value)}
            >
              <option value="">Select Git scope</option>
              <option value="personal">Personal account</option>
              <option value="organization">Organization</option>
            </select>
          )}
        </Field>
      </>
    ) : (
      <>
        <Text
          label="App ID environment name"
          value={value("appIdName")}
          placeholder="GITHUB_APP_ID"
          onChange={put("appIdName")}
        />
        <Text
          label="Private key environment name"
          value={value("appKeyName")}
          placeholder="GITHUB_APP_PRIVATE_KEY"
          hint="Held in session-scoped encrypted configuration. Never entered in chat or in this form."
          onChange={put("appKeyName")}
        />
      </>
    );
  if (family === "browser-login")
    return (
      <>
        <p className="step-note">
          For services that publish no API. An attended browser session is
          driven against an admitted origin; the person stays in control and
          challenges always stop the run.
        </p>
        <Text
          label="Entry origin"
          required
          value={value("origin")}
          placeholder="https://example.com"
          hint="An exact canonical origin, not a URL prefix or host pattern."
          onChange={put("origin")}
        />
        <Field
          label="Sign-in sequence"
          hint="Matched against the page before any submission. A passkey or challenge page hands back to the person instead of continuing."
        >
          {(id) => (
            <select
              id={id}
              value={value("sequence") || "combined"}
              onChange={(event) => put("sequence")(event.target.value)}
            >
              <option value="combined">Identifier and password together</option>
              <option value="identifier">Identifier, then password</option>
            </select>
          )}
        </Field>
      </>
    );
  if (family === "account-registration")
    return (
      <>
        <p className="step-note">
          This connection can bring an account into being, not merely use one.
        </p>
        <Text
          label="Service origin"
          required
          value={value("service")}
          placeholder="https://example.com"
          hint="Where registration happens, and the only origin a minted or chosen credential may be typed at."
          onChange={put("service")}
        />
        <Field label="What names the account">
          {(id) => (
            <select
              id={id}
              value={value("identifier") || "email"}
              onChange={(event) => put("identifier")(event.target.value)}
            >
              <option value="email">Email address</option>
              <option value="username">Username</option>
              <option value="organization">Organization</option>
            </select>
          )}
        </Field>
        <Field
          label="Credential"
          hint="Registration does not have to begin with a password, and a provider that issues its own credential is never asked for one."
        >
          {(id) => (
            <select
              id={id}
              value={value("secret") || "password"}
              onChange={(event) => put("secret")(event.target.value)}
            >
              <option value="none">
                None — passkey, single sign-on or mailed link
              </option>
              <option value="password">Password the provider will hold</option>
              <option value="issued-token">Token the provider issues</option>
              <option value="provider">Provider owns the step entirely</option>
            </select>
          )}
        </Field>
        <Field label="Where the account is created">
          {(id) => (
            <select
              id={id}
              value={value("createdBy") || "this-ceremony"}
              onChange={(event) => put("createdBy")(event.target.value)}
            >
              <option value="this-ceremony">In this ceremony</option>
              <option value="provider-browser">
                In the provider&rsquo;s own surface
              </option>
            </select>
          )}
        </Field>
      </>
    );
  return (
    <>
      <p className="step-note">
        The ceremony completes with nobody&rsquo;s name on it, and ownership is
        transferred later at the provider. Completion means the transfer
        happened — not that anonymous credentials keep working.
      </p>
      <Text
        label="Claim page"
        required
        value={value("claimUrl")}
        placeholder="https://example.com/claim"
        hint="A provider-owned transfer page. No email is collected here."
        onChange={put("claimUrl")}
      />
    </>
  );
}

function Step({
  index,
  title,
  state,
  onOpen,
  aside,
  children,
}: {
  index: number;
  title: string;
  state: "active" | "done" | "upcoming";
  onOpen?(): void;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section
      className="step"
      data-state={state}
      aria-labelledby={`step-${index}`}
    >
      {onOpen ? (
        <button type="button" className="step-head" onClick={onOpen}>
          <span className="step-index" aria-hidden="true">
            {index}
          </span>
          <span className="step-title" id={`step-${index}`}>
            {title}
          </span>
          {aside}
        </button>
      ) : (
        <div className="step-head">
          <span className="step-index" aria-hidden="true">
            {index}
          </span>
          <span className="step-title" id={`step-${index}`}>
            {title}
          </span>
          {aside}
        </div>
      )}
      {state === "active" && children && (
        <div className="step-body">{children}</div>
      )}
    </section>
  );
}

/**
 * Which browser runs this, offered from what the host says it actually has.
 *
 * The list is the runtime's own descriptors, capability booleans and all. An
 * engine this host does not run is shown disabled with that written on it,
 * because a choice that is accepted and then refused by name teaches a person
 * nothing they could have acted on beforehand.
 */
function BrowserChoice({
  draft,
  negotiation,
  set,
}: {
  draft: ConnectionDraft;
  negotiation: BackendNegotiation | undefined;
  set(patch: Partial<ConnectionDraft>): void;
}) {
  if (!negotiation)
    return (
      <p className="step-note" role="status">
        Asking this workspace which browsers it can run…
      </p>
    );
  if (negotiation.kind === "unavailable")
    return (
      <p className="step-note" role="status">
        {negotiation.message} No browser can be chosen here. This configuration
        can still be sent, and the server will say plainly that it will not run
        it.
      </p>
    );
  const backends = negotiation.backends;
  const chosen = backends.find(
    (backend) =>
      backend.engine === draft.engine && backend.ownership === draft.ownership,
  );
  const unenforced = chosen
    ? Object.entries(chosen.capabilities)
        .filter(([, able]) => able === false)
        .map(([name]) => name)
    : [];
  return (
    <>
      <fieldset className="choice-grid">
        <legend className="fieldset-legend">Browser engine</legend>
        {allEngines.map((engine) => {
          const available = backends.some(
            (backend) => backend.engine === engine,
          );
          const version = backends.find(
            (backend) => backend.engine === engine,
          )?.engineVersion;
          return (
            <label className="choice" key={engine}>
              <div>
                <span className="choice-title">{engineLabels[engine]}</span>
                <span className="choice-note">
                  {available
                    ? `Registered here${version && version !== "unknown" ? `, version ${version}` : ""}.`
                    : "No backend for this engine is registered on this host."}
                </span>
              </div>
              <input
                type="radio"
                name="browser-engine"
                checked={draft.engine === engine}
                disabled={!available}
                onChange={() => set({ engine })}
              />
            </label>
          );
        })}
      </fieldset>
      <fieldset className="choice-grid">
        <legend className="fieldset-legend">Whose browser</legend>
        {(["managed", "attached-user"] as const).map((ownership) => {
          const available = backends.some(
            (backend) =>
              backend.ownership === ownership &&
              backend.engine === draft.engine,
          );
          return (
            <label className="choice" key={ownership}>
              <div>
                <span className="choice-title">
                  {ownershipLabels[ownership]}
                </span>
                <span className="choice-note">
                  {available
                    ? ownership === "managed"
                      ? "Launched and disposed by this workspace."
                      : "Driven through an installed companion; your tabs and cookies are left as they were."
                    : `No ${engineLabels[draft.engine]} backend of this kind is registered on this host.`}
                </span>
              </div>
              <input
                type="radio"
                name="browser-ownership"
                checked={draft.ownership === ownership}
                disabled={!available}
                onChange={() => set({ ownership })}
              />
            </label>
          );
        })}
      </fieldset>
      {unenforced.length > 0 && (
        <p className="field-hint">
          This browser cannot enforce: {unenforced.join(", ")}. A configuration
          that requires one of them is refused before anything launches.
        </p>
      )}
    </>
  );
}

/** One labelled value of the compiled plan, addressable by tests and readers. */
function PlanRow({
  name,
  field,
  children,
}: {
  name: string;
  field: string;
  children: ReactNode;
}) {
  return (
    <>
      <dt>{name}</dt>
      <dd data-plan={field}>{children}</dd>
    </>
  );
}

/**
 * What the server decided, and nothing else.
 *
 * Every value in here arrives in a response. There is deliberately no branch
 * that falls back to the draft: an uncompiled configuration says it is
 * uncompiled, a refused one says who refused it, and a rejected field names the
 * reason and offers the step that owns it. The failure this replaces is a
 * summary that read like a settled configuration while the runtime had never
 * been told any of it.
 */
function EffectiveConfiguration({
  entry,
  draft,
  compiling,
  compiled,
  onFix,
}: {
  entry: CatalogEntry;
  draft: ConnectionDraft;
  compiling: boolean;
  compiled: CompileOutcome | undefined;
  onFix(step: 2 | 3): void;
}) {
  const projected = projectDraft(entry, draft);
  const dropped = notCarriedBy(draft);
  const aside = dropped.length > 0 && (
    <div className="plan-note">
      <h4 className="fieldset-legend">
        Collected here, not carried by the plan
      </h4>
      <ul>
        {dropped.map((item) => (
          <li key={item.key}>
            <strong>{item.label}</strong> — {item.reason}
          </li>
        ))}
      </ul>
    </div>
  );
  if (compiling)
    return (
      <>
        <p role="status">Sending this configuration to be compiled…</p>
        {aside}
      </>
    );
  if (!compiled)
    return (
      <>
        <p className="step-note" role="status">
          Nothing has been sent yet. What you chose is a request: until the
          server compiles it into a plan, none of it is in effect and none of it
          is shown here as settled.
        </p>
        {!projected.ok && (
          <p role="status" className="field-hint">
            <strong>{projected.label}</strong> — {projected.reason}{" "}
            <button
              type="button"
              className="ghost-button"
              onClick={() => onFix(projected.step)}
            >
              Fix in Configure
            </button>
          </p>
        )}
        {aside}
      </>
    );
  if (compiled.kind === "rejected")
    return (
      <>
        <p role="alert">
          The server rejected this configuration: <code>{compiled.reason}</code>
          . {compiled.message}
        </p>
        <button
          type="button"
          className="ghost-button"
          onClick={() => onFix(compiled.step)}
        >
          {compiled.step === 2 ? "Fix in Configure" : "Fix in Customize"}
        </button>
        {aside}
      </>
    );
  if (compiled.kind === "refused")
    return (
      <>
        <p role="alert">
          {compiled.message} <code>{compiled.code}</code>
        </p>
        {aside}
      </>
    );
  const { plan, result, session } = compiled;
  return (
    <>
      {plan ? (
        <dl className="summary-list">
          <PlanRow name="Plan digest" field="digest">
            <code>{plan.digest}</code>
          </PlanRow>
          <PlanRow name="Revision" field="revision">
            {plan.revision}
          </PlanRow>
          {plan.backendId && (
            <PlanRow name="Backend" field="backendId">
              {plan.backendId}
            </PlanRow>
          )}
          {plan.entryUrl && (
            <PlanRow name="Entry address" field="entryUrl">
              <code>{plan.entryUrl}</code>
            </PlanRow>
          )}
          {plan.navigationOrigins && (
            <PlanRow name="May navigate to" field="navigationOrigins">
              {plan.navigationOrigins.join(", ")}
            </PlanRow>
          )}
          {plan.credentialRecipients && (
            <PlanRow
              name="May receive a credential"
              field="credentialRecipients"
            >
              {Object.entries(plan.credentialRecipients).length
                ? Object.entries(plan.credentialRecipients)
                    .map(([role, origins]) => `${role}: ${origins.join(" ")}`)
                    .join("; ")
                : "Nowhere. No origin may be typed into."}
            </PlanRow>
          )}
          {plan.account && (
            <PlanRow name="Account" field="account">
              {plan.account.kind}
            </PlanRow>
          )}
          {plan.continuation && (
            <PlanRow name="When the call returns" field="continuation">
              {plan.continuation}
            </PlanRow>
          )}
          {plan.trustMode && (
            <PlanRow name="Control" field="trustMode">
              {plan.trustMode === "trusted-agent"
                ? "trusted-agent — the controlling client can read the page and use the account"
                : "constrained-auth — validated authentication operations only"}
            </PlanRow>
          )}
          {plan.interactionRounds !== undefined && (
            <PlanRow
              name="Rounds a person may be asked"
              field="interactionRounds"
            >
              {plan.interactionRounds}
            </PlanRow>
          )}
          {plan.requireVerification !== undefined && (
            <PlanRow name="Verification" field="requireVerification">
              {plan.requireVerification
                ? "required before this completes"
                : "not required by this plan"}
            </PlanRow>
          )}
          {plan.sessionTtlMs !== undefined && (
            <PlanRow name="Session lifetime" field="sessionTtlMs">
              {Math.round(plan.sessionTtlMs / 60000)} minutes
            </PlanRow>
          )}
        </dl>
      ) : (
        <p className="step-note">
          This host compiled the configuration and did not echo the plan it
          produced, so what follows is the outcome it reported rather than the
          plan itself.
        </p>
      )}
      <dl className="summary-list">
        <PlanRow name="Outcome" field="status">
          {result.status}
        </PlanRow>
        {result.reason && (
          <PlanRow name="Reason" field="resultReason">
            <code>{result.reason}</code>
          </PlanRow>
        )}
        {result.evidenceKind && (
          <PlanRow name="Evidence" field="evidenceKind">
            {result.evidenceKind}
          </PlanRow>
        )}
        {session && (
          <PlanRow name="Session verified" field="sessionVerified">
            {session.verified ? "yes" : "no"}
          </PlanRow>
        )}
        {session && (
          <PlanRow name="Session engine" field="sessionEngine">
            {session.engine} · {session.ownership}
          </PlanRow>
        )}
      </dl>
      {aside}
    </>
  );
}

export interface AddConnectionProps {
  entry: CatalogEntry;
  /**
   * The live ceremony for this connector.
   *
   * It is handed the compiled outcome, not just the draft, because everything
   * the run surface states about this connection has to come from what the
   * server resolved. `undefined` means nothing has been compiled yet, and the
   * surface has to say so rather than describing what was typed.
   */
  renderRun(
    draft: ConnectionDraft,
    compiled: CompileOutcome | undefined,
  ): ReactNode;
  /**
   * Where to open. A person who clicked a card is configuring; a person who
   * followed a resume link already did, and should land on the run.
   */
  initialStep?: 2 | 4;
  /**
   * Page-level controls that have to stay reachable while this dialog is open.
   *
   * A modal covers the surface behind it on purpose, so anything a person may
   * still need — a pending static-shell update, for one — is handed here and
   * rendered inside the dialog rather than left under the scrim.
   */
  utility?: ReactNode;
  onClose(): void;
  onChangeService(): void;
}

export function AddConnection({
  entry,
  renderRun,
  initialStep = 2,
  utility,
  onClose,
  onChangeService,
}: AddConnectionProps) {
  const [step, setStep] = useState<number>(initialStep);
  const [draft, setDraft] = useState(() => emptyDraft(entry));
  const [negotiation, setNegotiation] = useState<BackendNegotiation>();
  const [compiled, setCompiled] = useState<CompileOutcome>();
  const [compiling, setCompiling] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const set = (patch: Partial<ConnectionDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    // A compiled plan describes the draft it was compiled from. The moment the
    // draft changes it stops describing anything, and leaving it on screen is
    // exactly the confusion this whole file exists to remove.
    setCompiled(undefined);
  };
  useEffect(() => {
    setDraft(emptyDraft(entry));
    setStep(initialStep);
    setCompiled(undefined);
  }, [entry, initialStep]);
  useEffect(() => {
    // Where the keyboard was before the drawer took it, so closing puts it
    // back on the card that opened it rather than at the top of the document.
    const opener = document.activeElement;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("keydown", onKey);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [onClose]);
  // Which browsers this host has, asked once per drawer. Nothing is offered
  // before the answer arrives, and an answer that says "none" is displayed as
  // "none" rather than as a full set of choices that will all be refused.
  useEffect(() => {
    let live = true;
    void readBackends().then((result) => {
      if (!live) return;
      setNegotiation(result);
      const first = result.kind === "offered" ? result.backends[0] : undefined;
      if (first)
        setDraft((current) => ({
          ...current,
          engine: first.engine,
          ownership: first.ownership,
        }));
    });
    return () => {
      live = false;
    };
  }, []);
  const offered = negotiation?.kind === "offered" ? negotiation : undefined;
  const compile = async () => {
    setCompiling(true);
    setCompiled(undefined);
    try {
      setCompiled(await compileConnection(entry, draft));
    } finally {
      setCompiling(false);
    }
  };
  const toggle = (capability: Capability) =>
    set({
      capabilities: draft.capabilities.includes(capability)
        ? draft.capabilities.filter((value) => value !== capability)
        : [...draft.capabilities, capability],
    });
  const state = (index: number) =>
    step === index ? "active" : step > index ? "done" : "upcoming";
  return (
    <>
      <button
        type="button"
        className="drawer-scrim"
        aria-label="Close Add Connection"
        onClick={onClose}
      />
      <div
        className="connect-drawer"
        data-wide={step === 4 ? "" : undefined}
        data-theme="dark"
        role="dialog"
        aria-modal="true"
        aria-label="Add Connection"
        tabIndex={-1}
        ref={panel}
      >
        <div className="drawer-head">
          <h2>Add Connection</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={onClose}
          >
            <Glyph name="close" />
          </button>
        </div>
        <Step
          index={1}
          title={entry.name}
          state={step === 1 ? "active" : "done"}
          onOpen={onChangeService}
          aside={
            <span
              className="step-mark"
              aria-hidden="true"
              {...(entry.tint
                ? { style: { background: entry.tint, borderColor: entry.tint } }
                : {})}
            >
              {initials(entry.name)}
            </span>
          }
        />
        <Step
          index={2}
          title="Configure"
          state={state(2)}
          {...(step > 2 ? { onOpen: () => setStep(2) } : {})}
        >
          <div
            className="segmented"
            role="group"
            aria-label="Configuration source"
          >
            <button
              type="button"
              aria-pressed={draft.mode === "managed"}
              onClick={() => set({ mode: "managed" })}
            >
              Managed
            </button>
            <button
              type="button"
              aria-pressed={draft.mode === "custom"}
              onClick={() => set({ mode: "custom" })}
            >
              Custom
            </button>
          </div>
          {/*
            Every flow the connector declares, each one selectable and each
            swapping in the form its protocol actually needs. A connector with
            one flow still shows it: "which of these am I getting" is a fair
            question even when the answer is short.
          */}
          <fieldset className="flow-list">
            <legend className="fieldset-legend">
              Flows this connector supports
            </legend>
            {entry.auth.map((family) => {
              const [title, detail] = authFamilyLabels[family].split(" · ");
              return (
                <label className="flow" key={family}>
                  <input
                    type="radio"
                    name="auth-family"
                    checked={draft.family === family}
                    onChange={() => set({ family, values: {} })}
                  />
                  <div>
                    <span className="choice-title">{title}</span>
                    {detail && <span className="choice-note">{detail}</span>}
                  </div>
                </label>
              );
            })}
          </fieldset>
          <FamilyForm family={draft.family} draft={draft} set={set} />
          <BrowserChoice draft={draft} negotiation={negotiation} set={set} />
          <div className="step-actions">
            <button
              type="button"
              className="button-secondary"
              onClick={onChangeService}
            >
              Back
            </button>
            <span className="spacer" />
            <button
              type="button"
              className="button-primary"
              onClick={() => setStep(3)}
            >
              Continue
            </button>
          </div>
        </Step>
        <Step
          index={3}
          title="Customize"
          state={state(3)}
          {...(step > 3 ? { onOpen: () => setStep(3) } : {})}
        >
          <p className="step-note">
            What this connection is allowed to do beyond collecting a
            credential. Each option names the module that carries it.
          </p>
          <fieldset className="toggle-list">
            <legend className="sr-only">Connection capabilities</legend>
            {entry.capabilities.map((capability) => {
              const detail = capabilityDetails[capability];
              // The one capability a host can forbid turning off. When it says
              // so, the control is fixed on and carries the reason, rather
              // than accepting a choice the compiler will refuse by name.
              const pinned =
                capability === "verification" &&
                offered?.verificationRequired === true;
              return (
                <label className="toggle" key={capability}>
                  <input
                    type="checkbox"
                    checked={pinned || draft.capabilities.includes(capability)}
                    disabled={pinned}
                    onChange={() => toggle(capability)}
                  />
                  <div>
                    <span className="choice-title">{detail.label}</span>
                    <span className="choice-note">
                      {detail.summary} <code>{detail.module}</code>
                    </span>
                    {pinned && (
                      <span className="choice-note">
                        This workspace refuses a plan that turns verification
                        off, so this cannot be unchecked here.
                      </span>
                    )}
                  </div>
                </label>
              );
            })}
          </fieldset>
          <Field
            label="Interruption budget"
            hint="How often this integration may stop and ask a person. The cheapest route that still satisfies it is the one resolved."
          >
            {(id) => (
              <select
                id={id}
                value={draft.interruptions}
                onChange={(event) =>
                  set({
                    interruptions: event.target
                      .value as ConnectionDraft["interruptions"],
                  })
                }
              >
                <option value="any">Ask as often as the route needs</option>
                <option value="at-most-one">Interrupt at most once</option>
                <option value="none">Never interrupt anyone</option>
              </select>
            )}
          </Field>
          <Field
            label="Whose access this is"
            hint="“Anonymous” must complete without anyone; “personal” needs somebody to own the result."
          >
            {(id) => (
              <select
                id={id}
                value={draft.identity}
                onChange={(event) =>
                  set({
                    identity: event.target.value as ConnectionDraft["identity"],
                  })
                }
              >
                <option value="either">Either</option>
                <option value="personal">Personal</option>
                <option value="anonymous">Anonymous</option>
              </select>
            )}
          </Field>
          <div className="step-actions">
            <button
              type="button"
              className="button-secondary"
              onClick={() => setStep(2)}
            >
              Back
            </button>
            <span className="spacer" />
            <button
              type="button"
              className="button-primary"
              onClick={() => setStep(4)}
            >
              Continue
            </button>
          </div>
        </Step>
        <Step index={4} title="Complete" state={state(4)}>
          <section className="plan-panel" aria-label="Effective configuration">
            <h3 className="fieldset-legend">Effective configuration</h3>
            <EffectiveConfiguration
              entry={entry}
              draft={draft}
              compiling={compiling}
              compiled={compiled}
              onFix={(next) => setStep(next)}
            />
            <div className="step-actions">
              <button
                type="button"
                className="button-secondary"
                disabled={compiling}
                onClick={() => void compile()}
              >
                {compiled ? "Check again" : "Check this configuration"}
              </button>
            </div>
          </section>
          <div className="run-region">{renderRun(draft, compiled)}</div>
          <div className="step-actions">
            <button
              type="button"
              className="button-secondary"
              onClick={() => setStep(3)}
            >
              Back
            </button>
          </div>
        </Step>
        {utility}
        <p className="drawer-foot">
          Setup is saved between steps and only verified provider access
          completes a connection. You keep control of account access and
          provider approvals; cancelling here does not secretly revoke an
          upstream grant.
        </p>
      </div>
    </>
  );
}
