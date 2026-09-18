import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  authFamilyLabels,
  capabilityDetails,
  type AuthFamily,
  type Capability,
  type CatalogEntry,
} from "./catalog.js";
import { Glyph, initials } from "./connect-catalog.js";

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

export type KeyScope = "shared" | "per-user";
export type Mode = "managed" | "custom";

export interface ConnectionDraft {
  entryId: string;
  mode: Mode;
  family: AuthFamily;
  /** Free-form per-family configuration; the server re-validates all of it. */
  values: Record<string, string>;
  keyScope: KeyScope;
  capabilities: Capability[];
  interruptions: "any" | "at-most-one" | "none";
  identity: "personal" | "anonymous" | "either";
}

export function emptyDraft(entry: CatalogEntry): ConnectionDraft {
  return {
    entryId: entry.id,
    mode: "managed",
    family: entry.auth[0]!,
    values: {},
    keyScope: "shared",
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
  if (family === "oauth-code")
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
  keepMounted,
  children,
}: {
  index: number;
  title: string;
  state: "active" | "done" | "upcoming";
  onOpen?(): void;
  aside?: ReactNode;
  /**
   * Hide this step's body instead of unmounting it.
   *
   * Only Complete asks for this, and only because what it hosts is a live
   * connection: unmounting takes its WebMCP tools with it, so an agent would
   * lose `ceremony_<connector>_connect` the moment somebody closed a panel.
   * `hidden` keeps the registration and still takes the step out of the
   * accessibility tree.
   */
  keepMounted?: boolean;
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
      {children && (keepMounted || state === "active") && (
        <div className="step-body" hidden={state !== "active"}>
          {children}
        </div>
      )}
    </section>
  );
}

export interface AddConnectionProps {
  entry: CatalogEntry;
  /**
   * Whether the drawer is on screen.
   *
   * Closed, it renders nothing a person can see or reach — but it stays
   * mounted, because Complete hosts a live connection and unmounting it would
   * take its WebMCP tools with it. Before this surface existed, Connect
   * rendered that connection whenever Connect was showing, and an agent could
   * call `ceremony_<connector>_connect` without a human opening a panel first.
   */
  open: boolean;
  /** The live ceremony for this connector, rendered once the draft is settled. */
  renderRun(draft: ConnectionDraft): ReactNode;
  /**
   * Where to open. A person who clicked a card is configuring; a person who
   * followed a resume link already did, and should land on the run.
   */
  initialStep?: 2 | 4;
  onClose(): void;
  onChangeService(): void;
}

export function AddConnection({
  entry,
  open,
  renderRun,
  initialStep = 2,
  onClose,
  onChangeService,
}: AddConnectionProps) {
  const [step, setStep] = useState<number>(initialStep);
  const [draft, setDraft] = useState(() => emptyDraft(entry));
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  // Held in a ref so the focus effect below does not depend on a callback
  // identity. onClose is an inline arrow in the host, so a dependency on it
  // re-runs the effect on every host render and pulls focus back to the panel
  // from whatever the person was actually using.
  const dismiss = useRef(onClose);
  dismiss.current = onClose;
  const set = (patch: Partial<ConnectionDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  useEffect(() => {
    setDraft(emptyDraft(entry));
    setStep(initialStep);
    // Keyed on the id, not the object: `entries` is rebuilt whenever config
    // resolves, and a new object identity for the same connector would discard
    // everything the person had typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, initialStep]);
  /**
   * Focus enters once, cycles inside, and goes back where it came from.
   *
   * A dialog that declares aria-modal and then leaves the page behind it
   * tabbable is telling assistive technology something untrue, and dropping
   * focus on the floor at close leaves a keyboard user at the top of the
   * document with no idea where they were.
   */
  useEffect(() => {
    if (!open) return;
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss.current();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const reachable = [
        ...panel.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => element.getClientRects().length > 0);
      const first = reachable[0];
      const last = reachable[reachable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("keydown", onKey);
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, [open]);
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
        hidden={!open}
        onClick={onClose}
      />
      <div
        className="connect-drawer"
        hidden={!open}
        data-step={step}
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
          {step === 4 && (
            <button
              type="button"
              className="reopen-setup"
              onClick={() => setStep(2)}
            >
              Back to setup
            </button>
          )}
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
            What this connection should do beyond collecting a credential. Each
            option names the module that carries it. These are a declaration,
            not a grant: the budget and whose access this is reach the resolver
            directly, and the server decides what it will actually run.
          </p>
          <fieldset className="toggle-list">
            <legend className="sr-only">Connection capabilities</legend>
            {entry.capabilities.map((capability) => {
              const detail = capabilityDetails[capability];
              return (
                <label className="toggle" key={capability}>
                  <input
                    type="checkbox"
                    checked={draft.capabilities.includes(capability)}
                    onChange={() => toggle(capability)}
                  />
                  <div>
                    <span className="choice-title">{detail.label}</span>
                    <span className="choice-note">
                      {detail.summary} <code>{detail.module}</code>
                    </span>
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
        <Step index={4} title="Complete" state={state(4)} keepMounted>
          <details className="summary-disclosure">
            <summary>Connection summary</summary>
            <dl className="summary-list">
              <dt>Service</dt>
              <dd>{entry.name}</dd>
              <dt>Configuration</dt>
              <dd>{draft.mode === "managed" ? "Managed" : "Custom"}</dd>
              <dt>Auth family</dt>
              <dd>{authFamilyLabels[draft.family]}</dd>
              <dt>Capabilities</dt>
              <dd>
                {draft.capabilities.length
                  ? draft.capabilities
                      .map((capability) => capabilityDetails[capability].label)
                      .join(", ")
                  : "Credential collection only"}
              </dd>
            </dl>
          </details>
          <div className="run-region">{renderRun(draft)}</div>
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
