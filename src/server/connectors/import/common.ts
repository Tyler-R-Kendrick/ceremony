import {
  compatibilityIssueSchema,
  type CompatibilityIssue,
} from "../../../core/connectors/index.js";
import { ConnectorError } from "../errors.js";

/** A plain data object: what the bounded parsers produce and the only object shape the importer walks. */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** RFC 6901 escaping for one pointer segment. */
export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function appendPointer(
  pointer: string,
  segment: string | number,
): string {
  return `${pointer}/${typeof segment === "number" ? segment : escapePointerSegment(segment)}`;
}

const POINTER_LIMIT = 1024;

/** A pointer safe for a diagnostic: printable and bounded; a very deep location is truncated, never dropped. */
export function boundedPointer(pointer: string): string {
  const printable = pointer.replace(/\p{Cc}/gu, "");
  return printable.length > POINTER_LIMIT
    ? `${printable.slice(0, POINTER_LIMIT - 3)}...`
    : printable;
}

export type IssueInput = Omit<
  CompatibilityIssue,
  "sourcePointer" | "dimension"
> & {
  sourcePointer: string;
  dimension?: CompatibilityIssue["dimension"] | undefined;
};

/**
 * Builds a validated compatibility issue. Messages are fixed text chosen by
 * code; the pointer is the only document-derived field and it names keys, not
 * values. A caller that passes an invalid combination gets a thrown error
 * rather than an issue that quietly fails schema validation downstream.
 */
export function makeIssue(input: IssueInput): CompatibilityIssue {
  const result = compatibilityIssueSchema.safeParse({
    ...input,
    dimension: input.dimension ?? "import",
    sourcePointer: boundedPointer(input.sourcePointer),
  });
  if (!result.success)
    throw new ConnectorError("invalid-request", {
      detail: "import.issue-invalid",
    });
  return result.data;
}

/** Appends an issue unless the same code was already reported at the same pointer. */
export function pushIssue(
  issues: CompatibilityIssue[],
  seen: Set<string>,
  issue: CompatibilityIssue,
): void {
  const key = `${issue.code}\u0000${issue.sourcePointer}`;
  if (seen.has(key)) return;
  seen.add(key);
  issues.push(issue);
}
