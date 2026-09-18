import {
  compatibilityIssueSchema,
  type CompatibilityIssue,
} from "../../../../core/connectors/contracts.js";
import type { SupportDimension } from "../../../../core/connectors/identity.js";

/*
 * Every diagnostic this format can raise is declared here with a fixed
 * message. A message never interpolates document text: the pointer says where,
 * the code says what, and a hostile description cannot smuggle a credential or
 * an instruction into a review screen through an error string.
 */

type Category = CompatibilityIssue["category"];
type Severity = CompatibilityIssue["severity"];
type Disposition = CompatibilityIssue["disposition"];
type Impact = CompatibilityIssue["executionImpact"];

type IssueSpec = {
  category: Category;
  severity: Severity;
  disposition: Disposition;
  impact: Impact;
  message: string;
  remediation?: string;
};

const blocking = (
  category: Category,
  message: string,
  remediation?: string,
  impact: Impact = "blocks-operation",
  disposition: Disposition = "unsupported",
): IssueSpec => ({
  category,
  severity: "blocking",
  disposition,
  impact,
  message,
  ...(remediation ? { remediation } : {}),
});
const warning = (
  category: Category,
  message: string,
  remediation?: string,
  disposition: Disposition = "adapted",
): IssueSpec => ({
  category,
  severity: "warning",
  disposition,
  impact: "none",
  message,
  ...(remediation ? { remediation } : {}),
});
const info = (
  category: Category,
  message: string,
  disposition: Disposition = "adapted",
): IssueSpec => ({
  category,
  severity: "info",
  disposition,
  impact: "none",
  message,
});

export const arazzoIssueTable = {
  // Structure and bounds (reader).
  "arazzo.structure.not-object": blocking(
    "structure",
    "An Arazzo description must be a JSON object.",
    undefined,
    "blocks-definition",
    "rejected",
  ),
  "arazzo.structure.limit-exceeded": blocking(
    "structure",
    "The document exceeds a size, depth or count bound and was not read further.",
    "Split the description or remove the oversized construct.",
    "blocks-definition",
    "rejected",
  ),
  "arazzo.structure.reserved-key": blocking(
    "structure",
    "The document uses a reserved object key.",
    undefined,
    "blocks-definition",
    "rejected",
  ),
  "arazzo.structure.unsupported-value": blocking(
    "structure",
    "The document contains a value that is not representable as JSON.",
    undefined,
    "blocks-definition",
    "rejected",
  ),
  "arazzo.structure.missing-field": blocking(
    "structure",
    "A required field is missing.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.structure.invalid-type": blocking(
    "structure",
    "A field has a value of the wrong type.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.structure.invalid-value": blocking(
    "structure",
    "A field has a value outside the set the specification allows.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.structure.unknown-field": warning(
    "structure",
    "A field the specification does not define was preserved for review and is never executed.",
    "Move vendor data under an x- extension.",
  ),
  "arazzo.structure.empty-list": blocking(
    "structure",
    "A list that must have at least one entry is empty.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.structure.invalid-identifier": blocking(
    "structure",
    "An identifier does not match the pattern the specification requires.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.structure.duplicate-id": blocking(
    "structure",
    "An identifier that must be unique appears more than once.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.structure.duplicate-parameter": blocking(
    "structure",
    "A parameter name and location pair appears more than once in one step.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.structure.extension-limit": warning(
    "structure",
    "More extensions were declared than the description keeps; later ones were not projected.",
  ),
  "arazzo.structure.issue-limit": warning(
    "structure",
    "More diagnostics were raised than the description keeps; later ones were dropped.",
  ),
  "arazzo.structure.recipe-limit": blocking(
    "structure",
    "The compiled recipe exceeds a recipe contract bound.",
    "Split the workflow so each recipe stays within the leaf and binding limits.",
  ),
  "arazzo.version.missing": blocking(
    "version",
    "The arazzo version field is missing or is not a string.",
    undefined,
    "blocks-definition",
    "rejected",
  ),
  "arazzo.version.unsupported": blocking(
    "version",
    "This Arazzo version is not one this reader implements; the document was preserved without interpretation and its version was not rewritten.",
    "Supported versions are 1.0.1 and 1.1.0.",
    "blocks-definition",
  ),
  "arazzo.version.field-unavailable": blocking(
    "version",
    "This field or value belongs to a later Arazzo version than the document declares; it was preserved but not interpreted.",
    "Declare the Arazzo version that defines the construct.",
  ),
  "arazzo.step.operation-reference-count": blocking(
    "structure",
    "A step must reference exactly one of operationId, operationPath, channelPath or workflowId.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.step.parameter-location-missing": blocking(
    "structure",
    "A parameter of an operation step must declare its location.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.step.parameter-location-ignored": warning(
    "structure",
    "Parameters of a workflow step map to workflow inputs; the declared location has no effect.",
  ),
  "arazzo.expression.invalid": blocking(
    "structure",
    "A runtime expression does not match the expression grammar.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.reference.unknown-component": blocking(
    "structure",
    "A reusable reference names a component the document does not define.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.reference.component-kind-mismatch": blocking(
    "structure",
    "A reusable reference names a component of the wrong kind for its location.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.reference.unknown-step": blocking(
    "identity",
    "A reference names a step that does not exist in this workflow.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.reference.unknown-step-output": blocking(
    "identity",
    "A reference names an output the referenced step does not declare.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.reference.forward-step-output": blocking(
    "structure",
    "A step references the outputs of a step that runs later in sequential order.",
    "Reorder the steps, or declare step dependencies in an Arazzo 1.1.0 description.",
    "blocks-operation",
    "rejected",
  ),
  "arazzo.reference.unknown-workflow": blocking(
    "identity",
    "A reference names a workflow that does not exist in this document or its arazzo source descriptions.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.reference.unknown-source-description": blocking(
    "identity",
    "A reference names a source description the document does not declare.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.reference.source-kind-mismatch": blocking(
    "identity",
    "A reference names a source description of a type that cannot hold the referenced object.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.dependency.self": blocking(
    "structure",
    "An object depends on itself.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.dependency.cycle": blocking(
    "structure",
    "Dependencies form a cycle; the workflow cannot be ordered.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.action.target-count": blocking(
    "structure",
    "A goto or retry target must name exactly one of stepId or workflowId, and end must name neither.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.criteria.context-required": blocking(
    "structure",
    "A regex, JSONPath or XPath criterion must declare its context.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.criteria.invalid-condition": blocking(
    "structure",
    "A simple condition does not parse under the bounded condition grammar.",
    "Use literals, comparison and logical operators and supported runtime expressions only.",
    "blocks-operation",
    "rejected",
  ),
  "arazzo.source.url-credentials": blocking(
    "security",
    "A source description URL carries credentials; it was not projected as a declared server.",
    "Publish the description at a URL without userinfo.",
    "blocks-operation",
    "rejected",
  ),
  "arazzo.source.url-relative": info(
    "structure",
    "A source description URL is a relative reference; it is preserved but not projected as a declared server.",
    "exact",
  ),
  "arazzo.source.type-missing": info(
    "structure",
    "A source description declares no type; it is preserved but not projected as a declared server.",
    "exact",
  ),
  "arazzo.identity.reserved-identifier": blocking(
    "identity",
    "An identifier collides with a reserved word and cannot be projected.",
    "Rename the workflow or step.",
    "blocks-operation",
    "rejected",
  ),
  // Executable profile (compiler).
  "arazzo.binding.catalog-tenant-mismatch": blocking(
    "policy",
    "The operation catalog belongs to a different tenant than the compilation.",
    undefined,
    "blocks-definition",
    "rejected",
  ),
  "arazzo.binding.unbound-operation": blocking(
    "identity",
    "No host-registered document binds this operation reference; imported references never register operations.",
    "Register the source document, its version and the operation in the host catalog.",
    "blocks-operation",
    "requires-configuration",
  ),
  "arazzo.binding.unregistered-operation": blocking(
    "identity",
    "The catalog maps this reference to an operation version the registry does not hold.",
    "Register the operation version before binding.",
    "blocks-operation",
    "requires-configuration",
  ),
  "arazzo.identity.ambiguous-operation": blocking(
    "identity",
    "More than one registered document defines this operation; the step must name its source description.",
    "Reference the operation as $sourceDescriptions.<name>.<operationId> or through an operationPath.",
    "blocks-operation",
    "rejected",
  ),
  "arazzo.identity.ambiguous-document": blocking(
    "identity",
    "More than one catalog document matches this source description.",
    "Pin exactly one document identity per source description.",
    "blocks-operation",
    "rejected",
  ),
  "arazzo.identity.source-mismatch": blocking(
    "identity",
    "The catalog document identity does not match the source description exactly.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.identity.operation-path-not-source-relative": blocking(
    "identity",
    "An operationPath must combine a $sourceDescriptions URL expression with a JSON pointer; absolute or foreign locations are not followed.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.identity.step-id-unrepresentable": blocking(
    "identity",
    "A step identifier cannot be represented as a recipe node identifier.",
    "Start the identifier with a letter and keep it under 96 characters.",
  ),
  "arazzo.binding.unbound-workflow": blocking(
    "identity",
    "No host-registered recipe binds this workflow reference.",
    "Publish the workflow as a recipe and register its exact version and digest in the catalog.",
    "blocks-operation",
    "requires-configuration",
  ),
  "arazzo.binding.dependency-inputs-unsupported": blocking(
    "structure",
    "A depended-on workflow that requires inputs cannot be invoked implicitly.",
    "Invoke the workflow through a workflowId step with explicit parameters.",
  ),
  "arazzo.binding.unknown-parameter": blocking(
    "structure",
    "A parameter does not map to an input of the bound operation.",
    "Map the parameter in the catalog or remove it.",
    "blocks-operation",
    "rejected",
  ),
  "arazzo.binding.unmapped-output": blocking(
    "structure",
    "A step output expression is not mapped to an output of the bound operation.",
    "Map the extraction expression to a registered output in the catalog.",
    "blocks-operation",
    "requires-configuration",
  ),
  "arazzo.binding.input-contract-conflict": blocking(
    "schema",
    "One workflow input feeds operation inputs with different registered contracts.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.binding.output-contract-mismatch": blocking(
    "schema",
    "A step output feeds an input with a different registered contract.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.binding.missing-required-input": blocking(
    "structure",
    "The bound operation requires an input the step does not supply.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.binding.literal-rejected": blocking(
    "schema",
    "A literal value does not satisfy the registered contract of the input it feeds.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.binding.unsupported-literal": blocking(
    "structure",
    "Only string, number, boolean and null literals can bind an input.",
  ),
  "arazzo.binding.output-not-step-derived": blocking(
    "structure",
    "A workflow output must reference a step output.",
  ),
  "arazzo.binding.request-body-unsupported": blocking(
    "serialization",
    "This request body shape is outside the executable profile.",
    "Use a JSON object whose top-level properties map to registered inputs.",
  ),
  "arazzo.binding.request-body-unmapped": blocking(
    "serialization",
    "A request body property is not mapped to an input of the bound operation.",
    "Map the property in the catalog.",
    "blocks-operation",
    "requires-configuration",
  ),
  "arazzo.serialization.request-body-content-type": blocking(
    "serialization",
    "Only JSON request bodies are within the executable profile.",
  ),
  "arazzo.serialization.querystring-unsupported": blocking(
    "serialization",
    "Whole-query-string parameters are outside the executable profile.",
  ),
  "arazzo.policy.private-literal": blocking(
    "policy",
    "A literal can only bind an input whose registered contract is public.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.policy.private-output": blocking(
    "policy",
    "A workflow output would publish a value classified personal or secret.",
    "Remove the output or bind it to a public registered contract.",
    "blocks-operation",
    "rejected",
  ),
  "arazzo.policy.unclassified-output": blocking(
    "policy",
    "A workflow output has no registered classification and is treated as private.",
    "Classify the registered contract before publishing it.",
    "blocks-operation",
    "rejected",
  ),
  "arazzo.policy.retry-not-replay-safe": blocking(
    "policy",
    "A retry action is only allowed when the bound operation has explicit replay evidence.",
    "Register read-only, idempotency-key or reconciliation replay for the operation, or remove the retry.",
    "blocks-operation",
    "rejected",
  ),
  "arazzo.policy.retry-limit-exceeded": blocking(
    "policy",
    "A retry action exceeds the bounded retry limit or delay.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.policy.retry-target-unsupported": blocking(
    "policy",
    "Retrying through another step or workflow is outside the executable profile.",
  ),
  "arazzo.policy.timeout-exceeded": blocking(
    "policy",
    "A step timeout exceeds the bounded maximum.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.step.timeout-adapted": warning(
    "policy",
    "The step timeout is carried in the compiled plan; the host enforces it through the command signal.",
  ),
  "arazzo.step.channel-unsupported": blocking(
    "structure",
    "Event channel steps are outside the executable profile.",
  ),
  "arazzo.step.async-unsupported": blocking(
    "structure",
    "Asynchronous message correlation is outside the executable profile.",
  ),
  "arazzo.step.limit-exceeded": blocking(
    "structure",
    "The workflow has more executable steps than one recipe can hold; nothing was truncated.",
    "Split the workflow into recipes of at most 32 leaves.",
  ),
  "arazzo.expression.unsupported-context": blocking(
    "structure",
    "This runtime expression reads a context the executable profile does not provide.",
    "Bind values through workflow inputs or step outputs.",
  ),
  "arazzo.expression.pointer-unsupported": blocking(
    "structure",
    "JSON pointer extraction inside a binding is outside the executable profile.",
  ),
  "arazzo.expression.embedded-unsupported": blocking(
    "structure",
    "String templates with embedded expressions are outside the executable profile.",
  ),
  "arazzo.expression.selector-unsupported": blocking(
    "structure",
    "Selector objects are outside the executable profile.",
  ),
  "arazzo.criteria.type-unsupported": blocking(
    "executable-code",
    "Regex, JSONPath and XPath criteria are not evaluated by this runtime.",
    "Express the assertion as a simple condition over supported runtime expressions.",
  ),
  "arazzo.criteria.response-body-unsupported": blocking(
    "structure",
    "Criteria over the raw request, response or message are outside the executable profile.",
    "Assert on step outputs the registered operation exposes.",
  ),
  "arazzo.criteria.context-unsupported": blocking(
    "structure",
    "A simple criterion with a context is outside the executable profile.",
  ),
  "arazzo.control.goto-next": info(
    "structure",
    "A goto to the next sequential step was compiled as ordinary sequencing.",
  ),
  "arazzo.control.goto-branch": blocking(
    "structure",
    "A goto that skips or repeats steps is a branch the recipe runtime cannot express.",
  ),
  "arazzo.control.goto-cycle": blocking(
    "structure",
    "A goto transfers control backwards and would loop.",
    undefined,
    "blocks-operation",
    "rejected",
  ),
  "arazzo.control.goto-workflow-unsupported": blocking(
    "structure",
    "Transferring control to another workflow is outside the executable profile.",
  ),
  "arazzo.control.conditional-end": blocking(
    "structure",
    "Ending the workflow early under a condition is outside the executable profile.",
  ),
  "arazzo.control.unreachable-steps": blocking(
    "structure",
    "An unconditional end leaves later steps unreachable; nothing was truncated.",
  ),
  "arazzo.control.failure-goto-unsupported": blocking(
    "structure",
    "Branching after a failure is outside the executable profile.",
  ),
  "arazzo.control.sequentialized": info(
    "structure",
    "Step dependencies were compiled into one sequential order that satisfies every declared and implicit dependency.",
  ),
  "arazzo.text.truncated": info(
    "structure",
    "A display text was shortened to fit the recipe contract.",
  ),
  // Review and export.
  "arazzo.review.studio-version": blocking(
    "version",
    "The studio edits Arazzo 1.0.1 documents only.",
    undefined,
    "blocks-definition",
  ),
  "arazzo.review.studio-shape": blocking(
    "structure",
    "This construct has no editable field in the studio; the document is reviewable but not editable.",
    undefined,
    "blocks-definition",
  ),
  "arazzo.review.studio-descriptive-loss": warning(
    "structure",
    "This descriptive field is not kept by the studio form.",
  ),
  "arazzo.review.studio-schema": blocking(
    "structure",
    "The reduced document does not satisfy the studio project schema.",
    undefined,
    "blocks-definition",
  ),
  "arazzo.export.version-changed": info(
    "version",
    "The document was exported under a different Arazzo version than it declared.",
  ),
  "arazzo.export.version-downgrade-loss": blocking(
    "version",
    "This construct does not exist in the requested Arazzo version; the document was not exported.",
    "Export as Arazzo 1.1.0 or remove the construct.",
    "blocks-definition",
  ),
  "arazzo.export.unknown-field-dropped": warning(
    "structure",
    "A field the specification does not define was not exported.",
  ),
} as const satisfies Record<string, IssueSpec>;

export type ArazzoIssueCode = keyof typeof arazzoIssueTable;

export type IssueOverrides = {
  dimension?: SupportDimension;
  normalizedPointer?: string;
  impact?: Impact;
};

/** Pointer segments are escaped per RFC 6901 and stripped of control characters. */
export function jsonPointer(...segments: Array<string | number>): string {
  return segments
    .map(
      (segment) =>
        `/${String(segment)
          .replace(/~/g, "~0")
          .replace(/\//g, "~1")
          .replace(/\p{Cc}/gu, "?")}`,
    )
    .join("");
}

export function arazzoIssue(
  code: ArazzoIssueCode,
  sourcePointer: string,
  overrides: IssueOverrides = {},
): CompatibilityIssue {
  const spec = arazzoIssueTable[code];
  return compatibilityIssueSchema.parse({
    code,
    category: spec.category,
    sourcePointer: sourcePointer.slice(0, 1024) || "/",
    ...(overrides.normalizedPointer
      ? { normalizedPointer: overrides.normalizedPointer.slice(0, 1024) }
      : {}),
    dimension: overrides.dimension ?? "import",
    disposition: spec.disposition,
    severity: spec.severity,
    executionImpact:
      spec.severity === "blocking" ? (overrides.impact ?? spec.impact) : "none",
    message: spec.message,
    ...("remediation" in spec && spec.remediation
      ? { remediation: spec.remediation }
      : {}),
  });
}

export function hasBlocking(issues: readonly CompatibilityIssue[]): boolean {
  return issues.some((issue) => issue.severity === "blocking");
}

export function blockingIssues(
  issues: readonly CompatibilityIssue[],
): CompatibilityIssue[] {
  return issues.filter((issue) => issue.severity === "blocking");
}
