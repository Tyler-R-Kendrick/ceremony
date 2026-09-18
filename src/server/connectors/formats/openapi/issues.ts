import {
  compatibilityIssueSchema,
  type CompatibilityIssue,
} from "../../../../core/connectors/index.js";

/*
 * Diagnostics are the product of an import as much as the definition is. Each
 * one carries a stable code, the category the charter recognizes, a JSON
 * pointer into the source, and a sentence written for a person. Nothing here
 * ever quotes a source value: names of parameters, schemes and media types are
 * bounded tokens, and anything else is located by its pointer, not echoed.
 */

export type IssueSeverity = CompatibilityIssue["severity"];
export type IssueCategory = CompatibilityIssue["category"];
export type IssueDimension = CompatibilityIssue["dimension"];
export type IssueDisposition = CompatibilityIssue["disposition"];
export type IssueImpact = CompatibilityIssue["executionImpact"];

export interface IssueInput {
  code: string;
  category: IssueCategory;
  pointer: string;
  dimension: IssueDimension;
  severity: IssueSeverity;
  message: string;
  disposition?: IssueDisposition;
  executionImpact?: IssueImpact;
  remediation?: string;
  normalizedPointer?: string;
}

const CONTROL = /\p{Cc}/gu;

/** Bounded, control-character-free text for a message, label or summary. */
export function safeText(value: unknown, max = 500): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** A short token (a name, a media type, a method) that may appear inside a message. */
export function token(value: unknown, max = 64): string {
  const text = safeText(value, max);
  return text.length ? text : "?";
}

/** Percent-decoding-free JSON pointer construction (RFC 6901 escaping). */
export function pointer(...segments: Array<string | number>): string {
  const built =
    "#" +
    segments
      .map(
        (segment) =>
          "/" +
          String(segment).replaceAll("~", "~0").replaceAll("/", "~1"),
      )
      .join("");
  const cleaned = built.replace(CONTROL, "");
  return cleaned.length > 1024 ? cleaned.slice(0, 1024) : cleaned;
}

export function makeIssue(input: IssueInput): CompatibilityIssue {
  const disposition =
    input.disposition ??
    (input.severity === "blocking"
      ? "unsupported"
      : input.severity === "warning"
        ? "adapted"
        : "exact");
  const executionImpact =
    input.executionImpact ??
    (input.severity === "blocking" ? "blocks-operation" : "none");
  return compatibilityIssueSchema.parse({
    code: input.code,
    category: input.category,
    sourcePointer: input.pointer.replace(CONTROL, "").slice(0, 1024),
    ...(input.normalizedPointer
      ? { normalizedPointer: input.normalizedPointer.slice(0, 1024) }
      : {}),
    dimension: input.dimension,
    disposition,
    severity: input.severity,
    executionImpact,
    message: safeText(input.message, 500) || "Unsupported construct.",
    ...(input.remediation
      ? { remediation: safeText(input.remediation, 500) }
      : {}),
  });
}

/** Collects issues with a ceiling so a hostile document cannot produce unbounded output. */
export class IssueCollector {
  readonly issues: CompatibilityIssue[] = [];
  private overflow = false;
  constructor(private readonly limit = 4096) {}
  add(input: IssueInput): CompatibilityIssue | undefined {
    if (this.issues.length >= this.limit) {
      if (!this.overflow) {
        this.overflow = true;
        this.issues[this.limit - 1] = makeIssue({
          code: "structure.issue-limit",
          category: "structure",
          pointer: "#",
          dimension: "import",
          severity: "warning",
          message:
            "The document produced more diagnostics than the import can report; later diagnostics were dropped.",
        });
      }
      return undefined;
    }
    const issue = makeIssue(input);
    this.issues.push(issue);
    return issue;
  }
  blocking(): boolean {
    return this.issues.some((issue) => issue.severity === "blocking");
  }
}

export const hasBlocking = (issues: readonly CompatibilityIssue[]) =>
  issues.some((issue) => issue.severity === "blocking");
