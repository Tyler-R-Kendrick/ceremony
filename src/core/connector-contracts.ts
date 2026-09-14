import { z } from "zod";
import {
  identifierSchema,
  semanticVersionSchema,
} from "./operation-contracts.js";

/** Portable requirements only. Values, recipients, URLs and authority stay with the host. */
export const humanHandoffContractSchema = z.strictObject({
  surface: z.enum(["provider-browser", "private-collector"]),
  recipient: z.enum(["initiating-subject", "authorized-owner"]),
  delegation: z.literal("a2h-authorize"),
  resume: z.literal("verify"),
});
export type HumanHandoffContract = z.infer<typeof humanHandoffContractSchema>;

/**
 * What a provider needs before it will make an account, in the order it needs it.
 *
 * Registration does not begin with a password. It begins with whatever names
 * the account — an address at one provider, a handle at another, both at a
 * third — and only then, if at all, with something proving it. A flow built the
 * other way round asks every person for a password whether or not their
 * provider wants one, which is wrong for single sign-on, wrong for a passkey,
 * wrong for a magic link, and wrong for every provider that issues the
 * credential itself rather than accepting one.
 *
 * So the identifier is declared separately from the secret, and the secret is
 * declared as a kind rather than assumed to exist:
 *
 * - `none` — nothing beyond the identifier. A passkey, single sign-on, or a
 *   link the provider mails. No credential field is ever shown.
 * - `password` — a password, which the provider will hold. `mint` says whether
 *   the ceremony may generate it instead of asking a person to invent one.
 * - `issued-token` — the provider issues the credential in its own surface and
 *   a person brings it back. Never generated here: only the provider can make
 *   one that works.
 * - `provider` — the provider owns the credential step completely, as a
 *   redirect or a device code. Nothing is collected and nothing is minted.
 *
 * `mint` is only ever true for `password`, and being true is what lets a
 * ceremony hand somebody a strong credential they never had to think of — and
 * never had to type where anything could read it.
 */
export const registrationContractSchema = z
  .strictObject({
    identifier: z
      .array(z.enum(["email", "username", "organization"]))
      .min(1)
      .max(3)
      .refine(
        (values) => new Set(values).size === values.length,
        "Duplicate identifier",
      ),
    secret: z.enum(["none", "password", "issued-token", "provider"]),
    mint: z.boolean(),
    /** Where the account comes into existence: here, or in the provider's own surface. */
    createdBy: z.enum(["this-ceremony", "provider-browser"]),
  })
  .refine(
    (value) => !value.mint || value.secret === "password",
    "Only a password may be minted",
  );
export type RegistrationContract = z.infer<typeof registrationContractSchema>;

export const methodContractSchema = z
  .strictObject({
    profile: identifierSchema,
    surfaces: z
      .array(z.enum(["browser", "headless"]))
      .min(1)
      .max(2)
      .refine(
        (values) => new Set(values).size === values.length,
        "Duplicate surface",
      ),
    configuration: z
      .array(
        z.strictObject({
          name: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/),
          source: z.enum(["session-environment", "host"]),
          classification: z.enum(["public", "personal", "secret"]),
          required: z.boolean(),
        }),
      )
      .max(24),
    configurationGroups: z
      .array(
        z.strictObject({
          id: identifierSchema,
          rule: z.enum(["all-or-none", "at-least-one"]),
          names: z
            .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/))
            .min(2)
            .max(24),
        }),
      )
      .max(12),
    prerequisites: z
      .array(
        z.strictObject({
          id: identifierSchema,
          kind: z.enum([
            "configuration",
            "provider-registration",
            "provider-consent",
          ]),
          reuse: z.literal("verified-context"),
          handoff: humanHandoffContractSchema,
        }),
      )
      .max(12),
    handoff: humanHandoffContractSchema,
    /** Present when this method can bring an account into being, not merely use one. */
    registration: registrationContractSchema.optional(),
    completion: z.strictObject({
      verifier: identifierSchema,
      ownership: z
        .array(z.enum(["authenticated", "anonymous", "claimed"]))
        .min(1)
        .max(3)
        .refine(
          (values) => new Set(values).size === values.length,
          "Duplicate ownership",
        ),
    }),
    /** Host-bound document identity; never a remotely fetched executable URL. */
    workflows: z
      .array(
        z.strictObject({
          document: identifierSchema,
          version: semanticVersionSchema,
          workflowId: identifierSchema,
        }),
      )
      .max(12),
  })
  .superRefine((value, context) => {
    for (const [items, keys] of [
      [value.configuration, value.configuration.map((item) => item.name)],
      [value.prerequisites, value.prerequisites.map((item) => item.id)],
      [
        value.configurationGroups,
        value.configurationGroups.map((item) => item.id),
      ],
      [
        value.workflows,
        value.workflows.map((item) => `${item.document}:${item.workflowId}`),
      ],
    ] as const) {
      if (items.length !== new Set(keys).size)
        context.addIssue({
          code: "custom",
          message: "Duplicate contract requirement",
        });
    }
    for (const group of value.configurationGroups) {
      if (
        new Set(group.names).size !== group.names.length ||
        group.names.some(
          (name) => !value.configuration.some((item) => item.name === name),
        )
      )
        context.addIssue({
          code: "custom",
          message: "Configuration group requires distinct declared names",
        });
    }
  });
export type MethodContract = z.infer<typeof methodContractSchema>;

/** Presence is supplied by trusted host lookup, never values or browser claims. Advisory, not a grant. */
export function inspectConfiguration(
  contract: MethodContract,
  present: ReadonlySet<string>,
) {
  const parsed = methodContractSchema.parse(contract);
  const missingRequired = parsed.configuration
    .filter((item) => item.required && !present.has(item.name))
    .map((item) => item.name);
  const unsatisfiedGroups = parsed.configurationGroups.flatMap((group) => {
    const count = group.names.filter((name) => present.has(name)).length;
    if (
      (group.rule === "all-or-none" &&
        count > 0 &&
        count < group.names.length) ||
      (group.rule === "at-least-one" && count === 0)
    )
      return [
        {
          id: group.id,
          rule: group.rule,
          missing: group.names.filter((name) => !present.has(name)),
        },
      ];
    return [];
  });
  return {
    ready: missingRequired.length === 0 && unsatisfiedGroups.length === 0,
    missingRequired,
    unsatisfiedGroups,
  };
}
