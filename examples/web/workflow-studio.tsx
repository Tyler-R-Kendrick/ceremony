import { useEffect, useRef, useState } from "react";
import { createAuthoringTools } from "../../src/core/authoring-tools.js";
import {
  ceremonyFamilyLabel,
  ceremonyPrerequisiteLabels,
} from "../../src/core/connector-authoring.js";
import type { FlowKind } from "../../src/core/schema.js";
import { browserModelContext } from "../../src/core/webmcp.js";
import {
  CeremonyBoard,
  type CeremonyReport,
} from "../../src/react/teaching.js";

type ChatMessage = { role: "user" | "assistant"; text: string };
type ProgressLine = { at: number; text: string };
type RunSnapshot = {
  id: string;
  provider: string;
  identity?: { handle: string };
  capture?: boolean;
  account?: "stored";
  human?: { reason: string; fields: string[] };
  nodes: Array<{ operationId: string; state: string }>;
};

async function readSseEvents(
  response: Response,
  on: (event: string, payload: Record<string, any>) => void,
) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("denied-or-unavailable");
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      on(eventName, JSON.parse(data));
      eventName = "message";
    }
  }
}

function formatElapsed(ms: number) {
  const seconds = Math.max(0, ms) / 1000;
  return seconds >= 10 ? `${seconds.toFixed(0)}s` : `${seconds.toFixed(1)}s`;
}

function activityPhase(
  lines: ProgressLine[],
  busy: boolean,
): Array<{ id: string; label: string; state: "pending" | "active" | "done" }> {
  const text = lines.map((line) => line.text).join("\n");
  const generated = /Generating /.test(text);
  const connecting = /Starting generated|Running /.test(text);
  const discovered = /Using |Found /.test(text) || generated;
  return [
    {
      id: "discover",
      label: "Discover",
      state:
        connecting || generated
          ? "done"
          : busy
            ? "active"
            : discovered
              ? "done"
              : "pending",
    },
    {
      id: "generate",
      label: "Generate ceremonies",
      state: connecting
        ? "done"
        : generated
          ? busy
            ? "active"
            : "done"
          : "pending",
    },
    {
      id: "connect",
      label: "Run connection",
      state: connecting ? (busy ? "active" : "done") : "pending",
    },
  ];
}

async function authoringRequest(path: string, body?: unknown) {
  const response = await fetch(`/api/v1/teaching${path}`, {
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok) throw new Error("denied-or-unavailable");
  return response.json();
}

/** Agentic authoring surface. Provider kickoff is chat plus WebMCP tools, not a form. */
export default function WorkflowStudio() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      text: "Name a provider. I'll disambiguate it, discover well-known auth methods, and draft the ceremony. I'll only ask a person for consent or private credentials.",
    },
  ]);
  const [draft, setDraft] = useState("");
  const [conversationId, setConversationId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [run, setRun] = useState<RunSnapshot>();
  const [report, setReport] = useState<CeremonyReport>();
  const [connectorId, setConnectorId] = useState<string>();
  const [progress, setProgress] = useState<ProgressLine[]>([]);
  const [startedAt, setStartedAt] = useState(0);
  const [tick, setTick] = useState(0);
  const log = useRef<HTMLDivElement>(null);
  const liveLog = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const context = browserModelContext();
    if (!context) return;
    const lifetime = new AbortController();
    const tools = createAuthoringTools("ceremony_author", {
      fromProvider: (input) =>
        authoringRequest("/authoring/from-provider", input),
      compose: (input) => authoringRequest("/authoring/compose", input),
      read: (draftId) => authoringRequest(`/authoring/drafts/${draftId}`),
      delete: (input) => authoringRequest("/authoring/delete", input),
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
  }, []);
  useEffect(() => {
    log.current?.lastElementChild?.scrollIntoView({ block: "end" });
  }, [messages, busy, progress]);
  useEffect(() => {
    liveLog.current?.lastElementChild?.scrollIntoView({ block: "end" });
  }, [progress]);
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setTick(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [busy]);
  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setError("");
    setBusy(true);
    const began = Date.now();
    setStartedAt(began);
    setTick(began);
    setProgress([{ at: began, text: "Starting ceremony discovery" }]);
    setMessages((current) => [...current, { role: "user", text }]);
    const applyReply = (reply: {
      conversationId?: string;
      messages?: ChatMessage[];
      run?: typeof run;
      result?: {
        discovery?: CeremonyReport;
        draft?: { methods?: FlowKind[]; connectorId?: string };
      };
    }) => {
      if (reply.conversationId) setConversationId(reply.conversationId);
      if (reply.messages) setMessages(reply.messages);
      if (reply.result?.draft?.connectorId) {
        const nextConnector = reply.result.draft.connectorId;
        setConnectorId(nextConnector);
        setRun((current) =>
          current?.provider === nextConnector ? current : undefined,
        );
      }
      if (reply.run) setRun(reply.run);
      if (reply.result?.discovery || reply.result?.draft?.methods)
        setReport({
          ...(reply.result.discovery ?? {}),
          methods: (reply.result.draft?.methods ?? []).map(
            (kind: FlowKind) => ({
              kind,
              label: ceremonyFamilyLabel(kind),
              requires: ceremonyPrerequisiteLabels(kind),
            }),
          ),
        });
    };
    try {
      const response = await fetch("/api/v1/teaching/authoring/chat", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: text,
          ...(conversationId ? { conversationId } : {}),
        }),
      });
      if (!response.ok) throw new Error("denied-or-unavailable");
      const type = response.headers.get("content-type") ?? "";
      if (!type.includes("text/event-stream")) {
        applyReply(await response.json());
        return;
      }
      await readSseEvents(response, (eventName, payload) => {
        if (eventName === "draft") applyReply(payload);
        if (eventName === "progress" && payload.text) {
          const line = { at: Date.now(), text: payload.text as string };
          setProgress((current) => [...current, line].slice(-80));
        }
        if (eventName === "done") applyReply(payload);
        if (eventName === "error") throw new Error(payload.error);
      });
    } catch {
      setError(
        "The authoring agent could not continue. Don't send credentials here.",
      );
    } finally {
      setTick(Date.now());
      setBusy(false);
    }
  }
  async function runCeremony(kind: string, account?: string) {
    if (!connectorId || busy) return;
    const began = Date.now();
    setBusy(true);
    setStartedAt(began);
    setTick(began);
    setProgress([
      {
        at: began,
        text: `Running ${ceremonyFamilyLabel(kind as FlowKind)} in the isolated browser`,
      },
    ]);
    let lastEvent = "";
    try {
      const response = await fetch("/api/v1/teaching/runs", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          connectorId,
          ceremony: kind,
          ...(account ? { account } : {}),
        }),
      });
      if (!response.ok) throw new Error("denied-or-unavailable");
      let snapshot: RunSnapshot | undefined;
      const type = response.headers.get("content-type") ?? "";
      if (type.includes("text/event-stream")) {
        await readSseEvents(response, (eventName, payload) => {
          if (eventName === "progress" && payload.text) {
            lastEvent = payload.text as string;
            const line = { at: Date.now(), text: payload.text as string };
            setProgress((current) => [...current, line].slice(-80));
          }
          if (eventName === "done") snapshot = payload as RunSnapshot;
          if (eventName === "error") throw new Error(payload.error);
        });
      } else snapshot = (await response.json()) as RunSnapshot;
      if (!snapshot) throw new Error("denied-or-unavailable");
      const finished: RunSnapshot = snapshot;
      setRun(finished);
      if (finished.identity)
        setMessages((current) => [
          ...current,
          {
            role: "assistant",
            text: `Connected as ${finished.identity!.handle}.`,
          },
        ]);
      else if (finished.account === "stored")
        setMessages((current) => [
          ...current,
          {
            role: "assistant",
            text: "An isolated account was stored for later ceremonies. Choose another ceremony to continue. Secrets are not shown here.",
          },
        ]);
      else
        setMessages((current) => [
          ...current,
          {
            role: "assistant",
            text: `That ceremony could not finish${lastEvent ? `: ${lastEvent}` : " without an existing provider session"}. Choose another ceremony.`,
          },
        ]);
    } catch {
      setError("The isolated browser could not run that ceremony.");
    } finally {
      setTick(Date.now());
      setBusy(false);
    }
  }
  const elapsed = startedAt
    ? Math.max(0, (busy ? tick || Date.now() : tick || startedAt) - startedAt)
    : 0;
  const tried = progress.filter((line) =>
    line.text.startsWith("Trying "),
  ).length;
  const found = progress.filter((line) =>
    line.text.startsWith("Found "),
  ).length;
  const current = progress.at(-1)?.text ?? "Starting ceremony discovery";
  const phases = activityPhase(progress, busy);
  return (
    <section className="connector-authoring" aria-label="Connector authoring">
      <div className="page-heading">
        <div>
          <h1>Workflow studio</h1>
          <p>
            Talk to the authoring agent. It registers WebMCP tools and drafts
            provider ceremonies. This page has no setup form.
          </p>
        </div>
      </div>
      <div className="authoring-chat">
        <div ref={log} className="authoring-log" role="log" aria-live="polite">
          {messages.map((message, index) => (
            <p
              key={`${message.role}-${index}`}
              data-role={message.role}
              className="authoring-turn"
            >
              <span>{message.role === "assistant" ? "Agent" : "You"}</span>
              {message.text
                .split(/(\/\?connector=[a-z0-9-]+)/)
                .map((part, partIndex) =>
                  part.startsWith("/?connector=") ? (
                    <a key={partIndex} href={part}>
                      {part}
                    </a>
                  ) : (
                    part
                  ),
                )}
            </p>
          ))}
          {(busy || progress.length > 0) && (
            <section
              className="authoring-activity"
              aria-label="Ceremony progress"
              aria-busy={busy}
              aria-live="polite"
            >
              <header className="authoring-activity-head">
                <span
                  className={
                    busy ? "authoring-pulse" : "authoring-pulse is-idle"
                  }
                  aria-hidden="true"
                />
                <strong>{busy ? "Agent working" : "Ceremony log"}</strong>
                <span className="authoring-elapsed">
                  {formatElapsed(elapsed)}
                </span>
                <span className="authoring-counters">
                  {tried} origin{tried === 1 ? "" : "s"} · {found} document
                  {found === 1 ? "" : "s"} · {progress.length} update
                  {progress.length === 1 ? "" : "s"}
                </span>
              </header>
              <p className="authoring-current">
                <span>Current</span>
                {current}
              </p>
              <ol className="authoring-tasks">
                {phases.map((phase) => (
                  <li key={phase.id} data-state={phase.state}>
                    {phase.label}
                  </li>
                ))}
              </ol>
              <ol className="authoring-live-log" ref={liveLog}>
                {progress.map((line, index) => (
                  <li key={`${line.at}-${index}`}>
                    <time dateTime={new Date(line.at).toISOString()}>
                      {formatElapsed(line.at - startedAt)}
                    </time>
                    {line.text}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
        {error && (
          <p className="teaching-error" role="alert">
            {error}
          </p>
        )}
        <label className="authoring-composer">
          Message the authoring agent
          <textarea
            value={draft}
            maxLength={2000}
            rows={3}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
        </label>
        <button
          className="primary"
          disabled={busy || !draft.trim()}
          onClick={() => void send()}
        >
          Send
        </button>
        {report ? (
          <CeremonyBoard
            key={connectorId}
            report={report}
            title="Discovered ceremonies"
            onRun={runCeremony}
            running={busy}
            accountPrompt={{
              ...(connectorId === "github"
                ? { pattern: "[A-Za-z0-9-]+", maxLength: 100 }
                : {}),
              label:
                connectorId === "github"
                  ? "GitHub handle"
                  : "Account name or email",
              hint:
                connectorId === "github"
                  ? "An existing handle uses sign-in; an available handle starts registration."
                  : "The provider checks whether to sign in or register.",
            }}
          />
        ) : null}
        {run?.capture && (
          <figure className="authoring-capture">
            <figcaption>Isolated browser recording</figcaption>
            <video
              controls
              playsInline
              aria-label="Silent recording of the isolated browser"
              src={`/api/v1/teaching/runs/${encodeURIComponent(run.id)}/capture`}
            />
          </figure>
        )}
        {run?.identity && (
          <p className="teaching-note">
            Connected as {run.identity.handle}. The provider verified this
            connection.
          </p>
        )}
        {run?.account === "stored" && !run.identity && (
          <p className="teaching-note">
            An isolated account is stored for later ceremonies. Secrets stay in
            the encrypted vault and are not shown in chat.
          </p>
        )}
        {run?.human && (
          <section
            className="teaching-note"
            aria-label="Human assistance required"
          >
            <strong>Human assistance required</strong>
            <p>
              {run.human.reason === "session"
                ? "Provide the existing account and password through the secure handoff."
                : run.human.reason === "passkey"
                  ? "Use your passkey or security key at the provider in your own browser. The handoff discovers supported authorization methods; your private key stays in your authenticator."
                  : run.human.reason === "challenge"
                    ? "Complete the provider CAPTCHA or MFA challenge in the human handoff."
                    : run.human.reason === "verification"
                      ? "Complete the provider verification code step in the human handoff."
                      : run.human.reason === "submission-uncertain"
                        ? "The provider outcome is unclear. Automatic resubmission stopped; use the secure handoff to check the account or try sign-in recovery."
                        : ["email-in-use", "username-in-use"].includes(
                              run.human.reason,
                            )
                          ? "This account identifier is already in use. Sign in if it is yours, or choose another account."
                          : "Continue the provider step in the human handoff."}
            </p>
            <a
              className="button primary"
              href={`/api/v1/teaching/${encodeURIComponent(run.provider)}/${encodeURIComponent(run.id)}/human`}
            >
              Continue with human assistance
            </a>
            <a
              className="button"
              href={`/api/v1/teaching/${encodeURIComponent(run.provider)}/${encodeURIComponent(run.id)}/human?flow=native`}
            >
              Discover browser sign-in options
            </a>
          </section>
        )}
        {run &&
          !run.identity &&
          run.nodes.some((node) => node.state === "awaiting-human") && (
            <p className="teaching-note">
              That ceremony is waiting on the provider. Choose a different
              ceremony; do not type credentials here.
            </p>
          )}
      </div>
    </section>
  );
}
