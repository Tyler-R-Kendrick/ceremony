import { z } from "zod";
import { ceremonyGoalSchema, ceremonyRoleSchema } from "./browser-contracts.js";
import { identifierSchema } from "./operation-contracts.js";

/**
 * A ceremony plan: what it takes to get through a provider's authentication,
 * written down so it can be shared and run again.
 *
 * A plan is a template, not a record of an attempt. It names the steps, what
 * each one needs before it can run, which data the caller has to be able to
 * supply, and the different ways the goal can be reached — because there is
 * usually more than one, and they do not cost the same. What a plan never
 * carries is a value, a credential, a session, or a line of the provider's
 * markup: it describes shape and order, so sharing one discloses nothing about
 * the person or the attempt it came from.
 *
 * The four questions a plan exists to answer:
 *
 * - **What must happen first?** `step.needs` — a registration before a sign-in,
 *   a sign-in before a consent.
 * - **What else would work?** `paths` — more than one route to the same goal,
 *   each with the price it charges in human attention.
 * - **What do I have to be able to supply?** `data` — every role any path may
 *   ask for, and whether the caller brings it, an earlier step produces it, or
 *   only a person can.
 * - **Is this the same plan I had before?** `canonicalCeremonyPlan` and
 *   `digestCeremonyPlan`.
 */

export const PLAN_LIMITS = Object.freeze({
  bytes: 128 * 1024,
  steps: 48,
  paths: 12,
  data: 32,
});

/** Where a datum comes from, which decides who has to be asked for it. */
export const dataSourceSchema = z.discriminatedUnion("from", [
  /** The caller must hold this before the ceremony starts. */
  z.strictObject({ from: z.literal("caller") }),
  /** An earlier step produces it, such as a code mailed during registration. */
  z.strictObject({ from: z.literal("step"), step: identifierSchema }),
  /**
   * Only a person can supply it, in their own browser. A plan that needs one
   * of these is a plan that cannot run unattended, and says so here rather
   * than discovering it halfway through.
   */
  z.strictObject({ from: z.literal("human") }),
]);
export type DataSource = z.infer<typeof dataSourceSchema>;

export const planDatumSchema = z
  .strictObject({
    role: ceremonyRoleSchema,
    /** Whether disclosing it would disclose a credential. */
    secret: z.boolean(),
    source: dataSourceSchema,
    /** False when only some paths ask for it. */
    always: z.boolean(),
  })
  .strict();
export type PlanDatum = z.infer<typeof planDatumSchema>;

/**
 * What a step is. These are kinds of obstacle, not provider names: the point
 * is that a reader can tell whether a step is something an agent can do.
 */
export const planStepKinds = [
  /** Fill a form and submit it. */
  "form",
  /** Follow a link or button that only moves the ceremony along. */
  "navigate",
  /** Approve or refuse something on the provider's behalf. */
  "decision",
  /** Read a code or link out of a mailbox. */
  "out-of-band",
  /** A human challenge: a widget, an authenticator, a browser dialog. */
  "human",
  /** Redirect back to the caller with a result. */
  "callback",
] as const;
export const planStepKindSchema = z.enum(planStepKinds);
export type PlanStepKind = z.infer<typeof planStepKindSchema>;

export const planStepSchema = z
  .strictObject({
    id: identifierSchema,
    kind: planStepKindSchema,
    /** A short description for a person reading the plan. */
    label: z.string().min(1).max(120),
    /**
     * Origin and path only, never a query string: a plan is a template, and a
     * query carries the particular attempt it was discovered on.
     */
    at: z.string().url().max(512).optional(),
    /** Steps that must have run first. */
    needs: z.array(identifierSchema).max(PLAN_LIMITS.steps),
    /** Data this step consumes, by key into `data`. */
    uses: z.array(identifierSchema).max(PLAN_LIMITS.data),
    /** Data this step produces, by key into `data`. */
    produces: z.array(identifierSchema).max(PLAN_LIMITS.data),
    /**
     * Why a person is needed, when they are. Present exactly on `human` steps
     * so a reader never has to guess what the interruption is for.
     */
    humanReason: z
      .enum(["challenge", "passkey", "native-dialog", "approval"])
      .optional(),
  })
  .strict()
  .superRefine((step, context) => {
    const human = step.kind === "human";
    if (human !== (step.humanReason !== undefined))
      context.addIssue({
        code: "custom",
        message:
          "A human step states its reason, and only a human step has one",
      });
  });
export type PlanStep = z.infer<typeof planStepSchema>;

/**
 * One way through. Paths are what make a fork legible: the same goal reached
 * by a signed request or by a person clearing an interstitial is two paths,
 * and `handoffs` is the difference that matters when choosing between them.
 */
export const planPathSchema = z
  .strictObject({
    id: identifierSchema,
    label: z.string().min(1).max(120),
    steps: z.array(identifierSchema).min(1).max(PLAN_LIMITS.steps),
    /** How many times this path has to interrupt a person. */
    handoffs: z.number().int().min(0).max(PLAN_LIMITS.steps),
    /** Preconditions that make this path the applicable one. */
    when: z.array(z.string().min(1).max(120)).max(8),
  })
  .strict();
export type PlanPath = z.infer<typeof planPathSchema>;

export const ceremonyPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: identifierSchema,
    title: z.string().min(1).max(120),
    goal: ceremonyGoalSchema,
    /**
     * The origin this plan was written against. A plan is reusable against the
     * same provider, not evidence about it, and never a claim that the
     * provider endorses it.
     */
    origin: z.string().url().max(512),
    data: z
      .record(identifierSchema, planDatumSchema)
      .refine((value) => Object.keys(value).length <= PLAN_LIMITS.data),
    steps: z.array(planStepSchema).min(1).max(PLAN_LIMITS.steps),
    paths: z.array(planPathSchema).min(1).max(PLAN_LIMITS.paths),
  })
  .strict()
  .superRefine((plan, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message });
    const steps = new Map(plan.steps.map((step) => [step.id, step]));
    if (steps.size !== plan.steps.length) issue("Duplicate step");

    for (const step of plan.steps) {
      for (const need of step.needs)
        if (!steps.has(need)) issue(`Unknown prerequisite ${need}`);
      for (const key of [...step.uses, ...step.produces])
        if (!Object.hasOwn(plan.data, key)) issue(`Unknown datum ${key}`);
      // A step cannot consume what it is itself producing.
      for (const key of step.produces)
        if (step.uses.includes(key)) issue(`${key} is both used and produced`);
    }

    // Every datum a step produces must say so, and the other way round: a plan
    // whose data and steps disagree would send a caller looking for a value
    // nothing creates.
    for (const [key, datum] of Object.entries(plan.data)) {
      if (datum.source.from !== "step") continue;
      const producer = steps.get(datum.source.step);
      if (!producer) issue(`${key} names a step that is not in the plan`);
      else if (!producer.produces.includes(key))
        issue(`${key} claims a producer that does not produce it`);
    }

    for (const path of plan.paths) {
      const seen = new Set<string>();
      for (const id of path.steps) {
        const step = steps.get(id);
        if (!step) {
          issue(`Path ${path.id} names unknown step ${id}`);
          continue;
        }
        // A path must be runnable in the order it is written: every
        // prerequisite of a step has to appear before it on that same path.
        for (const need of step.needs)
          if (!seen.has(need))
            issue(`Path ${path.id} runs ${id} before ${need}`);
        seen.add(id);
      }
      const human = path.steps.filter(
        (id) => steps.get(id)?.kind === "human",
      ).length;
      if (human !== path.handoffs)
        issue(
          `Path ${path.id} claims ${path.handoffs} handoffs but has ${human}`,
        );
    }

    // A step no path uses is not part of the plan; leaving it in would make
    // the plan look like it does more than it does.
    const used = new Set(plan.paths.flatMap((path) => path.steps));
    for (const step of plan.steps)
      if (!used.has(step.id)) issue(`No path uses ${step.id}`);

    // `always` has to mean what it says, or a caller cannot tell which data it
    // must have before starting.
    for (const [key, datum] of Object.entries(plan.data)) {
      const paths = plan.paths.filter((path) =>
        path.steps.some((id) => steps.get(id)?.uses.includes(key)),
      );
      if (paths.length === 0) issue(`No path uses ${key}`);
      else if (datum.always !== (paths.length === plan.paths.length))
        issue(
          `${key} is marked always=${datum.always} but is used by ${paths.length} of ${plan.paths.length} paths`,
        );
    }
  });
export type CeremonyPlan = z.infer<typeof ceremonyPlanSchema>;

export function parseCeremonyPlan(text: string): CeremonyPlan {
  if (new TextEncoder().encode(text).byteLength > PLAN_LIMITS.bytes)
    throw new Error("Ceremony plan exceeds import limit");
  return ceremonyPlanSchema.parse(JSON.parse(text));
}

/** Stable bytes for a plan, so two copies can be compared or addressed. */
export function canonicalCeremonyPlan(plan: unknown): string {
  const parsed = ceremonyPlanSchema.parse(plan);
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  }
  return JSON.stringify(canonical(parsed));
}

/**
 * Integrity only. A digest says two plans are the same bytes; it conveys no
 * authority, no provider endorsement and no evidence that the plan works.
 */
export async function digestCeremonyPlan(plan: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalCeremonyPlan(plan)),
  );
  return Buffer.from(digest).toString("base64url");
}

/**
 * The path to try first: the one that interrupts a person least, and among
 * equals the shortest. This is the whole point of recording alternatives —
 * a caller should not have to decide what "cheapest" means.
 */
export function preferredPath(plan: CeremonyPlan): PlanPath {
  return [...plan.paths].sort(
    (a, b) =>
      a.handoffs - b.handoffs ||
      a.steps.length - b.steps.length ||
      (a.id < b.id ? -1 : 1),
  )[0]!;
}

/**
 * Data the caller must be able to supply for a path, in the order the path
 * asks for it. Data an earlier step produces is excluded: the caller does not
 * bring a code that has not been sent yet.
 */
export function requiredOf(
  plan: CeremonyPlan,
  path: PlanPath,
): readonly (PlanDatum & { key: string })[] {
  const steps = new Map(plan.steps.map((step) => [step.id, step]));
  const seen = new Set<string>();
  const needed: (PlanDatum & { key: string })[] = [];
  for (const id of path.steps)
    for (const key of steps.get(id)?.uses ?? []) {
      const datum = plan.data[key];
      if (!datum || seen.has(key) || datum.source.from !== "caller") continue;
      seen.add(key);
      needed.push({ ...datum, key });
    }
  return needed;
}
