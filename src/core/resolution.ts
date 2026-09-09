import { z } from "zod";
import type { AuthMethod, ConnectorManifest } from "./schema.js";

/** Caller hints are not authorization or evidence of stored credentials. */
export const entryContextSchema = z
  .object({
    surface: z.enum(["browser", "headless"]).default("browser"),
    requiredScopes: z.array(z.string().min(1).max(100)).max(30).default([]),
  })
  .strict();
export type EntryContext = z.input<typeof entryContextSchema>;
export type MethodAvailability = "available" | "configured" | "unavailable";

/** Deterministic policy shared by clients and trusted server-side entry points. */
export function resolveCeremonyMethod(
  manifest: ConnectorManifest,
  context: EntryContext = {},
  availability: (method: AuthMethod) => MethodAvailability = () => "available",
): AuthMethod {
  const { surface, requiredScopes } = entryContextSchema.parse(context);
  const order =
    surface === "browser"
      ? [
          "oauth-code",
          "github-app",
          "device",
          "authmd-anonymous",
          "api-key",
          "form",
          "basic",
        ]
      : [
          "device",
          "oauth-code",
          "github-app",
          "authmd-anonymous",
          "api-key",
          "form",
          "basic",
        ];
  const candidates = manifest.methods.flatMap((method, index) => {
    const state = availability(method);
    if (
      state === "unavailable" ||
      !requiredScopes.every((scope) => method.scopes.includes(scope))
    )
      return [];
    return [
      {
        method,
        score: (state === "configured" ? -100 : 0) + order.indexOf(method.kind),
        index,
      },
    ];
  });
  candidates.sort((a, b) => a.score - b.score || a.index - b.index);
  if (!candidates[0])
    throw new Error(
      "No available authentication method satisfies this connection request.",
    );
  return candidates[0].method;
}
