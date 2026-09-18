import type {
  CompatibilityIssue,
  NativeCapability,
} from "../../../../core/connectors/contracts.js";
import { parseBoundedJsonText } from "./json.js";
import {
  AGENTCORE_TOOL_DELIMITER,
  toolDefinitionSchema,
  type GetGatewayTargetResponse,
} from "./schemas.js";

/*
 * What a target can actually become.
 *
 * AgentCore Gateway converts OpenAPI schemas, Lambda functions, Smithy models
 * and remote MCP servers into tools, but it does not accept every document:
 * https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-schema-openapi.html
 * (retrieved 2026-09-18) lists the supported and unsupported OpenAPI features,
 * and https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-lambda.html
 * (retrieved 2026-09-18) gives the required tool-definition shape. Assuming
 * every imported operation becomes a tool is exactly the failure this module
 * exists to prevent: an operation the gateway will reject is reported as a
 * blocking compatibility issue while the rest of the target stays visible.
 *
 * Nothing here executes or fetches anything. A schema stored in Amazon S3 is
 * not retrieved: S3 is not an approved destination of this binding, and a
 * target whose schema cannot be read is reported as unverifiable rather than
 * assumed compatible.
 */

/** Media types the gateway documents as supported for request and response bodies. */
const SUPPORTED_MEDIA_TYPES = new Set([
  "application/json",
  "application/xml",
  "multipart/form-data",
  "application/x-www-form-urlencoded",
]);
const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);
const COMPOSITION_KEYWORDS = ["oneOf", "anyOf", "allOf"] as const;

export type TargetKind =
  | "openapi"
  | "smithy"
  | "lambda"
  | "mcp-server"
  | "api-gateway"
  | "connector"
  | "http"
  | "inference"
  | "unknown";

export type TargetAnalysis = {
  targetId: string;
  targetName: string;
  kind: TargetKind;
  /** Fully namespaced tool names (`${target}___${tool}`) this target can expose. */
  toolNames: string[];
  capabilities: NativeCapability[];
  issues: CompatibilityIssue[];
  /** True when nothing on this target can be bound as a tool without operator action. */
  blocked: boolean;
  /** The target reaches a VPC-private endpoint and needs an administrator-approved network policy. */
  privateEndpoint: boolean;
  outboundCredential: string | undefined;
};

function issue(
  input: Pick<CompatibilityIssue, "code" | "category" | "message"> &
    Partial<CompatibilityIssue> & { sourcePointer: string },
): CompatibilityIssue {
  return {
    dimension: "import",
    disposition: "unsupported",
    severity: "blocking",
    executionImpact: "blocks-operation",
    ...input,
  } as CompatibilityIssue;
}

/** `${target_name}___${tool_name}`, the only namespacing the gateway documents. */
export function gatewayToolName(targetName: string, toolName: string): string {
  return `${targetName}${AGENTCORE_TOOL_DELIMITER}${toolName}`;
}

/** Splits a namespaced tool name; a name without the delimiter belongs to no target. */
export function splitGatewayToolName(
  name: string,
): { targetName: string; toolName: string } | undefined {
  const index = name.indexOf(AGENTCORE_TOOL_DELIMITER);
  if (index <= 0) return undefined;
  const toolName = name.slice(index + AGENTCORE_TOOL_DELIMITER.length);
  if (!toolName) return undefined;
  return { targetName: name.slice(0, index), toolName };
}

function hasComposition(value: unknown, depth = 0): string | undefined {
  if (depth > 24 || !value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = hasComposition(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const keyword of COMPOSITION_KEYWORDS)
    if (Object.hasOwn(record, keyword)) return keyword;
  for (const item of Object.values(record)) {
    const found = hasComposition(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** A server URL whose host itself is a template can be pointed anywhere. */
function unconstrainedHost(url: string): boolean {
  const withoutScheme = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  const host = withoutScheme.split("/")[0] ?? "";
  return /\{[^}]*\}/.test(host);
}

export type OpenApiAnalysis = {
  operationIds: string[];
  issues: CompatibilityIssue[];
  blocked: boolean;
};

/**
 * Analyzes an inline OpenAPI document against the gateway's documented
 * support. The document is untrusted input: it is parsed within bounds and
 * never dereferenced, fetched or evaluated.
 */
export function analyzeOpenApiSchema(
  text: string,
  pointerBase: string,
): OpenApiAnalysis {
  const issues: CompatibilityIssue[] = [];
  let document: unknown;
  try {
    document = parseBoundedJsonText(text);
  } catch {
    issues.push(
      issue({
        code: "agentcore.openapi.unreadable",
        category: "serialization",
        sourcePointer: pointerBase,
        executionImpact: "blocks-definition",
        message:
          "The inline OpenAPI schema is not bounded JSON this importer can read.",
        remediation:
          "Provide the schema as JSON within the import bounds, or bind tools from the gateway's tool list.",
      }),
    );
    return { operationIds: [], issues, blocked: true };
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    issues.push(
      issue({
        code: "agentcore.openapi.not-a-document",
        category: "structure",
        sourcePointer: pointerBase,
        executionImpact: "blocks-definition",
        message: "The inline OpenAPI schema is not an object.",
      }),
    );
    return { operationIds: [], issues, blocked: true };
  }
  const root = document as Record<string, unknown>;
  if (typeof root["swagger"] === "string") {
    issues.push(
      issue({
        code: "agentcore.openapi.swagger-2",
        category: "version",
        sourcePointer: `${pointerBase}/swagger`,
        executionImpact: "blocks-definition",
        message:
          "AgentCore Gateway supports OpenAPI 3.0 and 3.1; Swagger 2.0 is not supported.",
        remediation: "Convert the description to OpenAPI 3.0 or 3.1.",
      }),
    );
    return { operationIds: [], issues, blocked: true };
  }
  const version = root["openapi"];
  if (typeof version !== "string" || !/^3\.[01](\.\d+)?$/.test(version)) {
    issues.push(
      issue({
        code: "agentcore.openapi.version-unsupported",
        category: "version",
        sourcePointer: `${pointerBase}/openapi`,
        executionImpact: "blocks-definition",
        message:
          "AgentCore Gateway supports OpenAPI 3.0 and 3.1 schema versions only.",
      }),
    );
    return { operationIds: [], issues, blocked: true };
  }
  const servers = Array.isArray(root["servers"]) ? root["servers"] : [];
  if (servers.length === 0)
    issues.push(
      issue({
        code: "agentcore.openapi.server-missing",
        category: "structure",
        sourcePointer: `${pointerBase}/servers`,
        executionImpact: "blocks-definition",
        message:
          "The server attribute must carry a valid URL of the actual endpoint.",
      }),
    );
  servers.forEach((server, index) => {
    const url =
      server && typeof server === "object"
        ? (server as Record<string, unknown>)["url"]
        : undefined;
    if (typeof url !== "string") return;
    if (unconstrainedHost(url))
      issues.push(
        issue({
          code: "agentcore.openapi.server-host-templated",
          category: "security",
          sourcePointer: `${pointerBase}/servers/${index}/url`,
          disposition: "rejected",
          executionImpact: "blocks-definition",
          message:
            "A server URL whose host is a template allows arbitrary domain substitution.",
          remediation:
            "Use a fully qualified static URL, or restrict variables with an enum inside a controlled domain.",
        }),
      );
  });
  const components = root["components"];
  const securitySchemes =
    components && typeof components === "object"
      ? (components as Record<string, unknown>)["securitySchemes"]
      : undefined;
  if (
    (Array.isArray(root["security"]) && root["security"].length > 0) ||
    (securitySchemes &&
      typeof securitySchemes === "object" &&
      Object.keys(securitySchemes).length > 0)
  )
    issues.push(
      issue({
        code: "agentcore.openapi.security-scheme",
        category: "security",
        sourcePointer: `${pointerBase}/components/securitySchemes`,
        dimension: "authorize",
        executionImpact: "blocks-authorization",
        message:
          "Security schemes at the specification level are not supported; the gateway's outbound authorization configuration carries authentication.",
        remediation:
          "Configure an AgentCore credential provider for the target instead.",
      }),
    );

  const operationIds: string[] = [];
  const paths = root["paths"];
  if (paths && typeof paths === "object" && !Array.isArray(paths))
    for (const [path, item] of Object.entries(
      paths as Record<string, unknown>,
    )) {
      if (!item || typeof item !== "object") continue;
      for (const [method, operation] of Object.entries(
        item as Record<string, unknown>,
      )) {
        if (!HTTP_METHODS.has(method.toLowerCase())) continue;
        if (!operation || typeof operation !== "object") continue;
        const record = operation as Record<string, unknown>;
        const pointer = `${pointerBase}/paths${path}/${method}`;
        const operationId = record["operationId"];
        let blocked = false;
        if (typeof operationId !== "string" || operationId.length === 0) {
          issues.push(
            issue({
              code: "agentcore.openapi.operation-id-missing",
              category: "structure",
              sourcePointer: pointer,
              message:
                "Every operation exposed as a tool must declare an operationId; it becomes the tool name.",
            }),
          );
          continue;
        }
        const parameters = Array.isArray(record["parameters"])
          ? record["parameters"]
          : [];
        for (const parameter of parameters) {
          if (!parameter || typeof parameter !== "object") continue;
          const parameterRecord = parameter as Record<string, unknown>;
          if (
            parameterRecord["style"] !== undefined ||
            parameterRecord["explode"] !== undefined
          ) {
            issues.push(
              issue({
                code: "agentcore.openapi.parameter-serializer",
                category: "serialization",
                sourcePointer: `${pointer}/parameters`,
                message:
                  "Parameter serializers for path, query, header and cookie parameters are not supported.",
              }),
            );
            blocked = true;
            break;
          }
        }
        const requestBody = record["requestBody"];
        if (requestBody && typeof requestBody === "object") {
          const content = (requestBody as Record<string, unknown>)["content"];
          if (content && typeof content === "object")
            for (const mediaType of Object.keys(
              content as Record<string, unknown>,
            ))
              if (!SUPPORTED_MEDIA_TYPES.has(mediaType.split(";")[0]!.trim())) {
                issues.push(
                  issue({
                    code: "agentcore.openapi.media-type",
                    category: "serialization",
                    sourcePointer: `${pointer}/requestBody/content`,
                    message:
                      "Only the documented media types are supported; custom and binary media types are not.",
                  }),
                );
                blocked = true;
              }
        }
        const composition = hasComposition(record);
        if (composition) {
          issues.push(
            issue({
              code: "agentcore.openapi.schema-composition",
              category: "schema",
              sourcePointer: pointer,
              message:
                "Schema composition with oneOf, anyOf or allOf is not supported by the gateway.",
            }),
          );
          blocked = true;
        }
        if (record["callbacks"] !== undefined)
          issues.push(
            issue({
              code: "agentcore.openapi.callbacks",
              category: "structure",
              sourcePointer: `${pointer}/callbacks`,
              severity: "warning",
              executionImpact: "none",
              message:
                "Callback operations are not supported; the operation itself is unaffected.",
            }),
          );
        if (!blocked) operationIds.push(operationId);
      }
    }
  if (operationIds.length === 0 && issues.length === 0)
    issues.push(
      issue({
        code: "agentcore.openapi.no-operations",
        category: "structure",
        sourcePointer: `${pointerBase}/paths`,
        severity: "warning",
        executionImpact: "none",
        disposition: "requires-configuration",
        message: "The schema declares no operation that could become a tool.",
      }),
    );
  return { operationIds, issues, blocked: operationIds.length === 0 };
}

function capabilityFor(
  toolName: string,
  summary: string | undefined,
): NativeCapability {
  return {
    kind: "mcp-tool",
    nativeId: toolName,
    label: toolName.slice(0, 200),
    ...(summary ? { summary: summary.slice(0, 500) } : {}),
    /*
     * A gateway tool's effect is not declared anywhere the gateway exposes:
     * an OpenAPI GET may still cost money and a Lambda may write. The host's
     * bound operation decides; the description says "unknown" rather than
     * guessing from the HTTP method or the tool name.
     */
    effect: "unknown",
    dataClassification: "unknown",
    cost: "unknown",
  };
}

/** Analyzes one target read from `GetGatewayTarget`. */
export function analyzeTarget(
  target: GetGatewayTargetResponse,
): TargetAnalysis {
  const issues: CompatibilityIssue[] = [];
  const pointer = `/targets/${target.targetId}`;
  const outbound = target.credentialProviderConfigurations?.[0];
  const privateEndpoint = Boolean(
    target.privateEndpoint ??
      (target.privateEndpointManagedResources?.length ?? 0) > 0,
  );
  if (privateEndpoint)
    issues.push(
      issue({
        code: "agentcore.target.private-endpoint",
        category: "network",
        sourcePointer: `${pointer}/privateEndpoint`,
        dimension: "invoke",
        disposition: "requires-configuration",
        severity: "warning",
        executionImpact: "blocks-operation",
        message:
          "The target reaches a VPC-private endpoint; only an administrator-approved private network policy may bind it.",
      }),
    );
  if (outbound?.credentialProviderType === "JWT_PASSTHROUGH")
    issues.push(
      issue({
        code: "agentcore.target.jwt-passthrough",
        category: "security",
        sourcePointer: `${pointer}/credentialProviderConfigurations/0`,
        dimension: "invoke",
        disposition: "native-extension",
        severity: "warning",
        executionImpact: "none",
        message:
          "The gateway forwards the inbound token to this target unchanged; the same token is accepted by both.",
        remediation:
          "Prefer an on-behalf-of exchange or a target-scoped credential provider.",
      }),
    );
  if (target.status !== "READY")
    issues.push(
      issue({
        code: "agentcore.target.not-ready",
        category: "policy",
        sourcePointer: `${pointer}/status`,
        dimension: "invoke",
        disposition: "requires-configuration",
        severity: "warning",
        executionImpact: "blocks-operation",
        message:
          "The target is not READY; its tools are not guaranteed to be listed or callable.",
      }),
    );

  const base: Omit<TargetAnalysis, "kind" | "toolNames" | "capabilities"> = {
    targetId: target.targetId,
    targetName: target.name,
    issues,
    blocked: true,
    privateEndpoint,
    outboundCredential: outbound?.credentialProviderType,
  };

  const configuration = target.targetConfiguration;
  if (configuration?.http !== undefined)
    return {
      ...base,
      kind: "http",
      toolNames: [],
      capabilities: [],
      issues: [
        ...issues,
        issue({
          code: "agentcore.target.http-passthrough",
          category: "structure",
          sourcePointer: `${pointer}/targetConfiguration/http`,
          dimension: "invoke",
          message:
            "HTTP targets are proxied by path-based routing and are not aggregated into the gateway's tool list.",
        }),
      ],
    };
  if (configuration?.inference !== undefined)
    return {
      ...base,
      kind: "inference",
      toolNames: [],
      capabilities: [],
      issues: [
        ...issues,
        issue({
          code: "agentcore.target.inference",
          category: "structure",
          sourcePointer: `${pointer}/targetConfiguration/inference`,
          dimension: "invoke",
          message:
            "Inference targets route model traffic and expose no MCP tools.",
        }),
      ],
    };
  const mcp = configuration?.mcp;
  if (!mcp)
    return {
      ...base,
      kind: "unknown",
      toolNames: [],
      capabilities: [],
      issues: [
        ...issues,
        issue({
          code: "agentcore.target.configuration-unknown",
          category: "structure",
          sourcePointer: `${pointer}/targetConfiguration`,
          dimension: "import",
          disposition: "requires-configuration",
          severity: "warning",
          executionImpact: "blocks-operation",
          message:
            "The target configuration is not one this importer recognizes; read the gateway's tool list before binding.",
        }),
      ],
    };

  if (mcp.openApiSchema) {
    if (typeof mcp.openApiSchema.inlinePayload === "string") {
      const analysis = analyzeOpenApiSchema(
        mcp.openApiSchema.inlinePayload,
        `${pointer}/targetConfiguration/mcp/openApiSchema`,
      );
      const toolNames = analysis.operationIds.map((operationId) =>
        gatewayToolName(target.name, operationId),
      );
      return {
        ...base,
        kind: "openapi",
        toolNames,
        capabilities: toolNames.map((name) => capabilityFor(name, undefined)),
        issues: [...issues, ...analysis.issues],
        blocked: analysis.blocked,
      };
    }
    return {
      ...base,
      kind: "openapi",
      toolNames: [],
      capabilities: [],
      issues: [
        ...issues,
        issue({
          code: "agentcore.target.schema-in-s3",
          category: "structure",
          sourcePointer: `${pointer}/targetConfiguration/mcp/openApiSchema/s3`,
          disposition: "requires-configuration",
          severity: "warning",
          executionImpact: "blocks-operation",
          message:
            "The schema lives in Amazon S3, which this binding does not approve as a destination; tool identities must come from the gateway's tool list.",
        }),
      ],
    };
  }
  if (mcp.lambda) {
    const inline = mcp.lambda.toolSchema?.inlinePayload;
    if (!inline)
      return {
        ...base,
        kind: "lambda",
        toolNames: [],
        capabilities: [],
        issues: [
          ...issues,
          issue({
            code: "agentcore.target.schema-in-s3",
            category: "structure",
            sourcePointer: `${pointer}/targetConfiguration/mcp/lambda/toolSchema`,
            disposition: "requires-configuration",
            severity: "warning",
            executionImpact: "blocks-operation",
            message:
              "The Lambda tool schema is not inline; tool identities must come from the gateway's tool list.",
          }),
        ],
      };
    const toolNames: string[] = [];
    const capabilities: NativeCapability[] = [];
    const lambdaIssues: CompatibilityIssue[] = [];
    inline.forEach((raw, index) => {
      const parsed = toolDefinitionSchema.safeParse(raw);
      const pointerAt = `${pointer}/targetConfiguration/mcp/lambda/toolSchema/inlinePayload/${index}`;
      if (!parsed.success || !parsed.data.name) {
        lambdaIssues.push(
          issue({
            code: "agentcore.lambda.tool-name-missing",
            category: "structure",
            sourcePointer: pointerAt,
            message: "A Lambda tool definition must declare a name.",
          }),
        );
        return;
      }
      const definition = parsed.data;
      const input = definition.inputSchema as
        | Record<string, unknown>
        | undefined;
      if (!definition.description) {
        lambdaIssues.push(
          issue({
            code: "agentcore.lambda.tool-description-missing",
            category: "structure",
            sourcePointer: pointerAt,
            message:
              "A Lambda tool definition must declare a description; it is a required field.",
          }),
        );
        return;
      }
      if (!input || input["type"] !== "object") {
        lambdaIssues.push(
          issue({
            code: "agentcore.lambda.input-schema-invalid",
            category: "schema",
            sourcePointer: `${pointerAt}/inputSchema`,
            message:
              "A Lambda tool definition must declare an object-typed inputSchema.",
          }),
        );
        return;
      }
      const composition = hasComposition(definition.inputSchema);
      if (composition) {
        lambdaIssues.push(
          issue({
            code: "agentcore.lambda.schema-composition",
            category: "schema",
            sourcePointer: `${pointerAt}/inputSchema`,
            message:
              "Schema composition with oneOf, anyOf or allOf is not supported by the gateway.",
          }),
        );
        return;
      }
      const name = gatewayToolName(target.name, definition.name);
      toolNames.push(name);
      capabilities.push(capabilityFor(name, definition.description));
    });
    return {
      ...base,
      kind: "lambda",
      toolNames,
      capabilities,
      issues: [...issues, ...lambdaIssues],
      blocked: toolNames.length === 0,
    };
  }
  const deferred = (
    kind: TargetKind,
    code: string,
    message: string,
    at: string,
  ): TargetAnalysis => ({
    ...base,
    kind,
    toolNames: [],
    capabilities: [],
    issues: [
      ...issues,
      issue({
        code,
        category: "structure",
        sourcePointer: `${pointer}/targetConfiguration/mcp/${at}`,
        disposition: "requires-configuration",
        severity: "warning",
        executionImpact: "blocks-operation",
        message,
      }),
    ],
  });
  if (mcp.smithyModel)
    return deferred(
      "smithy",
      "agentcore.target.smithy-not-enumerated",
      "Smithy model targets are synchronized by the gateway; tool identities must come from the gateway's tool list.",
      "smithyModel",
    );
  if (mcp.mcpServer)
    return deferred(
      "mcp-server",
      "agentcore.target.mcp-server-synchronized",
      "Remote MCP server targets are discovered by synchronization; tool identities must come from the gateway's tool list.",
      "mcpServer",
    );
  if (mcp.apiGateway !== undefined)
    return deferred(
      "api-gateway",
      "agentcore.target.api-gateway-not-enumerated",
      "Amazon API Gateway targets are synchronized by the gateway; tool identities must come from the gateway's tool list.",
      "apiGateway",
    );
  if (mcp.connector !== undefined)
    return deferred(
      "connector",
      "agentcore.target.connector-not-enumerated",
      "Built-in connector targets are synchronized by the gateway; tool identities must come from the gateway's tool list.",
      "connector",
    );
  return deferred(
    "unknown",
    "agentcore.target.configuration-unknown",
    "The MCP target configuration is not one this importer recognizes; read the gateway's tool list before binding.",
    "",
  );
}
