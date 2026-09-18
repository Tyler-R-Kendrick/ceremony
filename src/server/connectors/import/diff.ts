import {
  DEFINITION_LIMITS,
  type CompatibilityIssue,
  type SourceRecord,
} from "../../../core/connectors/index.js";
import {
  appendPointer,
  isPlainObject,
  makeIssue,
  pushIssue,
} from "./common.js";
import { DEFAULT_PARSE_LIMITS } from "./limits.js";

/*
 * Refresh is a comparison, never a replacement. Given the previous capture
 * and a new candidate, the diff lists every structural change by pointer and
 * classifies the ones that alter security semantics: where requests go,
 * which authority issues tokens, which schemes and scopes apply, where a
 * parameter travels, which operations exist, and how data is classified.
 * Messages are fixed text per code; values never appear, because a changed
 * server URL or scope name is exactly the kind of value that can carry a
 * secret. The decision derived from a diff says what an approval built on
 * the previous revision can still rely on; it does not activate anything.
 */

export type SourceSnapshot = { record: SourceRecord; value: unknown };
export type DiffChangeKind = "added" | "removed" | "changed";
export type DiffChange = {
  pointer: string;
  kind: DiffChangeKind;
  code: string;
  category: "security" | "structure" | "version";
};
export type SourceDiff = {
  identical: boolean;
  previous: { sourceRef: string; digest: string };
  next: { sourceRef: string; digest: string };
  changes: DiffChange[];
  issues: CompatibilityIssue[];
  /** The security-category subset of `issues`. */
  security: CompatibilityIssue[];
  truncated: boolean;
};

const httpMethods = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
  "query",
]);

type Rule = { pattern: string; code: string; kinds?: DiffChangeKind[] };

// Ordered: the first matching rule wins, so specific OAuth and scope rules
// precede the general security-scheme rule.
const securityRules: readonly Rule[] = [
  {
    pattern: "/components/securitySchemes/*/flows/*/authorizationUrl",
    code: "security.oauth-endpoint-changed",
  },
  {
    pattern: "/components/securitySchemes/*/flows/*/tokenUrl",
    code: "security.oauth-endpoint-changed",
  },
  {
    pattern: "/components/securitySchemes/*/flows/*/refreshUrl",
    code: "security.oauth-endpoint-changed",
  },
  {
    pattern: "/components/securitySchemes/*/openIdConnectUrl",
    code: "security.oauth-endpoint-changed",
  },
  {
    pattern: "/securityDefinitions/*/authorizationUrl",
    code: "security.oauth-endpoint-changed",
  },
  {
    pattern: "/securityDefinitions/*/tokenUrl",
    code: "security.oauth-endpoint-changed",
  },
  {
    pattern: "/components/securitySchemes/*/flows/*/scopes/**",
    code: "security.scope-changed",
  },
  {
    pattern: "/components/securitySchemes/*/flows/*/scopes",
    code: "security.scope-changed",
  },
  {
    pattern: "/securityDefinitions/*/scopes/**",
    code: "security.scope-changed",
  },
  { pattern: "/securityDefinitions/*/scopes", code: "security.scope-changed" },
  {
    pattern: "/components/securitySchemes/**",
    code: "security.scheme-changed",
  },
  { pattern: "/components/securitySchemes", code: "security.scheme-changed" },
  { pattern: "/securityDefinitions/**", code: "security.scheme-changed" },
  { pattern: "/securityDefinitions", code: "security.scheme-changed" },
  { pattern: "/security/**", code: "security.requirement-changed" },
  { pattern: "/security", code: "security.requirement-changed" },
  { pattern: "/paths/*/*/security/**", code: "security.requirement-changed" },
  { pattern: "/paths/*/*/security", code: "security.requirement-changed" },
  {
    pattern: "/operations/*/security/**",
    code: "security.requirement-changed",
  },
  { pattern: "/operations/*/security", code: "security.requirement-changed" },
  { pattern: "/servers/*/security/**", code: "security.requirement-changed" },
  { pattern: "/servers/*/security", code: "security.requirement-changed" },
  { pattern: "/channels/*/servers/**", code: "security.server-changed" },
  { pattern: "/channels/*/address", code: "security.server-changed" },
  { pattern: "/servers/**", code: "security.server-changed" },
  { pattern: "/servers", code: "security.server-changed" },
  { pattern: "/host", code: "security.server-changed" },
  { pattern: "/basePath", code: "security.server-changed" },
  { pattern: "/schemes/**", code: "security.server-changed" },
  { pattern: "/schemes", code: "security.server-changed" },
  { pattern: "/paths/*/servers/**", code: "security.server-changed" },
  { pattern: "/paths/*/servers", code: "security.server-changed" },
  { pattern: "/paths/*/*/servers/**", code: "security.server-changed" },
  { pattern: "/paths/*/*/servers", code: "security.server-changed" },
  { pattern: "/sourceDescriptions/*/url", code: "security.server-changed" },
  { pattern: "/remotes/**", code: "security.server-changed" },
  { pattern: "/remotes", code: "security.server-changed" },
  { pattern: "/packages/**", code: "security.package-changed" },
  { pattern: "/packages", code: "security.package-changed" },
  {
    pattern: "/paths/*/*/parameters/*/in",
    code: "security.parameter-location-changed",
  },
  {
    pattern: "/paths/*/parameters/*/in",
    code: "security.parameter-location-changed",
  },
  {
    pattern: "/components/parameters/*/in",
    code: "security.parameter-location-changed",
  },
  { pattern: "/parameters/*/in", code: "security.parameter-location-changed" },
  {
    pattern: "/paths/*",
    code: "security.path-changed",
    kinds: ["added", "removed"],
  },
  {
    pattern: "/paths",
    code: "security.path-changed",
    kinds: ["added", "removed"],
  },
];
const classificationKeys = new Set([
  "x-ceremony-classification",
  "x-ceremony-data-classification",
  "x-data-classification",
]);
const versionKeys = new Set([
  "openapi",
  "swagger",
  "asyncapi",
  "arazzo",
  "overlay",
]);

const securityMessages: Readonly<Record<string, string>> = Object.freeze({
  "security.server-changed":
    "A declared server, host or destination changed between revisions.",
  "security.oauth-endpoint-changed":
    "An OAuth issuer, authorization, token or refresh endpoint changed between revisions.",
  "security.scope-changed": "Declared OAuth scopes changed between revisions.",
  "security.scheme-changed":
    "A security scheme was added, removed or changed between revisions.",
  "security.requirement-changed":
    "Security requirements applying to operations changed between revisions.",
  "security.parameter-location-changed":
    "A parameter moved to a different location (for example query to header) between revisions.",
  "security.path-changed": "A path was added or removed between revisions.",
  "security.operation-changed":
    "An operation was added or removed between revisions.",
  "security.classification-changed":
    "A data classification hint changed between revisions.",
  "security.package-changed":
    "A declared runtime package or its arguments changed between revisions.",
});

function matches(pattern: string, segments: readonly string[]): boolean {
  const parts = pattern.split("/").slice(1);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (part === "**") return segments.length > index;
    if (index >= segments.length) return false;
    if (part !== "*" && part !== segments[index]) return false;
  }
  return parts.length === segments.length;
}

function classify(
  segments: readonly string[],
  kind: DiffChangeKind,
  before: unknown,
  after: unknown,
): { code: string; category: DiffChange["category"] } {
  const last = segments[segments.length - 1];
  if (
    segments.length === 3 &&
    segments[0] === "paths" &&
    httpMethods.has(segments[2]!) &&
    kind !== "changed"
  )
    return { code: "security.operation-changed", category: "security" };
  if (last !== undefined && classificationKeys.has(last))
    return { code: "security.classification-changed", category: "security" };
  if (last === "format" && (before === "password" || after === "password"))
    return { code: "security.classification-changed", category: "security" };
  for (const rule of securityRules)
    if (
      (!rule.kinds || rule.kinds.includes(kind)) &&
      matches(rule.pattern, segments)
    )
      return { code: rule.code, category: "security" };
  if (
    (segments.length === 1 && versionKeys.has(segments[0]!)) ||
    (segments.length === 2 &&
      segments[0] === "info" &&
      segments[1] === "version")
  )
    return { code: "version.declared-version-changed", category: "version" };
  return { code: `structure.${kind}`, category: "structure" };
}

class DiffTruncated extends Error {}

/** Compares two captures; see the module comment. */
export function diffSources(
  previous: SourceSnapshot,
  next: SourceSnapshot,
): SourceDiff {
  const changes: DiffChange[] = [];
  const issues: CompatibilityIssue[] = [];
  const security: CompatibilityIssue[] = [];
  const seen = new Set<string>();
  const maxChanges = DEFINITION_LIMITS.issues;
  let truncated = false;
  const record = (
    segments: readonly string[],
    kind: DiffChangeKind,
    before: unknown,
    after: unknown,
  ) => {
    if (changes.length >= maxChanges) throw new DiffTruncated();
    const pointer = segments.reduce<string>(
      (acc, segment) => appendPointer(acc, segment),
      "",
    );
    const { code, category } = classify(segments, kind, before, after);
    changes.push({ pointer, kind, code, category });
    const issue =
      category === "security"
        ? makeIssue({
            code,
            category: "security",
            sourcePointer: pointer,
            disposition: "requires-configuration",
            severity: "blocking",
            executionImpact: "blocks-operation",
            message: securityMessages[code] ?? "Security semantics changed.",
            remediation:
              "Review the candidate revision and re-approve affected bindings before use.",
          })
        : makeIssue({
            code,
            category,
            sourcePointer: pointer,
            disposition: "exact",
            severity: "info",
            executionImpact: "none",
            message:
              category === "version"
                ? "The declared document or API version changed between revisions."
                : `A value was ${kind} at this location between revisions.`,
          });
    pushIssue(issues, seen, issue);
    if (category === "security") security.push(issue);
  };
  const walk = (
    before: unknown,
    after: unknown,
    segments: string[],
    depth: number,
  ) => {
    if (depth > DEFAULT_PARSE_LIMITS.maxDepth) {
      record(segments, "changed", undefined, undefined);
      return;
    }
    if (isPlainObject(before) && isPlainObject(after)) {
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      for (const key of keys) {
        const path = [...segments, key];
        if (!Object.hasOwn(before, key))
          record(path, "added", undefined, after[key]);
        else if (!Object.hasOwn(after, key))
          record(path, "removed", before[key], undefined);
        else walk(before[key], after[key], path, depth + 1);
      }
      return;
    }
    if (Array.isArray(before) && Array.isArray(after)) {
      const length = Math.max(before.length, after.length);
      for (let index = 0; index < length; index++) {
        const path = [...segments, String(index)];
        if (index >= before.length)
          record(path, "added", undefined, after[index]);
        else if (index >= after.length)
          record(path, "removed", before[index], undefined);
        else walk(before[index], after[index], path, depth + 1);
      }
      return;
    }
    if (!Object.is(before, after)) record(segments, "changed", before, after);
  };
  try {
    walk(previous.value, next.value, [], 0);
  } catch (error) {
    if (!(error instanceof DiffTruncated)) throw error;
    truncated = true;
    pushIssue(
      issues,
      seen,
      makeIssue({
        code: "structure.diff-truncated",
        category: "structure",
        sourcePointer: "",
        disposition: "rejected",
        severity: "warning",
        executionImpact: "none",
        message:
          "The comparison stopped at the issue ceiling; further changes exist and require a full review.",
      }),
    );
  }
  return {
    identical: changes.length === 0 && !truncated,
    previous: {
      sourceRef: previous.record.sourceRef,
      digest: previous.record.digest.value,
    },
    next: {
      sourceRef: next.record.sourceRef,
      digest: next.record.digest.value,
    },
    changes,
    issues,
    security,
    truncated,
  };
}

export type RefreshDecision = {
  outcome: "no-change" | "candidate-revision" | "security-review-required";
  /** What an approval that was bound to the previous revision can no longer rely on. */
  invalidates: { approvals: boolean; evidence: boolean; bindings: boolean };
  securityChanges: number;
  otherChanges: number;
  codes: string[];
};

/**
 * What a refresh means for approvals built on the previous revision. Any
 * security-category change invalidates approvals, evidence and bindings for
 * the candidate; other changes make the candidate a new revision that still
 * needs review, while existing approvals stay pinned to the old one. A
 * truncated diff is treated as security-relevant, because it could not be
 * shown not to be.
 */
export function refreshDecision(diff: SourceDiff): RefreshDecision {
  const securityChanges = diff.security.length;
  const otherChanges = diff.changes.length - securityChanges;
  const codes = [...new Set(diff.changes.map((change) => change.code))];
  if (diff.identical)
    return {
      outcome: "no-change",
      invalidates: { approvals: false, evidence: false, bindings: false },
      securityChanges: 0,
      otherChanges: 0,
      codes,
    };
  if (securityChanges > 0 || diff.truncated)
    return {
      outcome: "security-review-required",
      invalidates: { approvals: true, evidence: true, bindings: true },
      securityChanges,
      otherChanges,
      codes,
    };
  return {
    outcome: "candidate-revision",
    invalidates: { approvals: false, evidence: false, bindings: false },
    securityChanges,
    otherChanges,
    codes,
  };
}

export type PinnedSelection = {
  outcome: "pinned" | "pinned-with-candidate" | "pin-missing";
  /** Always the pinned record, or absent; never a newer one. */
  selected?: SourceRecord;
  /** A newer capture a reviewer may promote; nothing selects it automatically. */
  candidate?: SourceRecord;
};

/**
 * Chooses the record an active binding uses. The pin wins by exact reference
 * and byte digest; a catalog's "latest", a newer capture time or a missing
 * pin never substitutes another record. When the pinned record is gone the
 * caller blocks the binding; it does not fall forward.
 */
export function resolvePinnedSource(
  pin: { sourceRef: string; digest: string },
  available: ReadonlyArray<{ record: SourceRecord; latest?: boolean }>,
): PinnedSelection {
  const selected = available.find(
    (entry) =>
      entry.record.sourceRef === pin.sourceRef &&
      entry.record.digest.value === pin.digest,
  )?.record;
  const candidate = available
    .filter((entry) => entry.record.digest.value !== pin.digest)
    .sort(
      (a, b) =>
        Number(Boolean(b.latest)) - Number(Boolean(a.latest)) ||
        b.record.capturedAt.localeCompare(a.record.capturedAt),
    )[0]?.record;
  if (!selected)
    return { outcome: "pin-missing", ...(candidate ? { candidate } : {}) };
  return {
    outcome: candidate ? "pinned-with-candidate" : "pinned",
    selected,
    ...(candidate ? { candidate } : {}),
  };
}
