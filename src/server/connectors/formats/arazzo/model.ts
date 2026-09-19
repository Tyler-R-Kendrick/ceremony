import type { ArazzoVersion } from "./limits.js";

/*
 * The preserved shape of an Arazzo description after a bounded read. Every
 * object keeps its `x-` extensions and any field the specification does not
 * define under `unknown`, so a reviewer sees what was written and an export
 * can say exactly what it drops. JSON Schemas, payloads and literal values are
 * kept as inert data: nothing in this model is executable.
 */

export type Extensions = Record<string, unknown>;

export interface PreservedBase {
  /** JSON pointer of this object in the source document; diagnostics cite it. */
  pointer: string;
  extensions: Extensions;
  /** Fields outside the specification (or outside the declared version), preserved and never interpreted. */
  unknown: Extensions;
}

export interface PreservedInfo extends PreservedBase {
  title: string;
  version: string;
  summary?: string;
  description?: string;
}

export interface PreservedSourceDescription extends PreservedBase {
  name: string;
  url: string;
  type?: string;
}

export interface PreservedParameter extends PreservedBase {
  name: string;
  in?: string;
  value: unknown;
}

/** A `$components` reference; the specification ignores any other property here. */
export interface PreservedReusable {
  reference: string;
  value?: unknown;
}

export interface PreservedExpressionType extends PreservedBase {
  type: string;
  version: string;
}

export interface PreservedCriterion extends PreservedBase {
  context?: string;
  condition: string;
  type?: string | PreservedExpressionType;
}

export interface PreservedSuccessAction extends PreservedBase {
  name: string;
  type: string;
  workflowId?: string;
  stepId?: string;
  criteria?: PreservedCriterion[];
  parameters?: Array<PreservedParameter | PreservedReusable>;
}

export interface PreservedFailureAction extends PreservedSuccessAction {
  retryAfter?: number;
  retryLimit?: number;
}

export interface PreservedPayloadReplacement extends PreservedBase {
  target: string;
  value: unknown;
  targetSelectorType?: unknown;
}

export interface PreservedRequestBody extends PreservedBase {
  contentType?: string;
  payload?: unknown;
  replacements?: PreservedPayloadReplacement[];
}

export interface PreservedStep extends PreservedBase {
  stepId: string;
  description?: string;
  operationId?: string;
  operationPath?: string;
  channelPath?: string;
  workflowId?: string;
  parameters?: Array<PreservedParameter | PreservedReusable>;
  requestBody?: PreservedRequestBody;
  successCriteria?: PreservedCriterion[];
  onSuccess?: Array<PreservedSuccessAction | PreservedReusable>;
  onFailure?: Array<PreservedFailureAction | PreservedReusable>;
  outputs?: Record<string, unknown>;
  timeout?: number;
  correlationId?: string;
  action?: string;
  dependsOn?: string[];
}

export interface PreservedWorkflow extends PreservedBase {
  workflowId: string;
  summary?: string;
  description?: string;
  /** JSON Schema 2020-12, preserved inertly and never compiled. */
  inputs?: unknown;
  dependsOn?: string[];
  steps: PreservedStep[];
  successActions?: Array<PreservedSuccessAction | PreservedReusable>;
  failureActions?: Array<PreservedFailureAction | PreservedReusable>;
  outputs?: Record<string, unknown>;
  parameters?: Array<PreservedParameter | PreservedReusable>;
}

export interface PreservedComponents extends PreservedBase {
  inputs?: Record<string, unknown>;
  parameters?: Record<string, PreservedParameter>;
  successActions?: Record<string, PreservedSuccessAction>;
  failureActions?: Record<string, PreservedFailureAction>;
}

export interface PreservedArazzoDocument extends PreservedBase {
  arazzo: ArazzoVersion;
  self?: string;
  info: PreservedInfo;
  sourceDescriptions: PreservedSourceDescription[];
  workflows: PreservedWorkflow[];
  components?: PreservedComponents;
}

export function isReusable(
  value: PreservedParameter | PreservedReusable | PreservedSuccessAction,
): value is PreservedReusable {
  return "reference" in value;
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A 1.1.0 Selector Object: structured extraction that this runtime never evaluates. */
export function isSelectorObject(
  value: unknown,
): value is { context: unknown; selector: unknown; type: unknown } {
  return (
    isPlainObject(value) &&
    "context" in value &&
    "selector" in value &&
    "type" in value
  );
}
