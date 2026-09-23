import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";

/** One scripted assistant step: the tool calls it emits, or none for a plain text reply. */
export type ScriptedCall = { name: string; input: Record<string, unknown> };
export type RecordedRequest = {
  path: string;
  headers: IncomingHttpHeaders;
  raw: string;
  body: {
    model?: string;
    tools?: unknown[];
    messages: { role: string; content: unknown }[];
  };
};

/**
 * A loopback model speaking either the OpenAI-compatible chat-completions
 * shape or the Anthropic Messages shape. Every request is recorded verbatim so
 * tests can assert exactly what left the broker. No live network is involved.
 */
export async function scriptedModel(
  protocol: "chat" | "anthropic",
  script: (index: number, request: RecordedRequest) => ScriptedCall[],
) {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request: RecordedRequest = {
      path: req.url!,
      headers: req.headers,
      raw,
      body: JSON.parse(raw),
    };
    const calls = script(requests.length, request);
    requests.push(request);
    res.setHeader("content-type", "application/json");
    const id = `step-${requests.length}`;
    if (protocol === "chat")
      return res.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          created: 1,
          model: "fixture",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: calls.length ? null : "Nothing further.",
                ...(calls.length
                  ? {
                      tool_calls: calls.map((call, index) => ({
                        id: `${id}-call-${index}`,
                        type: "function",
                        function: {
                          name: call.name,
                          arguments: JSON.stringify(call.input),
                        },
                      })),
                    }
                  : {}),
              },
              finish_reason: calls.length ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    res.end(
      JSON.stringify({
        id: `msg_${id}`,
        type: "message",
        role: "assistant",
        model: request.body.model,
        content: calls.length
          ? calls.map((call, index) => ({
              type: "tool_use",
              id: `toolu_${id}_${index}`,
              name: call.name,
              input: call.input,
            }))
          : [{ type: "text", text: "Nothing further." }],
        stop_reason: calls.length ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The single rebuilt user message a step sends: `{run, results}` as JSON. */
export function stepContext(request: RecordedRequest): {
  run: { revision: number; nodes: { id: string; state: string }[] };
  results: { tool: string; output?: unknown; error?: string }[];
} {
  const users = request.body.messages.filter(
    (message) => message.role === "user",
  );
  const content = users.at(-1)!.content;
  const text =
    typeof content === "string"
      ? content
      : (content as { type: string; text?: string }[])
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
  return JSON.parse(text);
}
