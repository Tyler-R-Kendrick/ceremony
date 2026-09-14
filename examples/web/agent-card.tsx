import { useState, type CSSProperties, type FormEvent } from "react";
import { z } from "zod";
import { ConnectorCard } from "../../src/react/connectors.js";
import { SecureField } from "../../src/react/index.js";
import { manifestSchema } from "../../src/core/index.js";
import { brandOf } from "../../scripts/gallery-brands.js";
import "../../src/react/styles.css";

/**
 * What the browser needs to know about a provider the agent can register at.
 *
 * Deliberately not the provider itself: the catalogue belongs to the server
 * that runs the agent, and importing it here dragged its contract builders into
 * every visitor's download for data the page renders four fields of.
 */
export const agentProviderSchema = z.object({
  manifest: manifestSchema,
  /** Whether this ceremony makes the account, or the provider's own surface does. */
  own: z.boolean(),
  credentialLabel: z.string().optional(),
});
export type AgentProvider = z.infer<typeof agentProviderSchema>;

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

/** One run, as the card holds it. */
interface Run {
  phase: Phase;
  id?: string | undefined;
  steps: Step[];
  stage?: string | undefined;
  session?: Session | undefined;
  ask?: Ask | undefined;
  handoff?: Handoff | undefined;
  outputs: Output[];
  done?: Done | undefined;
  problem?: string | undefined;
}
const idle: Run = { phase: "idle", steps: [], outputs: [] };

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

function AgentConnectorCard({ provider }: { provider: AgentProvider }) {
  const [run, setRun] = useState<Run>(idle);
  const { phase, steps, stage, session, ask, handoff, outputs, done, problem } =
    run;
  const patch = (next: Partial<Run>) =>
    setRun((current) => ({ ...current, ...next }));
  const own = provider.own;
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
        `Hands back the ${provider.credentialLabel ?? "credential"}`,
      ];

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    setRun({ ...idle, phase: "running" });
    const started = await post("/api/live/agent", {
      provider: provider.manifest.id,
      ...(email ? { email } : {}),
    });
    if (!started.ok) {
      patch({ phase: "done", problem: "The agent could not be started." });
      return;
    }
    const { id } = (await started.json()) as { id: string };
    patch({ id });
    const source = new EventSource(`/api/live/agent/${id}/events`);
    const read = (event: Event) => JSON.parse((event as MessageEvent).data);
    source.addEventListener("step", (event) => {
      const step = read(event) as Step;
      setRun((current) => ({ ...current, steps: [...current.steps, step] }));
    });
    source.addEventListener("phase", (event) => {
      patch({ stage: (read(event) as { phase: string }).phase });
    });
    source.addEventListener("session", (event) => {
      patch({ session: read(event) as Session });
    });
    source.addEventListener("ask", (event) => {
      patch({ ask: read(event) as Ask });
    });
    source.addEventListener("handoff", (event) => {
      patch({ handoff: read(event) as Handoff });
    });
    source.addEventListener("output", (event) => {
      const output = read(event) as Output;
      setRun((current) => ({
        ...current,
        outputs: [...current.outputs, output],
      }));
      // Redeemed once, straight into a masked field. The reference is spent.
      void post(`/api/live/agent/${id}/redeem`, { ref: output.ref })
        .then((response) => (response.ok ? response.json() : undefined))
        .then((body: { value?: string } | undefined) => {
          const value = body?.value;
          if (typeof value !== "string") return;
          setRun((current) => ({
            ...current,
            outputs: current.outputs.map((entry) =>
              entry.ref === output.ref ? { ...entry, value } : entry,
            ),
          }));
        });
    });
    source.addEventListener("done", (event) => {
      patch({
        phase: "done",
        done: read(event) as Done,
        ask: undefined,
        handoff: undefined,
      });
    });
    source.addEventListener("end", () => source.close());
    source.onerror = () => {
      source.close();
      setRun((current) =>
        current.phase === "done"
          ? current
          : {
              ...current,
              phase: "done",
              problem: "The stream from the agent closed.",
            },
      );
    };
  };

  const answer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const value = String(new FormData(form).get("value") ?? "");
    form.reset();
    if (!run.id || !value) return;
    patch({ ask: undefined });
    await post(`/api/live/agent/${run.id}/answer`, { value });
  };

  const human = async (result: "completed" | "declined") => {
    if (!run.id) return;
    patch({ handoff: undefined });
    await post(`/api/live/agent/${run.id}/human`, { result });
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
        onConnect={() => setRun({ ...idle, phase: "identify" })}
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

export function AgentConnectors({
  providers,
}: {
  providers: readonly AgentProvider[];
}) {
  if (!providers.length) return null;
  return (
    <section className="agent-connectors" aria-labelledby="agent-connectors">
      <h2 id="agent-connectors">Accounts the agent can register</h2>
      {providers.map((provider) => (
        <AgentConnectorCard key={provider.manifest.id} provider={provider} />
      ))}
    </section>
  );
}
