import { z } from "zod";
import { safeTextSchema, type EvidenceLevel } from "./identity.js";

/*
 * Support labels, derived from recorded evidence and nothing else.
 *
 * A connector's label used to be whatever its adapter family declared: the
 * generic OpenAPI and provider-catalog adapters said `fixture` however well
 * they were exercised, and an adapter with no ledger entry read
 * `not-recorded` however configured it was. The family is a fact about the
 * code, not about what has been checked, so it cannot decide how much a
 * reader should trust a connector.
 *
 * A label is now computed from dated evidence entries. Each entry names one
 * adapter, one check that ran (a repository test file, or a named check such
 * as a ledger work item or an attended certification record), the kind of
 * target that check ran against, and the day it was recorded. The label is
 * the strongest one any *fresh, admissible* entry earns:
 *
 * | Label        | Minimum evidence (at least one entry)                   | Fresh for | Needs configuration |
 * | ------------ | ------------------------------------------------------- | --------- | ------------------- |
 * | `unverified` | none                                                    | —         | —                   |
 * | `fixture`    | a check against an in-process fixture                   | 365 days  | no                  |
 * | `local`      | a check against a local double (loopback server, real   | 365 days  | no                  |
 * |              | local browser, local dependency)                        |           |                     |
 * | `live`       | a recorded run against the real provider                | 90 days   | yes                 |
 * | `certified`  | a live run a named person attended and certified        | 180 days  | yes                 |
 *
 * `supportLabelRules` below is that table, and it is the only place the
 * ordering, the minimum evidence and the windows are written down: the
 * runtime catalog, the binding gate and the generated support matrix all
 * read it.
 *
 * Staleness. An entry older than its target's window has expired: it earns
 * nothing, and the label falls back to whatever the remaining fresh entries
 * earn. Live evidence expires fastest because a provider changes without
 * telling anyone; a certification lasts longer because it is rarer and a
 * person stood behind it, but it still ends. Fixture and local evidence is
 * re-run by every CI build, so a year without re-recording it means the
 * ledger, not the code, went stale. Expired entries are reported rather than
 * dropped silently, so a reader can see what lapsed.
 *
 * Configuration. Live and certified evidence was measured with the
 * configuration it needed; a deployment lacking that configuration cannot
 * present the evidence as its own (the same rule `capabilityStatusSchema`
 * applies to live evidence levels), so such entries are not admissible there.
 *
 * Dates. An entry is dated by UTC calendar day. One dated after the
 * evaluation day is not evidence yet: validation at every boundary that
 * accepts entries (the ledger generator, a host supplying its own) refuses
 * it, and computation ignores it and reports it.
 *
 * Nothing here can raise a label from the adapter family, a model's
 * suggestion or a registration: only an entry can, and an attended
 * certification is refused unless it names who attended it.
 */

/** What a check ran against, weakest to strongest. */
export const checkTargets = [
  "in-process-fixture",
  "local-double",
  "recorded-live",
  "attended-live",
] as const;
export const checkTargetSchema = z.enum(checkTargets);
export type CheckTarget = z.infer<typeof checkTargetSchema>;

/** Support labels, weakest to strongest. */
export const supportLabels = [
  "unverified",
  "fixture",
  "local",
  "live",
  "certified",
] as const;
export const supportLabelSchema = z.enum(supportLabels);
export type SupportLabel = z.infer<typeof supportLabelSchema>;

export type SupportLabelRule = {
  /** The weakest check target that earns this label. */
  readonly target: CheckTarget;
  /** Days an entry of that target stays fresh. */
  readonly freshForDays: number;
  /** Whether the entry counts only where the configuration it was measured with is present. */
  readonly needsConfiguration: boolean;
};

/** The ordering, minimum evidence and staleness of every label above `unverified`. See the table above. */
export const supportLabelRules: Readonly<
  Record<Exclude<SupportLabel, "unverified">, SupportLabelRule>
> = {
  fixture: {
    target: "in-process-fixture",
    freshForDays: 365,
    needsConfiguration: false,
  },
  local: {
    target: "local-double",
    freshForDays: 365,
    needsConfiguration: false,
  },
  live: { target: "recorded-live", freshForDays: 90, needsConfiguration: true },
  certified: {
    target: "attended-live",
    freshForDays: 180,
    needsConfiguration: true,
  },
};

/** Labels that claim the real provider was exercised. */
export const liveSupportLabels = [
  "live",
  "certified",
] as const satisfies readonly SupportLabel[];

export const isLiveSupportLabel = (label: SupportLabel): boolean =>
  (liveSupportLabels as readonly SupportLabel[]).includes(label);

const labelRank = (label: SupportLabel) => supportLabels.indexOf(label);

/** Whether `label` is at least as strong as `minimum`. */
export function supportLabelAtLeast(
  label: SupportLabel,
  minimum: SupportLabel,
): boolean {
  return labelRank(label) >= labelRank(minimum);
}

/** The label an entry of this target earns while fresh. */
export function labelForTarget(
  target: CheckTarget,
): Exclude<SupportLabel, "unverified"> {
  const found = (
    Object.entries(supportLabelRules) as Array<
      [Exclude<SupportLabel, "unverified">, SupportLabelRule]
    >
  ).find(([, rule]) => rule.target === target);
  // Every target has exactly one rule; the table above is total.
  return found![0];
}

/**
 * A work item recorded before entries were dated carries only an evidence
 * level. That level does not say what the check ran against, so it maps to
 * the weakest target it could mean: `protocol-fixture` covers both in-process
 * fixtures and loopback doubles, so it counts as an in-process fixture. A
 * level that proves nothing (`not-tested`) earns no entry. Raising such an
 * adapter above `fixture` takes an explicit, dated entry naming its target.
 */
export function legacyCheckTarget(
  level: EvidenceLevel,
): CheckTarget | undefined {
  switch (level) {
    case "not-tested":
      return undefined;
    case "unit":
    case "protocol-fixture":
      return "in-process-fixture";
    case "local-integration":
    case "browser-integration":
      return "local-double";
    case "live-authorized":
    case "deployed-authorized":
      return "recorded-live";
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const calendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD day")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Not a calendar day");

/** UTC midnight of the day an instant falls on. */
const dayOf = (instant: number) => Math.floor(instant / DAY_MS) * DAY_MS;
const dayValue = (day: string) => Date.parse(`${day}T00:00:00.000Z`);

/*
 * A check is either a repository-relative path (a test file, a harness a test
 * imports, a fixture document) or a named check, `scheme:identifier`, such as
 * `ledger:HTTP/HTTP-04` or `attended:2026-10-01-acme`. Neither form can climb
 * out of the repository or carry a URL, so an entry cannot smuggle a
 * destination or a credential into a published document.
 */
const repositoryPath = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)+[A-Za-z0-9_.-]+$/;
const namedCheck = /^[a-z][a-z0-9-]{1,23}:[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const checkSchema = z
  .string()
  .min(3)
  .max(240)
  .refine(
    (value) => repositoryPath.test(value) || namedCheck.test(value),
    "A check is a repository path or a named scheme:identifier",
  )
  .refine(
    (value) => !value.split("/").some((segment) => segment === ".."),
    "A check cannot leave the repository",
  )
  .refine(
    (value) => !/^(?:https?|file|data|javascript):/i.test(value),
    "A check is not a URL",
  );

export const supportEvidenceSchema = z
  .strictObject({
    adapterId: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[a-z0-9][a-z0-9._:-]*$/),
    check: checkSchema,
    target: checkTargetSchema,
    recordedAt: calendarDay,
    /** Who attended a certification. Required for `attended-live`, refused otherwise. */
    attendedBy: safeTextSchema.min(1).max(120).optional(),
    notes: safeTextSchema.max(500).optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.target === "attended-live" && !entry.attendedBy)
      ctx.addIssue({
        code: "custom",
        message: "An attended certification names who attended it",
      });
    if (entry.target !== "attended-live" && entry.attendedBy)
      ctx.addIssue({
        code: "custom",
        message: "Only an attended certification names an attendee",
      });
  });
export type SupportEvidence = z.infer<typeof supportEvidenceSchema>;

/**
 * Every reason these entries cannot be accepted as of `asOf`: a malformed
 * entry, or one dated after the evaluation day. Empty means all are admissible.
 */
export function supportEvidenceProblems(
  entries: readonly unknown[],
  options: { asOf: number },
): string[] {
  const problems: string[] = [];
  const today = dayOf(options.asOf);
  entries.forEach((raw, index) => {
    const parsed = supportEvidenceSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(
        `evidence[${index}]: ${parsed.error.issues
          .slice(0, 3)
          .map(
            (issue) =>
              `${issue.path.length ? `${issue.path.join(".")} ` : ""}${issue.message}`,
          )
          .join("; ")}`,
      );
      return;
    }
    if (dayValue(parsed.data.recordedAt) > today)
      problems.push(
        `evidence[${index}]: ${parsed.data.adapterId} ${parsed.data.check} is dated ${parsed.data.recordedAt}, after ${new Date(today).toISOString().slice(0, 10)}`,
      );
  });
  return problems;
}

export class SupportEvidenceError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Support evidence refused: ${problems.slice(0, 5).join(" | ")}`);
    this.name = "SupportEvidenceError";
  }
}

/** Parses entries, refusing the whole list if any entry is malformed or dated in the future. */
export function parseSupportEvidence(
  entries: readonly unknown[],
  options: { asOf: number },
): SupportEvidence[] {
  const problems = supportEvidenceProblems(entries, options);
  if (problems.length > 0) throw new SupportEvidenceError(problems);
  return entries.map((entry) => supportEvidenceSchema.parse(entry));
}

export type SupportLabelResult = {
  label: SupportLabel;
  /** The entry that earned the label; absent for `unverified`. */
  basis?: SupportEvidence;
  /** Entries that would have counted but have outlived their window. */
  expired: SupportEvidence[];
  /** Live entries not admissible because the configuration they need is absent. */
  unconfigured: SupportEvidence[];
  /** Entries dated after the evaluation day; never evidence. */
  future: SupportEvidence[];
};

/**
 * The label one adapter's entries earn as of `asOf`. Entries for other
 * adapters are ignored, so a caller may pass a whole ledger.
 */
export function computeSupportLabel(
  adapterId: string,
  entries: readonly SupportEvidence[],
  options: { asOf: number; configured: boolean },
): SupportLabelResult {
  const today = dayOf(options.asOf);
  const result: SupportLabelResult = {
    label: "unverified",
    expired: [],
    unconfigured: [],
    future: [],
  };
  for (const entry of entries) {
    if (entry.adapterId !== adapterId) continue;
    const recorded = dayValue(entry.recordedAt);
    if (recorded > today) {
      result.future.push(entry);
      continue;
    }
    const earns = labelForTarget(entry.target);
    const rule = supportLabelRules[earns];
    if (rule.needsConfiguration && !options.configured) {
      result.unconfigured.push(entry);
      continue;
    }
    if ((today - recorded) / DAY_MS > rule.freshForDays) {
      result.expired.push(entry);
      continue;
    }
    // Strongest wins; among equals the most recent is the basis shown.
    if (
      labelRank(earns) > labelRank(result.label) ||
      (earns === result.label &&
        result.basis &&
        entry.recordedAt > result.basis.recordedAt)
    ) {
      result.label = earns;
      result.basis = entry;
    }
  }
  return result;
}
