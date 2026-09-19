import {
  compatibilityIssueSchema,
  nativeIdentifierSchema,
  type CompatibilityIssue,
} from "../../../../core/connectors/index.js";

/*
 * Shared by the Zapier, n8n and Workato readers. A diagnostic locates a
 * construct by pointer and names it by code; it never quotes the construct,
 * because the constructs these readers meet are code, and code from an
 * untrusted source is neither displayed nor logged verbatim. The readers are
 * deliberately decoupled from the other format directories so that a change
 * in one importer family cannot break another.
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
const BIDI = /[‪-‮⁦-⁩]/gu;

/** Bounded, control-character-free text for a message, label or summary. */
export function safeText(value: unknown, max = 500): string {
  if (typeof value !== "string") return "";
  const cleaned = value
    .replace(CONTROL, " ")
    .replace(BIDI, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= max) return cleaned;
  return `${Array.from(cleaned)
    .slice(0, Math.max(0, max - 1))
    .join("")}…`;
}

/** A short token (a key, a type name, a method) that may appear inside a message. */
export function token(value: unknown, max = 64): string {
  const text = safeText(value, max);
  return text.length ? text : "?";
}

/** A JSON pointer with RFC 6901 escaping, prefixed with `#`. */
export function pointer(...segments: Array<string | number>): string {
  const built =
    "#" +
    segments
      .map(
        (segment) =>
          "/" + String(segment).replaceAll("~", "~0").replaceAll("/", "~1"),
      )
      .join("");
  const cleaned = built.replace(CONTROL, "").replace(BIDI, "");
  return cleaned.length > 1024 ? cleaned.slice(0, 1024) : cleaned;
}

export type SourceLocation = { file?: string; line: number; column: number };

/** A pointer suffixed with the file:line:column the construct was read from. */
export function locate(path: string, location?: SourceLocation): string {
  if (!location) return path.slice(0, 1024);
  const file = location.file ? safeText(location.file, 120) : "source";
  return `${path} (${file}:${location.line}:${location.column})`.slice(0, 1024);
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
            "The source produced more diagnostics than the import can report; later diagnostics were dropped.",
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
  /** True when an issue blocks the whole definition rather than one construct. */
  blocksDefinition(): boolean {
    return this.issues.some(
      (issue) => issue.executionImpact === "blocks-definition",
    );
  }
}

/** A native identifier as the upstream spelled it, or undefined when it cannot be carried. */
export function nativeId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = nativeIdentifierSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Directory grouping key derived from a display name; undefined when nothing safe remains. */
export function serviceKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/[^\x20-\x7e]/g, "")
    .toLowerCase()
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+/g, "-")
    .slice(0, 120)
    .replace(/[^a-z0-9]+$/, "");
  return /^[a-z0-9][a-z0-9._-]*$/.test(key) ? key : undefined;
}

/**
 * Bounded, control-free copy of inert data for native extensions. Functions,
 * symbols and class instances never survive; keys that alias prototype
 * machinery are dropped; depth and size are capped so a source cannot smuggle
 * an unbounded blob into a definition.
 */
export function inertCopy(
  value: unknown,
  budget: { depth: number; nodes: number; string: number } = {
    depth: 12,
    nodes: 2048,
    string: 4096,
  },
): unknown {
  let nodes = 0;
  const walk = (item: unknown, depth: number): unknown => {
    if (++nodes > budget.nodes || depth > budget.depth) return undefined;
    if (item === null) return null;
    if (typeof item === "string") return safeText(item, budget.string);
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    if (typeof item === "boolean") return item;
    if (Array.isArray(item)) {
      const out: unknown[] = [];
      for (const entry of item) {
        if (nodes > budget.nodes) break;
        const copied = walk(entry, depth + 1);
        out.push(copied === undefined ? null : copied);
      }
      return out;
    }
    if (typeof item === "object") {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null)
        return undefined;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(item as object)) {
        if (["__proto__", "prototype", "constructor"].includes(key)) continue;
        if (nodes > budget.nodes) break;
        const copied = walk((item as Record<string, unknown>)[key], depth + 1);
        if (copied !== undefined) out[safeText(key, 120) || "_"] = copied;
      }
      return out;
    }
    return undefined;
  };
  return walk(value, 1);
}
