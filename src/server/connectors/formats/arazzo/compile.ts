import type { CompatibilityIssue } from "../../../../core/connectors/contracts.js";
import {
  identifierSchema,
  publicValueSchema,
} from "../../../../core/operation-contracts.js";
import {
  RECIPE_LIMITS,
  recipeDefinitionSchema,
  type Binding,
  type RecipeDefinition,
  type RecipeInvocation,
} from "../../../../core/recipe-contracts.js";
import type { RunPlanNode } from "../../../commands.js";
import type {
  OperationRegistry,
  RegisteredOperation,
} from "../../../recipes/registry.js";
import {
  operationBindingCatalogSchema,
  resolveOperation,
  resolveWorkflow,
  type CatalogDocumentIdentity,
  type CatalogOperation,
  type CatalogWorkflow,
  type OperationBindingCatalog,
  type OperationBindingCatalogInput,
} from "./catalog.js";
import {
  ConditionSyntaxError,
  isEvaluableReference,
  parseCondition,
  type Classification,
  type ParsedCondition,
} from "./evaluator.js";
import {
  embeddedExpressions,
  parseRuntimeExpression,
  type RuntimeExpression,
} from "./expressions.js";
import {
  resolveFailureAction,
  resolveParameter,
  resolveSuccessAction,
  stepExpressions,
  stepGraph,
  type ExpressionSite,
} from "./graph.js";
import { arazzoIssue, hasBlocking, jsonPointer, type ArazzoIssueCode } from "./issues.js";
import { ARAZZO_EXECUTABLE_PROFILE, ARAZZO_LIMITS } from "./limits.js";
import {
  isPlainObject,
  isSelectorObject,
  type PreservedCriterion,
  type PreservedFailureAction,
  type PreservedParameter,
  type PreservedStep,
  type PreservedSuccessAction,
  type PreservedWorkflow,
} from "./model.js";
import { displayText, type ArazzoReadResult } from "./read.js";

/*
 * The executable profile: a declarative Arazzo workflow becomes an existing
 * recipe definition, and nothing else. Every step must resolve to a
 * host-registered document identity and a registered operation version; every
 * value must flow through a recipe binding (input, earlier output or public
 * literal); every criterion must be one the bounded evaluator understands.
 * Anything outside that is preserved by the reader and reported here as a
 * blocking issue with its pointer. A blocked compilation has no recipe: a
 * workflow is never truncated into something that merely looks runnable.
 */

export type CompiledCriterion = { pointer: string; condition: ParsedCondition };
export type CompiledRetry = {
  limit: number;
  afterMs: number;
  replay: "read-only" | "upstream-idempotency-key" | "reconciliation";
  criteria: CompiledCriterion[];
};
export type CompiledOutput = { name: string; classification: Classification };
export type CompiledStep = {
  stepId: string;
  nodeId: string;
  pointer: string;
  kind: "operation" | "workflow";
  binding?: {
    sourceDescriptionName: string;
    documentIdentity: CatalogDocumentIdentity;
    declaredUrl: string;
    version: string;
    reference: { operationId: string } | { operationPath: string };
    operation: { id: string; version: string };
  };
  recipe?: CatalogWorkflow["recipe"];
  dependsOn: string[];
  successCriteria: CompiledCriterion[];
  retry?: CompiledRetry;
  timeoutMs?: number;
  /** Arazzo output name to the registered output it maps to, with its classification. */
  outputs: Record<string, CompiledOutput>;
};

export type ArazzoCompilation = {
  profile: typeof ARAZZO_EXECUTABLE_PROFILE;
  workflowId: string;
  status: "executable" | "blocked";
  recipe?: RecipeDefinition;
  steps: CompiledStep[];
  /** Node identifiers in the one sequential order the host advances them. */
  order: string[];
  inputs: Record<string, { contract: string; classification: Classification }>;
  outputs: Record<
    string,
    { node: string; name: string; classification: Classification }
  >;
  issues: CompatibilityIssue[];
};

export type CompileArazzoOptions = {
  workflowId: string;
  registry: OperationRegistry;
  tenantId: string;
  recipeId?: string;
};

type Issue = (code: ArazzoIssueCode, pointer: string) => void;

type EffectiveParameter = { parameter: PreservedParameter; pointer: string };
type EffectiveSuccess = { action: PreservedSuccessAction; pointer: string };
type EffectiveFailure = { action: PreservedFailureAction; pointer: string };

type StepAnalysis = {
  step: PreservedStep;
  parameters: EffectiveParameter[];
  onSuccess: EffectiveSuccess[];
  onFailure: EffectiveFailure[];
  expressions: ExpressionSite[];
};

type WorkflowAnalysis = {
  workflow: PreservedWorkflow;
  issues: CompatibilityIssue[];
  /** Steps in execution order; empty when the graph is cyclic. */
  order: StepAnalysis[];
  sequential: boolean;
  explicit: Map<string, string[]>;
  implicit: Map<string, string[]>;
};

const isJson = (contentType: string) =>
  /^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;.*)?$/i.test(contentType);

/** Read issues that concern the root of the document or the given workflows. */
export function issuesInScope(
  read: ArazzoReadResult,
  workflows: readonly PreservedWorkflow[],
): CompatibilityIssue[] {
  const scopes = workflows.map((workflow) => `${workflow.pointer}/`);
  return read.issues.filter((issue) => {
    const pointer = issue.sourcePointer;
    if (!pointer.startsWith("/workflows/")) return true;
    return scopes.some(
      (scope) => pointer.startsWith(scope) || pointer === scope.slice(0, -1),
    );
  });
}

function criterionType(criterion: PreservedCriterion): string {
  if (criterion.type === undefined) return "simple";
  return typeof criterion.type === "string" ? criterion.type : criterion.type.type;
}

/**
 * Catalog-free analysis of one workflow: effective parameters and actions,
 * the execution order and every construct outside the executable profile.
 * The review path reports these; the compiler adds binding and policy checks.
 */
export function analyzeWorkflow(
  read: ArazzoReadResult,
  workflowId: string,
): WorkflowAnalysis | undefined {
  const document = read.document;
  const workflow = document?.workflows.find((item) => item.workflowId === workflowId);
  if (!document || !workflow) return undefined;
  const issues: CompatibilityIssue[] = [];
  const issue: Issue = (code, pointer) =>
    issues.push(arazzoIssue(code, pointer, { dimension: "invoke" }));
  const components = document.components;
  const expressions = new Map<string, ExpressionSite[]>();
  const analyses = new Map<string, StepAnalysis>();
  const workflowParameters = (workflow.parameters ?? []).flatMap((item, index) => {
    const parameter = resolveParameter(item, components);
    return parameter
      ? [{ parameter, pointer: `${workflow.pointer}/parameters/${index}` }]
      : [];
  });
  const workflowSuccess = (workflow.successActions ?? []).flatMap((item, index) => {
    const action = resolveSuccessAction(item, components);
    return action
      ? [{ action, pointer: `${workflow.pointer}/successActions/${index}` }]
      : [];
  });
  const workflowFailure = (workflow.failureActions ?? []).flatMap((item, index) => {
    const action = resolveFailureAction(item, components);
    return action
      ? [{ action, pointer: `${workflow.pointer}/failureActions/${index}` }]
      : [];
  });
  for (const step of workflow.steps) {
    const own = (step.parameters ?? []).flatMap((item, index) => {
      const parameter = resolveParameter(item, components);
      return parameter
        ? [{ parameter, pointer: `${step.pointer}/parameters/${index}` }]
        : [];
    });
    const key = (parameter: PreservedParameter) =>
      `${parameter.in ?? ""}:${parameter.name}`;
    const parameters = [
      ...own,
      ...workflowParameters.filter(
        (inherited) =>
          !own.some((item) => key(item.parameter) === key(inherited.parameter)),
      ),
    ];
    const ownSuccess = (step.onSuccess ?? []).flatMap((item, index) => {
      const action = resolveSuccessAction(item, components);
      return action ? [{ action, pointer: `${step.pointer}/onSuccess/${index}` }] : [];
    });
    const ownFailure = (step.onFailure ?? []).flatMap((item, index) => {
      const action = resolveFailureAction(item, components);
      return action ? [{ action, pointer: `${step.pointer}/onFailure/${index}` }] : [];
    });
    const onSuccess = [
      ...ownSuccess,
      ...workflowSuccess.filter(
        (inherited) =>
          !ownSuccess.some((item) => item.action.name === inherited.action.name),
      ),
    ];
    const onFailure = [
      ...ownFailure,
      ...workflowFailure.filter(
        (inherited) =>
          !ownFailure.some((item) => item.action.name === inherited.action.name),
      ),
    ];
    const sites = stepExpressions(step, step.pointer, components);
    expressions.set(step.stepId, sites);
    analyses.set(step.stepId, {
      step,
      parameters,
      onSuccess,
      onFailure,
      expressions: sites,
    });
  }
  const graph = stepGraph(workflow, expressions);
  const orderIds = graph.sequential
    ? workflow.steps.map((step) => step.stepId)
    : (graph.order ?? []);
  const order = orderIds.map((id) => analyses.get(id)!);
  if (!graph.sequential && graph.order)
    issue("arazzo.control.sequentialized", workflow.pointer);
  if (workflow.steps.length > ARAZZO_LIMITS.executableSteps)
    issue("arazzo.step.limit-exceeded", `${workflow.pointer}/steps`);

  const position = new Map(orderIds.map((id, index) => [id, index]));
  order.forEach((analysis, index) => {
    const { step } = analysis;
    if (!identifierSchema.safeParse(step.stepId).success)
      issue("arazzo.identity.step-id-unrepresentable", `${step.pointer}/stepId`);
    if (step.channelPath !== undefined)
      issue("arazzo.step.channel-unsupported", `${step.pointer}/channelPath`);
    if (step.action !== undefined || step.correlationId !== undefined)
      issue("arazzo.step.async-unsupported", step.pointer);
    if (step.timeout !== undefined) {
      if (step.timeout > ARAZZO_LIMITS.timeoutMs)
        issue("arazzo.policy.timeout-exceeded", `${step.pointer}/timeout`);
      else issue("arazzo.step.timeout-adapted", `${step.pointer}/timeout`);
    }
    for (const { parameter, pointer } of analysis.parameters)
      if (parameter.in === "querystring")
        issue("arazzo.serialization.querystring-unsupported", `${pointer}/in`);
    if (step.requestBody) {
      const pointer = `${step.pointer}/requestBody`;
      if (step.workflowId !== undefined)
        issue("arazzo.binding.request-body-unsupported", pointer);
      if (
        step.requestBody.contentType !== undefined &&
        !isJson(step.requestBody.contentType)
      )
        issue("arazzo.serialization.request-body-content-type", `${pointer}/contentType`);
      if (step.requestBody.replacements?.length)
        issue("arazzo.binding.request-body-unsupported", `${pointer}/replacements`);
    }
    for (const site of analysis.expressions) profileSite(site, issue);
    step.successCriteria?.forEach((criterion, criterionIndex) =>
      profileCriterion(
        criterion,
        `${step.pointer}/successCriteria/${criterionIndex}`,
        issue,
      ),
    );
    for (const { action, pointer } of analysis.onSuccess) {
      if (action.type === "end") {
        if (action.criteria?.length) issue("arazzo.control.conditional-end", pointer);
        else if (index !== order.length - 1)
          issue("arazzo.control.unreachable-steps", pointer);
        continue;
      }
      if (action.workflowId !== undefined) {
        issue("arazzo.control.goto-workflow-unsupported", `${pointer}/workflowId`);
        continue;
      }
      const target = action.stepId === undefined ? undefined : position.get(action.stepId);
      if (target === undefined) continue;
      if (target === index + 1) issue("arazzo.control.goto-next", pointer);
      else if (target <= index) issue("arazzo.control.goto-cycle", pointer);
      else issue("arazzo.control.goto-branch", pointer);
    }
    for (const { action, pointer } of analysis.onFailure) {
      if (action.type === "goto") {
        issue("arazzo.control.failure-goto-unsupported", pointer);
        continue;
      }
      if (action.type !== "retry") continue;
      if (action.stepId !== undefined || action.workflowId !== undefined)
        issue("arazzo.policy.retry-target-unsupported", pointer);
      if (
        (action.retryLimit ?? 1) > ARAZZO_LIMITS.retryLimit ||
        (action.retryAfter ?? 0) > ARAZZO_LIMITS.retryAfterSeconds
      )
        issue("arazzo.policy.retry-limit-exceeded", pointer);
      action.criteria?.forEach((criterion, criterionIndex) =>
        profileCriterion(criterion, `${pointer}/criteria/${criterionIndex}`, issue),
      );
    }
    for (const [name, value] of Object.entries(step.outputs ?? {})) {
      const pointer = `${step.pointer}/outputs${jsonPointer(name)}`;
      if (!identifierSchema.safeParse(name).success)
        issue("arazzo.identity.name-unrepresentable", pointer);
      if (isSelectorObject(value)) issue("arazzo.expression.selector-unsupported", pointer);
    }
  });
  for (const [name, value] of Object.entries(workflow.outputs ?? {})) {
    const pointer = `${workflow.pointer}/outputs${jsonPointer(name)}`;
    if (!identifierSchema.safeParse(name).success)
      issue("arazzo.identity.name-unrepresentable", pointer);
    if (isSelectorObject(value)) {
      issue("arazzo.expression.selector-unsupported", pointer);
      continue;
    }
    const expression = typeof value === "string" ? parseRuntimeExpression(value) : undefined;
    if (!expression) continue;
    if (expression.kind === "steps") {
      if (expression.pointer !== undefined)
        issue("arazzo.expression.pointer-unsupported", pointer);
    } else if (expression.kind === "inputs")
      issue("arazzo.binding.output-not-step-derived", pointer);
    else issue("arazzo.expression.unsupported-context", pointer);
  }
  return {
    workflow,
    issues,
    order,
    sequential: graph.sequential,
    explicit: graph.explicit,
    implicit: graph.implicit,
  };
}

function profileSite(site: ExpressionSite, issue: Issue) {
  if (site.invalid || !site.expression) return;
  if (site.role === "selector-context") {
    issue("arazzo.expression.selector-unsupported", site.pointer);
    return;
  }
  if (site.role === "criterion" || site.role === "action-criterion") return;
  if (site.role === "criterion-context" || site.role === "action-criterion-context") {
    issue("arazzo.criteria.context-unsupported", site.pointer);
    return;
  }
  if (site.embedded) {
    issue("arazzo.expression.embedded-unsupported", site.pointer);
    return;
  }
  const expression = site.expression;
  if (expression.kind === "inputs" || expression.kind === "steps") {
    if (expression.pointer !== undefined)
      issue("arazzo.expression.pointer-unsupported", site.pointer);
    return;
  }
  if (site.role === "output" && expression.kind !== "inputs") {
    // Step output extraction expressions are mapped by the catalog, not evaluated.
    return;
  }
  issue("arazzo.expression.unsupported-context", site.pointer);
}

function profileCriterion(criterion: PreservedCriterion, pointer: string, issue: Issue) {
  const type = criterionType(criterion);
  if (type !== "simple") {
    issue("arazzo.criteria.type-unsupported", `${pointer}/type`);
    return;
  }
  let parsed: ParsedCondition;
  try {
    parsed = parseCondition(criterion.condition);
  } catch (error) {
    if (!(error instanceof ConditionSyntaxError)) throw error;
    issue("arazzo.criteria.invalid-condition", `${pointer}/condition`);
    return;
  }
  for (const reference of parsed.references) {
    const expression = reference.expression;
    if (isEvaluableReference(expression)) continue;
    if (
      expression.kind === "request" ||
      expression.kind === "response" ||
      expression.kind === "message"
    )
      issue("arazzo.criteria.response-body-unsupported", `${pointer}/condition`);
    else issue("arazzo.expression.unsupported-context", `${pointer}/condition`);
  }
}

/** Recipe plan nodes for the command service, from validated recipe leaves. */
export function toRunPlan(leaves: readonly RecipeInvocation[]): RunPlanNode[] {
  return leaves.map((leaf) => {
    if (leaf.use.kind !== "operation")
      throw new Error("Recipe leaves must be operations");
    return {
      id: leaf.id,
      operationId: leaf.use.id,
      operationVersion: leaf.use.version,
      dependsOn: [...leaf.dependsOn],
      bindings: structuredClone(leaf.bindings),
    };
  });
}

class Compiler {
  readonly issues: CompatibilityIssue[] = [];
  readonly inputs: ArazzoCompilation["inputs"] = {};
  readonly compiled = new Map<string, CompiledStep>();
  readonly invocations: RecipeInvocation[] = [];
  constructor(
    readonly read: ArazzoReadResult,
    readonly catalog: OperationBindingCatalog,
    readonly registry: OperationRegistry,
  ) {}

  issue(code: ArazzoIssueCode, pointer: string) {
    this.issues.push(arazzoIssue(code, pointer, { dimension: "invoke" }));
  }

  classification(contract: string): Classification {
    return this.registry.vocabulary.get(contract)?.classification ?? "unclassified";
  }

  /** Binds one Arazzo value to a recipe binding for an input with the given contract. */
  bindValue(value: unknown, pointer: string, contract: string): Binding | undefined {
    if (typeof value === "string" && value.startsWith("$")) {
      const expression = parseRuntimeExpression(value);
      if (!expression) return undefined;
      return this.bindExpression(expression, pointer, contract);
    }
    if (typeof value === "string" && embeddedExpressions(value).expressions.length)
      return undefined;
    if (isSelectorObject(value) || isPlainObject(value) || Array.isArray(value)) {
      if (!isSelectorObject(value)) this.issue("arazzo.binding.unsupported-literal", pointer);
      return undefined;
    }
    const vocabulary = this.registry.vocabulary.get(contract);
    if (!vocabulary || vocabulary.classification !== "public") {
      this.issue("arazzo.policy.private-literal", pointer);
      return undefined;
    }
    if (
      !publicValueSchema.safeParse(value).success ||
      !vocabulary.schema.safeParse(value).success
    ) {
      this.issue("arazzo.binding.literal-rejected", pointer);
      return undefined;
    }
    return { from: "literal", value: value as string | number | boolean | null };
  }

  bindExpression(
    expression: RuntimeExpression,
    pointer: string,
    contract: string,
  ): Binding | undefined {
    if (expression.kind === "inputs") {
      if (expression.pointer !== undefined) return undefined;
      if (!identifierSchema.safeParse(expression.name).success) {
        this.issue("arazzo.identity.name-unrepresentable", pointer);
        return undefined;
      }
      const existing = this.inputs[expression.name];
      if (existing && existing.contract !== contract) {
        this.issue("arazzo.binding.input-contract-conflict", pointer);
        return undefined;
      }
      this.inputs[expression.name] = {
        contract,
        classification: this.classification(contract),
      };
      return { from: "input", name: expression.name };
    }
    if (expression.kind === "steps") {
      if (expression.pointer !== undefined) return undefined;
      const producer = this.compiled.get(expression.stepId);
      const output = producer?.outputs[expression.name];
      if (!producer || !output) {
        this.issue("arazzo.reference.unknown-step-output", pointer);
        return undefined;
      }
      const producerContract = this.outputContract(producer, output.name);
      if (producerContract !== contract) {
        this.issue("arazzo.binding.output-contract-mismatch", pointer);
        return undefined;
      }
      return { from: "output", node: producer.nodeId, name: output.name };
    }
    return undefined;
  }

  /** The registered contract of a compiled step's output. */
  outputContract(step: CompiledStep, name: string): string | undefined {
    if (step.kind === "operation" && step.binding) {
      const operation = this.registry.get(
        step.binding.operation.id,
        step.binding.operation.version,
      );
      return operation?.contract.outputs[name]?.contract;
    }
    const entry = this.catalog.workflows.find(
      (candidate) =>
        candidate.recipe.id === step.recipe?.id &&
        candidate.recipe.version === step.recipe.version &&
        candidate.recipe.digest === step.recipe.digest,
    );
    return entry?.outputs[name];
  }

  compileCriteria(
    criteria: readonly PreservedCriterion[] | undefined,
    pointer: string,
    step: CompiledStep,
  ): CompiledCriterion[] {
    const compiled: CompiledCriterion[] = [];
    criteria?.forEach((criterion, index) => {
      if (criterionType(criterion) !== "simple") return;
      let parsed: ParsedCondition;
      try {
        parsed = parseCondition(criterion.condition);
      } catch {
        return;
      }
      const at = `${pointer}/${index}/condition`;
      for (const { expression } of parsed.references) {
        if (expression.kind === "inputs" && !this.inputs[expression.name])
          this.issue("arazzo.criteria.unbound-input", at);
        if (expression.kind === "steps") {
          const producer = this.compiled.get(expression.stepId);
          if (!producer || !producer.outputs[expression.name])
            this.issue("arazzo.reference.unknown-step-output", at);
        }
        if (expression.kind === "outputs")
          this.issue("arazzo.expression.unsupported-context", at);
      }
      compiled.push({ pointer: `${pointer}/${index}`, condition: parsed });
      void step;
    });
    return compiled;
  }

  compileOperationStep(
    analysis: StepAnalysis,
    nodeId: string,
    dependsOn: string[],
  ): CompiledStep | undefined {
    const { step } = analysis;
    const sources = this.read.document!.sourceDescriptions;
    const resolution = resolveOperation(this.catalog, sources, step);
    const referencePointer = `${step.pointer}/${
      step.operationPath !== undefined ? "operationPath" : "operationId"
    }`;
    if (resolution.status !== "resolved") {
      const code: ArazzoIssueCode =
        resolution.status === "invalid-reference"
          ? step.operationPath !== undefined
            ? "arazzo.identity.operation-path-not-source-relative"
            : "arazzo.expression.invalid"
          : resolution.status === "unknown-source"
            ? "arazzo.reference.unknown-source-description"
            : resolution.status === "source-mismatch"
              ? "arazzo.identity.source-mismatch"
              : resolution.status === "ambiguous-document"
                ? "arazzo.identity.ambiguous-document"
                : resolution.status === "ambiguous-operation"
                  ? "arazzo.identity.ambiguous-operation"
                  : "arazzo.binding.unbound-operation";
      this.issue(code, referencePointer);
      return undefined;
    }
    const { binding } = resolution;
    const operation = this.registry.get(binding.operation.id, binding.operation.version);
    if (!operation) {
      this.issue("arazzo.binding.unregistered-operation", referencePointer);
      return undefined;
    }
    const compiled: CompiledStep = {
      stepId: step.stepId,
      nodeId,
      pointer: step.pointer,
      kind: "operation",
      binding: {
        sourceDescriptionName: binding.sourceDescriptionName,
        documentIdentity: binding.documentIdentity,
        declaredUrl: binding.declaredUrl,
        version: binding.version,
        reference: binding.reference,
        operation: binding.operation,
      },
      dependsOn,
      successCriteria: [],
      outputs: {},
      ...(step.timeout !== undefined && step.timeout <= ARAZZO_LIMITS.timeoutMs
        ? { timeoutMs: step.timeout }
        : {}),
    };
    const bindings = this.bindInputs(analysis, operation, binding.entry);
    this.bindRequestBody(step, operation, binding.entry, bindings);
    for (const [name, input] of Object.entries(operation.contract.inputs))
      if (input.required && !bindings[name])
        this.issue("arazzo.binding.missing-required-input", step.pointer);
    for (const [name, value] of Object.entries(step.outputs ?? {})) {
      const pointer = `${step.pointer}/outputs${jsonPointer(name)}`;
      if (typeof value !== "string") continue;
      const registered = binding.entry.outputs?.[value];
      const contract = registered
        ? operation.contract.outputs[registered]?.contract
        : undefined;
      if (!registered || !contract) {
        this.issue("arazzo.binding.unmapped-output", pointer);
        continue;
      }
      compiled.outputs[name] = {
        name: registered,
        classification: this.classification(contract),
      };
    }
    compiled.successCriteria = this.compileCriteria(
      step.successCriteria,
      `${step.pointer}/successCriteria`,
      compiled,
    );
    const retry = this.compileRetry(analysis, binding.entry, compiled);
    if (retry) compiled.retry = retry;
    this.invocations.push({
      id: nodeId,
      use: {
        kind: "operation",
        id: binding.operation.id,
        version: binding.operation.version,
      },
      dependsOn,
      bindings,
    });
    return compiled;
  }

  bindInputs(
    analysis: StepAnalysis,
    operation: RegisteredOperation,
    entry: CatalogOperation,
  ): Record<string, Binding> {
    const bindings: Record<string, Binding> = {};
    for (const { parameter, pointer } of analysis.parameters) {
      const mapped =
        entry.parameters?.[`${parameter.in ?? ""}:${parameter.name}`] ??
        entry.parameters?.[parameter.name] ??
        (identifierSchema.safeParse(parameter.name).success
          ? parameter.name
          : undefined);
      const input = mapped ? operation.contract.inputs[mapped] : undefined;
      if (!mapped || !input) {
        this.issue("arazzo.binding.unknown-parameter", pointer);
        continue;
      }
      const binding = this.bindValue(parameter.value, `${pointer}/value`, input.contract);
      if (binding) bindings[mapped] = binding;
    }
    return bindings;
  }

  bindRequestBody(
    step: PreservedStep,
    operation: RegisteredOperation,
    entry: CatalogOperation,
    bindings: Record<string, Binding>,
  ) {
    const body = step.requestBody;
    if (!body || body.payload === undefined) return;
    const pointer = `${step.pointer}/requestBody/payload`;
    const bind = (property: string | undefined, value: unknown, at: string) => {
      const mapped =
        property === undefined
          ? entry.requestBody?.["*"]
          : (entry.requestBody?.[property] ??
            (identifierSchema.safeParse(property).success &&
            operation.contract.inputs[property]
              ? property
              : undefined));
      const input = mapped ? operation.contract.inputs[mapped] : undefined;
      if (!mapped || !input) {
        this.issue("arazzo.binding.request-body-unmapped", at);
        return;
      }
      const binding = this.bindValue(value, at, input.contract);
      if (binding) bindings[mapped] = binding;
    };
    if (typeof body.payload === "string" && body.payload.startsWith("$")) {
      bind(undefined, body.payload, pointer);
      return;
    }
    if (!isPlainObject(body.payload) || isSelectorObject(body.payload)) {
      this.issue("arazzo.binding.request-body-unsupported", pointer);
      return;
    }
    for (const [property, value] of Object.entries(body.payload)) {
      const at = `${pointer}${jsonPointer(property)}`;
      if (isPlainObject(value) && !isSelectorObject(value)) {
        this.issue("arazzo.binding.request-body-unsupported", at);
        continue;
      }
      if (Array.isArray(value)) {
        this.issue("arazzo.binding.request-body-unsupported", at);
        continue;
      }
      bind(property, value, at);
    }
  }

  compileRetry(
    analysis: StepAnalysis,
    entry: CatalogOperation,
    compiled: CompiledStep,
  ): CompiledRetry | undefined {
    const retry = analysis.onFailure.find(({ action }) => action.type === "retry");
    if (!retry) return undefined;
    const { action, pointer } = retry;
    if (action.stepId !== undefined || action.workflowId !== undefined)
      return undefined;
    if (entry.replay === "none") {
      this.issue("arazzo.policy.retry-not-replay-safe", pointer);
      return undefined;
    }
    const limit = action.retryLimit ?? 1;
    const afterSeconds = action.retryAfter ?? 0;
    if (limit > ARAZZO_LIMITS.retryLimit || afterSeconds > ARAZZO_LIMITS.retryAfterSeconds)
      return undefined;
    return {
      limit,
      afterMs: Math.round(afterSeconds * 1000),
      replay: entry.replay,
      criteria: this.compileCriteria(action.criteria, `${pointer}/criteria`, compiled),
    };
  }

  compileWorkflowStep(
    analysis: StepAnalysis,
    nodeId: string,
    dependsOn: string[],
  ): CompiledStep | undefined {
    const { step } = analysis;
    const pointer = `${step.pointer}/workflowId`;
    const reference = this.workflowReference(step.workflowId!);
    if (!reference) {
      this.issue("arazzo.expression.invalid", pointer);
      return undefined;
    }
    const resolution = resolveWorkflow(this.catalog, reference, this.read.digest!);
    if (resolution.status !== "resolved") {
      this.issue(
        resolution.status === "ambiguous"
          ? "arazzo.identity.ambiguous-document"
          : "arazzo.binding.unbound-workflow",
        pointer,
      );
      return undefined;
    }
    const entry = resolution.binding;
    const bindings: Record<string, Binding> = {};
    for (const { parameter, pointer: at } of analysis.parameters) {
      const contract = entry.inputs[parameter.name];
      if (!contract || !identifierSchema.safeParse(parameter.name).success) {
        this.issue("arazzo.binding.unknown-parameter", at);
        continue;
      }
      const binding = this.bindValue(parameter.value, `${at}/value`, contract);
      if (binding) bindings[parameter.name] = binding;
    }
    for (const name of Object.keys(entry.inputs))
      if (!bindings[name]) this.issue("arazzo.binding.missing-required-input", step.pointer);
    const compiled: CompiledStep = {
      stepId: step.stepId,
      nodeId,
      pointer: step.pointer,
      kind: "workflow",
      recipe: entry.recipe,
      dependsOn,
      successCriteria: [],
      outputs: Object.fromEntries(
        Object.entries(entry.outputs).map(([name, contract]) => [
          name,
          { name, classification: this.classification(contract) },
        ]),
      ),
    };
    for (const name of Object.keys(step.outputs ?? {}))
      this.issue(
        "arazzo.expression.unsupported-context",
        `${step.pointer}/outputs${jsonPointer(name)}`,
      );
    compiled.successCriteria = this.compileCriteria(
      step.successCriteria,
      `${step.pointer}/successCriteria`,
      compiled,
    );
    this.invocations.push({
      id: nodeId,
      use: { kind: "recipe", ...entry.recipe },
      dependsOn,
      bindings,
    });
    return compiled;
  }

  workflowReference(
    text: string,
  ): { workflowId: string; sourceDescriptionName?: string } | undefined {
    if (!text.startsWith("$")) return { workflowId: text };
    const expression = parseRuntimeExpression(text);
    if (expression?.kind !== "sourceDescriptions") return undefined;
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(expression.reference)) return undefined;
    return {
      workflowId: expression.reference,
      sourceDescriptionName: expression.source,
    };
  }

  compileDependency(text: string, pointer: string, previous: string | undefined) {
    const reference = this.workflowReference(text);
    if (!reference) return undefined;
    const resolution = resolveWorkflow(this.catalog, reference, this.read.digest!);
    if (resolution.status !== "resolved") {
      this.issue(
        resolution.status === "ambiguous"
          ? "arazzo.identity.ambiguous-document"
          : "arazzo.binding.unbound-workflow",
        pointer,
      );
      return undefined;
    }
    const entry = resolution.binding;
    if (Object.keys(entry.inputs).length) {
      this.issue("arazzo.binding.dependency-inputs-unsupported", pointer);
      return undefined;
    }
    const nodeId = `dependsOn.${reference.workflowId}`;
    if (!identifierSchema.safeParse(nodeId).success) {
      this.issue("arazzo.identity.name-unrepresentable", pointer);
      return undefined;
    }
    this.invocations.push({
      id: nodeId,
      use: { kind: "recipe", ...entry.recipe },
      dependsOn: previous ? [previous] : [],
      bindings: {},
    });
    return nodeId;
  }
}

export function compileArazzoToRecipe(
  read: ArazzoReadResult,
  catalogInput: OperationBindingCatalogInput,
  options: CompileArazzoOptions,
): ArazzoCompilation {
  const catalog = operationBindingCatalogSchema.parse(catalogInput);
  const base = {
    profile: ARAZZO_EXECUTABLE_PROFILE,
    workflowId: options.workflowId,
    steps: [] as CompiledStep[],
    order: [] as string[],
    inputs: {},
    outputs: {},
  } satisfies Partial<ArazzoCompilation>;
  const blockedWith = (issues: CompatibilityIssue[]): ArazzoCompilation => ({
    ...base,
    status: "blocked",
    issues,
  });
  if (catalog.tenantId !== options.tenantId)
    return blockedWith([
      arazzoIssue("arazzo.binding.catalog-tenant-mismatch", "/", {
        dimension: "invoke",
      }),
    ]);
  const analysis = analyzeWorkflow(read, options.workflowId);
  if (!read.document || !read.digest || !analysis)
    return blockedWith([
      ...read.issues,
      arazzoIssue("arazzo.reference.unknown-workflow", "/workflows", {
        dimension: "invoke",
      }),
    ]);
  const { workflow } = analysis;
  const referenced = new Set<PreservedWorkflow>([workflow]);
  for (const candidate of referenced) {
    const ids = [
      ...(candidate.dependsOn ?? []),
      ...candidate.steps.flatMap((step) =>
        step.workflowId === undefined ? [] : [step.workflowId],
      ),
    ];
    for (const id of ids) {
      const local = read.document.workflows.find((item) => item.workflowId === id);
      if (local) referenced.add(local);
    }
  }
  const compiler = new Compiler(read, catalog, options.registry);
  compiler.issues.push(...issuesInScope(read, [...referenced]), ...analysis.issues);
  const cyclic = analysis.order.length !== workflow.steps.length;
  let previous: string | undefined;
  workflow.dependsOn?.forEach((dependency, index) => {
    const nodeId = compiler.compileDependency(
      dependency,
      `${workflow.pointer}/dependsOn/${index}`,
      previous,
    );
    if (nodeId) previous = nodeId;
  });
  const lastDependency = previous;
  const order: string[] = [];
  if (!cyclic)
    for (const stepAnalysis of analysis.order) {
      const { step } = stepAnalysis;
      if (!identifierSchema.safeParse(step.stepId).success) continue;
      const nodeId = step.stepId;
      const producers = [
        ...(analysis.explicit.get(step.stepId) ?? []),
        ...(analysis.implicit.get(step.stepId) ?? []),
      ]
        .map((id) => compiler.compiled.get(id)?.nodeId)
        .filter((id): id is string => id !== undefined);
      const dependsOn = [
        ...new Set([
          ...(analysis.sequential && previous ? [previous] : []),
          ...(!analysis.sequential && !producers.length && lastDependency
            ? [lastDependency]
            : []),
          ...producers,
        ]),
      ];
      const compiled =
        step.workflowId !== undefined
          ? compiler.compileWorkflowStep(stepAnalysis, nodeId, dependsOn)
          : step.channelPath !== undefined
            ? undefined
            : compiler.compileOperationStep(stepAnalysis, nodeId, dependsOn);
      if (!compiled) continue;
      compiler.compiled.set(step.stepId, compiled);
      order.push(nodeId);
      if (analysis.sequential) previous = nodeId;
    }
  const outputs: ArazzoCompilation["outputs"] = {};
  for (const [name, value] of Object.entries(workflow.outputs ?? {})) {
    const pointer = `${workflow.pointer}/outputs${jsonPointer(name)}`;
    const expression = typeof value === "string" ? parseRuntimeExpression(value) : undefined;
    if (expression?.kind !== "steps" || expression.pointer !== undefined) continue;
    const producer = compiler.compiled.get(expression.stepId);
    const output = producer?.outputs[expression.name];
    if (!producer || !output) {
      compiler.issue("arazzo.reference.unknown-step-output", pointer);
      continue;
    }
    if (output.classification === "personal" || output.classification === "secret")
      compiler.issue("arazzo.policy.private-output", pointer);
    else if (output.classification === "unclassified")
      compiler.issue("arazzo.policy.unclassified-output", pointer);
    outputs[name] = {
      node: producer.nodeId,
      name: output.name,
      classification: output.classification,
    };
  }
  const recipeId = options.recipeId ?? workflow.workflowId;
  if (!identifierSchema.safeParse(recipeId).success)
    compiler.issue("arazzo.identity.name-unrepresentable", `${workflow.pointer}/workflowId`);
  if (compiler.invocations.length > RECIPE_LIMITS.leaves)
    compiler.issue("arazzo.step.limit-exceeded", `${workflow.pointer}/steps`);
  const steps = [...compiler.compiled.values()];
  if (hasBlocking(compiler.issues))
    return {
      ...base,
      status: "blocked",
      steps,
      order: [...compiler.invocations.map((invocation) => invocation.id)],
      inputs: compiler.inputs,
      outputs,
      issues: compiler.issues,
    };
  const title = displayText(workflow.summary ?? workflow.workflowId, 100);
  const description = displayText(workflow.description ?? "", 1000);
  if (
    (workflow.summary && title !== workflow.summary) ||
    (workflow.description && description !== workflow.description)
  )
    compiler.issue("arazzo.text.truncated", workflow.pointer);
  const candidate = recipeDefinitionSchema.safeParse({
    schemaVersion: 1,
    id: recipeId,
    title: title || workflow.workflowId,
    description,
    inputs: Object.fromEntries(
      Object.entries(compiler.inputs).map(([name, input]) => [
        name,
        { contract: input.contract, required: true },
      ]),
    ),
    invocations: compiler.invocations,
    outputs: Object.fromEntries(
      Object.entries(outputs).map(([name, output]) => [
        name,
        { node: output.node, name: output.name },
      ]),
    ),
  });
  if (!candidate.success) {
    compiler.issue("arazzo.structure.recipe-limit", workflow.pointer);
    return {
      ...base,
      status: "blocked",
      steps,
      order: compiler.invocations.map((invocation) => invocation.id),
      inputs: compiler.inputs,
      outputs,
      issues: compiler.issues,
    };
  }
  return {
    ...base,
    status: "executable",
    recipe: candidate.data,
    steps,
    order: compiler.invocations.map((invocation) => invocation.id),
    inputs: compiler.inputs,
    outputs,
    issues: compiler.issues,
  };
}
