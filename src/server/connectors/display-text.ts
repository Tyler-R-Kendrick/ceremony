/*
 * Text a provider chose, about to be shown to a person who may type one of the
 * names. Control characters and the bidirectional controls (the embeddings,
 * overrides and isolates, and the implicit marks) are replaced by a space, so a
 * name cannot render as another, and the edges are trimmed. The same set the
 * connector identifiers refuse (see core/connectors/identity.ts).
 */
const UNSAFE =
  /[\p{Cc}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200E}\u{200F}\u{061C}]/gu;

export function displayText(value: string): string {
  return value.replace(UNSAFE, " ").trim();
}
