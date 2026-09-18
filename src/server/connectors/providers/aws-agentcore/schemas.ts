import { z } from "zod";

/*
 * Wire shapes of the Amazon Bedrock AgentCore control plane, pinned to the
 * documented API (`bedrock-agentcore-control-2023-06-05`) and read on
 * 2026-09-18 from:
 *
 * - https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_ListGateways.html
 * - https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_GetGateway.html
 * - https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_ListGatewayTargets.html
 * - https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_GetGatewayTarget.html
 * - https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_TargetConfiguration.html
 * - https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_McpTargetConfiguration.html
 * - https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_ApiSchemaConfiguration.html
 * - https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_McpLambdaTargetConfiguration.html
 * - https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_McpServerTargetConfiguration.html
 * - https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CredentialProviderConfiguration.html
 *
 * Responses are parsed, never trusted: unknown members are dropped rather than
 * forwarded, and every identifier keeps its documented pattern so a response
 * cannot smuggle a path segment, a URL or a control character into a later
 * request. The patterns are the ones AWS publishes, quoted unchanged.
 */

export const AGENTCORE_ADAPTER_VERSION = "1.0.0";
/** The control-plane API this client speaks, as named in the AWS SDK links. */
export const AGENTCORE_CONTROL_API_VERSION = "2023-06-05";
export const AGENTCORE_CONTROL_PROFILE = "aws-agentcore-control-2023-06-05";
/** The MCP revision this adapter speaks to a gateway. */
export const AGENTCORE_MCP_PROTOCOL_VERSION = "2026-07-28";
export const AGENTCORE_MCP_PROFILE = "aws-agentcore-gateway-mcp-2026-07-28";
/**
 * Other revisions the gateway accepts (`supportedVersions` of
 * `protocolConfiguration.mcp`). This adapter does not speak them: they use the
 * `initialize` handshake and a session, which belongs to the MCP runtime
 * client, not to a provider adapter that would otherwise reimplement it.
 */
export const AGENTCORE_MCP_LEGACY_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
] as const;
/** `${target_name}___${tool_name}`; documented in "Understand how AgentCore Gateway tools are named". */
export const AGENTCORE_TOOL_DELIMITER = "___";
/** Listed first by `tools/list` when semantic search is enabled on the gateway. */
export const AGENTCORE_SEARCH_TOOL = "x_amz_bedrock_agentcore_search";
/** Default signing service name; unverified against a published endpoint table, so it stays configurable. */
export const AGENTCORE_DEFAULT_SIGNING_SERVICE = "bedrock-agentcore";

export const gatewayIdentifierSchema = z
  .string()
  .regex(/^([0-9a-z][-]?){1,100}-[0-9a-z]{10}$/);
export const targetIdSchema = z.string().regex(/^[0-9a-zA-Z]{10}$/);
export const gatewayNameSchema = z.string().regex(/^([0-9a-zA-Z][-]?){1,48}$/);
export const targetNameSchema = z.string().regex(/^([0-9a-zA-Z][-]?){1,100}$/);
export const gatewayArnSchema = z
  .string()
  .regex(
    /^arn:aws(|-cn|-us-gov):bedrock-agentcore:[a-z0-9-]{1,20}:[0-9]{12}:gateway\/([0-9a-z][-]?){1,48}-[a-z0-9]{10}$/,
  );
export const lambdaArnSchema = z
  .string()
  .max(170)
  .regex(
    /^arn:(aws[a-zA-Z-]*)?:lambda:([a-z]{2}(-gov)?-[a-z]+-\d{1}):(\d{12}):function:([a-zA-Z0-9-_.]+)(:(\$LATEST|[a-zA-Z0-9-_]+))?$/,
  );

export const gatewayStatusSchema = z.enum([
  "CREATING",
  "UPDATING",
  "UPDATE_UNSUCCESSFUL",
  "DELETING",
  "READY",
  "FAILED",
]);
export const targetStatusSchema = z.enum([
  "CREATING",
  "UPDATING",
  "UPDATE_UNSUCCESSFUL",
  "DELETING",
  "READY",
  "FAILED",
  "SYNCHRONIZING",
  "SYNCHRONIZE_UNSUCCESSFUL",
  "CREATE_PENDING_AUTH",
  "UPDATE_PENDING_AUTH",
  "SYNCHRONIZE_PENDING_AUTH",
]);
export const authorizerTypeSchema = z.enum([
  "CUSTOM_JWT",
  "AWS_IAM",
  "NONE",
  "AUTHENTICATE_ONLY",
]);
export const credentialProviderTypeSchema = z.enum([
  "GATEWAY_IAM_ROLE",
  "OAUTH",
  "API_KEY",
  "CALLER_IAM_CREDENTIALS",
  "JWT_PASSTHROUGH",
]);

const text = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\p{Cc}]*$/u);
const timestamp = z.string().max(64).optional();

export const gatewaySummarySchema = z.object({
  gatewayId: gatewayIdentifierSchema,
  name: gatewayNameSchema,
  description: text(200).optional(),
  status: gatewayStatusSchema,
  authorizerType: authorizerTypeSchema,
  protocolType: z.string().max(32),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type GatewaySummary = z.infer<typeof gatewaySummarySchema>;

export const listGatewaysResponseSchema = z.object({
  items: z.array(z.unknown()).max(1000).default([]),
  nextToken: z.string().min(1).max(2048).optional(),
});

/** The gateway's invocation endpoint, as the service returns it; never composed locally. */
export const gatewayUrlSchema = z.string().min(1).max(1024);

export const customJwtAuthorizerSchema = z.object({
  discoveryUrl: z.string().max(2048).optional(),
  allowedClients: z.array(text(256)).max(64).optional(),
  allowedAudience: z.array(text(256)).max(64).optional(),
});

export const getGatewayResponseSchema = z.object({
  gatewayArn: gatewayArnSchema,
  gatewayId: gatewayIdentifierSchema,
  gatewayUrl: gatewayUrlSchema.optional(),
  name: gatewayNameSchema,
  description: text(200).optional(),
  status: gatewayStatusSchema,
  statusReasons: z.array(text(2048)).max(100).optional(),
  authorizerType: authorizerTypeSchema,
  authorizerConfiguration: z
    .object({ customJWTAuthorizer: customJwtAuthorizerSchema.optional() })
    .optional(),
  protocolType: z.string().max(32),
  protocolConfiguration: z
    .object({
      mcp: z
        .object({
          supportedVersions: z.array(text(32)).max(16).optional(),
          instructions: text(4096).optional(),
          searchType: text(64).optional(),
        })
        .optional(),
    })
    .optional(),
  roleArn: z.string().max(2048).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  workloadIdentityDetails: z
    .object({ workloadIdentityArn: z.string().max(2048).optional() })
    .optional(),
});
export type GetGatewayResponse = z.infer<typeof getGatewayResponseSchema>;

export const targetSummarySchema = z.object({
  targetId: targetIdSchema,
  name: targetNameSchema,
  description: text(200).optional(),
  status: targetStatusSchema,
  targetType: z.string().max(64).optional(),
  listingMode: z.string().max(32).optional(),
  lastSynchronizedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type TargetSummary = z.infer<typeof targetSummarySchema>;

export const listGatewayTargetsResponseSchema = z.object({
  items: z.array(z.unknown()).max(1000).default([]),
  nextToken: z.string().min(1).max(2048).optional(),
});

/** `ApiSchemaConfiguration`: a union of an inline document and an S3 location. */
export const apiSchemaConfigurationSchema = z.object({
  inlinePayload: z
    .string()
    .max(4 * 1024 * 1024)
    .optional(),
  s3: z
    .object({
      uri: z.string().max(2048).optional(),
      bucketOwnerAccountId: z.string().max(32).optional(),
    })
    .optional(),
});

export const toolDefinitionSchema = z.object({
  name: z.string().max(200).optional(),
  description: z.string().max(4096).optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
});

export const mcpTargetConfigurationSchema = z.object({
  openApiSchema: apiSchemaConfigurationSchema.optional(),
  smithyModel: apiSchemaConfigurationSchema.optional(),
  lambda: z
    .object({
      lambdaArn: lambdaArnSchema,
      toolSchema: z
        .object({
          inlinePayload: z.array(z.unknown()).max(512).optional(),
          s3: z
            .object({
              uri: z.string().max(2048).optional(),
              bucketOwnerAccountId: z.string().max(32).optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
  mcpServer: z
    .object({
      endpoint: z
        .string()
        .max(2048)
        .regex(/^https:\/\/.*$/),
      listingMode: z.enum(["DEFAULT", "DYNAMIC"]).optional(),
      resourcePriority: z.number().int().min(0).max(1000).optional(),
      mcpToolSchema: z.unknown().optional(),
    })
    .optional(),
  apiGateway: z.unknown().optional(),
  connector: z.unknown().optional(),
});

export const targetConfigurationSchema = z.object({
  mcp: mcpTargetConfigurationSchema.optional(),
  http: z.unknown().optional(),
  inference: z.unknown().optional(),
});

export const getGatewayTargetResponseSchema = z.object({
  targetId: targetIdSchema,
  name: targetNameSchema,
  description: text(200).optional(),
  status: targetStatusSchema,
  statusReasons: z.array(text(2048)).max(100).optional(),
  protocolType: z.enum(["MCP", "HTTP"]).optional(),
  gatewayArn: gatewayArnSchema.optional(),
  lastSynchronizedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
  targetConfiguration: targetConfigurationSchema.optional(),
  credentialProviderConfigurations: z
    .array(
      z.object({
        credentialProviderType: credentialProviderTypeSchema,
        credentialProvider: z.unknown().optional(),
      }),
    )
    .max(4)
    .optional(),
  privateEndpoint: z.unknown().optional(),
  privateEndpointManagedResources: z
    .array(
      z.object({
        domain: text(256).optional(),
        resourceAssociationArn: z.string().max(2048).optional(),
        resourceGatewayArn: z.string().max(2048).optional(),
      }),
    )
    .max(16)
    .optional(),
  metadataConfiguration: z
    .object({
      allowedQueryParameters: z.array(text(120)).max(64).optional(),
      allowedRequestHeaders: z.array(text(120)).max(64).optional(),
      allowedResponseHeaders: z.array(text(120)).max(64).optional(),
    })
    .optional(),
});
export type GetGatewayTargetResponse = z.infer<
  typeof getGatewayTargetResponseSchema
>;

/** AWS JSON error shape: `__type` in the body and `x-amzn-errortype` in the headers. */
export const awsErrorBodySchema = z.object({
  __type: z.string().max(200).optional(),
  message: z.string().max(4096).optional(),
  Message: z.string().max(4096).optional(),
});
