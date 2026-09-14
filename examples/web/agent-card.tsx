import { useState, type CSSProperties, type FormEvent } from "react";
import { ConnectorCard } from "../../src/react/connectors.js";
import { SecureField } from "../../src/react/index.js";
import {
  accountProviders,
  type AccountProvider,
} from "../../scripts/gallery-accounts.js";
import { brandOf } from "../../scripts/gallery-brands.js";
import "../../src/react/styles.css";

/**
 * A branded card that has the agent make the account, and shows it doing so.
 *
 * Pressing the card asks for the one thing the agent cannot invent for a real
 * provider — the address — and then starts a browser on the server. Every step
 * the driver takes lands here as it is taken. When the agent needs a person it
 * asks in the card: a code that was mailed to them, a credential the provider
 * issued on its own page, or a hand on the browser for a challenge. What the
 * run produces comes back as references and is redeemed into masked fields
 * with a reveal and a copy, which is the only place a value ever appears.
 *
 * The steps are the driver's value-free records: a role that was filled, a
 * control that was pressed. No credential, no code and no page markup travels
 * over the stream.
 */

interface Step {
  action: string;
  role?: string;
  note?: string;
  reason?: string;
  path?: string;
}

interface Ask {
  role: string;
  prompt: string;
}

interface Handoff {
  reason: string;
  url: string;
  attempt: number;
}

interface Session {
  backend: string;
  liveUrl?: string;
}

interface Output {
  name: string;
  label: string;
  ref: string;
  value?: string;
}

interface Done {
  status: string;
  identity?: string;
  steps?: number;
  handoffs?: number;
  message?: string;
  reason?: string;
  evidence?: string;
}

type Phase = "idle" | "identify" | "running" | "done";

const describe = (step: Step) =>
  step.action === "fill"
    ? `Filled ${step.role}`
    : step.action === "click"
      ? `Pressed ${step.note ?? "a control"}`
      : step.action === "check"
        ? "Ticked a required box"
        : step.action === "blocked"
          ? `Stopped: ${step.reason}`
          : step.action === "handoff"
            ? `Asked you to take over (${step.reason})`
            : step.action === "done"
              ? "Claimed the account exists"
              : step.action === "wait"
                ? (step.note ?? "Waited for the page")
                : step.action;

const phaseLabel: Record<string, string> = {
  register: "Registering in the agent’s browser",
  issue: "At the provider’s credential page",
  collect: "Waiting for the credential",
};

const backendLabel: Record<string, string> = {
  local: "Chromium on this server",
  cloudflare: "Cloudflare Browser Rendering",
  "browser-use": "Browser Use Cloud",
};

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function AgentConnectorCard({ provider }: { provider: AccountProvider }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [runId, setRunId] = useState<string>();
  const [steps, setSteps] = useState<Step[]>([]);
  const [stage, setStage] = useState<string>();
  const [session, setSession] = useState<Session>();
  const [ask, setAsk] = useState<Ask>();
  const [handoff, setHandoff] = useState<Handoff>();
  const [outputs, setOutputs] = useState<Output[]>([]);
  const [done, setDone] = useState<Done>();
  const [problem, setProblem] = useState<string>();
  const own = provider.registration.createdBy === "this-ceremony";
  const brand = brandOf(provider.manifest.id);
  const idPrefix = `agent-${provider.manifest.id}`;
  // What this card will do, which is not what the provider's own catalogue
  // entry promises: there, a person opens the signup page. Here the agent does.
  const promises = own
    ? [
        "Registers the account",
        "Generates the password",
        "Hands back a session token",
      ]
    : [
        `Registers at ${provider.manifest.name} in its own browser`,
        "Asks you for the emailed code",
        `Hands back the ${provider.credential?.label ?? "credential"}`,
      ];

  const reset = () => {
    setRunId(undefined);
    setSteps([]);
    setStage(undefined);
    setSession(undefined);
    setAsk(undefined);
    setHandoff(undefined);
    setOutputs([]);
    setDone(undefined);
    setProblem(undefined);
  };

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    reset();
    setPhase("running");
    const started = await post("/api/live/agent", {
      provider: provider.manifest.id,
      ...(email ? { email } : {}),
    });
    if (!started.ok) {
      setProblem("The agent could not be started.");
      setPhase("done");
      return;
    }
    const { id } = (await started.json()) as { id: string };
    setRunId(id);
    const source = new EventSource(`/api/live/agent/${id}/events`);
    const read = (event: Event) => JSON.parse((event as MessageEvent).data);
    source.addEventListener("step", (event) => {
      setSteps((all) => [...all, read(event) as Step]);
    });
    source.addEventListener("phase", (event) => {
      setStage((read(event) as { phase: string }).phase);
    });
    source.addEventListener("session", (event) => {
      setSession(read(event) as Session);
    });
    source.addEventListener("ask", (event) => {
      setAsk(read(event) as Ask);
    });
    source.addEventListener("handoff", (event) => {
      setHandoff(read(event) as Handoff);
    });
    source.addEventListener("output", (event) => {
      const output = read(event) as Output;
      setOutputs((all) => [...all, output]);
      // Redeemed once, straight into a masked field. The reference is spent.
      void post(`/api/live/agent/${id}/redeem`, { ref: output.ref })
        .then((response) => (response.ok ? response.json() : undefined))
        .then((body: { value?: string } | undefined) => {
          const value = body?.value;
          if (typeof value !== "string") return;
          setOutputs((all) =>
            all.map((entry) =>
              entry.ref === output.ref ? { ...entry, value } : entry,
            ),
          );
        });
    });
    source.addEventListener("done", (event) => {
      setDone(read(event) as Done);
      setAsk(undefined);
      setHandoff(undefined);
      setPhase("done");
    });
    source.addEventListener("end", () => source.close());
    source.onerror = () => {
      source.close();
      setPhase((current) => (current === "running" ? "done" : current));
      setProblem((current) => current ?? "The stream from the agent closed.");
    };
  };

  const answer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const value = String(new FormData(form).get("value") ?? "");
    form.reset();
    if (!runId || !value) return;
    setAsk(undefined);
    await post(`/api/live/agent/${runId}/answer`, { value });
  };

  const human = async (result: "completed" | "declined") => {
    if (!runId) return;
    setHandoff(undefined);
    await post(`/api/live/agent/${runId}/human`, { result });
  };

  const connected =
    done?.status === "completed" ||
    outputs.some((output) => output.name === "token");
  const status = connected
    ? "connected"
    : done || problem
      ? "attention"
      : "available";

  return (
    <div
      className="agent-flow"
      style={
        {
          ["--ceremony-accent"]: brand.tint,
          ["--ceremony-on-accent"]: brand.ink,
        } as CSSProperties
      }
    >
      <ConnectorCard
        manifest={provider.manifest}
        status={status}
        tint={brand.tint}
        ink={brand.ink}
        {...(brand.logo ? { logo: brand.logo } : {})}
        intent={{ permissions: promises.map((label) => ({ label })) }}
        busy={phase === "running"}
        {...(done ? { handoffs: done.handoffs ?? 0 } : {})}
        actionLabel={phase === "idle" ? "Create account" : "Start over"}
        onConnect={() => {
          reset();
          setPhase("identify");
        }}
      />
      {phase !== "idle" && (
        <div className="agent-live" aria-live="polite">
          {phase === "identify" && (
            <form
              className="agent-form"
              onSubmit={(event) => void start(event)}
            >
              <label htmlFor={`${idPrefix}-email`}>
                Email address
                <input
                  id={`${idPrefix}-email`}
                  name="email"
                  type="email"
                  autoComplete="email"
                  required={!own}
                  placeholder={own ? "Leave blank and one is minted" : ""}
                />
              </label>
              <button type="submit" className="primary">
                Register in the agent’s browser
              </button>
            </form>
          )}
          {session && (
            <p className="agent-session">
              Browser: {backendLabel[session.backend] ?? session.backend}
              {session.liveUrl && (
                <>
                  {" · "}
                  <a href={session.liveUrl} target="_blank" rel="noreferrer">
                    Watch live
                  </a>
                </>
              )}
            </p>
          )}
          {stage && phase === "running" && (
            <p className="agent-stage" role="status">
              {phaseLabel[stage] ?? stage}
            </p>
          )}
          {steps.length > 0 && (
            <ol className="agent-steps" aria-label="What the agent did">
              {steps.map((step, index) => (
                <li key={index} data-action={step.action}>
                  {describe(step)}
                </li>
              ))}
            </ol>
          )}
          {ask && (
            <form
              className="agent-form agent-ask"
              onSubmit={(event) => void answer(event)}
            >
              <SecureField
                id={`${idPrefix}-${ask.role}`}
                name="value"
                label={ask.prompt}
                required
              />
              <button type="submit" className="primary">
                Send to the agent’s browser
              </button>
            </form>
          )}
          {handoff && (
            <div className="agent-handoff" role="alert">
              <p>
                {handoff.reason} — a step only you can do.
                {session?.liveUrl && (
                  <>
                    {" "}
                    <a href={handoff.url} target="_blank" rel="noreferrer">
                      Take over its browser
                    </a>
                  </>
                )}
              </p>
              <div className="agent-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => void human("completed")}
                >
                  I’m done
                </button>
                <button type="button" onClick={() => void human("declined")}>
                  Stop
                </button>
              </div>
            </div>
          )}
          {outputs.length > 0 && (
            <dl className="agent-outputs">
              {outputs.map((output) => (
                <div key={output.ref}>
                  <dt>{output.label}</dt>
                  <dd>
                    <SecureField
                      id={`${idPrefix}-${output.name}`}
                      label={output.label}
                      value={output.value ?? ""}
                    />
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {(done || problem) && (
            <p
              className="agent-outcome"
              data-status={done?.status ?? "failed"}
              role="status"
            >
              {problem ??
                (done?.status === "completed"
                  ? `Registered ${done.identity} — ${done.steps} steps, ${done.handoffs} handoffs, confirmed by the provider.`
                  : done?.status === "failed"
                    ? `The run failed: ${done.message}`
                    : done?.status === "blocked"
                      ? `Stopped after ${done.steps} steps: ${done.reason}.`
                      : `Ended ${done?.status} after ${done?.steps} steps${
                          done?.evidence === "credential-shape"
                            ? "; the credential the provider issued is held above."
                            : "."
                        }`)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function AgentConnectors() {
  return (
    <section className="agent-connectors" aria-labelledby="agent-connectors">
      <h2 id="agent-connectors">Accounts the agent can register</h2>
      {accountProviders.map((provider) => (
        <AgentConnectorCard key={provider.manifest.id} provider={provider} />
      ))}
    </section>
  );
}
