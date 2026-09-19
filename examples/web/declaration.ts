import {
  entryContextSchema,
  type EntryContext,
  type MethodSelection,
} from "../../src/core/index.js";
import type { ConnectionDraft } from "./add-connection.js";

/**
 * What the drawer collected, as something the resolver can act on.
 *
 * Configure and Customize are not a form that gets filed somewhere: every
 * answer either narrows which routes are eligible or changes which eligible
 * route is cheapest. Collecting an issuer URL and a scope list and then
 * running the same ceremony regardless is how a wizard becomes decoration.
 */

/**
 * The keys each family uses to name a session-environment entry.
 *
 * These are names, never values — the secret itself stays in the encrypted
 * vault and reaches the adapter by reference. Naming one tells the resolver a
 * route will not have to stop and ask for it, which is what makes that route
 * cheaper; it authorizes nothing on its own.
 */
const environmentNameKeys = [
  "clientIdName",
  "keyName",
  "appIdName",
  "appKeyName",
] as const;

/**
 * The same shape `entryContextSchema` enforces.
 *
 * The schema throws on anything else, and the client parses its context
 * eagerly while the drawer is rendering — so a name that cannot be an
 * environment entry has to be dropped here rather than thrown from inside a
 * render. The field that collects it rejects the same shape as you type, so
 * in practice this is the second of two guards rather than the only one.
 */
export const environmentName = /^[A-Z][A-Z0-9_]{0,95}$/;

/** `entryContextSchema` bounds: 24 held names, 30 scopes of 100 characters. */
const heldLimit = 24;
const scopeLimit = 30;
const scopeLength = 100;

/** Names of session-environment entries this connection already holds. */
export function heldConfigurationOf(draft: ConnectionDraft): string[] {
  const names = environmentNameKeys
    .map((key) => (draft.values[key] ?? "").trim())
    .filter((name) => environmentName.test(name));
  return [...new Set(names)].slice(0, heldLimit);
}

/**
 * Scopes the host is asking this connection to carry.
 *
 * Separated by whitespace or commas, because both are how providers write
 * them and neither is worth correcting somebody over.
 */
export function requiredScopesOf(draft: ConnectionDraft): string[] {
  const scopes = (draft.values["scopes"] ?? "")
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0 && scope.length <= scopeLength);
  return [...new Set(scopes)].slice(0, scopeLimit);
}

/**
 * The drawer's answers as an `EntryContext`.
 *
 * Parsed here rather than handed over raw, so a draft that cannot produce a
 * valid declaration fails at the one place that can say so instead of inside
 * the client's constructor.
 */
export function declarationOf(draft: ConnectionDraft): EntryContext {
  return entryContextSchema.parse({
    identity: draft.identity,
    interruptions: draft.interruptions,
    heldConfiguration: heldConfigurationOf(draft),
    requiredScopes: requiredScopesOf(draft),
  });
}

/**
 * Why a route was set aside, in the words of the answer that set it aside.
 *
 * The resolver's reason codes name a rule; a person needs the step to go back
 * to. Keyed exhaustively off `methodSelectionSchema`, so a new reason is a
 * compile error here rather than a blank line on screen.
 */
export const refusals: Record<
  MethodSelection["candidates"][number]["reason"],
  string
> = {
  eligible: "Eligible.",
  unavailable: "Not available in this workspace.",
  "unsupported-surface": "Cannot run in a browser.",
  "insufficient-scopes": "Does not carry every scope Configure asked for.",
  "wrong-identity": "Does not match whose access Customize said this is.",
  "too-many-interruptions":
    "Stops for a person more often than Customize allows.",
};
