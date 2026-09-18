import { createHash } from "node:crypto";
import {
  canonicalConnectorJson,
  type CompatibilityIssue,
} from "../../../../core/connectors/index.js";
import { IssueCollector, safeText, token } from "../openapi/issues.js";
import { entriesOf, isRecord } from "../openapi/refs.js";
import {
  SUPPORTED_SELECTOR_SYNTAX,
  SelectionBudgetExceeded,
  parseJsonPath,
  selectNodes,
  type Match,
} from "./jsonpath.js";

/*
 * Overlay application, versioned on the `overlay` field.
 *
 * 1.0.0: `update` merges into object targets and appends one entry to array
 *        targets; targets must be objects or arrays; `remove` deletes the
 *        target from its container. Primitive array items cannot be replaced
 *        or removed individually.
 * 1.1.0: adds primitive targets (`update` replaces them, `remove` deletes
 *        them), array-to-array concatenation, and `copy`.
 *
 * Both: actions apply in order, each to the result of the previous one; a
 * target selecting zero nodes succeeds without changing the document. An
 * overlay is a structural transformation. It never approves an endpoint, never
 * lowers a classification and never widens a grant, so the result is a new
 * candidate document whose security-relevant changes must be diffed and
 * re-reviewed before any binding uses it.
 */

export const OVERLAY_VERSIONS = ["1.0.0", "1.1.0"] as const;
export type OverlayVersion = (typeof OVERLAY_VERSIONS)[number];
export const APPLIER_VERSION = "1.0.0";

export interface ApplyLimits {
  /** Nodes a single action's selection may visit. */
  maxSelectionNodes: number;
  /** Actions in one overlay. */
  maxActions: number;
  /** Depth of a merge. */
  maxMergeDepth: number;
  /** Nodes one `update` value may carry. */
  maxUpdateNodes: number;
}

export const DEFAULT_APPLY_LIMITS: ApplyLimits = Object.freeze({
  maxSelectionNodes: 100_000,
  maxActions: 512,
  maxMergeDepth: 48,
  maxUpdateNodes: 50_000,
});

export interface ApplyOptions {
  /** The source document's identity, for `extends` pinning. */
  source?: { digest?: string; identity?: string };
  limits?: Partial<ApplyLimits>;
  /** Refuse to apply when `extends` names something other than the pinned source. */
  requireExtendsMatch?: boolean;
}

export interface AdaptationStep {
  step: string;
  version: string;
  inputDigest: string;
  outputDigest: string;
}

export interface ActionRecord {
  index: number;
  target: string;
  kind: "update" | "remove" | "copy";
  matched: number;
  applied: number;
  description?: string;
}

export interface ApplyResult {
  /** The transformed document; on failure, the input document unchanged. */
  document: unknown;
  applied: boolean;
  version?: OverlayVersion;
  issues: CompatibilityIssue[];
  actions: ActionRecord[];
  /** Provenance: digests before and after, with the applier version. */
  adaptation?: AdaptationStep;
  /** How `extends` related to the pinned source. */
  extends?: {
    declared?: string;
    match: "digest" | "identity" | "absent" | "mismatch" | "unpinned";
  };
}

const digestOf = (value: unknown): string =>
  createHash("sha256").update(canonicalConnectorJson(value)).digest("hex");

function cloneJson(value: unknown, limit: number): unknown {
  const text = JSON.stringify(value);
  if (text === undefined) return undefined;
  if (text.length > limit * 64) throw new SelectionBudgetExceeded();
  return JSON.parse(text);
}

type MergeOutcome = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * The recursive merge both versions define: a property only in the target is
 * left alone, a property only in the update is inserted, and a property in
 * both merges by type — primitives replace, arrays concatenate, objects
 * recurse. Any other combination is an error, not a silent overwrite.
 */
function mergeValue(
  target: unknown,
  update: unknown,
  depth: number,
  limits: ApplyLimits,
): MergeOutcome {
  if (depth > limits.maxMergeDepth) return { ok: false, reason: "merge-too-deep" };
  if (isRecord(target) && isRecord(update)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of entriesOf(target)) result[key] = value;
    for (const [key, value] of entriesOf(update)) {
      if (!Object.hasOwn(result, key)) {
        result[key] = value;
        continue;
      }
      const merged = mergeValue(result[key], value, depth + 1, limits);
      if (!merged.ok) return merged;
      result[key] = merged.value;
    }
    return { ok: true, value: result };
  }
  if (Array.isArray(target) && Array.isArray(update))
    return { ok: true, value: [...target, ...update] };
  const targetPrimitive = !isRecord(target) && !Array.isArray(target);
  const updatePrimitive = !isRecord(update) && !Array.isArray(update);
  if (targetPrimitive && updatePrimitive) return { ok: true, value: update };
  return { ok: false, reason: "incompatible-types" };
}

function setAt(match: Match, value: unknown): boolean {
  if (match.parent === undefined || match.key === undefined) return false;
  if (Array.isArray(match.parent) && typeof match.key === "number") {
    match.parent[match.key] = value;
    return true;
  }
  if (isRecord(match.parent) && typeof match.key === "string") {
    if (["__proto__", "prototype", "constructor"].includes(match.key)) return false;
    match.parent[match.key] = value;
    return true;
  }
  return false;
}

function removeAt(match: Match): boolean {
  if (match.parent === undefined || match.key === undefined) return false;
  if (Array.isArray(match.parent) && typeof match.key === "number") {
    match.parent.splice(match.key, 1);
    return true;
  }
  if (isRecord(match.parent) && typeof match.key === "string") {
    if (["__proto__", "prototype", "constructor"].includes(match.key)) return false;
    delete match.parent[match.key];
    return true;
  }
  return false;
}

function readVersion(
  overlay: Record<string, unknown>,
  issues: IssueCollector,
): OverlayVersion | undefined {
  const value = overlay.overlay;
  if (typeof value !== "string") {
    issues.add({
      code: "version.missing",
      category: "version",
      pointer: "#",
      dimension: "import",
      severity: "blocking",
      disposition: "rejected",
      executionImpact: "blocks-definition",
      message:
        "The overlay declares no `overlay` version string; the version is not guessed and nothing is applied.",
    });
    return undefined;
  }
  // The patch component addresses errata, not the feature set: 1.0.x reads as
  // 1.0.0 and 1.1.x as 1.1.0, exactly as the specification instructs tooling.
  const match = /^1\.([01])\.(\d{1,4})$/.exec(value);
  if (!match) {
    issues.add({
      code: "version.unsupported",
      category: "version",
      pointer: "#/overlay",
      dimension: "import",
      severity: "blocking",
      disposition: "unsupported",
      executionImpact: "blocks-definition",
      message: `The Overlay version "${token(value, 24)}" is not supported; 1.0.x and 1.1.x are applied.`,
    });
    return undefined;
  }
  return match[1] === "0" ? "1.0.0" : "1.1.0";
}

/**
 * Applies an overlay document to a parsed OpenAPI (or any JSON) document.
 * The input document is never mutated: the result is a fresh structure.
 */
export function applyOverlay(
  document: unknown,
  overlay: unknown,
  options: ApplyOptions = {},
): ApplyResult {
  const limits: ApplyLimits = { ...DEFAULT_APPLY_LIMITS, ...(options.limits ?? {}) };
  const issues = new IssueCollector(512);
  const actions: ActionRecord[] = [];
  const fail = (): ApplyResult => ({
    document,
    applied: false,
    issues: issues.issues,
    actions,
  });
  if (!isRecord(overlay)) {
    issues.add({
      code: "structure.not-an-object",
      category: "structure",
      pointer: "#",
      dimension: "import",
      severity: "blocking",
      disposition: "rejected",
      executionImpact: "blocks-definition",
      message: "The overlay is not a JSON object and was not applied.",
    });
    return fail();
  }
  const version = readVersion(overlay, issues);
  if (!version) return fail();

  // `extends` is provenance, and pinning it is how a reviewed overlay is kept
  // attached to the exact document it was reviewed against.
  const declared =
    typeof overlay.extends === "string" ? safeText(overlay.extends, 2048) : undefined;
  let extendsMatch: NonNullable<ApplyResult["extends"]>["match"];
  if (!options.source?.digest && !options.source?.identity)
    extendsMatch = "unpinned";
  else if (declared === undefined) extendsMatch = "absent";
  else if (options.source.digest && declared.includes(options.source.digest))
    extendsMatch = "digest";
  else if (options.source.identity && declared === options.source.identity)
    extendsMatch = "identity";
  else extendsMatch = "mismatch";
  const extendsInfo = {
    ...(declared === undefined ? {} : { declared }),
    match: extendsMatch,
  };
  if (extendsMatch === "mismatch") {
    issues.add({
      code: "structure.extends-mismatch",
      category: "structure",
      pointer: "#/extends",
      dimension: "import",
      severity: options.requireExtendsMatch ? "blocking" : "warning",
      disposition: options.requireExtendsMatch ? "rejected" : "adapted",
      ...(options.requireExtendsMatch ? { executionImpact: "blocks-definition" as const } : {}),
      message:
        "The overlay names a target document other than the pinned source; applying it would transform a document the overlay was not written for.",
    });
    if (options.requireExtendsMatch) return { ...fail(), extends: extendsInfo };
  } else if (extendsMatch === "absent")
    issues.add({
      code: "structure.extends-absent",
      category: "structure",
      pointer: "#",
      dimension: "import",
      severity: "info",
      disposition: "adapted",
      message:
        "The overlay names no target document; the caller's choice of source is the only thing binding them together.",
    });

  const rawActions = overlay.actions;
  if (!Array.isArray(rawActions) || rawActions.length === 0) {
    issues.add({
      code: "structure.actions-missing",
      category: "structure",
      pointer: "#/actions",
      dimension: "import",
      severity: "blocking",
      disposition: "rejected",
      executionImpact: "blocks-definition",
      message: "The overlay declares no actions; the array is required and must hold at least one action.",
    });
    return { ...fail(), extends: extendsInfo };
  }
  if (rawActions.length > limits.maxActions) {
    issues.add({
      code: "structure.action-limit",
      category: "structure",
      pointer: "#/actions",
      dimension: "import",
      severity: "blocking",
      disposition: "rejected",
      executionImpact: "blocks-definition",
      message: "The overlay declares more actions than the applier allows; nothing is applied.",
    });
    return { ...fail(), extends: extendsInfo };
  }

  const inputDigest = digestOf(document);
  let working: unknown;
  try {
    working = cloneJson(document, limits.maxUpdateNodes);
  } catch {
    issues.add({
      code: "structure.document-too-large",
      category: "structure",
      pointer: "#",
      dimension: "import",
      severity: "blocking",
      disposition: "rejected",
      executionImpact: "blocks-definition",
      message: "The target document exceeds the applier's size budget; nothing is applied.",
    });
    return { ...fail(), extends: extendsInfo };
  }
  if (working === undefined) {
    issues.add({
      code: "structure.document-not-json",
      category: "structure",
      pointer: "#",
      dimension: "import",
      severity: "blocking",
      disposition: "rejected",
      executionImpact: "blocks-definition",
      message: "The target document is not JSON-serializable and was not transformed.",
    });
    return { ...fail(), extends: extendsInfo };
  }

  for (const [index, raw] of rawActions.entries()) {
    const pointer = `#/actions/${index}`;
    if (!isRecord(raw)) {
      issues.add({
        code: "structure.invalid-action",
        category: "structure",
        pointer,
        dimension: "import",
        severity: "blocking",
        disposition: "rejected",
        executionImpact: "blocks-definition",
        message: "An action is not an object; the overlay is not applied.",
      });
      return { ...fail(), extends: extendsInfo };
    }
    const target = raw.target;
    if (typeof target !== "string") {
      issues.add({
        code: "structure.invalid-action",
        category: "structure",
        pointer: `${pointer}/target`,
        dimension: "import",
        severity: "blocking",
        disposition: "rejected",
        executionImpact: "blocks-definition",
        message: "An action declares no target expression; the overlay is not applied.",
      });
      return { ...fail(), extends: extendsInfo };
    }
    const parsed = parseJsonPath(target);
    if (!parsed.ok) {
      issues.add({
        code: "structure.unsupported-selector",
        category: "structure",
        pointer: `${pointer}/target`,
        dimension: "import",
        severity: "blocking",
        disposition: "unsupported",
        executionImpact: "blocks-definition",
        message: `The target expression uses "${token(parsed.reason, 48)}", which this applier does not implement; it is refused rather than approximated.`,
        remediation: `Supported selectors: ${SUPPORTED_SELECTOR_SYNTAX}.`,
      });
      return { ...fail(), extends: extendsInfo };
    }
    const remove = raw.remove === true;
    const hasUpdate = Object.hasOwn(raw, "update") && !remove;
    const hasCopy = Object.hasOwn(raw, "copy") && !remove && !hasUpdate;
    if (hasCopy && version === "1.0.0") {
      issues.add({
        code: "structure.copy-unsupported",
        category: "structure",
        pointer: `${pointer}/copy`,
        dimension: "import",
        severity: "blocking",
        disposition: "unsupported",
        executionImpact: "blocks-definition",
        message:
          "The `copy` action was introduced in Overlay 1.1.0; a document declaring 1.0.x cannot use it, and the overlay is not applied.",
      });
      return { ...fail(), extends: extendsInfo };
    }
    if (!remove && !hasUpdate && !hasCopy) {
      issues.add({
        code: "structure.action-without-modifier",
        category: "structure",
        pointer,
        dimension: "import",
        severity: "warning",
        disposition: "adapted",
        message: "An action declares neither update, copy nor remove; it changes nothing.",
      });
      actions.push({
        index,
        target: safeText(target, 500),
        kind: "update",
        matched: 0,
        applied: 0,
      });
      continue;
    }

    let matches: Match[];
    try {
      matches = selectNodes(working, parsed.segments, {
        nodes: 0,
        limit: limits.maxSelectionNodes,
      });
    } catch {
      issues.add({
        code: "structure.selection-budget",
        category: "structure",
        pointer: `${pointer}/target`,
        dimension: "import",
        severity: "blocking",
        disposition: "rejected",
        executionImpact: "blocks-definition",
        message: "Evaluating the target expression exceeded the applier's node budget; nothing is applied.",
      });
      return { ...fail(), extends: extendsInfo };
    }

    const kind: ActionRecord["kind"] = remove ? "remove" : hasCopy ? "copy" : "update";
    const description = safeText(raw.description, 500);
    const record: ActionRecord = {
      index,
      target: safeText(target, 500),
      kind,
      matched: matches.length,
      applied: 0,
      ...(description ? { description } : {}),
    };
    if (matches.length === 0) {
      // Specified behaviour: zero matches succeeds and changes nothing.
      actions.push(record);
      continue;
    }

    if (remove) {
      // Removing by index shifts later indexes, so containers are edited from
      // the end and array removals are grouped per container.
      const ordered = [...matches].sort((a, b) => {
        const left = typeof a.key === "number" ? a.key : -1;
        const right = typeof b.key === "number" ? b.key : -1;
        return right - left;
      });
      for (const match of ordered) {
        if (match.parent === undefined) {
          issues.add({
            code: "structure.remove-root",
            category: "structure",
            pointer: `${pointer}/target`,
            dimension: "import",
            severity: "blocking",
            disposition: "rejected",
            executionImpact: "blocks-definition",
            message: "An action targets the root document for removal; the overlay is not applied.",
          });
          return { ...fail(), extends: extendsInfo };
        }
        const primitive = !isRecord(match.value) && !Array.isArray(match.value);
        if (primitive && version === "1.0.0" && Array.isArray(match.parent)) {
          issues.add({
            code: "structure.primitive-target-unsupported",
            category: "structure",
            pointer: `${pointer}/target`,
            dimension: "import",
            severity: "blocking",
            disposition: "unsupported",
            executionImpact: "blocks-definition",
            message:
              "Overlay 1.0.0 cannot remove a primitive item of an array individually; the overlay is not applied.",
          });
          return { ...fail(), extends: extendsInfo };
        }
        if (removeAt(match)) record.applied += 1;
      }
      actions.push(record);
      continue;
    }

    let updateValue: unknown;
    if (hasCopy) {
      const copyExpression = raw.copy;
      if (typeof copyExpression !== "string") {
        issues.add({
          code: "structure.invalid-action",
          category: "structure",
          pointer: `${pointer}/copy`,
          dimension: "import",
          severity: "blocking",
          disposition: "rejected",
          executionImpact: "blocks-definition",
          message: "A copy action's expression is not a string; the overlay is not applied.",
        });
        return { ...fail(), extends: extendsInfo };
      }
      const copyParsed = parseJsonPath(copyExpression);
      if (!copyParsed.ok) {
        issues.add({
          code: "structure.unsupported-selector",
          category: "structure",
          pointer: `${pointer}/copy`,
          dimension: "import",
          severity: "blocking",
          disposition: "unsupported",
          executionImpact: "blocks-definition",
          message: `The copy expression uses "${token(copyParsed.reason, 48)}", which this applier does not implement; it is refused rather than approximated.`,
          remediation: `Supported selectors: ${SUPPORTED_SELECTOR_SYNTAX}.`,
        });
        return { ...fail(), extends: extendsInfo };
      }
      let sources: Match[];
      try {
        sources = selectNodes(working, copyParsed.segments, {
          nodes: 0,
          limit: limits.maxSelectionNodes,
        });
      } catch {
        issues.add({
          code: "structure.selection-budget",
          category: "structure",
          pointer: `${pointer}/copy`,
          dimension: "import",
          severity: "blocking",
          disposition: "rejected",
          executionImpact: "blocks-definition",
          message: "Evaluating the copy expression exceeded the applier's node budget; nothing is applied.",
        });
        return { ...fail(), extends: extendsInfo };
      }
      if (sources.length !== 1) {
        issues.add({
          code: "structure.copy-not-single",
          category: "structure",
          pointer: `${pointer}/copy`,
          dimension: "import",
          severity: "blocking",
          disposition: "rejected",
          executionImpact: "blocks-definition",
          message:
            "A copy expression must select exactly one node; the overlay is not applied.",
        });
        return { ...fail(), extends: extendsInfo };
      }
      updateValue = cloneJson(sources[0]!.value, limits.maxUpdateNodes);
    } else updateValue = cloneJson(raw.update, limits.maxUpdateNodes);

    // Every selected node must be the same shape, so one action cannot mean
    // "merge here, append there" depending on what the document happened to hold.
    const shapes = new Set(
      matches.map((match) =>
        Array.isArray(match.value) ? "array" : isRecord(match.value) ? "object" : "primitive",
      ),
    );
    if (shapes.size > 1) {
      issues.add({
        code: "structure.mixed-target-shapes",
        category: "structure",
        pointer: `${pointer}/target`,
        dimension: "import",
        severity: "blocking",
        disposition: "rejected",
        executionImpact: "blocks-definition",
        message:
          "The target selects nodes of different shapes; an update must apply the same way to every selected node, so the overlay is not applied.",
      });
      return { ...fail(), extends: extendsInfo };
    }
    const shape = [...shapes][0]!;
    if (shape === "primitive" && version === "1.0.0") {
      issues.add({
        code: "structure.primitive-target-unsupported",
        category: "structure",
        pointer: `${pointer}/target`,
        dimension: "import",
        severity: "blocking",
        disposition: "unsupported",
        executionImpact: "blocks-definition",
        message:
          "Overlay 1.0.0 requires targets to be objects or arrays; select the containing object to change a primitive.",
      });
      return { ...fail(), extends: extendsInfo };
    }

    for (const match of matches) {
      if (shape === "array") {
        const array = match.value as unknown[];
        // 1.0.0 appends one entry; 1.1.0 concatenates an array and appends anything else.
        if (version === "1.1.0" && Array.isArray(updateValue)) array.push(...(updateValue as unknown[]));
        else if (version === "1.0.0" && Array.isArray(updateValue)) {
          issues.add({
            code: "structure.array-update-not-an-entry",
            category: "structure",
            pointer: `${pointer}/update`,
            dimension: "import",
            severity: "blocking",
            disposition: "rejected",
            executionImpact: "blocks-definition",
            message:
              "Overlay 1.0.0 appends a single entry to an array target; concatenating an array requires 1.1.0.",
          });
          return { ...fail(), extends: extendsInfo };
        } else array.push(cloneJson(updateValue, limits.maxUpdateNodes));
        record.applied += 1;
        continue;
      }
      if (shape === "primitive") {
        if (setAt(match, cloneJson(updateValue, limits.maxUpdateNodes))) record.applied += 1;
        continue;
      }
      const merged = mergeValue(
        match.value,
        cloneJson(updateValue, limits.maxUpdateNodes),
        0,
        limits,
      );
      if (!merged.ok) {
        issues.add({
          code:
            merged.reason === "merge-too-deep"
              ? "structure.merge-too-deep"
              : "structure.incompatible-update",
          category: "structure",
          pointer: `${pointer}/update`,
          dimension: "import",
          severity: "blocking",
          disposition: "rejected",
          executionImpact: "blocks-definition",
          message:
            merged.reason === "merge-too-deep"
              ? "The update nests deeper than the applier's merge limit; nothing is applied."
              : "The update names a property whose type is incompatible with the target's; the specification calls this an error, so nothing is applied.",
        });
        return { ...fail(), extends: extendsInfo };
      }
      if (match.parent === undefined) working = merged.value;
      else if (!setAt(match, merged.value)) continue;
      record.applied += 1;
    }
    actions.push(record);
  }

  const outputDigest = digestOf(working);
  return {
    document: working,
    applied: true,
    version,
    issues: issues.issues,
    actions,
    adaptation: {
      step: `overlay-${version}`,
      version: APPLIER_VERSION,
      inputDigest,
      outputDigest,
    },
    extends: extendsInfo,
  };
}
