import { z } from "zod";
import {
  manifestSchema,
  type AuthMethod,
  type ConnectorManifest,
} from "./schema.js";

/** Caller hints are not authorization or evidence of stored credentials. */
export const entryContextSchema = z
  .object({
    surface: z.enum(["browser", "headless"]).default("browser"),
    requiredScopes: z.array(z.string().min(1).max(100)).max(30).default([]),
  })
  .strict();
export type EntryContext = z.input<typeof entryContextSchema>;
export type MethodAvailability = "available" | "configured" | "unavailable";

export const methodSelectionSchema = z.strictObject({
  selectedMethodId: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/)
    .nullable(),
  candidates: z
    .array(
      z.strictObject({
        methodId: z.string().regex(/^[a-z0-9-]{1,64}$/),
        availability: z.enum(["available", "configured", "unavailable"]),
        reason: z.enum([
          "eligible",
          "unavailable",
          "unsupported-surface",
          "insufficient-scopes",
        ]),
      }),
    )
    .min(1)
    .max(12),
});
export type MethodSelection = z.infer<typeof methodSelectionSchema>;

/** Deterministic policy shared by clients and trusted server-side entry points. */
export function explainCeremonySelection(
  manifest: ConnectorManifest,
  context: EntryContext = {},
  availability: (method: AuthMethod) => MethodAvailability = () => "available",
): MethodSelection {
  // Validate without replacing method identity: existing host callbacks may key by object.
  manifestSchema.parse(manifest);
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
  const candidates = manifest.methods.map((method, index) => {
    const state = z
      .enum(["available", "configured", "unavailable"])
      .parse(availability(method));
    const reason =
      state === "unavailable"
        ? "unavailable"
        : method.contract && !method.contract.surfaces.includes(surface)
          ? "unsupported-surface"
          : !requiredScopes.every((scope) => method.scopes.includes(scope))
            ? "insufficient-scopes"
            : "eligible";
    return {
      methodId: method.id,
      availability: state,
      reason,
      score: (state === "configured" ? -100 : 0) + order.indexOf(method.kind),
      index,
    };
  });
  const eligible = candidates
    .filter((item) => item.reason === "eligible")
    .sort((a, b) => a.score - b.score || a.index - b.index);
  return methodSelectionSchema.parse({
    selectedMethodId: eligible[0]?.methodId ?? null,
    candidates: candidates.map(({ methodId, availability, reason }) => ({
      methodId,
      availability,
      reason,
    })),
  });
}

export function resolveCeremonyMethod(
  manifest: ConnectorManifest,
  context: EntryContext = {},
  availability: (method: AuthMethod) => MethodAvailability = () => "available",
): AuthMethod {
  const selection = explainCeremonySelection(manifest, context, availability);
  const method = manifest.methods.find(
    (item) => item.id === selection.selectedMethodId,
  );
  if (!method)
    throw new Error(
      "No available authentication method satisfies this connection request.",
    );
  return method;
}
