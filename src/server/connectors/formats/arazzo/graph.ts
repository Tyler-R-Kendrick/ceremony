import {
  embeddedExpressions,
  parseRuntimeExpression,
  type RuntimeExpression,
} from "./expressions.js";
import { parseCondition, ConditionSyntaxError } from "./evaluator.js";
import { jsonPointer } from "./issues.js";
import {
  isPlainObject,
  isReusable,
  isSelectorObject,
  type PreservedComponents,
  type PreservedCriterion,
  type PreservedFailureAction,
  type PreservedParameter,
  type PreservedReusable,
  type PreservedStep,
  type PreservedSuccessAction,
  type PreservedWorkflow,
} from "./model.js";

/*
 * Static analysis shared by the reader and the compiler: which runtime
 * expressions a step uses and where, which steps a step depends on, and one
 * deterministic execution order that satisfies every declared and implicit
 * dependency. Nothing here evaluates an expression.
 */

export type ExpressionSite = {
  pointer: string;
  text: string;
  expression?: RuntimeExpression;
  /** Found inside a string template `{$...}` rather than as a whole value. */
  embedded: boolean;
  /** Where the expression sits, for profile decisions. */
  role:
    | "parameter"
    | "requestBody"
    | "replacement"
    | "criterion"
    | "criterion-context"
    | "action-criterion"
    | "action-criterion-context"
    | "output"
    | "selector-context";
  invalid: boolean;
};

const CONDITION_ROLE = {
  step: "criterion",
  action: "action-criterion",
} as const;

function site(
  pointer: string,
  text: string,
  role: ExpressionSite["role"],
  embedded: boolean,
): ExpressionSite {
  const expression = parseRuntimeExpression(text);
  return {
    pointer,
    text,
    ...(expression ? { expression } : {}),
    embedded,
    role,
    invalid: !expression,
  };
}

/** Expressions inside a literal value: whole-string expressions, templates and selector contexts. */
export function valueExpressions(
  value: unknown,
  pointer: string,
  role: ExpressionSite["role"],
  out: ExpressionSite[] = [],
): ExpressionSite[] {
  if (typeof value === "string") {
    if (value.startsWith("$")) out.push(site(pointer, value, role, false));
    else {
      const embedded = embeddedExpressions(value);
      for (const item of embedded.expressions)
        out.push(site(pointer, item.text, role, true));
      if (embedded.invalid)
        out.push({
          pointer,
          text: "",
          embedded: true,
          role,
          invalid: true,
        });
    }
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      valueExpressions(item, `${pointer}/${index}`, role, out),
    );
    return out;
  }
  if (isSelectorObject(value)) {
    if (typeof value.context === "string")
      out.push(
        site(`${pointer}/context`, value.context, "selector-context", false),
      );
    return out;
  }
  if (isPlainObject(value))
    for (const [key, item] of Object.entries(value))
      valueExpressions(item, `${pointer}${jsonPointer(key)}`, role, out);
  return out;
}

function criterionExpressions(
  criterion: PreservedCriterion,
  pointer: string,
  kind: keyof typeof CONDITION_ROLE,
  out: ExpressionSite[],
) {
  const role = CONDITION_ROLE[kind];
  if (criterion.context !== undefined)
    out.push(
      site(
        `${pointer}/context`,
        criterion.context,
        `${role}-context` as ExpressionSite["role"],
        false,
      ),
    );
  const type =
    typeof criterion.type === "string"
      ? criterion.type
      : criterion.type === undefined
        ? "simple"
        : criterion.type.type;
  if (type === "simple") {
    try {
      for (const reference of parseCondition(criterion.condition).references)
        out.push({
          pointer: `${pointer}/condition`,
          text: reference.text,
          expression: reference.expression,
          embedded: false,
          role,
          invalid: false,
        });
    } catch (error) {
      if (!(error instanceof ConditionSyntaxError)) throw error;
      out.push({
        pointer: `${pointer}/condition`,
        text: "",
        embedded: false,
        role,
        invalid: true,
      });
    }
    return;
  }
  const embedded = embeddedExpressions(criterion.condition);
  for (const item of embedded.expressions)
    out.push(site(`${pointer}/condition`, item.text, role, true));
  if (embedded.invalid)
    out.push({
      pointer: `${pointer}/condition`,
      text: "",
      embedded: true,
      role,
      invalid: true,
    });
}

/*
 * A component reference names its target with an identifier the document
 * chose, and an identifier may be `__proto__` or `constructor` as easily as
 * `retry`. Plain indexing would then answer with a member of
 * `Object.prototype`, and a dangling reference would resolve to something that
 * is not a component at all: the reader would lose its blocking diagnostic and
 * the compiler would carry an inherited function forward as a parameter. Every
 * component lookup therefore goes through an own-property check. The map
 * cannot hold such a key — `measureJsonValue` refuses a reserved key outright
 * — so the only question that matters is whether the *reference* names one.
 */
function ownComponent<T>(
  components: Readonly<Record<string, T>> | undefined,
  name: string,
): T | undefined {
  return components !== undefined && Object.hasOwn(components, name)
    ? components[name]
    : undefined;
}

/** Resolves a reusable parameter against components; undefined when the reference is dangling. */
export function resolveParameter(
  item: PreservedParameter | PreservedReusable,
  components: PreservedComponents | undefined,
): PreservedParameter | undefined {
  if (!isReusable(item)) return item;
  const expression = parseRuntimeExpression(item.reference);
  if (
    !expression ||
    expression.kind !== "components" ||
    expression.component !== "parameters"
  )
    return undefined;
  const parameter = ownComponent(components?.parameters, expression.name);
  if (!parameter) return undefined;
  return item.value === undefined
    ? parameter
    : { ...parameter, value: item.value };
}

export function resolveSuccessAction(
  item: PreservedSuccessAction | PreservedReusable,
  components: PreservedComponents | undefined,
): PreservedSuccessAction | undefined {
  if (!isReusable(item)) return item;
  const expression = parseRuntimeExpression(item.reference);
  if (
    !expression ||
    expression.kind !== "components" ||
    expression.component !== "successActions"
  )
    return undefined;
  return ownComponent(components?.successActions, expression.name);
}

export function resolveFailureAction(
  item: PreservedFailureAction | PreservedReusable,
  components: PreservedComponents | undefined,
): PreservedFailureAction | undefined {
  if (!isReusable(item)) return item;
  const expression = parseRuntimeExpression(item.reference);
  if (
    !expression ||
    expression.kind !== "components" ||
    expression.component !== "failureActions"
  )
    return undefined;
  return ownComponent(components?.failureActions, expression.name);
}

/** Every expression a step uses, with the pointer of the site that uses it. */
export function stepExpressions(
  step: PreservedStep,
  pointer: string,
  components: PreservedComponents | undefined,
): ExpressionSite[] {
  const out: ExpressionSite[] = [];
  step.parameters?.forEach((item, index) => {
    const parameter = resolveParameter(item, components);
    if (parameter)
      valueExpressions(
        parameter.value,
        `${pointer}/parameters/${index}/value`,
        "parameter",
        out,
      );
  });
  if (step.requestBody) {
    if (step.requestBody.payload !== undefined)
      valueExpressions(
        step.requestBody.payload,
        `${pointer}/requestBody/payload`,
        "requestBody",
        out,
      );
    step.requestBody.replacements?.forEach((replacement, index) =>
      valueExpressions(
        replacement.value,
        `${pointer}/requestBody/replacements/${index}/value`,
        "replacement",
        out,
      ),
    );
  }
  step.successCriteria?.forEach((criterion, index) =>
    criterionExpressions(
      criterion,
      `${pointer}/successCriteria/${index}`,
      "step",
      out,
    ),
  );
  step.onSuccess?.forEach((item, index) => {
    const action = resolveSuccessAction(item, components);
    action?.criteria?.forEach((criterion, criterionIndex) =>
      criterionExpressions(
        criterion,
        `${pointer}/onSuccess/${index}/criteria/${criterionIndex}`,
        "action",
        out,
      ),
    );
  });
  step.onFailure?.forEach((item, index) => {
    const action = resolveFailureAction(item, components);
    action?.criteria?.forEach((criterion, criterionIndex) =>
      criterionExpressions(
        criterion,
        `${pointer}/onFailure/${index}/criteria/${criterionIndex}`,
        "action",
        out,
      ),
    );
  });
  for (const [name, value] of Object.entries(step.outputs ?? {}))
    valueExpressions(
      value,
      `${pointer}/outputs${jsonPointer(name)}`,
      "output",
      out,
    );
  return out;
}

export type StepGraph = {
  /** No step declares dependsOn: Arazzo's sequential execution model applies. */
  sequential: boolean;
  explicit: Map<string, string[]>;
  implicit: Map<string, string[]>;
  /** Steps in one deterministic order satisfying every dependency; undefined when cyclic. */
  order: string[] | undefined;
  cyclic: string[];
};

/**
 * Builds the step dependency graph from declared `dependsOn` and implicit
 * `$steps.<id>.outputs` references, then orders it with document order as the
 * tie-breaker so two hosts compile the same plan from the same document.
 */
export function stepGraph(
  workflow: PreservedWorkflow,
  expressions: ReadonlyMap<string, readonly ExpressionSite[]>,
): StepGraph {
  const ids = workflow.steps.map((step) => step.stepId);
  const known = new Set(ids);
  const explicit = new Map<string, string[]>();
  const implicit = new Map<string, string[]>();
  let sequential = true;
  for (const step of workflow.steps) {
    if (step.dependsOn !== undefined) sequential = false;
    explicit.set(
      step.stepId,
      [...new Set(step.dependsOn ?? [])].filter(
        (id) => known.has(id) && id !== step.stepId,
      ),
    );
    const referenced = new Set<string>();
    for (const item of expressions.get(step.stepId) ?? [])
      if (
        item.expression?.kind === "steps" &&
        known.has(item.expression.stepId) &&
        item.expression.stepId !== step.stepId
      )
        referenced.add(item.expression.stepId);
    implicit.set(step.stepId, [...referenced]);
  }
  const placed = new Set<string>();
  const order: string[] = [];
  const dependencies = (id: string) => [
    ...(explicit.get(id) ?? []),
    ...(implicit.get(id) ?? []),
  ];
  for (;;) {
    const next = ids.find(
      (id) =>
        !placed.has(id) &&
        dependencies(id).every((dependency) => placed.has(dependency)),
    );
    if (!next) break;
    placed.add(next);
    order.push(next);
  }
  const cyclic = ids.filter((id) => !placed.has(id));
  return {
    sequential,
    explicit,
    implicit,
    order: cyclic.length ? undefined : order,
    cyclic,
  };
}

/** Directed cycle members of a small graph, in first-seen order. */
export function cycleMembers(
  nodes: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): string[] {
  const state = new Map<string, "active" | "done">();
  const members = new Set<string>();
  const visit = (id: string, path: string[]) => {
    const current = state.get(id);
    if (current === "done") return;
    if (current === "active") {
      for (const member of path.slice(path.indexOf(id))) members.add(member);
      return;
    }
    state.set(id, "active");
    for (const next of edges.get(id) ?? []) visit(next, [...path, id]);
    state.set(id, "done");
  };
  for (const id of nodes) visit(id, []);
  return nodes.filter((id) => members.has(id));
}
