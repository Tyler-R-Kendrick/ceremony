import { z } from "zod";
import type { NormalizedDefinition } from "../../../core/connectors/index.js";
import type { BoundOperation } from "../binding.js";
import type { ConfigurationPort } from "../ports.js";

/*
 * What the command layer reads out of a reviewed definition: the origins its
 * OAuth profiles declare, the configuration names a call may see, and the
 * transport an operation declares. Pure functions of their input.
 */

/** Profile kinds an issuer policy can apply to. */
export const OAUTH_PROFILE_KINDS: ReadonlySet<string> = new Set([
  "oauth-authorization-code",
  "openid-connect",
  "oauth-device",
  "oauth-client-credentials",
]);

/** Origins a definition declares for its OAuth profiles; candidates for review, never approval. */
export function declaredOAuthOrigins(
  definition: NormalizedDefinition,
): string[] {
  const origins = new Set<string>();
  for (const profile of definition.authentication)
    for (const key of [
      "issuer",
      "authorizationEndpoint",
      "tokenEndpoint",
      "deviceAuthorizationEndpoint",
    ] as const) {
      const value = (profile as Partial<Record<typeof key, string>>)[key];
      if (value && URL.canParse(value)) origins.add(new URL(value).origin);
    }
  return [...origins];
}
/** A configuration port that answers only for the names given; any other reads as absent. */
export function narrowConfiguration(
  port: ConfigurationPort,
  names: ReadonlySet<string>,
): ConfigurationPort {
  return {
    read: async (name) => (names.has(name) ? port.read(name) : undefined),
    present: async (asked) => {
      const allowed = asked.filter((name) => names.has(name));
      return allowed.length ? port.present(allowed) : new Set<string>();
    },
    revision: () => port.revision(),
  };
}

export function boundOperationTransport(
  value: unknown,
): BoundOperation["transport"] | undefined {
  const parsed = z
    .discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("http"),
        method: z.enum([
          "GET",
          "HEAD",
          "POST",
          "PUT",
          "PATCH",
          "DELETE",
          "OPTIONS",
        ]),
        pathTemplate: z
          .string()
          .max(1024)
          .regex(/^\/[^\p{Cc}?#]*$/u),
      }),
      z.strictObject({
        kind: z.literal("mcp-tool"),
        toolName: z.string().min(1).max(512),
      }),
      z.strictObject({
        kind: z.literal("mcp-resource"),
        uriTemplate: z.string().max(2048),
      }),
      z.strictObject({
        kind: z.literal("mcp-prompt"),
        promptName: z.string().min(1).max(512),
      }),
      z.strictObject({
        kind: z.literal("broker-action"),
        action: z.string().min(1).max(512),
      }),
      z.strictObject({
        kind: z.literal("delegated"),
        route: z.string().min(1).max(256),
      }),
    ])
    .safeParse(value);
  return parsed.success
    ? (parsed.data as BoundOperation["transport"])
    : undefined;
}
