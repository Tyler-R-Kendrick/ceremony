import { useEffect, useRef, useState } from "react";
import { createAuthoringTools } from "../../src/core/authoring-tools.js";
import { browserModelContext } from "../../src/core/webmcp.js";

type ChatMessage = { role: "user" | "assistant"; text: string };

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
  const log = useRef<HTMLDivElement>(null);
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
  }, [messages, busy]);
  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setError("");
    setBusy(true);
    setMessages((current) => [...current, { role: "user", text }]);
    try {
      const reply = await authoringRequest("/authoring/chat", {
        message: text,
        ...(conversationId ? { conversationId } : {}),
      });
      setConversationId(reply.conversationId);
      setMessages(reply.messages);
    } catch {
      setError(
        "The authoring agent could not continue. Don't send credentials here.",
      );
    } finally {
      setBusy(false);
    }
  }
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
          {busy && (
            <p className="authoring-turn" data-role="assistant">
              <span>Agent</span>
              Working…
            </p>
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
      </div>
    </section>
  );
}
