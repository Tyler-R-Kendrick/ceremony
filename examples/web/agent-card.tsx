import { useState } from "react";

/**
 * The agent doing the registration, watched as it happens.
 *
 * Nothing on this card sends anybody anywhere. Pressing it starts a real
 * browser on the server, driven by the ceremony driver against the provider's
 * own registration page, and every step it takes arrives here as it is taken.
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

interface Done {
  status: string;
  identity?: string;
  steps?: number;
  handoffs?: number;
  message?: string;
}

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
            ? "Asked a person to take part"
            : step.action === "done"
              ? "Claimed the ceremony finished"
              : step.action;

export function AgentCard() {
  const [steps, setSteps] = useState<Step[]>([]);
  const [done, setDone] = useState<Done | undefined>(undefined);
  const [running, setRunning] = useState(false);

  const start = () => {
    setSteps([]);
    setDone(undefined);
    setRunning(true);
    const source = new EventSource("/api/live/agent");
    source.addEventListener("step", (event) => {
      setSteps((all) => [...all, JSON.parse((event as MessageEvent).data)]);
    });
    source.addEventListener("done", (event) => {
      setDone(JSON.parse((event as MessageEvent).data));
      setRunning(false);
      source.close();
    });
    source.onerror = () => {
      setRunning(false);
      source.close();
    };
  };

  return (
    <section className="agent-card" aria-labelledby="agent-heading">
      <div className="agent-head">
        <h2 id="agent-heading">Let the agent register an account</h2>
        <button
          type="button"
          className="primary"
          disabled={running}
          onClick={start}
        >
          {running ? "Running…" : steps.length ? "Run again" : "Run it"}
        </button>
      </div>
      <p className="agent-what">
        A browser opens on the server and the driver works the provider’s own
        registration page: it invents an address, sets a password, reads the
        confirmation code from the provider’s mailbox, and comes back. You do
        nothing.
      </p>
      {(steps.length > 0 || done) && (
        <ol className="agent-steps">
          {steps.map((step, index) => (
            <li key={index} data-action={step.action}>
              {describe(step)}
            </li>
          ))}
        </ol>
      )}
      {done && (
        <p className="agent-outcome" data-status={done.status} role="status">
          {done.status === "completed"
            ? `Registered ${done.identity} — ${done.steps} steps, ${done.handoffs} handoffs, confirmed by the provider.`
            : done.status === "failed"
              ? `The run failed: ${done.message}`
              : `Ended ${done.status} after ${done.steps} steps.`}
        </p>
      )}
    </section>
  );
}
