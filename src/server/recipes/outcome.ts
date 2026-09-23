import type { RecipeOutcome } from "../../core/recipe-contracts.js";
import {
  ConditionSyntaxError,
  evaluateCriteria,
  parseCondition,
  type ClassifiedValue,
  type EvaluationContext,
  type ParsedCondition,
} from "../connectors/formats/arazzo/evaluator.js";
import {
  parseRuntimeExpression,
  type RuntimeExpression,
} from "../connectors/formats/arazzo/expressions.js";
import type { OperationResponseFacts } from "./registry.js";

/*
 * Success criteria and a bounded retry on one recipe invocation, checked when
 * a recipe is validated and enforced by the command service when the step
 * runs. The conditions are Arazzo `simple` conditions and go through the same
 * bounded evaluator the Arazzo importer uses (no eval, no document-built
 * regular expression). What a condition may read is closed:
 *
 * - a value named in the outcome's `values`, bound like any other recipe
 *   binding and required to be public, so a criterion cannot become an oracle
 *   over a secret or personal value;
 * - the public transport facts the operation's trusted handler reported.
 *
 * Anything else, including `$response.body`, is a validation diagnostic.
 */

export type OutcomeDiagnostic =
  "invalid-criterion" | "unsupported-criterion" | "unbound-criterion-value";

/** The `values` key a condition reference reads, when it reads a bound value. */
export function outcomeReferenceKey(
  expression: RuntimeExpression,
): string | undefined {
  if (expression.kind === "inputs") return `$inputs.${expression.name}`;
  if (expression.kind === "steps")
    return `$steps.${expression.stepId}.outputs.${expression.name}`;
  return undefined;
}

/** A reference to a public transport fact the handler may report. */
function isTransportReference(expression: RuntimeExpression): boolean {
  return (
    expression.kind === "statusCode" ||
    expression.kind === "url" ||
    expression.kind === "method" ||
    (expression.kind === "response" &&
      expression.source === "header" &&
      expression.name !== undefined)
  );
}

function conditions(outcome: RecipeOutcome): string[] {
  return [...outcome.successCriteria, ...(outcome.retry?.criteria ?? [])];
}

/** Diagnostics for the conditions of one outcome; empty when every one is enforceable. */
export function checkOutcomeConditions(
  outcome: RecipeOutcome,
): OutcomeDiagnostic[] {
  const found = new Set<OutcomeDiagnostic>();
  for (const text of conditions(outcome)) {
    let parsed: ParsedCondition;
    try {
      parsed = parseCondition(text);
    } catch (error) {
      if (!(error instanceof ConditionSyntaxError)) throw error;
      found.add("invalid-criterion");
      continue;
    }
    for (const { expression } of parsed.references) {
      if (isTransportReference(expression)) continue;
      const key = outcomeReferenceKey(expression);
      if (!key) found.add("unsupported-criterion");
      else if (!Object.hasOwn(outcome.values, key))
        found.add("unbound-criterion-value");
    }
  }
  return [...found];
}

/** Build the evaluator's context from resolved public values and reported facts. */
function evaluationContext(
  values: ReadonlyMap<string, unknown>,
  response: OperationResponseFacts | undefined,
): EvaluationContext {
  const inputs: Array<[string, ClassifiedValue]> = [];
  const steps = new Map<string, Array<[string, ClassifiedValue]>>();
  for (const [key, value] of values) {
    const expression = parseRuntimeExpression(key);
    // Every value is public by validation; the evaluator still tracks it.
    const classified: ClassifiedValue = { value, classification: "public" };
    if (expression?.kind === "inputs")
      inputs.push([expression.name, classified]);
    else if (expression?.kind === "steps")
      steps.set(expression.stepId, [
        ...(steps.get(expression.stepId) ?? []),
        [expression.name, classified],
      ]);
  }
  // Object.fromEntries defines own data properties, so no name can reach a prototype.
  return {
    inputs: Object.fromEntries(inputs),
    steps: Object.fromEntries(
      [...steps].map(([stepId, outputs]) => [
        stepId,
        { outputs: Object.fromEntries(outputs) },
      ]),
    ),
    ...(typeof response?.statusCode === "number"
      ? { statusCode: response.statusCode }
      : {}),
    ...(typeof response?.url === "string" ? { url: response.url } : {}),
    ...(typeof response?.method === "string"
      ? { method: response.method }
      : {}),
    ...(response?.headers
      ? {
          responseHeaders: Object.fromEntries(
            Object.entries(response.headers).filter(
              ([, value]) => typeof value === "string",
            ),
          ),
        }
      : {}),
  };
}

/**
 * Whether an attempt met its success criteria and, when it did not, whether
 * its retry criteria allow another attempt. Unresolved references fail
 * closed: a criterion over a fact the handler did not report is not met.
 */
export function evaluateOutcome(
  outcome: RecipeOutcome,
  values: ReadonlyMap<string, unknown>,
  response: OperationResponseFacts | undefined,
): { satisfied: boolean; retryable: boolean } {
  const context = evaluationContext(values, response);
  return {
    satisfied: evaluateCriteria(outcome.successCriteria, context).satisfied,
    retryable: Boolean(
      outcome.retry &&
      evaluateCriteria(outcome.retry.criteria, context).satisfied,
    ),
  };
}
