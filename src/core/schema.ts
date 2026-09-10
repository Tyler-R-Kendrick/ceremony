import { z } from "zod";
import { fieldClassificationSchema } from "./operation-contracts.js";
import { methodContractSchema } from "./connector-contracts.js";

export const flowKinds = [
  "api-key",
  "basic",
  "form",
  "oauth-code",
  "device",
  "authmd-anonymous",
  "github-app",
] as const;
export const flowKindSchema = z.enum(flowKinds);
export type FlowKind = z.infer<typeof flowKindSchema>;
export const fieldSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/),
    label: z.string().min(1).max(100),
    type: z.enum(["text", "email", "password"]),
    required: z.boolean(),
    classification: fieldClassificationSchema.optional(),
  })
  .strict()
  .refine(
    (field) =>
      !(
        field.type === "password" || ["password", "token"].includes(field.name)
      ) ||
      field.classification === undefined ||
      field.classification === "secret",
    "Credential fields must remain secret",
  );
export type Field = z.infer<typeof fieldSchema>;
export const methodSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,64}$/),
    label: z.string().min(1).max(100),
    kind: flowKindSchema,
    fields: z.array(fieldSchema).max(12),
    /** Omit for the email/code profile; [] supports provider-owned claiming. */
    claimFields: z.array(fieldSchema).max(12).optional(),
    scopes: z.array(z.string().min(1).max(100)).max(30),
    templateId: z.string().regex(/^[a-z0-9-]{1,64}$/),
    contract: methodContractSchema.optional(),
  })
  .strict()
  .superRefine((method, ctx) => {
    const names = method.fields.map((field) => field.name);
    if (
      method.claimFields &&
      (method.kind !== "authmd-anonymous" ||
        new Set(method.claimFields.map((field) => field.name)).size !==
          method.claimFields.length)
    )
      ctx.addIssue({
        code: "custom",
        message: "Claim fields require anonymous auth and unique names",
      });
    if (new Set(names).size !== names.length)
      ctx.addIssue({ code: "custom", message: "Duplicate field names" });
    if (
      method.contract &&
      method.kind !== "authmd-anonymous" &&
      method.contract.completion.ownership.some(
        (ownership) => ownership !== "authenticated",
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "This method requires authenticated completion",
      });
    if (
      method.contract &&
      ["basic", "api-key", "form"].includes(method.kind) &&
      method.contract.handoff.surface !== "private-collector"
    )
      ctx.addIssue({
        code: "custom",
        message: "Credential methods require private collection",
      });
    const expected =
      method.kind === "basic"
        ? ["username", "password"]
        : method.kind === "api-key"
          ? ["token"]
          : null;
    if (
      expected &&
      (names.length !== expected.length ||
        expected.some((name) => !names.includes(name)))
    ) {
      ctx.addIssue({
        code: "custom",
        message: `${method.kind} requires ${expected.join(", ")}`,
      });
    }
    if (method.kind === "form" && !names.length)
      ctx.addIssue({ code: "custom", message: "Form requires fields" });
    if (!["basic", "api-key", "form"].includes(method.kind) && names.length)
      ctx.addIssue({
        code: "custom",
        message: "This method does not collect credentials",
      });
    if (
      [...method.fields, ...(method.claimFields ?? [])].some(
        (field) =>
          ["password", "token"].includes(field.name) &&
          field.type !== "password",
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Credentials require masked inputs",
      });
  });
export type AuthMethod = z.infer<typeof methodSchema>;
export const manifestSchema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    support: z.enum(["fixture", "live-adapter"]).optional(),
    id: z.string().regex(/^[a-z0-9-]{1,64}$/),
    name: z.string().min(1).max(100),
    description: z.string().max(500),
    methods: z.array(methodSchema).min(1).max(12),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.schemaVersion === 1 &&
      (!value.support ||
        value.methods.some(
          (method) =>
            !method.contract ||
            [...method.fields, ...(method.claimFields ?? [])].some(
              (field) => !field.classification,
            ),
        ))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Version 1 requires support, method contracts and explicit field classifications",
      });
    if (
      new Set(value.methods.map((method) => method.id)).size !==
      value.methods.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate method IDs" });
  });
export type ConnectorManifest = z.infer<typeof manifestSchema>;

const classifiedFieldSchema = fieldSchema.safeExtend({
  classification: fieldClassificationSchema,
});
/** Formal authoring profile. Legacy manifestSchema remains supported for existing hosts. */
export const connectorManifestV1Schema = manifestSchema.safeExtend({
  schemaVersion: z.literal(1),
  support: z.enum(["fixture", "live-adapter"]),
  methods: z
    .array(
      methodSchema.safeExtend({
        contract: methodContractSchema,
        fields: z.array(classifiedFieldSchema).max(12),
        claimFields: z.array(classifiedFieldSchema).max(12).optional(),
      }),
    )
    .min(1)
    .max(12),
});

export function parseConnectorManifest(text: string): ConnectorManifest {
  if (new TextEncoder().encode(text).byteLength > 256 * 1024)
    throw new Error("Connector manifest exceeds import limit");
  return manifestSchema.parse(JSON.parse(text));
}

export const steps = [
  "intro",
  "input",
  "redirect",
  "waiting",
  "anonymous",
  "claim",
  "complete",
  "error",
  "cancelled",
  "expired",
] as const;
export type Step = (typeof steps)[number];
export const actionNames = [
  "begin",
  "submit",
  "claim",
  "finish",
  "retry",
  "cancel",
  "request-human",
] as const;
export type ActionName = (typeof actionNames)[number];
export const outcomeSchema = z
  .object({
    connectionRef: z.string().min(1).max(200),
    ownership: z.enum(["authenticated", "anonymous", "claimed"]),
    scopes: z.array(z.string()),
  })
  .strict();
export type AuthOutcome = z.infer<typeof outcomeSchema>;
export type CeremonySnapshot = z.infer<typeof snapshotSchema>;
const displayUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    !url.hash &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  );
}, "Unsafe navigation URL");
export const snapshotSchema = z
  .object({
    id: z.string().min(1),
    revision: z.number().int().nonnegative(),
    connectorId: z.string(),
    connectorName: z.string(),
    description: z.string(),
    method: methodSchema,
    step: z.enum(steps),
    fields: z.array(fieldSchema),
    actions: z.array(z.enum(actionNames)),
    expiresAt: z.number().finite(),
    message: z.string().optional(),
    authorizationUrl: displayUrlSchema.optional(),
    verificationUri: displayUrlSchema.optional(),
    userCode: z.string().optional(),
    outcome: outcomeSchema.optional(),
    prerequisites: z
      .array(
        z
          .object({
            id: z.string(),
            label: z.string(),
            status: z.enum([
              "blocked",
              "ready",
              "awaiting-human",
              "verifying",
              "succeeded",
              "failed",
            ]),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export const actionSchema = z
  .object({
    action: z.enum(actionNames),
    revision: z.number().int().nonnegative(),
    values: z.record(z.string(), z.string().max(4096)).default({}),
    secretRef: z.uuid().optional(),
  })
  .strict();
export type CeremonyAction = z.infer<typeof actionSchema>;
export interface CeremonyTransport {
  /** Resolve using trusted session state; clients never supply credential availability. */
  connect?(
    connectorId: string,
    context: import("./resolution.js").EntryContext,
  ): Promise<CeremonySnapshot>;
  privateInputUrl?(id: string): string;
  start(connectorId: string, methodId: string): Promise<CeremonySnapshot>;
  read(id: string): Promise<CeremonySnapshot>;
  collect?(
    id: string,
    revision: number,
    values: Record<string, string>,
  ): Promise<string>;
  act(id: string, action: CeremonyAction): Promise<CeremonySnapshot>;
}
export function fieldsFor(step: Step, method: AuthMethod): Field[] {
  if (step === "input") return method.fields;
  if (step === "claim")
    return (
      method.claimFields ?? [
        {
          name: "email",
          label: "Account email",
          type: "email",
          required: true,
        },
      ]
    );
  return [];
}
export function actionsFor(
  step: Step,
  hasAnonymousAccess = false,
): ActionName[] {
  switch (step) {
    case "cancelled":
      return ["retry"];
    case "complete":
      return hasAnonymousAccess ? ["claim"] : [];
    case "intro":
      return ["begin", "cancel"];
    case "input":
    case "claim":
      return ["submit", "cancel"];
    case "anonymous":
      return ["finish", "claim", "cancel"];
    case "redirect":
    case "waiting":
      return ["cancel"];
    case "error":
    case "expired":
      return hasAnonymousAccess
        ? ["finish", "claim", "cancel"]
        : ["retry", "cancel"];
    default:
      return [];
  }
}
export function validateInput(
  fields: Field[],
  values: Record<string, string>,
): Record<string, string> {
  const names = new Set(fields.map((field) => field.name));
  if (Object.keys(values).some((name) => !names.has(name)))
    throw new Error("Unexpected field");
  const result: Record<string, string> = {};
  for (const field of fields) {
    const value = Object.hasOwn(values, field.name)
      ? (values[field.name] ?? "")
      : "";
    if (value.length > 4096 || (field.required && !value.trim()))
      throw new Error(`${field.label} is required`);
    if (value && field.type === "email" && !z.email().safeParse(value).success)
      throw new Error("Enter a valid email address");
    result[field.name] = value;
  }
  return result;
}

export const templateSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-z0-9-]{1,64}$/),
    kind: flowKindSchema,
    screens: z.record(z.enum(steps), z.string().min(1).max(20000)),
  })
  .strict();
export interface CeremonyTemplate {
  version: 1;
  id: string;
  kind: FlowKind;
  screens: Record<Step, string>;
}
export const requiredParts: Record<Step, string[]> = {
  intro: ["Details", "Access", "Actions", "Notice"],
  input: ["Details", "Fields", "Actions", "Notice"],
  redirect: ["Details", "Redirect", "Actions", "Notice"],
  waiting: ["Details", "Device", "Actions", "Notice"],
  anonymous: ["Details", "Outcome", "Actions", "Notice"],
  claim: ["Details", "Fields", "Actions", "Notice"],
  complete: ["Details", "Outcome", "Actions", "Notice"],
  error: ["Details", "Outcome", "Actions", "Notice"],
  cancelled: ["Details", "Outcome", "Actions", "Notice"],
  expired: ["Details", "Outcome", "Actions", "Notice"],
};
export function defaultTemplate(kind: FlowKind): CeremonyTemplate {
  const titles: Record<Step, string> = {
    intro:
      kind === "github-app"
        ? "Prepare your GitHub integration"
        : kind === "authmd-anonymous"
          ? "Start anonymous access"
          : "Connect your account",
    input: "Enter your credentials",
    redirect: "Continue with your provider",
    waiting: "Waiting for approval",
    anonymous: "Anonymous access is ready",
    claim: "Claim ownership",
    complete:
      kind === "authmd-anonymous" ? "Ceremony complete" : "You’re connected",
    error: "Let’s try that again",
    cancelled: "Connection cancelled",
    expired: "This attempt has expired",
  };
  const screens = templateSchema.shape.screens.parse(
    Object.fromEntries(
      steps.map((step) => [
        step,
        `root = Stack([Title(${JSON.stringify(titles[step])}), ${requiredParts[step].map((part) => `${part}()`).join(", ")}])`,
      ]),
    ),
  );
  return { version: 1, id: kind, kind, screens };
}
