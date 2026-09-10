"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { z } from "zod";
import type { RecipeDefinition } from "../core/recipe-contracts.js";
import type { DemonstrationEvent } from "../core/teaching-contracts.js";
import {
  createConnectionTools,
  type ConnectionState,
} from "../core/connection-tools.js";
import { createAuthoringTools } from "../core/authoring-tools.js";
import { browserModelContext } from "../core/webmcp.js";

export type TeachingRun = {
  id: string;
  revision: number;
  provider: string;
  profile: string;
  status: "active" | "cancelled" | "complete";
  nodes: Array<{
    id: string;
    operationId: string;
    state: string;
    verified: boolean;
  }>;
};
type Run = TeachingRun;
type Demo = {
  id: string;
  revision: number;
  consent: "recording" | "paused" | "stopped" | "discarded";
  events?: DemonstrationEvent[];
};
type Draft = {
  id: string;
  revision: number;
  digest: string;
  definition: RecipeDefinition;
  diagnostics: Array<{ code: string; node?: string }>;
};
type Saved = { definition: RecipeDefinition; version: string; digest: string };
const operationLabels: Record<string, string> = {
  "github.prepare-app": "Prepare GitHub App",
  "github.authorize-installation": "Authorize installation",
  "github.verify-access": "Verify GitHub access",
  "stripe.prepare-account": "Open or create your Stripe account",
  "stripe.obtain-key": "Obtain a restricted Stripe key",
  "stripe.verify-access": "Verify Stripe access",
  "supabase.prepare-project": "Set up your Supabase project",
  "supabase.obtain-session": "Sign in or create a project account",
  "supabase.verify-access": "Verify Supabase access",
  "jira.prepare-app": "Prepare the shared Jira integration",
  "jira.authorize-user": "Authorize your Atlassian account",
  "jira.verify-access": "Verify access to your Jira site",
};
const operationLabel = (id: string) =>
  operationLabels[id] ?? "Registered connection step";
class AccountRequired extends Error {}

async function requestAt<T>(
  base: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  if (
    typeof navigator !== "undefined" &&
    !navigator.onLine &&
    body !== undefined
  )
    throw new Error(
      "You are offline. Reconnect before continuing this connection.",
    );
  const response = await fetch(`${base}${path}`, {
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    if (response.status === 401)
      throw new Error("Sign in again to resume your connection.");
    if (response.status === 409) {
      const result: unknown = await response.json().catch(() => null);
      if (
        result &&
        typeof result === "object" &&
        Reflect.get(result, "error") === "account-required"
      )
        throw new AccountRequired("Choose the GitHub account to connect.");
      if (
        result &&
        typeof result === "object" &&
        Reflect.get(result, "error") === "jira-site-required"
      )
        throw new AccountRequired("Choose the Jira site to connect.");
      if (
        result &&
        typeof result === "object" &&
        Reflect.get(result, "error") === "incomplete-github-configuration"
      )
        throw new Error(
          "Complete all four GitHub App variables in Environment, or remove the partial configuration to use guided registration.",
        );
      throw new Error(
        "This connection changed in another tab. Refresh its status and try again.",
      );
    }
    if (response.status === 403)
      throw new Error("Your account does not have permission for this action.");
    throw new Error(
      "This action could not finish. Your completed steps are preserved; refresh the status to continue.",
    );
  }
  return response.json() as Promise<T>;
}

export interface TeachingConnectionProps {
  connectorId?: string;
  mode?: "connect" | "studio";
  apiBase?: string;
  resumeId?: string;
  /** Supplying this callback leaves URL/navigation ownership with the embedding host. */
  onRunChange?: (run: TeachingRun) => void;
  onSignIn?: () => void | Promise<void>;
  onSignOut?: () => void | Promise<void>;
  onSignedOut?: () => void;
  webmcp?: false | { prefix: string };
  className?: string;
  style?: CSSProperties;
  autoFocus?: boolean;
}
export function TeachingConnection({
  connectorId = "github",
  mode = "connect",
  apiBase = "/api/v1/teaching",
  resumeId,
  onRunChange,
  onSignIn,
  onSignOut,
  onSignedOut,
  webmcp,
  className,
  style,
  autoFocus = true,
}: TeachingConnectionProps) {
  const serviceName =
    connectorId === "github"
      ? "GitHub"
      : connectorId === "stripe"
        ? "Stripe"
        : connectorId === "supabase"
          ? "Supabase"
          : connectorId === "jira"
            ? "Jira"
            : connectorId === "bluesky"
              ? "Bluesky"
              : connectorId.replace(/-/g, " ");
  const base = apiBase.replace(/\/$/, "");
  const request = useCallback(
    <T,>(path: string, body?: unknown, signal?: AbortSignal) =>
      requestAt<T>(base, path, body, signal),
    [base],
  );
  const host = useRef({ onRunChange, onSignedOut });
  host.current = { onRunChange, onSignedOut };
  const toolPrefix =
    webmcp === false ? null : (webmcp?.prefix ?? `ceremony_${connectorId}`);
  const [capabilities, setCapabilities] = useState<{
    available: boolean;
    authenticated: boolean;
    modelAvailable: boolean;
    signOutAvailable?: boolean;
    connectors?: string[];
  }>();
  const [run, setRun] = useState<Run>();
  const [demo, setDemo] = useState<Demo>();
  const [draft, setDraft] = useState<Draft>();
  const [saved, setSaved] = useState<Saved[]>([]);
  const [selectedRecipes, setSelectedRecipes] = useState<string[]>([]);
  const [first, setFirst] = useState(0);
  const [last, setLast] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [assistant, setAssistant] = useState(false);
  const [assistantEpoch, setAssistantEpoch] = useState(0);
  const [assistantBlocked, setAssistantBlocked] = useState<
    "" | "stopped" | "budget-exhausted"
  >("");
  const [adjusting, setAdjusting] = useState(false);
  const [title, setTitle] = useState("");
  const [offline, setOffline] = useState(
    typeof navigator !== "undefined" && !navigator.onLine,
  );
  const [accountRequired, setAccountRequired] = useState(false);
  const [target, setTarget] = useState("");
  const mounted = useRef(true);
  const currentRun = useRef<Run | undefined>(undefined);
  const advancing = useRef(false);
  const lastAttempt = useRef("");
  const status = useRef<HTMLHeadingElement>(null);
  const active = run?.nodes.find((node) => !node.verified);
  const complete = run?.status === "complete";

  const act = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (error) {
      if (error instanceof AccountRequired) setAccountRequired(true);
      if (mounted.current)
        setError(
          error instanceof Error
            ? error.message
            : "The action could not finish.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);
  const remember = useCallback(
    (value: Run) => {
      if (!mounted.current) return;
      if (value.provider !== connectorId) {
        setError(
          "This saved connection belongs to another service. Start a connection for the selected service.",
        );
        return false;
      }
      setRun(value);
      currentRun.current = value;
      if (host.current.onRunChange) {
        // Host observers cannot turn a committed server result into a failed command.
        try {
          host.current.onRunChange(value);
        } catch {
          /* Observer owns its error handling. */
        }
        return true;
      }
      // Non-authorizing resume hint only; server authentication is required on every read.
      const url = new URL(location.href);
      url.searchParams.set("teachingRun", value.id);
      history.replaceState(null, "", url);
      return true;
    },
    [connectorId],
  );
  const refresh = useCallback(async () => {
    if (run)
      remember(await request<Run>(`/runs/${encodeURIComponent(run.id)}`));
    if (demo && demo.consent !== "discarded")
      setDemo(
        await request<Demo>(`/demonstrations/${encodeURIComponent(demo.id)}`),
      );
  }, [run, demo, remember, request]);
  const loadRecipes = useCallback(
    async () =>
      setSaved((await request<{ recipes: Saved[] }>("/recipes")).recipes),
    [request],
  );
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  const runId = run?.id;
  useEffect(() => {
    setAssistantBlocked("");
    if (autoFocus && runId) status.current?.focus();
  }, [runId, autoFocus]);
  useEffect(() => {
    if (
      !runId ||
      !capabilities?.modelAvailable ||
      offline ||
      typeof EventSource === "undefined"
    )
      return;
    const stream = new EventSource(
      `${base}/agent/${encodeURIComponent(runId)}/stream`,
    );
    let ended = false;
    stream.addEventListener("status", (event) => {
      const parsed = z
        .strictObject({
          status: z.enum([
            "idle",
            "running",
            "awaiting-human",
            "complete",
            "stopped",
            "unavailable",
            "budget-exhausted",
            "uncertain",
          ]),
          modelCalls: z.number().int().nonnegative(),
          requestedTools: z.number().int().nonnegative(),
        })
        .safeParse(
          (() => {
            try {
              return JSON.parse((event as MessageEvent<string>).data);
            } catch {
              return null;
            }
          })(),
        );
      if (!parsed.success) {
        stream.close();
        return;
      }
      const state = parsed.data.status;
      setAssistant(state === "running" || state === "awaiting-human");
      if (state === "stopped" || state === "budget-exhausted")
        setAssistantBlocked(state);
      if (state !== "running") {
        stream.close();
        if (!ended && state !== "idle") {
          ended = true;
          void act(() => latestRefresh.current());
        }
      }
    });
    // A transport disconnect does not issue stop/cancel. Native EventSource reconnects with a fresh authenticated read.
    return () => stream.close();
  }, [runId, capabilities?.modelAvailable, base, offline, assistantEpoch, act]);
  useEffect(() => {
    const context = browserModelContext();
    if (!context || mode !== "connect" || toolPrefix === null) return;
    const lifetime = new AbortController();
    const existing = () => {
      if (!currentRun.current) throw new Error("Connect first");
      return currentRun.current.id;
    };
    const accept = async (promise: Promise<ConnectionState>) => {
      const value = await promise;
      if (!lifetime.signal.aborted) remember(value);
      return value;
    };
    const tools = createConnectionTools(toolPrefix, {
      connect: () =>
        accept(request<ConnectionState>("/tools/connect", { connectorId })),
      snapshot: () =>
        request<ConnectionState>("/tools/snapshot", { runId: existing() }),
      advance: (nodeId, revision, commandId) =>
        accept(
          request<ConnectionState>("/tools/advance", {
            runId: existing(),
            nodeId,
            revision,
            commandId,
          }),
        ),
      cancel: (revision) =>
        accept(
          request<ConnectionState>("/tools/cancel", {
            runId: existing(),
            revision,
          }),
        ),
    });
    void (async () => {
      try {
        for (const tool of tools) {
          if (lifetime.signal.aborted) return;
          await context.registerTool(tool, { signal: lifetime.signal });
        }
      } catch {
        lifetime.abort();
        setNotice(
          "Browser tools are unavailable. The normal connection controls still work.",
        );
      }
    })();
    return () => lifetime.abort();
  }, [connectorId, mode, remember, request, toolPrefix]);
  useEffect(() => {
    const context = browserModelContext();
    if (!context || mode !== "connect") return;
    const lifetime = new AbortController();
    const tools = createAuthoringTools("ceremony_author", {
      fromProvider: (input) => request("/authoring/from-provider", input),
      compose: (input) => request("/authoring/compose", input),
      read: (draftId) => request(`/authoring/drafts/${draftId}`),
    });
    void (async () => {
      try {
        for (const tool of tools) {
          if (lifetime.signal.aborted) return;
          await context.registerTool(tool, { signal: lifetime.signal });
        }
      } catch {
        lifetime.abort();
      }
    })();
    return () => lifetime.abort();
  }, [mode, request]);
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    request<{
      available: boolean;
      authenticated: boolean;
      modelAvailable: boolean;
      signOutAvailable?: boolean;
      connectors?: string[];
    }>("/capabilities", undefined, abort.signal)
      .then(async (value) => {
        if (abort.signal.aborted) return;
        setCapabilities(value);
        if (!value.available || !value.authenticated) return;
        await loadRecipes();
        const hint =
          resumeId ??
          (host.current.onRunChange
            ? null
            : new URL(location.href).searchParams.get("teachingRun"));
        if (
          hint &&
          !remember(
            await request<Run>(
              `/runs/${encodeURIComponent(hint)}`,
              undefined,
              abort.signal,
            ),
          )
        )
          return;
        if (hint)
          setDemo(
            (
              await request<{ demonstration: Demo | null }>(
                `/runs/${encodeURIComponent(hint)}/demonstration`,
              )
            ).demonstration ?? undefined,
          );
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setCapabilities({
            available: false,
            authenticated: false,
            modelAvailable: false,
          });
      });
    const online = () => setOffline(!navigator.onLine);
    addEventListener("online", online);
    addEventListener("offline", online);
    const sessionChannel =
      typeof BroadcastChannel === "undefined"
        ? undefined
        : new BroadcastChannel("ceremony-session");
    if (sessionChannel)
      sessionChannel.onmessage = (event) => {
        if (event.data === "signed-out") {
          setRun(undefined);
          currentRun.current = undefined;
          setDemo(undefined);
          setDraft(undefined);
          setSaved([]);
          setAssistant(false);
          setCapabilities({
            available: true,
            authenticated: false,
            modelAvailable: false,
          });
          if (host.current.onSignedOut) host.current.onSignedOut();
          else if (!host.current.onRunChange) location.replace("/");
        }
      };
    return () => {
      mounted.current = false;
      abort.abort();
      removeEventListener("online", online);
      removeEventListener("offline", online);
      sessionChannel?.close();
    };
  }, [loadRecipes, remember, request, resumeId]);
  useEffect(() => {
    const focus = () => {
      if (navigator.onLine && run) void act(refresh);
    };
    addEventListener("focus", focus);
    return () => removeEventListener("focus", focus);
  }, [run, refresh, act]);
  useEffect(() => {
    if (
      !run ||
      run.status !== "active" ||
      !active ||
      active.state !== "pending" ||
      busy ||
      offline ||
      advancing.current
    )
      return;
    const attempt = `${run.id}:${run.revision}:${active.id}`;
    if (lastAttempt.current === attempt) return;
    lastAttempt.current = attempt;
    advancing.current = true;
    void act(async () => {
      await request(`/runs/${encodeURIComponent(run.id)}/advance`, {
        nodeId: active.id,
        revision: run.revision,
        commandId: `command-${crypto.randomUUID()}`,
      });
      await refresh();
    }).finally(() => {
      advancing.current = false;
    });
  }, [run, active, busy, offline, act, refresh, request]);
  useEffect(() => {
    if (draft) {
      setTitle(draft.definition.title);
      if (autoFocus) status.current?.focus();
    }
  }, [draft, autoFocus]);

  async function teach(scope: string[] = []) {
    let current = run;
    if (!current) {
      const started = await request<Run & { demonstration: Demo }>("/runs", {
        connectorId,
        teach: true,
        ...(target ? { target } : {}),
      });
      current = started;
      remember(current);
      setDemo(started.demonstration);
    } else
      setDemo(
        await request<Demo>("/demonstrations", { runId: current.id, scope }),
      );
    setNotice(
      "Teaching started. Only permitted semantic steps are recorded, not passwords or provider pages.",
    );
  }
  async function consent(value: Demo["consent"]) {
    if (!demo) return;
    const changed = await request<Demo>(
      `/demonstrations/${encodeURIComponent(demo.id)}`,
      { revision: demo.revision, consent: value },
    );
    if (value === "discarded") {
      setDemo(undefined);
      setDraft(undefined);
      setNotice(
        "Demonstration discarded. Your connection and required security records are unchanged.",
      );
      return;
    }
    const timeline = await request<Demo>(
      `/demonstrations/${encodeURIComponent(demo.id)}`,
    );
    setDemo({ ...changed, events: timeline.events ?? [] });
    const events = timeline.events ?? [];
    setFirst(events[0]?.sequence ?? 0);
    setLast(events.at(-1)?.sequence ?? 0);
  }

  if (!capabilities)
    return <p role="status">Checking connection capabilities…</p>;
  if (!capabilities.available)
    return (
      <p className="teaching-note">
        Teaching is unavailable in this host. Normal connector ceremonies remain
        available.
      </p>
    );
  if (!capabilities.authenticated)
    return (
      <p className="teaching-note">
        Sign in to connect and save reusable steps.{" "}
        <button
          disabled={busy || offline}
          onClick={() =>
            void act(async () => {
              if (onSignIn) {
                await onSignIn();
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
                  "Sign-in is unavailable. Contact this host’s administrator.",
                );
              const result = z
                .strictObject({ authorizationUrl: z.url() })
                .parse(await response.json());
              location.assign(result.authorizationUrl);
            })
          }
        >
          Sign in
        </button>
        {error && <span role="alert">{error}</span>}
      </p>
    );
  if (!(capabilities.connectors ?? ["github"]).includes(connectorId))
    return (
      <p className="teaching-note">
        This host has not registered a working ceremony for this connector.
      </p>
    );

  return (
    <section
      className={["teaching-connection", className].filter(Boolean).join(" ")}
      style={style}
      aria-label="Connection and reusable steps"
    >
      <div className="teaching-current">
        <h2 ref={status} tabIndex={-1}>
          {offline
            ? `Reconnect to check ${serviceName}`
            : complete
              ? `${serviceName} connection verified`
              : mode === "studio" && !run
                ? "Create from demonstration"
                : `Connect ${serviceName}`}
        </h2>
        <p role="status" aria-live="polite">
          {offline
            ? "Offline. Reconnect to read current status; authorization actions are not queued."
            : run?.status === "cancelled"
              ? "Connection cancelled. Completed provider changes have not been revoked."
              : complete
                ? "Verified access is ready for the original task."
                : active
                  ? `${operationLabel(active.operationId)} — ${active.state === "awaiting-human" ? "your participation is needed" : active.state === "uncertain" ? "the provider outcome needs reconciliation" : active.state === "failed" ? "verification needs attention" : active.state === "verifying" ? "checking provider evidence" : "preparing the next step"}.`
                  : "Existing setup is reused. We’ll ask only for what’s missing."}
        </p>
        {error && (
          <p role="alert" className="teaching-error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {accountRequired && !run && (
          <>
            <label>
              {connectorId === "jira"
                ? "Jira site URL"
                : "GitHub account or organization"}
              <input
                name={connectorId === "jira" ? "jira-site" : "github-account"}
                type={connectorId === "jira" ? "url" : "text"}
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                maxLength={connectorId === "jira" ? 2048 : 100}
                autoComplete="off"
                spellCheck={false}
              />
              <span className="teaching-note">
                {connectorId === "jira"
                  ? "Enter the HTTPS address of your atlassian.net site. Authorization must grant access to this exact site."
                  : "Enter its public GitHub login. GitHub will verify that the app and installation belong to this account."}
              </span>
            </label>
            {connectorId === "github" && (
              <p className="teaching-note">
                No GitHub account yet?{" "}
                <a
                  href="https://github.com/signup"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Create your GitHub account (opens a new tab)
                </a>
                . Complete GitHub’s email verification and required checks, then
                enter your new login here. This connection stays open; signup
                alone does not grant repository access.
              </p>
            )}
          </>
        )}
        <div className="teaching-actions">
          {!run && (
            <button
              className="primary"
              disabled={busy || offline}
              onClick={() =>
                void act(async () => {
                  if (mode === "studio") await teach();
                  else
                    remember(
                      await request<Run>("/runs", {
                        connectorId,
                        ...(target ? { target } : {}),
                      }),
                    );
                })
              }
            >
              {mode === "studio"
                ? "Create from demonstration"
                : `Connect ${serviceName}`}
            </button>
          )}
          {!run && mode === "connect" && (
            <button
              className="quiet"
              disabled={busy || offline}
              onClick={() => void act(() => teach())}
            >
              Teach this connection
            </button>
          )}
          {(active?.state === "awaiting-human" ||
            (["supabase", "jira"].includes(connectorId) &&
              active?.state === "uncertain")) &&
            run?.status === "active" && (
              <a
                className="button primary"
                href={`${base}/${encodeURIComponent(connectorId)}/${encodeURIComponent(run.id)}/human`}
              >
                Continue with {serviceName}
              </a>
            )}
          {active?.state === "failed" && run?.status === "active" && (
            <button
              className="primary"
              disabled={busy || offline}
              onClick={() =>
                void act(async () => {
                  await request(`/runs/${encodeURIComponent(run.id)}/advance`, {
                    nodeId: active.id,
                    revision: run.revision,
                    commandId: `command-${crypto.randomUUID()}`,
                  });
                  await refresh();
                })
              }
            >
              Retry this step
            </button>
          )}
          {active?.state === "uncertain" &&
            active.operationId === "github.prepare-app" &&
            run?.status === "active" && (
              <a
                className="button primary"
                href={`${base}/github/${encodeURIComponent(run.id)}/recovery`}
              >
                Recover existing GitHub App
              </a>
            )}
          {run && !complete && run.status !== "cancelled" && (
            <button
              disabled={busy || offline}
              onClick={() => void act(refresh)}
            >
              Refresh status
            </button>
          )}
          {run && run.status === "active" && !demo && (
            <button
              className="quiet"
              disabled={busy || offline}
              onClick={() => void act(() => teach(active ? [active.id] : []))}
            >
              Teach this step
            </button>
          )}
        </div>
        {run && (
          <details className="teaching-progress">
            <summary>
              {run.nodes.filter((node) => node.verified).length} of{" "}
              {run.nodes.length} steps verified
            </summary>
            <ol>
              {run.nodes.map((node) => (
                <li
                  key={node.id}
                  aria-current={node.id === active?.id ? "step" : undefined}
                >
                  {operationLabel(node.operationId)}{" "}
                  <span>
                    {node.verified
                      ? "Verified"
                      : node.state === "pending"
                        ? "Not started"
                        : node.state.replaceAll("-", " ")}
                  </span>
                </li>
              ))}
            </ol>
          </details>
        )}
        {run?.status === "active" && (
          <details>
            <summary>Assistance and connection controls</summary>
            <div className="teaching-actions">
              {capabilities.modelAvailable && (
                <button
                  disabled={busy || offline || !!assistantBlocked}
                  onClick={() =>
                    void act(async () => {
                      await request(
                        `/agent/${encodeURIComponent(run.id)}/${assistant ? "stop" : "start"}`,
                        {},
                      );
                      if (assistant) setAssistantBlocked("stopped");
                      setAssistant(!assistant);
                      setAssistantEpoch((value) => value + 1);
                    })
                  }
                >
                  {assistantBlocked === "stopped"
                    ? "Assistant stopped"
                    : assistantBlocked === "budget-exhausted"
                      ? "Assistant budget reached"
                      : assistant
                        ? "Stop assistant"
                        : "Ask assistant to help"}
                </button>
              )}
              <button
                disabled={busy || offline}
                onClick={() =>
                  void act(async () => {
                    remember(
                      await request<Run>(
                        `/runs/${encodeURIComponent(run.id)}/cancel`,
                        { revision: run.revision },
                      ),
                    );
                    setAssistant(false);
                  })
                }
              >
                Cancel connection
              </button>
            </div>
            <p className="teaching-note">
              Stopping assistance stops agent work. Cancelling ends local
              authorization work. Neither action revokes changes already made at
              GitHub.
            </p>
            {!capabilities.modelAvailable && (
              <p className="teaching-note">
                No model is configured. Connection and reusable steps work
                without one.
              </p>
            )}
          </details>
        )}
      </div>

      {demo && (
        <section className="teaching-review" aria-label="Demonstration">
          <h3>
            {demo.consent === "recording"
              ? "Teaching this connection"
              : "Review your demonstration"}
          </h3>
          <p className="teaching-note">
            We record meaningful connection steps, not clicks, credentials or
            external provider pages.
          </p>
          <div className="teaching-actions">
            {demo.consent === "recording" && (
              <>
                <button
                  disabled={busy || offline}
                  onClick={() => void act(() => consent("paused"))}
                >
                  Pause teaching
                </button>
                <button
                  disabled={busy || offline}
                  onClick={() => void act(() => consent("stopped"))}
                >
                  Stop teaching and review
                </button>
              </>
            )}
            {demo.consent === "paused" && (
              <>
                <button
                  disabled={busy || offline}
                  onClick={() => void act(() => consent("recording"))}
                >
                  Resume teaching
                </button>
                <button
                  disabled={busy || offline}
                  onClick={() => void act(() => consent("stopped"))}
                >
                  Stop teaching and review
                </button>
              </>
            )}
            <button
              className="quiet"
              disabled={busy || offline}
              onClick={() => void act(() => consent("discarded"))}
            >
              Discard demonstration
            </button>
          </div>
          {demo.consent === "stopped" && (
            <>
              {!demo.events?.length ? (
                <p>
                  No completed semantic steps were captured. Start teaching
                  before completing the step you want to save.
                </p>
              ) : (
                <>
                  <ol className="teaching-timeline">
                    {demo.events.map((event) => (
                      <li key={event.eventId}>
                        {operationLabel(event.operationId)} —{" "}
                        {event.verification === "accepted"
                          ? "verified boundary"
                          : event.kind}
                      </li>
                    ))}
                  </ol>
                  <div className="teaching-range">
                    <label>
                      Start with
                      <select
                        value={first}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          setFirst(value);
                          if (last < value) setLast(value);
                        }}
                      >
                        {demo.events.map((event) => (
                          <option key={event.eventId} value={event.sequence}>
                            {operationLabel(event.operationId)} · {event.kind}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      End with
                      <select
                        value={last}
                        onChange={(event) =>
                          setLast(Number(event.target.value))
                        }
                      >
                        {demo.events
                          .filter((event) => event.sequence >= first)
                          .map((event) => (
                            <option key={event.eventId} value={event.sequence}>
                              {operationLabel(event.operationId)} · {event.kind}
                            </option>
                          ))}
                      </select>
                    </label>
                  </div>
                  <button
                    disabled={busy || offline}
                    onClick={() =>
                      void act(async () =>
                        setDraft(
                          await request<Draft>("/drafts/compile", {
                            demonstrationId: demo.id,
                            first,
                            last,
                          }),
                        ),
                      )
                    }
                  >
                    Review reusable step
                  </button>
                </>
              )}
            </>
          )}
        </section>
      )}

      {draft && (
        <section className="teaching-review" aria-label="Reusable step review">
          <h3>{draft.definition.title}</h3>
          <dl>
            <dt>Starts with</dt>
            <dd>
              {Object.keys(draft.definition.inputs).length
                ? "Fresh inputs from the current session. Previous credentials and approvals are never reused from the demonstration."
                : "The current authorized session and compatible connector setup."}
            </dd>
            <dt>What it does</dt>
            <dd>
              <ol>
                {draft.definition.invocations.map((node) => (
                  <li key={node.id}>
                    {node.use.kind === "operation"
                      ? operationLabel(node.use.id)
                      : "Run a pinned reviewed step"}
                  </li>
                ))}
              </ol>
            </dd>
            <dt>When a person is needed</dt>
            <dd>
              GitHub owns sign-in, account selection and required consent. These
              remain human steps whenever the provider requires them.
            </dd>
            <dt>What proves completion</dt>
            <dd>
              The registered provider verifier must accept the required
              evidence. Returning from a page alone is not success.
            </dd>
          </dl>
          {draft.diagnostics.length > 0 && (
            <p role="alert">
              This draft needs adjustment before it can run:{" "}
              {draft.diagnostics
                .map((item) => item.code.replaceAll("-", " "))
                .join(", ")}
              .
            </p>
          )}
          <div className="teaching-actions">
            <button
              className="primary"
              disabled={busy || offline || draft.diagnostics.length > 0}
              onClick={() =>
                void act(async () => {
                  await request(
                    `/drafts/${encodeURIComponent(draft.id)}/review`,
                    { revision: draft.revision, digest: draft.digest },
                  );
                  await request(
                    `/drafts/${encodeURIComponent(draft.id)}/publish`,
                    { revision: draft.revision, digest: draft.digest },
                  );
                  await loadRecipes();
                  setDraft(undefined);
                  setNotice(
                    "Reusable step saved. Future connections still require their own authorized inputs and provider evidence.",
                  );
                })
              }
            >
              Save reusable step
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setTitle(draft.definition.title);
                setAdjusting(!adjusting);
              }}
            >
              Adjust
            </button>
          </div>
          {adjusting && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  setDraft(
                    await request<Draft>(
                      `/drafts/${encodeURIComponent(draft.id)}/edit`,
                      {
                        revision: draft.revision,
                        definition: { ...draft.definition, title },
                      },
                    ),
                  );
                  setAdjusting(false);
                });
              }}
            >
              <label>
                Step name
                <input
                  maxLength={100}
                  required
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <button disabled={busy || offline}>Save adjustment</button>
              {capabilities.modelAvailable && (
                <button
                  type="button"
                  disabled={busy || offline}
                  onClick={() =>
                    void act(async () => {
                      const result = await request<{
                        suggestion: { title: string } | null;
                      }>(`/drafts/${encodeURIComponent(draft.id)}/suggest`, {
                        revision: draft.revision,
                      });
                      if (result.suggestion) setTitle(result.suggestion.title);
                      else
                        setNotice(
                          "No suggestion is available. You can edit the name yourself.",
                        );
                    })
                  }
                >
                  Suggest a clearer name
                </button>
              )}
              <p className="teaching-note">
                To change the captured portion, adjust the start and end
                boundaries above and review again.
              </p>
            </form>
          )}
          <details>
            <summary>Advanced definition</summary>
            <pre>{JSON.stringify(draft.definition, null, 2)}</pre>
          </details>
        </section>
      )}

      {saved.length > 0 && (
        <section className="teaching-review" aria-label="Saved reusable steps">
          <h3>Reusable steps</h3>
          <p className="teaching-note">
            Select compatible procedures to combine. Access and approvals always
            belong to the new connection.
          </p>
          <ul className="teaching-saved">
            {saved.map((item) => {
              const id = `${item.definition.id}@${item.version}`;
              return (
                <li key={id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedRecipes.includes(id)}
                      onChange={(event) =>
                        setSelectedRecipes(
                          event.target.checked
                            ? [...selectedRecipes, id]
                            : selectedRecipes.filter(
                                (selected) => selected !== id,
                              ),
                        )
                      }
                    />
                    {item.definition.title}
                  </label>
                  <button
                    disabled={busy || offline}
                    onClick={() =>
                      void act(async () => {
                        remember(
                          await request<Run>("/recipes/execute", {
                            connectorId,
                            id: item.definition.id,
                            version: item.version,
                            digest: item.digest,
                            inputs: {},
                          }),
                        );
                      })
                    }
                  >
                    Use step
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            disabled={busy || offline || selectedRecipes.length < 2}
            onClick={() =>
              void act(async () =>
                setDraft(
                  await request<Draft>("/recipes/compose", {
                    references: saved
                      .filter((item) =>
                        selectedRecipes.includes(
                          `${item.definition.id}@${item.version}`,
                        ),
                      )
                      .map((item) => ({
                        id: item.definition.id,
                        version: item.version,
                        digest: item.digest,
                      })),
                  }),
                ),
              )
            }
          >
            Combine steps
          </button>
        </section>
      )}
      {capabilities.signOutAvailable && (
        <button
          className="quiet"
          disabled={busy || offline}
          onClick={() =>
            void act(async () => {
              if (onSignOut) await onSignOut();
              else {
                const response = await fetch("/api/auth/logout", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: "{}",
                  cache: "no-store",
                  credentials: "same-origin",
                });
                if (!response.ok)
                  throw new Error("Sign-out could not finish. Try again.");
              }
              setRun(undefined);
              currentRun.current = undefined;
              setDemo(undefined);
              setDraft(undefined);
              setSaved([]);
              setAssistant(false);
              setCapabilities({
                available: true,
                authenticated: false,
                modelAvailable: false,
              });
              const channel =
                typeof BroadcastChannel === "undefined"
                  ? undefined
                  : new BroadcastChannel("ceremony-session");
              channel?.postMessage("signed-out");
              channel?.close();
              if (host.current.onSignedOut) host.current.onSignedOut();
              else if (!host.current.onRunChange) location.replace("/");
            })
          }
        >
          Sign out
        </button>
      )}
    </section>
  );
}
