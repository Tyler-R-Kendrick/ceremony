import type { CompatibilityIssue } from "../../../../core/connectors/contracts.js";
import { expressionSince } from "./expressions.js";
import { valueExpressions } from "./graph.js";
import { arazzoIssue, hasBlocking, jsonPointer, type ArazzoIssueCode } from "./issues.js";
import { ARAZZO_MEDIA_TYPE, versionIncludes, type ArazzoVersion } from "./limits.js";
import {
  isReusable,
  isSelectorObject,
  type PreservedArazzoDocument,
  type PreservedBase,
  type PreservedComponents,
  type PreservedCriterion,
  type PreservedFailureAction,
  type PreservedParameter,
  type PreservedRequestBody,
  type PreservedReusable,
  type PreservedStep,
  type PreservedSuccessAction,
  type PreservedWorkflow,
} from "./model.js";
import type { ArazzoReadResult } from "./read.js";

/*
 * Version-aware export from the preserved model. Fields are emitted in the
 * specification's order for the requested version. A construct the requested
 * version does not define is a blocking loss and no document is produced,
 * because a 1.0.1 document that quietly lost its step dependencies or
 * selectors would execute differently from what its author wrote. Fields the
 * specification never defined are dropped and reported.
 */

export interface ArazzoExport {
  document?: Record<string, unknown>;
  losses: CompatibilityIssue[];
  mediaType: typeof ARAZZO_MEDIA_TYPE;
}

const v11 = "1.1.0" as const;
const ONE_ONE_EXPRESSION_TYPES = new Set(["jsonpointer"]);
const ONE_ONE_EXPRESSION_VERSIONS = new Set(["rfc9535", "xpath-31", "rfc6901"]);

class Exporter {
  readonly losses: CompatibilityIssue[] = [];
  constructor(readonly target: ArazzoVersion) {}
  loss(code: ArazzoIssueCode, pointer: string) {
    this.losses.push(arazzoIssue(code, pointer, { dimension: "export" }));
  }
  includes(since: ArazzoVersion) {
    return versionIncludes(this.target, since);
  }
  /** Emits a 1.1.0-only field, or records the downgrade loss. */
  gate<T>(value: T | undefined, pointer: string): T | undefined {
    if (value === undefined) return undefined;
    if (this.includes(v11)) return value;
    this.loss("arazzo.export.version-downgrade-loss", pointer);
    return undefined;
  }
  tail(node: PreservedBase): Record<string, unknown> {
    for (const key of Object.keys(node.unknown))
      this.loss("arazzo.export.unknown-field-dropped", `${node.pointer}${jsonPointer(key)}`);
    return { ...node.extensions };
  }
  value(value: unknown, pointer: string): unknown {
    if (!this.includes(v11)) {
      for (const site of valueExpressions(value, pointer, "parameter"))
        if (site.expression && !this.includes(expressionSince(site.expression)))
          this.loss("arazzo.export.version-downgrade-loss", site.pointer);
      if (containsSelector(value)) this.loss("arazzo.export.version-downgrade-loss", pointer);
    }
    return structuredClone(value);
  }
  expressionType(type: string | PreservedCriterion["type"], pointer: string): unknown {
    if (type === undefined) return undefined;
    if (typeof type === "string") return type;
    if (
      !this.includes(v11) &&
      (ONE_ONE_EXPRESSION_TYPES.has(type.type) ||
        ONE_ONE_EXPRESSION_VERSIONS.has(type.version))
    )
      this.loss("arazzo.export.version-downgrade-loss", pointer);
    return { type: type.type, version: type.version, ...this.tail(type) };
  }
  parameter(item: PreservedParameter | PreservedReusable): Record<string, unknown> {
    if (isReusable(item)) return this.reusable(item);
    if (item.in === "querystring" && !this.includes(v11))
      this.loss("arazzo.export.version-downgrade-loss", `${item.pointer}/in`);
    return defined({
      name: item.name,
      in: item.in,
      value: this.value(item.value, `${item.pointer}/value`),
      ...this.tail(item),
    });
  }
  reusable(item: PreservedReusable): Record<string, unknown> {
    return defined({ reference: item.reference, value: item.value });
  }
  criterion(item: PreservedCriterion): Record<string, unknown> {
    return defined({
      context: item.context,
      condition: item.condition,
      type: this.expressionType(item.type, `${item.pointer}/type`),
      ...this.tail(item),
    });
  }
  action(
    item: PreservedSuccessAction | PreservedFailureAction | PreservedReusable,
  ): Record<string, unknown> {
    if (isReusable(item)) return this.reusable(item);
    const failure = item as PreservedFailureAction;
    return defined({
      name: item.name,
      type: item.type,
      workflowId: item.workflowId,
      stepId: item.stepId,
      retryAfter: failure.retryAfter,
      retryLimit: failure.retryLimit,
      criteria: item.criteria?.map((criterion) => this.criterion(criterion)),
      parameters: this.gate(item.parameters, `${item.pointer}/parameters`)?.map(
        (parameter) => this.parameter(parameter),
      ),
      ...this.tail(item),
    });
  }
  requestBody(body: PreservedRequestBody): Record<string, unknown> {
    return defined({
      contentType: body.contentType,
      payload:
        body.payload === undefined
          ? undefined
          : this.value(body.payload, `${body.pointer}/payload`),
      replacements: body.replacements?.map((replacement) =>
        defined({
          target: replacement.target,
          targetSelectorType: this.gate(
            replacement.targetSelectorType,
            `${replacement.pointer}/targetSelectorType`,
          ),
          value: this.value(replacement.value, `${replacement.pointer}/value`),
          ...this.tail(replacement),
        }),
      ),
      ...this.tail(body),
    });
  }
  outputs(
    outputs: Record<string, unknown> | undefined,
    pointer: string,
  ): Record<string, unknown> | undefined {
    if (!outputs) return undefined;
    return Object.fromEntries(
      Object.entries(outputs).map(([name, value]) => [
        name,
        this.value(value, `${pointer}${jsonPointer(name)}`),
      ]),
    );
  }
  step(step: PreservedStep): Record<string, unknown> {
    return defined({
      description: step.description,
      stepId: step.stepId,
      operationId: step.operationId,
      operationPath: step.operationPath,
      channelPath: this.gate(step.channelPath, `${step.pointer}/channelPath`),
      workflowId: step.workflowId,
      parameters: step.parameters?.map((parameter) => this.parameter(parameter)),
      requestBody: step.requestBody ? this.requestBody(step.requestBody) : undefined,
      successCriteria: step.successCriteria?.map((criterion) => this.criterion(criterion)),
      onSuccess: step.onSuccess?.map((action) => this.action(action)),
      onFailure: step.onFailure?.map((action) => this.action(action)),
      outputs: this.outputs(step.outputs, `${step.pointer}/outputs`),
      timeout: this.gate(step.timeout, `${step.pointer}/timeout`),
      correlationId: this.gate(step.correlationId, `${step.pointer}/correlationId`),
      action: this.gate(step.action, `${step.pointer}/action`),
      dependsOn: this.gate(step.dependsOn, `${step.pointer}/dependsOn`),
      ...this.tail(step),
    });
  }
  workflow(workflow: PreservedWorkflow): Record<string, unknown> {
    return defined({
      workflowId: workflow.workflowId,
      summary: workflow.summary,
      description: workflow.description,
      inputs:
        workflow.inputs === undefined ? undefined : structuredClone(workflow.inputs),
      dependsOn: workflow.dependsOn,
      steps: workflow.steps.map((step) => this.step(step)),
      successActions: workflow.successActions?.map((action) => this.action(action)),
      failureActions: workflow.failureActions?.map((action) => this.action(action)),
      outputs: this.outputs(workflow.outputs, `${workflow.pointer}/outputs`),
      parameters: workflow.parameters?.map((parameter) => this.parameter(parameter)),
      ...this.tail(workflow),
    });
  }
  components(components: PreservedComponents): Record<string, unknown> {
    const map = <T>(
      entries: Record<string, T> | undefined,
      emit: (item: T) => unknown,
    ) =>
      entries === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(entries).map(([name, item]) => [name, emit(item)]),
          );
    return defined({
      inputs: map(components.inputs, (schema) => structuredClone(schema)),
      parameters: map(components.parameters, (parameter) => this.parameter(parameter)),
      successActions: map(components.successActions, (action) => this.action(action)),
      failureActions: map(components.failureActions, (action) => this.action(action)),
      ...this.tail(components),
    });
  }
  document(document: PreservedArazzoDocument): Record<string, unknown> {
    if (document.arazzo !== this.target)
      this.loss("arazzo.export.version-changed", "/arazzo");
    for (const source of document.sourceDescriptions)
      if (source.type === "asyncapi" && !this.includes(v11))
        this.loss("arazzo.export.version-downgrade-loss", `${source.pointer}/type`);
    return defined({
      arazzo: this.target,
      $self: this.gate(document.self, "/$self"),
      info: defined({
        title: document.info.title,
        summary: document.info.summary,
        description: document.info.description,
        version: document.info.version,
        ...this.tail(document.info),
      }),
      sourceDescriptions: document.sourceDescriptions.map((source) =>
        defined({
          name: source.name,
          url: source.url,
          type: source.type,
          ...this.tail(source),
        }),
      ),
      workflows: document.workflows.map((workflow) => this.workflow(workflow)),
      components: document.components ? this.components(document.components) : undefined,
      ...this.tail(document),
    });
  }
}

function defined(object: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  );
}

function containsSelector(value: unknown): boolean {
  if (isSelectorObject(value)) return true;
  if (Array.isArray(value)) return value.some(containsSelector);
  if (value && typeof value === "object")
    return Object.values(value as Record<string, unknown>).some(containsSelector);
  return false;
}

/**
 * Exports a read description as the requested Arazzo version. Same-version
 * and 1.0.1 to 1.1.0 exports are lossless apart from undefined fields; a
 * 1.1.0 document with 1.1.0-only constructs cannot become 1.0.1 and yields
 * blocking losses instead of a document.
 */
export function exportArazzo(
  read: ArazzoReadResult,
  options: { version: ArazzoVersion },
): ArazzoExport {
  const exporter = new Exporter(options.version);
  if (!read.document) {
    exporter.losses.push(
      ...read.issues.filter((issue) => issue.severity === "blocking"),
    );
    return { losses: exporter.losses, mediaType: ARAZZO_MEDIA_TYPE };
  }
  const document = exporter.document(read.document);
  if (hasBlocking(exporter.losses))
    return { losses: exporter.losses, mediaType: ARAZZO_MEDIA_TYPE };
  return { document, losses: exporter.losses, mediaType: ARAZZO_MEDIA_TYPE };
}
