import {
  compatibilityIssueSchema,
  type CompatibilityIssue,
} from "../../../../core/connectors/index.js";

/*
 * Compatibility issues for the provider catalog importers. Messages are fixed
 * prose written here; a provider file's own text never reaches a reviewer
 * through an issue, only the pointer that says where to look.
 */

type Kind = "info" | "adapted" | "warning" | "unsupported" | "rejected";

const shapes: Record<
  Kind,
  Pick<CompatibilityIssue, "severity" | "disposition" | "executionImpact">
> = {
  info: { severity: "info", disposition: "exact", executionImpact: "none" },
  adapted: {
    severity: "info",
    disposition: "adapted",
    executionImpact: "none",
  },
  warning: {
    severity: "warning",
    disposition: "adapted",
    executionImpact: "none",
  },
  unsupported: {
    severity: "blocking",
    disposition: "unsupported",
    executionImpact: "blocks-authorization",
  },
  rejected: {
    severity: "blocking",
    disposition: "rejected",
    executionImpact: "blocks-authorization",
  },
};

export function catalogIssue(input: {
  kind: Kind;
  code: string;
  pointer: string;
  message: string;
  category?: CompatibilityIssue["category"];
  dimension?: CompatibilityIssue["dimension"];
  executionImpact?: CompatibilityIssue["executionImpact"];
  remediation?: string;
}): CompatibilityIssue {
  const shape = shapes[input.kind];
  return compatibilityIssueSchema.parse({
    code: input.code,
    category: input.category ?? "structure",
    sourcePointer: input.pointer.slice(0, 1024),
    dimension: input.dimension ?? "import",
    ...shape,
    ...(input.executionImpact && shape.severity !== "info"
      ? { executionImpact: input.executionImpact }
      : {}),
    message: input.message,
    ...(input.remediation ? { remediation: input.remediation } : {}),
  });
}

/** JSON pointer escaping (RFC 6901) for a provider key or field name. */
export function pointer(...parts: readonly (string | number)[]): string {
  return parts
    .map(
      (part) =>
        `/${String(part)
          .replace(/~/g, "~0")
          .replace(/\//g, "~1")
          .replace(/\p{Cc}/gu, "")}`,
    )
    .join("");
}
