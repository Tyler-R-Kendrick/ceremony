/** Transformers returns text or a chat transcript; never use prompt text as output. */
export function finalAssistantText(generated: unknown): string {
  if (typeof generated === "string") return generated;
  if (!Array.isArray(generated)) return "";
  const assistant = generated.findLast(
    (message) => message?.role === "assistant",
  );
  return typeof assistant?.content === "string" ? assistant.content : "";
}
