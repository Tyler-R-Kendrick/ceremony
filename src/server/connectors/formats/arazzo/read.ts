import { createHash } from "node:crypto";
import {
  DEFINITION_LIMITS,
  nativeCapabilitySchema,
  normalizedDefinitionSchema,
  type CompatibilityIssue,
  type NormalizedDefinition,
} from "../../../../core/connectors/contracts.js";
import { completeDimensions } from "../../../../core/connectors/envelope.js";
import {
  canonicalConnectorJson,
  nativeIdentifierSchema,
  nativeVersionSchema,
} from "../../../../core/connectors/identity.js";
import { measureJsonValue } from "../../../../core/connectors/json-bounds.js";
import { ConditionSyntaxError, parseCondition } from "./evaluator.js";
import {
  expressionSince,
  identifierStrictPattern,
  parseRuntimeExpression,
  validJsonPointer,
  type RuntimeExpression,
} from "./expressions.js";
import {
  cycleMembers,
  resolveFailureAction,
  resolveParameter,
  resolveSuccessAction,
  stepExpressions,
  stepGraph,
  valueExpressions,
  type ExpressionSite,
} from "./graph.js";
import {
  arazzoIssue,
  jsonPointer,
  type ArazzoIssueCode,
  type IssueOverrides,
} from "./issues.js";
import {
  ARAZZO_IMPORTER,
  ARAZZO_LIMITS,
  ARAZZO_PROFILES,
  isArazzoVersion,
  versionIncludes,
  type ArazzoVersion,
} from "./limits.js";
import {
  isPlainObject,
  isReusable,
  isSelectorObject,
  type Extensions,
  type PreservedArazzoDocument,
  type PreservedComponents,
  type PreservedCriterion,
  type PreservedExpressionType,
  type PreservedFailureAction,
  type PreservedInfo,
  type PreservedParameter,
  type PreservedPayloadReplacement,
  type PreservedRequestBody,
  type PreservedReusable,
  type PreservedSourceDescription,
  type PreservedStep,
  type PreservedSuccessAction,
  type PreservedWorkflow,
} from "./model.js";

/*
 * A bounded reader for Arazzo 1.0.1 and 1.1.0 descriptions. It dispatches on
 * the declared `arazzo` version, preserves every construct the specification
 * defines for that version, keeps anything else as inert data, and reports
 * each problem with a JSON pointer. It never fetches a source description,
 * never evaluates an expression and never rewrites the version it was given.
 * An unknown version yields a blocking issue and no interpretation at all.
 */

const READ_BOUNDS = Object.freeze({
  depth: ARAZZO_LIMITS.depth,
  nodes: ARAZZO_LIMITS.nodes,
  bytes: DEFINITION_LIMITS.bytes,
  stringLength: ARAZZO_LIMITS.string,
});

type Impact = CompatibilityIssue["executionImpact"];
type FieldTable = ReadonlyArray<readonly [string, ArazzoVersion]>;
type ValueTable = ReadonlyArray<readonly [string, ArazzoVersion]>;

const v1 = "1.0.1" as const;
const v11 = "1.1.0" as const;
const ROOT_FIELDS: FieldTable = [
  ["arazzo", v1],
  ["info", v1],
  ["sourceDescriptions", v1],
  ["workflows", v1],
  ["components", v1],
  ["$self", v11],
];
const INFO_FIELDS: FieldTable = [
  ["title", v1],
  ["summary", v1],
  ["description", v1],
  ["version", v1],
];
const SOURCE_FIELDS: FieldTable = [
  ["name", v1],
  ["url", v1],
  ["type", v1],
];
const WORKFLOW_FIELDS: FieldTable = [
  ["workflowId", v1],
  ["summary", v1],
  ["description", v1],
  ["inputs", v1],
  ["dependsOn", v1],
  ["steps", v1],
  ["successActions", v1],
  ["failureActions", v1],
  ["outputs", v1],
  ["parameters", v1],
];
const STEP_FIELDS: FieldTable = [
  ["description", v1],
  ["stepId", v1],
  ["operationId", v1],
  ["operationPath", v1],
  ["workflowId", v1],
  ["parameters", v1],
  ["requestBody", v1],
  ["successCriteria", v1],
  ["onSuccess", v1],
  ["onFailure", v1],
  ["outputs", v1],
  ["channelPath", v11],
  ["timeout", v11],
  ["correlationId", v11],
  ["action", v11],
  ["dependsOn", v11],
];
const PARAMETER_FIELDS: FieldTable = [
  ["name", v1],
  ["in", v1],
  ["value", v1],
];
const CRITERION_FIELDS: FieldTable = [
  ["context", v1],
  ["condition", v1],
  ["type", v1],
];
const EXPRESSION_TYPE_FIELDS: FieldTable = [
  ["type", v1],
  ["version", v1],
];
const SUCCESS_FIELDS: FieldTable = [
  ["name", v1],
  ["type", v1],
  ["workflowId", v1],
  ["stepId", v1],
  ["criteria", v1],
  ["parameters", v11],
];
const FAILURE_FIELDS: FieldTable = [
  ["name", v1],
  ["type", v1],
  ["workflowId", v1],
  ["stepId", v1],
  ["retryAfter", v1],
  ["retryLimit", v1],
  ["criteria", v1],
  ["parameters", v11],
];
const REQUEST_BODY_FIELDS: FieldTable = [
  ["contentType", v1],
  ["payload", v1],
  ["replacements", v1],
];
const REPLACEMENT_FIELDS: FieldTable = [
  ["target", v1],
  ["value", v1],
  ["targetSelectorType", v11],
];
const COMPONENTS_FIELDS: FieldTable = [
  ["inputs", v1],
  ["parameters", v1],
  ["successActions", v1],
  ["failureActions", v1],
];

const SOURCE_TYPES: ValueTable = [
  ["openapi", v1],
  ["arazzo", v1],
  ["asyncapi", v11],
];
const PARAMETER_LOCATIONS: ValueTable = [
  ["path", v1],
  ["query", v1],
  ["header", v1],
  ["cookie", v1],
  ["querystring", v11],
];
const SUCCESS_TYPES: ValueTable = [
  ["end", v1],
  ["goto", v1],
];
const FAILURE_TYPES: ValueTable = [
  ["end", v1],
  ["retry", v1],
  ["goto", v1],
];
const CRITERION_TYPES: ValueTable = [
  ["simple", v1],
  ["regex", v1],
  ["jsonpath", v1],
  ["xpath", v1],
];
const EXPRESSION_TYPES: ValueTable = [
  ["jsonpath", v1],
  ["xpath", v1],
  ["jsonpointer", v11],
];
const EXPRESSION_VERSIONS: Record<string, ValueTable> = {
  jsonpath: [
    ["draft-goessner-dispatch-jsonpath-00", v1],
    ["rfc9535", v11],
  ],
  xpath: [
    ["xpath-30", v1],
    ["xpath-20", v1],
    ["xpath-10", v1],
    ["xpath-31", v11],
  ],
  jsonpointer: [["rfc6901", v11]],
};
const STEP_ACTIONS: ValueTable = [
  ["send", v11],
  ["receive", v11],
];
const COMPONENT_KEY = /^[a-zA-Z0-9._-]+$/;
const OUTPUT_KEY = /^[a-zA-Z0-9._-]+$/;
const UNSAFE_TEXT = /\p{Cc}|[‪-‮⁦-⁩]/gu;

/** Display-safe text: control and bidi characters blanked, bounded, no dangling surrogate. */
export function displayText(value: string, max: number): string {
  let text = value.replace(UNSAFE_TEXT, " ").trim().slice(0, max);
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  return text.trim();
}

class Reader {
  readonly issues: CompatibilityIssue[] = [];
  constructor(readonly version: ArazzoVersion) {}

  issue(code: ArazzoIssueCode, pointer: string, overrides: IssueOverrides = {}) {
    this.issues.push(arazzoIssue(code, pointer, overrides));
  }
  includes(since: ArazzoVersion): boolean {
    return versionIncludes(this.version, since);
  }

  /**
   * Splits an object into the fields this version defines, its `x-`
   * extensions and everything else. A field belonging to a later Arazzo
   * version is blocking for `impact`'s scope: ignoring it would silently
   * change what the author wrote, and interpreting it would apply semantics
   * the declared version does not have.
   */
  partition(
    object: Record<string, unknown>,
    pointer: string,
    fields: FieldTable,
    impact: Impact,
  ): { extensions: Extensions; unknown: Extensions } {
    const extensions: Extensions = {};
    const unknown: Extensions = {};
    for (const [key, value] of Object.entries(object)) {
      if (key.startsWith("x-")) {
        extensions[key] = value;
        continue;
      }
      const entry = fields.find(([name]) => name === key);
      if (entry && this.includes(entry[1])) continue;
      unknown[key] = value;
      const at = `${pointer}${jsonPointer(key)}`;
      if (!entry) this.issue("arazzo.structure.unknown-field", at);
      else this.issue("arazzo.version.field-unavailable", at, { impact });
    }
    if (Object.keys(extensions).length > ARAZZO_LIMITS.extensions)
      this.issue("arazzo.structure.extension-limit", pointer);
    return { extensions, unknown };
  }

  string(
    object: Record<string, unknown>,
    key: string,
    pointer: string,
    options: {
      required?: boolean;
      max: number;
      impact: Impact;
      keep: Extensions;
    },
  ): string | undefined {
    const value = object[key];
    const at = `${pointer}${jsonPointer(key)}`;
    if (value === undefined) {
      if (options.required)
        this.issue("arazzo.structure.missing-field", at, {
          impact: options.impact,
        });
      return undefined;
    }
    if (typeof value !== "string") {
      this.issue("arazzo.structure.invalid-type", at, { impact: options.impact });
      options.keep[key] = value;
      return undefined;
    }
    if (value.length > options.max) {
      this.issue("arazzo.structure.too-long", at, { impact: options.impact });
      options.keep[key] = value;
      return undefined;
    }
    return value;
  }

  identifier(
    object: Record<string, unknown>,
    key: string,
    pointer: string,
    options: { required?: boolean; impact: Impact; keep: Extensions },
  ): string | undefined {
    const value = this.string(object, key, pointer, {
      ...options,
      max: ARAZZO_LIMITS.identifier,
    });
    if (value === undefined) return undefined;
    if (!identifierStrictPattern.test(value)) {
      this.issue(
        "arazzo.structure.invalid-identifier",
        `${pointer}${jsonPointer(key)}`,
        { impact: options.impact },
      );
      options.keep[key] = value;
      return undefined;
    }
    return value;
  }

  number(
    object: Record<string, unknown>,
    key: string,
    pointer: string,
    options: { integer?: boolean; impact: Impact; keep: Extensions },
  ): number | undefined {
    const value = object[key];
    if (value === undefined) return undefined;
    const at = `${pointer}${jsonPointer(key)}`;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.issue("arazzo.structure.invalid-type", at, { impact: options.impact });
      options.keep[key] = value;
      return undefined;
    }
    if (value < 0 || (options.integer && !Number.isInteger(value))) {
      this.issue("arazzo.structure.invalid-value", at, {
        impact: options.impact,
      });
      options.keep[key] = value;
      return undefined;
    }
    return value;
  }

  array(
    object: Record<string, unknown>,
    key: string,
    pointer: string,
    options: {
      required?: boolean;
      min?: number;
      max: number;
      impact: Impact;
      keep: Extensions;
    },
  ): unknown[] | undefined {
    const value = object[key];
    const at = `${pointer}${jsonPointer(key)}`;
    if (value === undefined) {
      if (options.required)
        this.issue("arazzo.structure.missing-field", at, {
          impact: options.impact,
        });
      return undefined;
    }
    if (!Array.isArray(value)) {
      this.issue("arazzo.structure.invalid-type", at, { impact: options.impact });
      options.keep[key] = value;
      return undefined;
    }
    if (value.length < (options.min ?? 0)) {
      this.issue("arazzo.structure.empty-list", at, { impact: options.impact });
      return undefined;
    }
    if (value.length > options.max) {
      this.issue("arazzo.structure.too-many", at, { impact: options.impact });
      options.keep[key] = value;
      return undefined;
    }
    return value;
  }

  record(
    object: Record<string, unknown>,
    key: string,
    pointer: string,
    options: {
      max: number;
      keyPattern: RegExp;
      impact: Impact;
      keep: Extensions;
    },
  ): Record<string, unknown> | undefined {
    const value = object[key];
    if (value === undefined) return undefined;
    const at = `${pointer}${jsonPointer(key)}`;
    if (!isPlainObject(value)) {
      this.issue("arazzo.structure.invalid-type", at, { impact: options.impact });
      options.keep[key] = value;
      return undefined;
    }
    const entries = Object.entries(value);
    if (entries.length > options.max) {
      this.issue("arazzo.structure.too-many", at, { impact: options.impact });
      options.keep[key] = value;
      return undefined;
    }
    const result: Record<string, unknown> = {};
    for (const [name, item] of entries) {
      if (!options.keyPattern.test(name) || name.length > ARAZZO_LIMITS.identifier) {
        this.issue(
          "arazzo.structure.invalid-identifier",
          `${at}${jsonPointer(name)}`,
          { impact: options.impact },
        );
        continue;
      }
      result[name] = item;
    }
    return result;
  }

  /** True when the value is allowed in this version; reports the reason otherwise. */
  enumerated(
    value: string | undefined,
    allowed: ValueTable,
    pointer: string,
    impact: Impact,
  ): boolean {
    if (value === undefined) return true;
    const entry = allowed.find(([name]) => name === value);
    if (entry && this.includes(entry[1])) return true;
    this.issue(
      entry ? "arazzo.version.field-unavailable" : "arazzo.structure.invalid-value",
      pointer,
      { impact },
    );
    return false;
  }

  objectItems<T>(
    items: unknown[],
    pointer: string,
    impact: Impact,
    read: (item: Record<string, unknown>, at: string) => T | undefined,
  ): T[] {
    const out: T[] = [];
    items.forEach((item, index) => {
      const at = `${pointer}/${index}`;
      if (!isPlainObject(item)) {
        this.issue("arazzo.structure.invalid-type", at, { impact });
        return;
      }
      const value = read(item, at);
      if (value !== undefined) out.push(value);
    });
    return out;
  }

  expression(
    text: string,
    pointer: string,
    impact: Impact = "blocks-operation",
  ): RuntimeExpression | undefined {
    const expression = parseRuntimeExpression(text);
    if (!expression) {
      this.issue("arazzo.expression.invalid", pointer, { impact });
      return undefined;
    }
    if (!this.includes(expressionSince(expression))) {
      this.issue("arazzo.version.field-unavailable", pointer, { impact });
      return undefined;
    }
    return expression;
  }

  // Object readers -----------------------------------------------------

  readDocument(source: Record<string, unknown>): PreservedArazzoDocument {
    const pointer = "";
    const { extensions, unknown } = this.partition(
      source,
      pointer,
      ROOT_FIELDS,
      "blocks-definition",
    );
    const impact: Impact = "blocks-definition";
    const self = this.includes(v11)
      ? this.string(source, "$self", pointer, {
          max: ARAZZO_LIMITS.url,
          impact,
          keep: unknown,
        })
      : undefined;
    const info = isPlainObject(source.info)
      ? this.readInfo(source.info, "/info")
      : (this.issue(
          source.info === undefined
            ? "arazzo.structure.missing-field"
            : "arazzo.structure.invalid-type",
          "/info",
          { impact },
        ),
        {
          pointer: "/info",
          title: "",
          version: "",
          extensions: {},
          unknown: {},
        });
    const sources =
      this.array(source, "sourceDescriptions", pointer, {
        required: true,
        min: 1,
        max: ARAZZO_LIMITS.sourceDescriptions,
        impact,
        keep: unknown,
      }) ?? [];
    const sourceDescriptions = this.objectItems(
      sources,
      "/sourceDescriptions",
      impact,
      (item, at) => this.readSourceDescription(item, at),
    );
    const workflowItems =
      this.array(source, "workflows", pointer, {
        required: true,
        min: 1,
        max: ARAZZO_LIMITS.workflows,
        impact,
        keep: unknown,
      }) ?? [];
    const workflows = this.objectItems(
      workflowItems,
      "/workflows",
      "blocks-operation",
      (item, at) => this.readWorkflow(item, at),
    );
    let components: PreservedComponents | undefined;
    if (source.components !== undefined) {
      if (isPlainObject(source.components))
        components = this.readComponents(source.components, "/components");
      else this.issue("arazzo.structure.invalid-type", "/components");
    }
    return {
      pointer,
      arazzo: this.version,
      ...(self !== undefined ? { self } : {}),
      info,
      sourceDescriptions,
      workflows,
      ...(components ? { components } : {}),
      extensions,
      unknown,
    };
  }

  readInfo(object: Record<string, unknown>, pointer: string): PreservedInfo {
    const { extensions, unknown } = this.partition(
      object,
      pointer,
      INFO_FIELDS,
      "blocks-definition",
    );
    const text = (key: string, required: boolean) =>
      this.string(object, key, pointer, {
        required,
        max: ARAZZO_LIMITS.text,
        impact: "blocks-definition",
        keep: unknown,
      });
    const title = text("title", true);
    const version = text("version", true);
    const summary = text("summary", false);
    const description = text("description", false);
    return {
      pointer,
      title: title ?? "",
      version: version ?? "",
      ...(summary !== undefined ? { summary } : {}),
      ...(description !== undefined ? { description } : {}),
      extensions,
      unknown,
    };
  }

  readSourceDescription(
    object: Record<string, unknown>,
    pointer: string,
  ): PreservedSourceDescription | undefined {
    const { extensions, unknown } = this.partition(
      object,
      pointer,
      SOURCE_FIELDS,
      "blocks-operation",
    );
    const impact: Impact = "blocks-operation";
    const name = this.identifier(object, "name", pointer, {
      required: true,
      impact,
      keep: unknown,
    });
    const url = this.string(object, "url", pointer, {
      required: true,
      max: ARAZZO_LIMITS.url,
      impact,
      keep: unknown,
    });
    const type = this.string(object, "type", pointer, {
      max: ARAZZO_LIMITS.identifier,
      impact,
      keep: unknown,
    });
    this.enumerated(type, SOURCE_TYPES, `${pointer}/type`, impact);
    if (name === undefined || url === undefined) return undefined;
    return {
      pointer,
      name,
      url,
      ...(type !== undefined ? { type } : {}),
      extensions,
      unknown,
    };
  }

  readParameterOrReusable(
    object: Record<string, unknown>,
    pointer: string,
  ): PreservedParameter | PreservedReusable | undefined {
    if (typeof object.reference === "string" || "reference" in object)
      return this.readReusable(object, pointer);
    const { extensions, unknown } = this.partition(
      object,
      pointer,
      PARAMETER_FIELDS,
      "blocks-operation",
    );
    const impact: Impact = "blocks-operation";
    const name = this.string(object, "name", pointer, {
      required: true,
      max: ARAZZO_LIMITS.identifier,
      impact,
      keep: unknown,
    });
    const location = this.string(object, "in", pointer, {
      max: ARAZZO_LIMITS.identifier,
      impact,
      keep: unknown,
    });
    this.enumerated(location, PARAMETER_LOCATIONS, `${pointer}/in`, impact);
    if (!("value" in object))
      this.issue("arazzo.structure.missing-field", `${pointer}/value`, {
        impact,
      });
    this.checkValue(object.value, `${pointer}/value`);
    if (name === undefined) return undefined;
    return {
      pointer,
      name,
      ...(location !== undefined ? { in: location } : {}),
      value: object.value,
      extensions,
      unknown,
    };
  }

  /** Literal values may embed expressions or (1.1.0) selector objects; both are checked, never evaluated. */
  checkValue(value: unknown, pointer: string) {
    for (const site of valueExpressions(value, pointer, "parameter")) {
      if (site.invalid) {
        this.issue("arazzo.expression.invalid", site.pointer);
        continue;
      }
      if (site.expression && !this.includes(expressionSince(site.expression)))
        this.issue("arazzo.version.field-unavailable", site.pointer);
    }
    if (isSelectorObject(value)) this.readSelector(value, pointer);
    else if (Array.isArray(value))
      value.forEach((item, index) =>
        isSelectorObject(item)
          ? this.readSelector(item, `${pointer}/${index}`)
          : undefined,
      );
    else if (isPlainObject(value))
      for (const [key, item] of Object.entries(value))
        if (isSelectorObject(item))
          this.readSelector(item, `${pointer}${jsonPointer(key)}`);
  }

  readSelector(
    value: { context: unknown; selector: unknown; type: unknown },
    pointer: string,
  ) {
    if (!this.includes(v11)) {
      this.issue("arazzo.version.field-unavailable", pointer);
      return;
    }
    if (typeof value.selector !== "string" || !value.selector.length)
      this.issue("arazzo.structure.invalid-type", `${pointer}/selector`);
    if (typeof value.type === "string")
      this.enumerated(
        value.type,
        EXPRESSION_TYPES,
        `${pointer}/type`,
        "blocks-operation",
      );
    else if (isPlainObject(value.type))
      this.readExpressionType(value.type, `${pointer}/type`);
    else this.issue("arazzo.structure.invalid-type", `${pointer}/type`);
  }

  readReusable(
    object: Record<string, unknown>,
    pointer: string,
  ): PreservedReusable | undefined {
    const reference = object.reference;
    if (typeof reference !== "string") {
      this.issue("arazzo.structure.invalid-type", `${pointer}/reference`);
      return undefined;
    }
    const expression = this.expression(reference, `${pointer}/reference`);
    if (!expression) return undefined;
    if (expression.kind !== "components") {
      this.issue("arazzo.expression.invalid", `${pointer}/reference`);
      return undefined;
    }
    return {
      reference,
      ...(object.value !== undefined ? { value: object.value } : {}),
    };
  }

  readExpressionType(
    object: Record<string, unknown>,
    pointer: string,
  ): PreservedExpressionType | undefined {
    const { extensions, unknown } = this.partition(
      object,
      pointer,
      EXPRESSION_TYPE_FIELDS,
      "blocks-operation",
    );
    const impact: Impact = "blocks-operation";
    const type = this.string(object, "type", pointer, {
      required: true,
      max: ARAZZO_LIMITS.identifier,
      impact,
      keep: unknown,
    });
    const version = this.string(object, "version", pointer, {
      required: true,
      max: ARAZZO_LIMITS.identifier,
      impact,
      keep: unknown,
    });
    if (
      this.enumerated(type, EXPRESSION_TYPES, `${pointer}/type`, impact) &&
      type !== undefined
    )
      this.enumerated(
        version,
        EXPRESSION_VERSIONS[type] ?? [],
        `${pointer}/version`,
        impact,
      );
    if (type === undefined || version === undefined) return undefined;
    return { pointer, type, version, extensions, unknown };
  }

  readCriterion(
    object: Record<string, unknown>,
    pointer: string,
  ): PreservedCriterion | undefined {
    const { extensions, unknown } = this.partition(
      object,
      pointer,
      CRITERION_FIELDS,
      "blocks-operation",
    );
    const impact: Impact = "blocks-operation";
    const context = this.string(object, "context", pointer, {
      max: ARAZZO_LIMITS.expression,
      impact,
      keep: unknown,
    });
    if (context !== undefined) this.expression(context, `${pointer}/context`);
    const condition = this.string(object, "condition", pointer, {
      required: true,
      max: ARAZZO_LIMITS.condition,
      impact,
      keep: unknown,
    });
    let type: string | PreservedExpressionType | undefined;
    if (typeof object.type === "string") {
      this.enumerated(object.type, CRITERION_TYPES, `${pointer}/type`, impact);
      type = object.type;
    } else if (isPlainObject(object.type)) {
      type = this.readExpressionType(object.type, `${pointer}/type`);
    } else if (object.type !== undefined) {
      this.issue("arazzo.structure.invalid-type", `${pointer}/type`, { impact });
      unknown.type = object.type;
    }
    const effective =
      type === undefined ? "simple" : typeof type === "string" ? type : type.type;
    if (effective !== "simple" && context === undefined)
      this.issue("arazzo.criteria.context-required", pointer, { impact });
    if (condition !== undefined && effective === "simple") {
      try {
        parseCondition(condition);
      } catch (error) {
        if (!(error instanceof ConditionSyntaxError)) throw error;
        this.issue("arazzo.criteria.invalid-condition", `${pointer}/condition`, {
          impact,
        });
      }
    }
    if (condition === undefined) return undefined;
    return {
      pointer,
      ...(context !== undefined ? { context } : {}),
      condition,
      ...(type !== undefined ? { type } : {}),
      extensions,
      unknown,
    };
  }

  readCriteria(
    object: Record<string, unknown>,
    key: string,
    pointer: string,
    keep: Extensions,
  ): PreservedCriterion[] | undefined {
    const items = this.array(object, key, pointer, {
      max: ARAZZO_LIMITS.criteria,
      impact: "blocks-operation",
      keep,
    });
    if (!items) return undefined;
    return this.objectItems(
      items,
      `${pointer}${jsonPointer(key)}`,
      "blocks-operation",
      (item, at) => this.readCriterion(item, at),
    );
  }

  readParameters(
    object: Record<string, unknown>,
    key: string,
    pointer: string,
    keep: Extensions,
  ): Array<PreservedParameter | PreservedReusable> | undefined {
    const items = this.array(object, key, pointer, {
      max: ARAZZO_LIMITS.parameters,
      impact: "blocks-operation",
      keep,
    });
    if (!items) return undefined;
    return this.objectItems(
      items,
      `${pointer}${jsonPointer(key)}`,
      "blocks-operation",
      (item, at) => this.readParameterOrReusable(item, at),
    );
  }

  readAction(
    object: Record<string, unknown>,
    pointer: string,
    kind: "success" | "failure",
  ): PreservedSuccessAction | PreservedFailureAction | PreservedReusable | undefined {
    if ("reference" in object) return this.readReusable(object, pointer);
    const { extensions, unknown } = this.partition(
      object,
      pointer,
      kind === "success" ? SUCCESS_FIELDS : FAILURE_FIELDS,
      "blocks-operation",
    );
    const impact: Impact = "blocks-operation";
    const name = this.string(object, "name", pointer, {
      required: true,
      max: ARAZZO_LIMITS.identifier,
      impact,
      keep: unknown,
    });
    const type = this.string(object, "type", pointer, {
      required: true,
      max: ARAZZO_LIMITS.identifier,
      impact,
      keep: unknown,
    });
    this.enumerated(
      type,
      kind === "success" ? SUCCESS_TYPES : FAILURE_TYPES,
      `${pointer}/type`,
      impact,
    );
    const workflowId = this.string(object, "workflowId", pointer, {
      max: ARAZZO_LIMITS.expression,
      impact,
      keep: unknown,
    });
    const stepId = this.identifier(object, "stepId", pointer, {
      impact,
      keep: unknown,
    });
    const criteria = this.readCriteria(object, "criteria", pointer, unknown);
    const parameters = this.includes(v11)
      ? this.readParameters(object, "parameters", pointer, unknown)
      : undefined;
    const retryAfter =
      kind === "failure"
        ? this.number(object, "retryAfter", pointer, { impact, keep: unknown })
        : undefined;
    const retryLimit =
      kind === "failure"
        ? this.number(object, "retryLimit", pointer, {
            integer: true,
            impact,
            keep: unknown,
          })
        : undefined;
    if (type !== undefined) {
      const targets = [workflowId, stepId].filter(
        (item) => item !== undefined,
      ).length;
      if (
        (type === "goto" && targets !== 1) ||
        (type === "end" && targets !== 0) ||
        (type === "retry" && targets > 1)
      )
        this.issue("arazzo.action.target-count", pointer, { impact });
    }
    if (name === undefined || type === undefined) return undefined;
    return {
      pointer,
      name,
      type,
      ...(workflowId !== undefined ? { workflowId } : {}),
      ...(stepId !== undefined ? { stepId } : {}),
      ...(criteria ? { criteria } : {}),
      ...(parameters ? { parameters } : {}),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
      ...(retryLimit !== undefined ? { retryLimit } : {}),
      extensions,
      unknown,
    };
  }

  readActions<T extends PreservedSuccessAction | PreservedFailureAction>(
    object: Record<string, unknown>,
    key: string,
    pointer: string,
    kind: "success" | "failure",
    keep: Extensions,
  ): Array<T | PreservedReusable> | undefined {
    const items = this.array(object, key, pointer, {
      max: ARAZZO_LIMITS.actions,
      impact: "blocks-operation",
      keep,
    });
    if (!items) return undefined;
    return this.objectItems(
      items,
      `${pointer}${jsonPointer(key)}`,
      "blocks-operation",
      (item, at) => this.readAction(item, at, kind) as T | PreservedReusable,
    );
  }

  readRequestBody(
    object: Record<string, unknown>,
    pointer: string,
  ): PreservedRequestBody {
    const { extensions, unknown } = this.partition(
      object,
      pointer,
      REQUEST_BODY_FIELDS,
      "blocks-operation",
    );
    const impact: Impact = "blocks-operation";
    const contentType = this.string(object, "contentType", pointer, {
      max: ARAZZO_LIMITS.identifier,
      impact,
      keep: unknown,
    });
    if (object.payload !== undefined)
      this.checkValue(object.payload, `${pointer}/payload`);
    const replacementItems = this.array(object, "replacements", pointer, {
      max: ARAZZO_LIMITS.replacements,
      impact,
      keep: unknown,
    });
    const replacements = replacementItems
      ? this.objectItems(
          replacementItems,
          `${pointer}/replacements`,
          impact,
          (item, at): PreservedPayloadReplacement | undefined => {
            const parts = this.partition(item, at, REPLACEMENT_FIELDS, impact);
            const target = this.string(item, "target", at, {
              required: true,
              max: ARAZZO_LIMITS.expression,
              impact,
              keep: parts.unknown,
            });
            if (!("value" in item))
              this.issue("arazzo.structure.missing-field", `${at}/value`, {
                impact,
              });
            this.checkValue(item.value, `${at}/value`);
            if (this.includes(v11) && item.targetSelectorType !== undefined) {
              if (typeof item.targetSelectorType === "string")
                this.enumerated(
                  item.targetSelectorType,
                  EXPRESSION_TYPES,
                  `${at}/targetSelectorType`,
                  impact,
                );
              else if (isPlainObject(item.targetSelectorType))
                this.readExpressionType(
                  item.targetSelectorType,
                  `${at}/targetSelectorType`,
                );
              else
                this.issue(
                  "arazzo.structure.invalid-type",
                  `${at}/targetSelectorType`,
                  { impact },
                );
            }
            if (target === undefined) return undefined;
            return {
              pointer: at,
              target,
              value: item.value,
              ...(this.includes(v11) && item.targetSelectorType !== undefined
                ? { targetSelectorType: item.targetSelectorType }
                : {}),
              extensions: parts.extensions,
              unknown: parts.unknown,
            };
          },
        )
      : undefined;
    return {
      pointer,
      ...(contentType !== undefined ? { contentType } : {}),
      ...(object.payload !== undefined ? { payload: object.payload } : {}),
      ...(replacements ? { replacements } : {}),
      extensions,
      unknown,
    };
  }

  readOutputs(
    object: Record<string, unknown>,
    pointer: string,
    keep: Extensions,
  ): Record<string, unknown> | undefined {
    const outputs = this.record(object, "outputs", pointer, {
      max: ARAZZO_LIMITS.outputs,
      keyPattern: OUTPUT_KEY,
      impact: "blocks-operation",
      keep,
    });
    if (!outputs) return undefined;
    for (const [name, value] of Object.entries(outputs)) {
      const at = `${pointer}/outputs${jsonPointer(name)}`;
      if (typeof value === "string") {
        if (value.startsWith("$")) this.expression(value, at);
        else this.issue("arazzo.expression.invalid", at);
      } else if (isSelectorObject(value)) this.readSelector(value, at);
      else this.issue("arazzo.structure.invalid-type", at);
    }
    return outputs;
  }

  readStep(object: Record<string, unknown>, pointer: string): PreservedStep {
    const { extensions, unknown } = this.partition(
      object,
      pointer,
      STEP_FIELDS,
      "blocks-operation",
    );
    const impact: Impact = "blocks-operation";
    const stepId = this.identifier(object, "stepId", pointer, {
      required: true,
      impact,
      keep: unknown,
    });
    const text = (key: string, max: number) =>
      this.string(object, key, pointer, { max, impact, keep: unknown });
    const description = text("description", ARAZZO_LIMITS.text);
    const operationId = text("operationId", ARAZZO_LIMITS.expression);
    const operationPath = text("operationPath", ARAZZO_LIMITS.expression);
    const workflowId = text("workflowId", ARAZZO_LIMITS.expression);
    const channelPath = this.includes(v11)
      ? text("channelPath", ARAZZO_LIMITS.expression)
      : undefined;
    const correlationId = this.includes(v11)
      ? text("correlationId", ARAZZO_LIMITS.expression)
      : undefined;
    const action = this.includes(v11)
      ? text("action", ARAZZO_LIMITS.identifier)
      : undefined;
    this.enumerated(action, STEP_ACTIONS, `${pointer}/action`, impact);
    const timeout = this.includes(v11)
      ? this.number(object, "timeout", pointer, {
          integer: true,
          impact,
          keep: unknown,
        })
      : undefined;
    const parameters = this.readParameters(object, "parameters", pointer, unknown);
    let requestBody: PreservedRequestBody | undefined;
    if (object.requestBody !== undefined) {
      if (isPlainObject(object.requestBody))
        requestBody = this.readRequestBody(
          object.requestBody,
          `${pointer}/requestBody`,
        );
      else {
        this.issue("arazzo.structure.invalid-type", `${pointer}/requestBody`, {
          impact,
        });
        unknown.requestBody = object.requestBody;
      }
    }
    const successCriteria = this.readCriteria(
      object,
      "successCriteria",
      pointer,
      unknown,
    );
    const onSuccess = this.readActions<PreservedSuccessAction>(
      object,
      "onSuccess",
      pointer,
      "success",
      unknown,
    );
    const onFailure = this.readActions<PreservedFailureAction>(
      object,
      "onFailure",
      pointer,
      "failure",
      unknown,
    );
    const outputs = this.readOutputs(object, pointer, unknown);
    const dependsOnItems = this.includes(v11)
      ? this.array(object, "dependsOn", pointer, {
          max: ARAZZO_LIMITS.dependsOn,
          impact,
          keep: unknown,
        })
      : undefined;
    const dependsOn = dependsOnItems?.flatMap((item, index) => {
      if (typeof item === "string" && identifierStrictPattern.test(item))
        return [item];
      this.issue(
        typeof item === "string"
          ? "arazzo.structure.invalid-identifier"
          : "arazzo.structure.invalid-type",
        `${pointer}/dependsOn/${index}`,
        { impact },
      );
      return [];
    });
    return {
      pointer,
      stepId: stepId ?? "",
      ...(description !== undefined ? { description } : {}),
      ...(operationId !== undefined ? { operationId } : {}),
      ...(operationPath !== undefined ? { operationPath } : {}),
      ...(channelPath !== undefined ? { channelPath } : {}),
      ...(workflowId !== undefined ? { workflowId } : {}),
      ...(parameters ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      ...(successCriteria ? { successCriteria } : {}),
      ...(onSuccess ? { onSuccess } : {}),
      ...(onFailure ? { onFailure } : {}),
      ...(outputs ? { outputs } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
      ...(action !== undefined ? { action } : {}),
      ...(dependsOn ? { dependsOn } : {}),
      extensions,
      unknown,
    };
  }

  readWorkflow(
    object: Record<string, unknown>,
    pointer: string,
  ): PreservedWorkflow {
    const { extensions, unknown } = this.partition(
      object,
      pointer,
      WORKFLOW_FIELDS,
      "blocks-operation",
    );
    const impact: Impact = "blocks-operation";
    const workflowId = this.identifier(object, "workflowId", pointer, {
      required: true,
      impact,
      keep: unknown,
    });
    const summary = this.string(object, "summary", pointer, {
      max: ARAZZO_LIMITS.text,
      impact,
      keep: unknown,
    });
    const description = this.string(object, "description", pointer, {
      max: ARAZZO_LIMITS.text,
      impact,
      keep: unknown,
    });
    let inputs: unknown;
    if (object.inputs !== undefined) {
      if (isPlainObject(object.inputs) || typeof object.inputs === "boolean")
        inputs = object.inputs;
      else {
        this.issue("arazzo.structure.invalid-type", `${pointer}/inputs`, {
          impact,
        });
        unknown.inputs = object.inputs;
      }
    }
    const dependsOnItems = this.array(object, "dependsOn", pointer, {
      max: ARAZZO_LIMITS.dependsOn,
      impact,
      keep: unknown,
    });
    const dependsOn = dependsOnItems?.flatMap((item, index) => {
      if (typeof item === "string" && item.length <= ARAZZO_LIMITS.expression)
        return [item];
      this.issue("arazzo.structure.invalid-type", `${pointer}/dependsOn/${index}`, {
        impact,
      });
      return [];
    });
    const stepItems =
      this.array(object, "steps", pointer, {
        required: true,
        min: 1,
        max: ARAZZO_LIMITS.steps,
        impact,
        keep: unknown,
      }) ?? [];
    const steps = this.objectItems(stepItems, `${pointer}/steps`, impact, (item, at) =>
      this.readStep(item, at),
    );
    const successActions = this.readActions<PreservedSuccessAction>(
      object,
      "successActions",
      pointer,
      "success",
      unknown,
    );
    const failureActions = this.readActions<PreservedFailureAction>(
      object,
      "failureActions",
      pointer,
      "failure",
      unknown,
    );
    const outputs = this.readOutputs(object, pointer, unknown);
    const parameters = this.readParameters(object, "parameters", pointer, unknown);
    return {
      pointer,
      workflowId: workflowId ?? "",
      ...(summary !== undefined ? { summary } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(inputs !== undefined ? { inputs } : {}),
      ...(dependsOn ? { dependsOn } : {}),
      steps,
      ...(successActions ? { successActions } : {}),
      ...(failureActions ? { failureActions } : {}),
      ...(outputs ? { outputs } : {}),
      ...(parameters ? { parameters } : {}),
      extensions,
      unknown,
    };
  }

  readComponents(
    object: Record<string, unknown>,
    pointer: string,
  ): PreservedComponents {
    const { extensions, unknown } = this.partition(
      object,
      pointer,
      COMPONENTS_FIELDS,
      "blocks-operation",
    );
    const impact: Impact = "blocks-operation";
    const map = (key: string) =>
      this.record(object, key, pointer, {
        max: ARAZZO_LIMITS.components,
        keyPattern: COMPONENT_KEY,
        impact,
        keep: unknown,
      });
    const inputs = map("inputs");
    const readMap = <T>(
      key: string,
      read: (item: Record<string, unknown>, at: string) => T | undefined,
    ): Record<string, T> | undefined => {
      const entries = map(key);
      if (!entries) return undefined;
      const out: Record<string, T> = {};
      for (const [name, item] of Object.entries(entries)) {
        const at = `${pointer}${jsonPointer(key)}${jsonPointer(name)}`;
        if (!isPlainObject(item)) {
          this.issue("arazzo.structure.invalid-type", at, { impact });
          continue;
        }
        const value = read(item, at);
        if (value !== undefined) out[name] = value;
      }
      return out;
    };
    const parameters = readMap("parameters", (item, at) => {
      const parameter = this.readParameterOrReusable(item, at);
      if (parameter && isReusable(parameter)) {
        this.issue("arazzo.structure.invalid-type", at, { impact });
        return undefined;
      }
      return parameter;
    });
    const successActions = readMap("successActions", (item, at) => {
      const action = this.readAction(item, at, "success");
      if (action && isReusable(action)) {
        this.issue("arazzo.structure.invalid-type", at, { impact });
        return undefined;
      }
      return action as PreservedSuccessAction | undefined;
    });
    const failureActions = readMap("failureActions", (item, at) => {
      const action = this.readAction(item, at, "failure");
      if (action && isReusable(action)) {
        this.issue("arazzo.structure.invalid-type", at, { impact });
        return undefined;
      }
      return action as PreservedFailureAction | undefined;
    });
    return {
      pointer,
      ...(inputs ? { inputs } : {}),
      ...(parameters ? { parameters } : {}),
      ...(successActions ? { successActions } : {}),
      ...(failureActions ? { failureActions } : {}),
      extensions,
      unknown,
    };
  }

  // Cross-reference validation ------------------------------------------

  validate(document: PreservedArazzoDocument) {
    const sources = new Map<string, PreservedSourceDescription>();
    for (const source of document.sourceDescriptions) {
      if (sources.has(source.name))
        this.issue("arazzo.structure.duplicate-id", `${source.pointer}/name`);
      else sources.set(source.name, source);
    }
    const workflows = new Map<string, PreservedWorkflow>();
    for (const workflow of document.workflows) {
      if (!workflow.workflowId) continue;
      if (workflows.has(workflow.workflowId))
        this.issue(
          "arazzo.structure.duplicate-id",
          `${workflow.pointer}/workflowId`,
        );
      else workflows.set(workflow.workflowId, workflow);
    }
    const edges = new Map<string, string[]>();
    for (const workflow of document.workflows) {
      const targets = this.validateWorkflow(document, workflow, sources, workflows);
      edges.set(workflow.workflowId, targets);
    }
    for (const id of cycleMembers([...workflows.keys()], edges))
      this.issue("arazzo.dependency.cycle", workflows.get(id)!.pointer);
  }

  private sourceFor(
    expression: RuntimeExpression | undefined,
    pointer: string,
    sources: ReadonlyMap<string, PreservedSourceDescription>,
    kinds: readonly string[],
  ): PreservedSourceDescription | undefined {
    if (expression?.kind !== "sourceDescriptions") {
      this.issue("arazzo.expression.invalid", pointer);
      return undefined;
    }
    const source = sources.get(expression.source);
    if (!source) {
      this.issue("arazzo.reference.unknown-source-description", pointer);
      return undefined;
    }
    if (source.type !== undefined && !kinds.includes(source.type)) {
      this.issue("arazzo.reference.source-kind-mismatch", pointer);
      return undefined;
    }
    return source;
  }

  /** Local workflow id, or `$sourceDescriptions.<arazzo source>.<workflowId>`. Returns the local id when local. */
  private workflowReference(
    text: string,
    pointer: string,
    sources: ReadonlyMap<string, PreservedSourceDescription>,
    workflows: ReadonlyMap<string, PreservedWorkflow>,
  ): string | undefined {
    if (text.startsWith("$")) {
      const expression = parseRuntimeExpression(text);
      this.sourceFor(expression, pointer, sources, ["arazzo"]);
      return undefined;
    }
    if (!workflows.has(text)) {
      this.issue("arazzo.reference.unknown-workflow", pointer);
      return undefined;
    }
    return text;
  }

  private validateWorkflow(
    document: PreservedArazzoDocument,
    workflow: PreservedWorkflow,
    sources: ReadonlyMap<string, PreservedSourceDescription>,
    workflows: ReadonlyMap<string, PreservedWorkflow>,
  ): string[] {
    const targets: string[] = [];
    const steps = new Map<string, PreservedStep>();
    for (const step of workflow.steps) {
      if (!step.stepId) continue;
      if (steps.has(step.stepId))
        this.issue("arazzo.structure.duplicate-id", `${step.pointer}/stepId`);
      else steps.set(step.stepId, step);
    }
    workflow.dependsOn?.forEach((dependency, index) => {
      const at = `${workflow.pointer}/dependsOn/${index}`;
      if (dependency === workflow.workflowId) {
        this.issue("arazzo.dependency.self", at);
        return;
      }
      const local = this.workflowReference(dependency, at, sources, workflows);
      if (local) targets.push(local);
    });
    const parameterSites = (
      items: Array<PreservedParameter | PreservedReusable> | undefined,
      pointer: string,
      workflowStep: boolean,
    ) => {
      const seen = new Set<string>();
      items?.forEach((item, index) => {
        const at = `${pointer}/${index}`;
        const parameter = resolveParameter(item, document.components);
        if (!parameter) {
          this.issue(
            isReusable(item) &&
              parseRuntimeExpression(item.reference)?.kind === "components" &&
              (parseRuntimeExpression(item.reference) as {
                component: string;
              }).component !== "parameters"
              ? "arazzo.reference.component-kind-mismatch"
              : "arazzo.reference.unknown-component",
            `${at}/reference`,
          );
          return;
        }
        if (!workflowStep && parameter.in === undefined)
          this.issue("arazzo.step.parameter-location-missing", at);
        if (workflowStep && parameter.in !== undefined)
          this.issue("arazzo.step.parameter-location-ignored", at);
        const key = `${parameter.in ?? ""}:${parameter.name}`;
        if (seen.has(key)) this.issue("arazzo.structure.duplicate-parameter", at);
        seen.add(key);
      });
    };
    const expressions = new Map<string, ExpressionSite[]>();
    for (const step of workflow.steps) {
      const references = [
        step.operationId,
        step.operationPath,
        step.channelPath,
        step.workflowId,
      ].filter((item) => item !== undefined).length;
      if (references !== 1)
        this.issue("arazzo.step.operation-reference-count", step.pointer);
      if (step.operationId?.startsWith("$"))
        this.sourceFor(
          parseRuntimeExpression(step.operationId),
          `${step.pointer}/operationId`,
          sources,
          ["openapi", "asyncapi"],
        );
      if (step.operationPath !== undefined)
        this.validateSourcePath(
          step.operationPath,
          `${step.pointer}/operationPath`,
          sources,
          ["openapi", "asyncapi"],
        );
      if (step.channelPath !== undefined)
        this.validateSourcePath(
          step.channelPath,
          `${step.pointer}/channelPath`,
          sources,
          ["asyncapi"],
        );
      if (step.workflowId !== undefined) {
        const at = `${step.pointer}/workflowId`;
        if (step.workflowId === workflow.workflowId)
          this.issue("arazzo.dependency.self", at);
        else {
          const local = this.workflowReference(step.workflowId, at, sources, workflows);
          if (local) targets.push(local);
        }
      }
      parameterSites(
        step.parameters,
        `${step.pointer}/parameters`,
        step.workflowId !== undefined,
      );
      const actionTargets = (
        items:
          | Array<PreservedSuccessAction | PreservedFailureAction | PreservedReusable>
          | undefined,
        key: "onSuccess" | "onFailure",
      ) =>
        items?.forEach((item, index) => {
          const at = `${step.pointer}/${key}/${index}`;
          const action =
            key === "onSuccess"
              ? resolveSuccessAction(item, document.components)
              : resolveFailureAction(item, document.components);
          if (!action) {
            this.issue("arazzo.reference.unknown-component", `${at}/reference`);
            return;
          }
          if (action.stepId !== undefined && !steps.has(action.stepId))
            this.issue("arazzo.reference.unknown-step", `${at}/stepId`);
          if (action.workflowId !== undefined) {
            const local = this.workflowReference(
              action.workflowId,
              `${at}/workflowId`,
              sources,
              workflows,
            );
            if (local) targets.push(local);
          }
        });
      actionTargets(step.onSuccess, "onSuccess");
      actionTargets(step.onFailure, "onFailure");
      step.dependsOn?.forEach((dependency, index) => {
        const at = `${step.pointer}/dependsOn/${index}`;
        if (dependency === step.stepId) this.issue("arazzo.dependency.self", at);
        else if (!steps.has(dependency))
          this.issue("arazzo.reference.unknown-step", at);
      });
      const sites = stepExpressions(step, step.pointer, document.components);
      expressions.set(step.stepId, sites);
      for (const site of sites)
        this.validateSite(site, step, steps, sources, workflows);
    }
    parameterSites(workflow.parameters, `${workflow.pointer}/parameters`, false);
    for (const [name, value] of Object.entries(workflow.outputs ?? {}))
      for (const site of valueExpressions(
        value,
        `${workflow.pointer}/outputs${jsonPointer(name)}`,
        "output",
      ))
        this.validateSite(site, undefined, steps, sources, workflows);
    const graph = stepGraph(workflow, expressions);
    for (const id of graph.cyclic)
      this.issue("arazzo.dependency.cycle", steps.get(id)?.pointer ?? workflow.pointer);
    if (graph.sequential) {
      const index = new Map(workflow.steps.map((step, at) => [step.stepId, at]));
      for (const step of workflow.steps)
        for (const site of expressions.get(step.stepId) ?? [])
          if (
            site.expression?.kind === "steps" &&
            index.has(site.expression.stepId) &&
            index.get(site.expression.stepId)! > index.get(step.stepId)!
          )
            this.issue("arazzo.reference.forward-step-output", site.pointer);
    }
    return targets;
  }

  private validateSourcePath(
    text: string,
    pointer: string,
    sources: ReadonlyMap<string, PreservedSourceDescription>,
    kinds: readonly string[],
  ) {
    const parsed = parseSourcePath(text);
    if (!parsed) {
      this.issue(
        text.startsWith("{$sourceDescriptions.")
          ? "arazzo.expression.invalid"
          : "arazzo.identity.operation-path-not-source-relative",
        pointer,
      );
      return;
    }
    this.sourceFor(
      { kind: "sourceDescriptions", source: parsed.source, reference: "url" },
      pointer,
      sources,
      kinds,
    );
  }

  private validateSite(
    site: ExpressionSite,
    step: PreservedStep | undefined,
    steps: ReadonlyMap<string, PreservedStep>,
    sources: ReadonlyMap<string, PreservedSourceDescription>,
    workflows: ReadonlyMap<string, PreservedWorkflow>,
  ) {
    if (site.invalid || !site.expression) {
      this.issue("arazzo.expression.invalid", site.pointer);
      return;
    }
    const expression = site.expression;
    if (!this.includes(expressionSince(expression))) {
      this.issue("arazzo.version.field-unavailable", site.pointer);
      return;
    }
    switch (expression.kind) {
      case "steps": {
        if (step && expression.stepId === step.stepId) {
          this.issue("arazzo.dependency.self", site.pointer);
          return;
        }
        const target = steps.get(expression.stepId);
        if (!target) {
          this.issue("arazzo.reference.unknown-step", site.pointer);
          return;
        }
        if (target.workflowId !== undefined) {
          const local = workflows.get(target.workflowId);
          if (local && !Object.hasOwn(local.outputs ?? {}, expression.name))
            this.issue("arazzo.reference.unknown-step-output", site.pointer);
        } else if (!Object.hasOwn(target.outputs ?? {}, expression.name))
          this.issue("arazzo.reference.unknown-step-output", site.pointer);
        return;
      }
      case "workflows":
        if (!workflows.has(expression.workflowId))
          this.issue("arazzo.reference.unknown-workflow", site.pointer);
        return;
      case "sourceDescriptions":
        if (!sources.has(expression.source))
          this.issue("arazzo.reference.unknown-source-description", site.pointer);
        return;
      default:
        return;
    }
  }
}

/** `{$sourceDescriptions.<name>.url}#<json-pointer>`; anything else is not source-relative. */
export function parseSourcePath(
  text: string,
): { source: string; pointer: string } | undefined {
  if (!text.startsWith("{")) return undefined;
  const close = text.indexOf("}");
  if (close === -1) return undefined;
  const expression = parseRuntimeExpression(text.slice(1, close));
  if (
    !expression ||
    expression.kind !== "sourceDescriptions" ||
    expression.reference !== "url"
  )
    return undefined;
  const rest = text.slice(close + 1);
  if (!rest.startsWith("#")) return undefined;
  const pointer = rest.slice(1);
  if (!validJsonPointer(pointer) || pointer === "") return undefined;
  return { source: expression.source, pointer };
}

export interface ReadArazzoOptions {
  sourceRef?: string;
  definitionRef?: string;
  authorityNamespace?: string;
  nativeId?: string;
}

export interface ArazzoReadResult {
  /** The version string exactly as declared (display-sanitized), never rewritten. */
  declaredVersion?: string;
  version?: ArazzoVersion;
  profile?: string;
  document?: PreservedArazzoDocument;
  definition?: NormalizedDefinition;
  issues: CompatibilityIssue[];
  /** SHA-256 of the canonical JSON of the bounded input value. */
  digest?: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function declaredServers(
  document: PreservedArazzoDocument,
  issues: CompatibilityIssue[],
): NormalizedDefinition["declaredServers"] {
  const servers: NormalizedDefinition["declaredServers"] = [];
  for (const source of document.sourceDescriptions) {
    if (source.type === undefined) {
      issues.push(arazzoIssue("arazzo.source.type-missing", `${source.pointer}/type`));
      continue;
    }
    if (source.type !== "openapi") continue;
    if (!URL.canParse(source.url)) {
      issues.push(arazzoIssue("arazzo.source.url-relative", `${source.pointer}/url`));
      continue;
    }
    const url = new URL(source.url);
    if (url.username || url.password) {
      issues.push(arazzoIssue("arazzo.source.url-credentials", `${source.pointer}/url`));
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    servers.push({
      url: source.url,
      description: displayText(`${source.name} OpenAPI source description`, 500),
      status: "declared",
    });
  }
  return servers;
}

function buildDefinition(
  document: PreservedArazzoDocument,
  issues: CompatibilityIssue[],
  digest: string,
  options: ReadArazzoOptions,
): NormalizedDefinition | undefined {
  const capabilities: NormalizedDefinition["capabilities"] = [];
  document.workflows.forEach((workflow, index) => {
    const candidate = nativeCapabilitySchema.safeParse({
      kind: "custom",
      nativeId: workflow.workflowId,
      ...(workflow.summary && displayText(workflow.summary, 200)
        ? { label: displayText(workflow.summary, 200) }
        : {}),
      ...(workflow.description && displayText(workflow.description, 500)
        ? { summary: displayText(workflow.description, 500) }
        : {}),
      effect: "unknown",
      dataClassification: "unknown",
      cost: "unknown",
      ...(workflow.inputs !== undefined
        ? { inputSchemaRef: `/workflows/${index}/inputs` }
        : {}),
      ...(Object.keys(workflow.extensions).length &&
      Object.keys(workflow.extensions).length <= ARAZZO_LIMITS.extensions
        ? { nativeExtensions: workflow.extensions }
        : {}),
    });
    if (candidate.success) capabilities.push(candidate.data);
    else
      issues.push(
        arazzoIssue("arazzo.identity.reserved-identifier", `${workflow.pointer}/workflowId`),
      );
  });
  const servers = declaredServers(document, issues);
  const nativeId =
    [options.nativeId, document.self, document.info.title].find(
      (candidate) =>
        candidate !== undefined && nativeIdentifierSchema.safeParse(candidate).success,
    ) ?? `arazzo-${digest.slice(0, 16)}`;
  const nativeVersion = nativeVersionSchema.safeParse(document.info.version).success
    ? document.info.version
    : "unknown";
  const extensionEntries = Object.entries(document.extensions).filter(
    ([key]) => key.length <= 120,
  );
  if (extensionEntries.length > ARAZZO_LIMITS.extensions)
    issues.push(arazzoIssue("arazzo.structure.extension-limit", "/"));
  const blocked = issues.some(
    (issue) =>
      issue.severity === "blocking" && issue.executionImpact === "blocks-definition",
  );
  const kept =
    issues.length > DEFINITION_LIMITS.issues
      ? [
          ...issues.slice(0, DEFINITION_LIMITS.issues - 1),
          arazzoIssue("arazzo.structure.issue-limit", "/"),
        ]
      : [...issues];
  const body = {
    schemaVersion: 1 as const,
    identity: {
      ecosystem: "arazzo",
      authorityNamespace: options.authorityNamespace ?? "",
      nativeId,
      nativeVersion,
    },
    sourceRef: options.sourceRef ?? `arazzo:src:${digest.slice(0, 32)}`,
    importer: { id: ARAZZO_IMPORTER.id, version: ARAZZO_IMPORTER.version },
    display: {
      name: displayText(document.info.title, 200) || "Arazzo description",
      description: displayText(
        document.info.summary ?? document.info.description ?? "",
        500,
      ),
      ecosystem: "arazzo",
    },
    authentication: [],
    configuration: [],
    capabilities,
    events: [],
    declaredServers: servers.slice(0, 32),
    compatibility: {
      issues: kept,
      dimensions: completeDimensions({
        import: blocked ? "rejected" : "exact",
        export: "exact",
        invoke: "requires-configuration",
      }),
    },
    nativeExtensions: Object.fromEntries(
      extensionEntries.slice(0, ARAZZO_LIMITS.extensions),
    ),
  };
  const parsed = normalizedDefinitionSchema.safeParse({
    ...body,
    definitionRef: options.definitionRef ?? `arazzo:def:${digest.slice(0, 32)}`,
    normalizedDigest: sha256(canonicalConnectorJson(body)),
  });
  if (parsed.success) return parsed.data;
  issues.push(arazzoIssue("arazzo.definition.unprojectable", "/"));
  return undefined;
}

/**
 * Reads one already-parsed JSON value as an Arazzo description. Text parsing
 * (JSON or YAML) belongs to the import pipeline's bounded parsers; this
 * function bounds the value again before touching it.
 */
export function readArazzo(
  document: unknown,
  options: ReadArazzoOptions = {},
): ArazzoReadResult {
  const measured = measureJsonValue(document, READ_BOUNDS);
  if (!measured.ok)
    return {
      issues: [
        arazzoIssue(
          measured.reason === "reserved-key"
            ? "arazzo.structure.reserved-key"
            : measured.reason === "not-json"
              ? "arazzo.structure.unsupported-value"
              : "arazzo.structure.limit-exceeded",
          "/",
        ),
      ],
    };
  const source: unknown = structuredClone(document);
  const digest = sha256(canonicalConnectorJson(source));
  if (!isPlainObject(source))
    return { issues: [arazzoIssue("arazzo.structure.not-object", "/")], digest };
  const declared = source.arazzo;
  if (typeof declared !== "string")
    return { issues: [arazzoIssue("arazzo.version.missing", "/arazzo")], digest };
  const declaredVersion = displayText(declared, 128);
  if (!isArazzoVersion(declared))
    return {
      declaredVersion,
      issues: [arazzoIssue("arazzo.version.unsupported", "/arazzo")],
      digest,
    };
  const reader = new Reader(declared);
  const preserved = reader.readDocument(source);
  reader.validate(preserved);
  const definition = buildDefinition(preserved, reader.issues, digest, options);
  return {
    declaredVersion,
    version: declared,
    profile: ARAZZO_PROFILES[declared],
    document: preserved,
    ...(definition ? { definition } : {}),
    issues: reader.issues,
    digest,
  };
}
