/*
 * The MCP runtime: an inbound client for remote servers in both protocol
 * eras, the `mcp-remote` adapter that binds one to a connection, and the
 * connector tools that extend Ceremony's own MCP server.
 */

export * from "./profiles.js";
export {
  SseParser,
  WireError,
  collectHeaderParameters,
  decodeMcpHeaderValue,
  encodeMcpHeaderValue,
  isRecognizedModernError,
  parseBoundedJson,
  type ContentBlock,
  type ElicitationParams,
  type ElicitationResult,
  type Implementation,
  type PromptDefinition,
  type ResourceContents,
  type ResourceDefinition,
  type ResourceTemplateDefinition,
  type ServerCapabilities,
  type SseFrame,
  type ToolDefinition,
} from "./wire.js";
export {
  parseBearerChallenge,
  protectedResourceMetadataSchema,
  resolveAuthorizationChallenge,
  type AuthorizationChallenge,
  type ProtectedResourceMetadata,
} from "./authorization.js";
export { McpResultCache, principalKey, type CachePrincipal } from "./cache.js";
export {
  BoundsError,
  TransportError,
  type HttpReply,
  type TransportPhase,
} from "./http.js";
export {
  buildInputHandoff,
  buildInputResponses,
  elicitationDigest,
  formSchemaSchema,
  parseInputRequests,
  readSuspendedInput,
  validateFormValues,
  type FormSchema,
  type FormValues,
  type InputRequestKind,
  type ParsedInputRequest,
  type ResumeAction,
  type SuspendedInput,
} from "./input.js";
export {
  createMcpClient,
  definitionDigest,
  type CallToolPayload,
  type GetPromptPayload,
  type ListenFilter,
  type ListenResult,
  type McpAuth,
  type McpClient,
  type McpClientOptions,
  type McpDiscovery,
  type McpList,
  type McpOutcome,
  type McpTool,
  type ReadResourcePayload,
} from "./client.js";
export {
  MCP_ADAPTER_VERSION,
  createMcpRemoteAdapter,
  resumeInput,
  summarizeChallenge,
  type BeginMcpOAuth,
  type McpBrokerPort,
  type McpChallengeState,
  type McpOAuthRequest,
  type McpRemoteAdapterOptions,
} from "./adapter.js";
export { completeMcpOAuth, createMcpOAuth } from "./oauth.js";
export {
  connectorServerToolNames,
  connectorToolInputs,
  registerConnectorServerTools,
  type ConnectorConnectInput,
  type ConnectorConnectOutput,
  type ConnectorInvokeInput,
  type ConnectorInvokeOutput,
  type ConnectorToolContext,
  type ConnectorToolDependencies,
} from "./server-tools.js";
