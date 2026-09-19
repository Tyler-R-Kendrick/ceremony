import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  authFamilyLabels,
  capabilityDetails,
  isHostSwitchable,
  type AuthFamily,
  type HostCapability,
  type CatalogEntry,
} from "./catalog.js";
import { Glyph, initials } from "./connect-catalog.js";
import { environmentName } from "./declaration.js";
import {
  allEngines,
  compileConnection,
  engineLabels,
  ownershipLabels,
  readBackends,
  rejectionGuidance,
  type BackendNegotiation,
  type CompileOutcome,
  type ConnectionDraft,
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

/**
 * The draft lives beside the code that sends it, not beside the form.
 *
 * `connection-plan.ts` is the only module allowed to put a draft on the wire,
 * and it is the one that has to stay in step with the compiler's own draft
 * type. Defining the shape here as well meant two declarations of the same
 * thing, and the one the server checks against is the other one. Re-exported
 * because `main.tsx` and `declaration.ts` name it from here.
 */
export type { ConnectionDraft, KeyScope, Mode } from "./connection-plan.js";

/**
 * The families whose Configure step actually reads `mode`.
 *
 * Only these three swap a form when it changes: OAuth and the GitHub App offer
 * discovery against hand-entered endpoints, and device authorization makes one
 * field required. For the other five the control moved a highlight, changed
 * nothing on screen, and still wrote `custom` into the draft — which the
 * summary then reported as "Configuration: Custom" and the server received.
 * This branch removes the control where it is inert rather than styling it,
 * which is what was done to the other three controls like it.
 */
const modeAwareFamilies: readonly AuthFamily[] = [
  "oauth-code",
  "github-app",
  "device",
];

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
    // Only what this application can actually turn off, starting where the
    // application already started. A card that exists for one capability names
    // it; everything else takes the capability's own default, so opening a
    // drawer never quietly asks for more than the page did before.
    capabilities: entry.capabilities.filter(isHostSwitchable).filter(
      (capability) =>
        capabilityDetails[capability].defaultOn ||
        // A card that exists for one capability adds it to the defaults
        // rather than replacing them: "Record a Sign-in" is a reason to
        // teach, not a reason to stop exposing the connection.
        entry.defaultCapabilities?.includes(capability),
    ),
    interruptions: "any",
    identity: "either",
    // A starting point, not a decision. The Customize step replaces both from
    // the host's own registered backends, and a host that registers none
    // offers nothing to pick: the wizard says so rather than defaulting to a
    // browser that is not there.
    engine: "chromium",
    ownership: "managed",
  };
}

/** A duration a person can read, from the milliseconds a plan carries. */
function minutes(value: number | undefined): string {
  if (value === undefined) return "not stated";
  const total = Math.round(value / 60_000);
  if (total < 1) return "under a minute";
  return total === 1 ? "1 minute" : `${total} minutes`;
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
      {hint && (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

function Text({
  label,
  value,
  placeholder,
  required,
  hint,
  invalid,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  required?: boolean;
  hint?: ReactNode;
  /** Said out loud when the value cannot be used, in place of the hint. */
  invalid?: string;
  onChange(value: string): void;
}) {
  const message = invalid ?? hint;
  return (
    <Field
      label={label}
      {...(required ? { required } : {})}
      {...(message ? { hint: message } : {})}
    >
      {(id) => (
        <input
          id={id}
          type="text"
          value={value}
          {...(placeholder ? { placeholder } : {})}
          {...(message ? { "aria-describedby": `${id}-hint` } : {})}
          {...(invalid ? { "aria-invalid": true } : {})}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

/**
 * A field that names a session-environment entry rather than carrying a value.
 *
 * The name is the whole point — the secret stays in the encrypted vault — so a
 * name the vault cannot hold is worth saying immediately. The declaration
 * drops one silently rather than throwing from inside a render, and silently
 * is exactly what this stops it being.
 */
function EnvironmentName({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange(value: string): void;
}) {
  const usable =
    value.trim().length === 0 || environmentName.test(value.trim());
  return (
    <Text
      label={label}
      value={value}
      placeholder={placeholder}
      hint="Names a session-environment entry. Secrets are never typed into this form; the value stays in the encrypted vault."
      {...(usable
        ? {}
        : {
            invalid:
              "Capitals, digits and underscores, starting with a letter — the shape a session-environment entry has. Until it matches, this connection is declared as not holding it.",
          })}
      onChange={onChange}
    />
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
    return (
      <>
        {managed ? (
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
              Declare the endpoints yourself when a provider publishes no
              metadata document.
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
          </>
        )}
        {/* Neither of these is an endpoint, so discovery never supplies them:
            what a connection asks for is a decision, and where its client id
            lives is this workspace's business. Managed mode was offering only
            the issuer, which left a discovered provider with nothing to say to
            the resolver. */}
        <EnvironmentName
          label="Client ID environment name"
          value={value("clientIdName")}
          placeholder="EXAMPLE_CLIENT_ID"
          onChange={put("clientIdName")}
        />
        <Text
          label="Scopes"
          value={value("scopes")}
          placeholder="read:user repo"
          hint="What this connection is asking to be able to do. A route that cannot carry every one of them is not offered."
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
          <EnvironmentName
            label="Key environment name"
            value={value("keyName")}
            placeholder="EXAMPLE_API_KEY"
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
        <EnvironmentName
          label="App ID environment name"
          value={value("appIdName")}
          placeholder="GITHUB_APP_ID"
          onChange={put("appIdName")}
        />
        <EnvironmentName
          label="Private key environment name"
          value={value("appKeyName")}
          placeholder="GITHUB_APP_PRIVATE_KEY"
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
  renderRun(draft: ConnectionDraft, runEpoch: number): ReactNode;
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
  /**
   * How many times Complete has been arrived at.
   *
   * The run reads the declaration when it mounts and keeps what it read, so a
   * run mounted on the drawer's first paint is holding the empty draft and
   * every answer given afterwards is decoration — the summary says one thing
   * and the resolver is handed another. The fix is not to delay the mount:
   * mounting is also what registers this connection's WebMCP tools, and those
   * are expected from page load, whether or not anybody opens the drawer.
   *
   * So the run stays mounted throughout and is rebuilt at the one moment the
   * declaration is finished — arriving at Complete. Going back, changing an
   * answer and returning arrives again, so the rebuilt run carries the changed
   * declaration too. A run already under way is handed its resume id, so being
   * rebuilt returns it to the same ceremony rather than starting another.
   */
  const [runEpoch, setRunEpoch] = useState(0);
  useEffect(() => {
    if (step === 4) setRunEpoch((count) => count + 1);
  }, [step]);
  /**
   * What the server compiled, which is the only thing Complete may present as
   * settled.
   *
   * `undefined` is "not asked yet" and is rendered as such. It is never
   * rendered as the draft: a summary assembled from the answers a person gave
   * reads exactly like a summary of what will run, and the two are different
   * documents whenever the compiler narrows, refuses or substitutes anything.
   */
  const [compiled, setCompiled] = useState<CompileOutcome | undefined>();
  const [compiling, setCompiling] = useState(false);
  const [backends, setBackends] = useState<BackendNegotiation | undefined>();
  /**
   * Asked when the drawer opens, never on mount.
   *
   * This component stays mounted from page load so its WebMCP tools are
   * registered whether or not anybody opens it, and this host hands a session
   * to the first call that arrives without one - so a second question asked
   * beside the directory's own comes back as a different person: two sessions
   * created, and the browser keeping whichever reply landed last. Nobody
   * choosing a browser is doing it before the drawer is on screen, so there
   * is nothing to gain by asking earlier and a session to lose.
   */
  useEffect(() => {
    if (!open || backends !== undefined) return;
    let live = true;
    void readBackends().then((answer) => {
      if (live) setBackends(answer);
    });
    return () => {
      live = false;
    };
  }, [open, backends]);
  /** What the host actually registered. Empty until it has answered. */
  const offers = backends?.kind === "offered" ? backends.backends : [];
  /**
   * What the selected backend cannot do that a plan is allowed to require.
   *
   * Narrowed to the requirable set on purpose. A descriptor carries other
   * false flags that are not deficiencies at all - `debugExposure: false` is
   * the browser declining to expose a debugger, which is the answer anyone
   * would want - and listing those as things it "cannot enforce" would turn a
   * safety property into an apology. Only a capability a plan can name in
   * `required`, and therefore be refused over, belongs here.
   */
  const requirable = [
    "retainedSession",
    "strongEgressContainment",
    "statePersistence",
    "frameBinding",
    "popupBinding",
  ] as const;
  const selected = offers.find(
    (backend) =>
      backend.engine === draft.engine && backend.ownership === draft.ownership,
  );
  const unenforceable = selected
    ? requirable.filter((name) => selected.capabilities[name] !== true)
    : [];
  /**
   * A compiled plan describes the draft it was compiled from, and nothing
   * else.
   *
   * So any edit discards it. Leaving the previous answer on screen while the
   * configuration behind it changes is the same defect as rendering the draft
   * in the first place, only harder to notice: the digest, the origins and the
   * budget would all still be there, all still look authoritative, and all
   * describe a configuration that is no longer the one on screen.
   */
  useEffect(() => {
    setCompiled(undefined);
  }, [draft]);
  const check = async () => {
    setCompiling(true);
    const outcome = await compileConnection(entry, draft);
    setCompiled(outcome);
    setCompiling(false);
  };
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
    /*
     * Captured, not bubbled. A modal's dismissal should not be something a
     * descendant can withhold: on the way down this runs before anything
     * between the key and here gets a chance to stop it, and the alternative
     * is a dialog that cannot be closed from the keyboard for reasons no part
     * of this file can see.
     */
    addEventListener("keydown", onKey, true);
    return () => {
      removeEventListener("keydown", onKey, true);
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, [open]);
  /**
   * The step that replaces this one inherits the focus it held.
   *
   * Continue removes the button that was just pressed, so focus falls to the
   * body — outside a dialog that declares `aria-modal`, which is the thing the
   * trap above exists to prevent and it happened at every step rather than
   * only at close. A keyboard user was put at the top of the document with the
   * dialog still over it, and Escape went with them: the handler is on the
   * window, and a document with nothing focused is not reliably given the key
   * at all. That shows up as a modal nobody can dismiss.
   *
   * Focus already inside is left alone, so this never takes a field away from
   * somebody mid-answer.
   */
  useEffect(() => {
    if (!open || panel.current?.contains(document.activeElement)) return;
    panel.current?.focus();
  }, [open, step]);
  const toggle = (capability: HostCapability) =>
    set({
      capabilities: draft.capabilities.includes(capability)
        ? draft.capabilities.filter((value) => value !== capability)
        : [...draft.capabilities, capability],
    });
  const state = (index: number) =>
    step === index ? "active" : step > index ? "done" : "upcoming";
  const switchable = entry.capabilities.filter(isHostSwitchable);
  const described = entry.capabilities.filter(
    (capability) => !isHostSwitchable(capability),
  );
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
          {modeAwareFamilies.includes(draft.family) && (
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
          )}
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
                    onChange={() =>
                      set({
                        family,
                        values: {},
                        // A family that never reads this must not inherit
                        // somebody's answer to a question it does not ask.
                        ...(modeAwareFamilies.includes(family)
                          ? {}
                          : { mode: "managed" as const }),
                      })
                    }
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
          {/*
           * Two questions, not one dropdown.
           *
           * Which engine and whose browser are independent, and a host
           * commonly runs one of each rather than a matrix. Asking them
           * separately also lets each answer carry its own reason for being
           * unavailable, which a combined list cannot: "no backend for this
           * engine" and "no companion is attached" are different problems with
           * different fixes.
           *
           * An engine this host does not run is shown and disabled rather than
           * omitted. A list that silently contains only what works reads as
           * the whole world; a disabled row with a reason on it says the world
           * is bigger than this host.
           */}
          <fieldset className="choice-group">
            <legend>Browser engine</legend>
            {allEngines.map((engine) => {
              const offered = offers.some(
                (backend) => backend.engine === engine,
              );
              return (
                <label key={engine} className="choice">
                  <input
                    type="radio"
                    name="browser-engine"
                    value={engine}
                    disabled={!offered}
                    checked={offered && draft.engine === engine}
                    onChange={() => set({ engine })}
                  />
                  <span className="choice-title">{engineLabels[engine]}</span>
                  <span className="choice-note">
                    {offered
                      ? (offers.find((backend) => backend.engine === engine)
                          ?.engineVersion ?? "")
                      : "No backend for this engine is registered on this host."}
                  </span>
                </label>
              );
            })}
          </fieldset>
          <fieldset className="choice-group">
            <legend>Whose browser</legend>
            {(["managed", "attached-user"] as const).map((ownership) => {
              const offered = offers.some(
                (backend) => backend.ownership === ownership,
              );
              return (
                <label key={ownership} className="choice">
                  <input
                    type="radio"
                    name="browser-ownership"
                    value={ownership}
                    disabled={!offered}
                    checked={offered && draft.ownership === ownership}
                    onChange={() => set({ ownership })}
                  />
                  <span className="choice-title">
                    {ownershipLabels[ownership]}
                  </span>
                  {!offered && (
                    <span className="choice-note">
                      No browser of this kind is registered on this host.
                    </span>
                  )}
                </label>
              );
            })}
          </fieldset>
          {backends?.kind === "offered" && backends.verificationRequired && (
            <p className="choice-note">
              This workspace refuses a plan that turns verification off, so
              every connection made here has to read something the grant was for
              before it completes.
            </p>
          )}
          {unenforceable.length > 0 && (
            <p className="choice-note">
              What the selected browser cannot enforce:{" "}
              {unenforceable.join(", ")}. A plan that requires one of these is
              refused rather than run without it.
            </p>
          )}
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
            one names the module that carries it, so the claim is checkable
            rather than decorative.
          </p>
          {switchable.length > 0 && (
            <fieldset className="toggle-list">
              <legend className="sr-only">Connection capabilities</legend>
              {switchable.map((capability) => {
                const detail = capabilityDetails[capability];
                const on = draft.capabilities.includes(capability);
                return (
                  <label className="toggle" key={capability}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(capability)}
                    />
                    <div>
                      <span className="choice-title">{detail.label}</span>
                      <span className="choice-note">
                        {detail.summary} <code>{detail.module}</code>
                      </span>
                      {/* What the connection is without it, said while the
                          box is still ticked — after it is cleared there is
                          nothing on screen to explain what changed. */}
                      {on && "offNote" in detail && (
                        <span className="choice-note choice-consequence">
                          {detail.offNote}
                        </span>
                      )}
                    </div>
                  </label>
                );
              })}
            </fieldset>
          )}
          {/*
           * Not checkboxes. These are settled by the connector's manifest and
           * its adapter, so a box here would be a control that changes
           * nothing — the same promise the rail's dead switchers used to make.
           * They still belong on screen: they are most of what separates this
           * connection from a credential form.
           */}
          {described.length > 0 && (
            <div className="capability-readout">
              <h3>What this connection does anyway</h3>
              <ul>
                {described.map((capability) => {
                  const detail = capabilityDetails[capability];
                  return (
                    <li key={capability}>
                      <span className="choice-title">{detail.label}</span>
                      <span className="choice-note">
                        {detail.summary} <code>{detail.module}</code>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
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
          {/*
           * What the server compiled, never what this page asked for.
           *
           * The list this replaces was assembled from `draft` and read as a
           * statement of what would run: "Managed, OAuth, teaching on". It was
           * a statement of what had been *requested*. Every value below comes
           * out of the compiler's own echo, and when the compiler refused
           * there is no list at all - because there is nothing in effect to
           * describe, and printing the request in its place is the precise
           * defect this step exists to remove.
           */}
          <section
            className="plan-readout"
            aria-label="Effective configuration"
          >
            <h3>Effective configuration</h3>
            <button
              type="button"
              className="button-secondary"
              onClick={() => void check()}
              disabled={compiling}
            >
              {compiling
                ? "Checking…"
                : compiled
                  ? "Check this configuration again"
                  : "Check this configuration"}
            </button>
            {compiled === undefined ? (
              <p className="choice-note">
                Nothing has been sent yet, so there is nothing to report. What
                you chose above is a request; this is where the server says what
                it will actually run.
              </p>
            ) : compiled.kind === "refused" ? (
              <p className="choice-note" role="alert">
                {compiled.message}
              </p>
            ) : compiled.kind === "rejected" ? (
              <>
                <p role="alert">
                  <strong>{compiled.reason}</strong> — {compiled.message}
                </p>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setStep(compiled.step)}
                >
                  {compiled.step === 2
                    ? "Fix in Configure"
                    : "Fix in Customize"}
                </button>
              </>
            ) : compiled.plan === undefined ? (
              <p className="choice-note" role="status">
                This host ran the configuration without echoing the plan it
                compiled, so there is nothing here to show you. That is the
                host&rsquo;s answer, not a summary of what you typed.
              </p>
            ) : (
              <dl className="summary-list">
                <dt>Plan digest</dt>
                <dd>
                  <code data-plan="digest">{compiled.plan.digest}</code>
                </dd>
                <dt>Revision</dt>
                <dd data-plan="revision">{compiled.plan.revision}</dd>
                <dt>Browser</dt>
                <dd data-plan="engine">
                  {compiled.plan.engine ?? "not stated"} ·{" "}
                  {compiled.plan.ownership ?? "not stated"}
                </dd>
                <dt>Starts at</dt>
                <dd data-plan="entryUrl">
                  {compiled.plan.entryUrl ?? "not stated"}
                </dd>
                <dt>May navigate to</dt>
                <dd data-plan="navigationOrigins">
                  {compiled.plan.navigationOrigins?.join(", ") ?? "not stated"}
                </dd>
                <dt>Trust mode</dt>
                <dd data-plan="trustMode">
                  {compiled.plan.trustMode ?? "not stated"}
                </dd>
                <dt>Continuation</dt>
                <dd data-plan="continuation">
                  {compiled.plan.continuation ?? "not stated"}
                </dd>
                <dt>Verifies real access</dt>
                <dd data-plan="requireVerification">
                  {compiled.plan.requireVerification === undefined
                    ? "not stated"
                    : compiled.plan.requireVerification
                      ? "yes"
                      : "no"}
                </dd>
                <dt>Times it may interrupt</dt>
                <dd data-plan="interactionRounds">
                  {compiled.plan.interactionRounds ?? "not stated"}
                </dd>
                <dt>Session lifetime</dt>
                <dd data-plan="sessionTtlMs">
                  {minutes(compiled.plan.sessionTtlMs)}
                </dd>
              </dl>
            )}
          </section>
          <div className="run-region">{renderRun(draft, runEpoch)}</div>
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
