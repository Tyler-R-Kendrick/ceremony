import type { z } from "zod";
import { connectorProjectSchema } from "../../../../core/connector-authoring.js";
import type { CompatibilityIssue } from "../../../../core/connectors/contracts.js";
import { analyzeWorkflow, issuesInScope } from "./compile.js";
import { arazzoIssue, hasBlocking, jsonPointer, type ArazzoIssueCode } from "./issues.js";
import type { PreservedBase } from "./model.js";
import { readArazzo, type ArazzoReadResult, type ReadArazzoOptions } from "./read.js";

/*
 * Import review for the studio. Version 1 projects edit a deliberately
 * constrained Arazzo 1.0.1 document: one OpenAPI source named "provider",
 * lowercase identifiers, operationId steps and nothing else. A general
 * description is reviewed against that shape field by field; every construct
 * the studio has no field for is a loss with a pointer, and the document is
 * offered for editing only when no loss is blocking, so saving from the
 * studio can never silently drop parameters, criteria or control flow.
 */

/** Exactly the workflow-document shape a v1 project stores, minus the project-level file name. */
export const studioWorkflowDocumentSchema =
  connectorProjectSchema.shape.workflows.element.omit({ document: true });
export type StudioWorkflowDocument = z.infer<typeof studioWorkflowDocumentSchema>;

export interface ArazzoStudioReview {
  editable: boolean;
  document?: StudioWorkflowDocument;
  losses: CompatibilityIssue[];
}

export interface ArazzoWorkflowReview {
  workflowId: string;
  /** Within the executable profile before any catalog binding; binding is checked at compile time. */
  supported: boolean;
  issues: CompatibilityIssue[];
}

export interface ArazzoReview {
  read: ArazzoReadResult;
  studio: ArazzoStudioReview;
  executable: ArazzoWorkflowReview[];
}

const studioIdentifier = /^[a-z0-9-]{1,64}$/;
const studioOperation = /^[A-Za-z][A-Za-z0-9._/-]{0,119}$/;

/** Projects a read description onto the studio's v1 workflow document, reporting every loss. */
export function studioProjection(read: ArazzoReadResult): ArazzoStudioReview {
  const losses: CompatibilityIssue[] = [];
  const loss = (code: ArazzoIssueCode, pointer: string) =>
    losses.push(arazzoIssue(code, pointer));
  const document = read.document;
  if (!document) {
    losses.push(...read.issues.filter((issue) => issue.severity === "blocking"));
    if (!losses.length) loss("arazzo.review.studio-schema", "/");
    return { editable: false, losses };
  }
  const descriptive = (node: PreservedBase, extra: readonly string[] = []) => {
    for (const key of [...Object.keys(node.extensions), ...Object.keys(node.unknown), ...extra])
      loss("arazzo.review.studio-descriptive-loss", `${node.pointer}${jsonPointer(key)}`);
  };
  const shape = (pointer: string) => loss("arazzo.review.studio-shape", pointer);
  if (document.arazzo !== "1.0.1") loss("arazzo.review.studio-version", "/arazzo");
  if (document.self !== undefined) shape("/$self");
  if (document.components) shape("/components");
  descriptive(document);
  descriptive(document.info, [
    ...(document.info.summary !== undefined ? ["summary"] : []),
    ...(document.info.description !== undefined ? ["description"] : []),
  ]);
  if (document.info.version !== "1.0.0") shape("/info/version");
  if (!document.info.title || document.info.title.length > 100) shape("/info/title");
  if (document.sourceDescriptions.length !== 1) shape("/sourceDescriptions");
  for (const source of document.sourceDescriptions) {
    if (source.name !== "provider") shape(`${source.pointer}/name`);
    if (source.type !== "openapi") shape(`${source.pointer}/type`);
    descriptive(source);
  }
  if (document.workflows.length < 1 || document.workflows.length > 12)
    shape("/workflows");
  let totalSteps = 0;
  for (const workflow of document.workflows) {
    if (!studioIdentifier.test(workflow.workflowId))
      shape(`${workflow.pointer}/workflowId`);
    if (!workflow.summary || workflow.summary.length > 500)
      shape(`${workflow.pointer}/summary`);
    for (const key of [
      "inputs",
      "dependsOn",
      "successActions",
      "failureActions",
      "outputs",
      "parameters",
    ] as const)
      if (workflow[key] !== undefined) shape(`${workflow.pointer}/${key}`);
    descriptive(workflow, workflow.description !== undefined ? ["description"] : []);
    if (workflow.steps.length < 1 || workflow.steps.length > 32)
      shape(`${workflow.pointer}/steps`);
    totalSteps += workflow.steps.length;
    for (const step of workflow.steps) {
      if (!studioIdentifier.test(step.stepId)) shape(`${step.pointer}/stepId`);
      if (!step.description || step.description.length > 500)
        shape(`${step.pointer}/description`);
      if (step.operationId === undefined || !studioOperation.test(step.operationId))
        shape(`${step.pointer}/operationId`);
      for (const key of [
        "operationPath",
        "channelPath",
        "workflowId",
        "parameters",
        "requestBody",
        "successCriteria",
        "onSuccess",
        "onFailure",
        "outputs",
        "timeout",
        "correlationId",
        "action",
        "dependsOn",
      ] as const)
        if (step[key] !== undefined) shape(`${step.pointer}/${key}`);
      descriptive(step);
    }
  }
  if (totalSteps > 32) shape("/workflows");
  if (hasBlocking(losses)) return { editable: false, losses };
  const candidate = studioWorkflowDocumentSchema.safeParse({
    arazzo: "1.0.1",
    info: { title: document.info.title, version: document.info.version },
    sourceDescriptions: document.sourceDescriptions.map((source) => ({
      name: source.name,
      url: source.url,
      type: source.type,
    })),
    workflows: document.workflows.map((workflow) => ({
      workflowId: workflow.workflowId,
      summary: workflow.summary,
      steps: workflow.steps.map((step) => ({
        stepId: step.stepId,
        description: step.description,
        operationId: step.operationId,
      })),
    })),
  });
  if (!candidate.success) {
    loss("arazzo.review.studio-schema", "/");
    return { editable: false, losses };
  }
  return { editable: true, document: candidate.data, losses };
}

/** Executability of each workflow under the profile, independent of any host catalog. */
export function executabilityReview(read: ArazzoReadResult): ArazzoWorkflowReview[] {
  return (read.document?.workflows ?? []).map((workflow) => {
    const analysis = analyzeWorkflow(read, workflow.workflowId);
    const issues = [
      ...issuesInScope(read, [workflow]),
      ...(analysis?.issues ?? []),
    ];
    return { workflowId: workflow.workflowId, supported: !hasBlocking(issues), issues };
  });
}

/**
 * Reads a description and reports three things separately: what was read,
 * whether the studio can edit it without loss, and which workflows the
 * executable profile could compile once a host binds their operations.
 */
export function reviewArazzoImport(
  document: unknown,
  options: ReadArazzoOptions = {},
): ArazzoReview {
  const read = readArazzo(document, options);
  return {
    read,
    studio: studioProjection(read),
    executable: executabilityReview(read),
  };
}
