/*
 * OAuth and OpenID Connect for connectors, server-only.
 *
 * Specifications this module implements, pinned at the revisions observed on
 * 2026-09-17/18. Drafts are named as drafts; nothing here claims certification.
 *
 * - RFC 6749 / RFC 6750  OAuth 2.0 and bearer usage (baseline), including the
 *                        client credentials grant (§4.4) for confidential clients
 * - RFC 7636             PKCE; S256 only, via oauth4webapi
 * - RFC 7591             Dynamic client registration
 * - RFC 7662             Token introspection (exchange verification fallback)
 * - RFC 8414             Authorization server metadata, exact issuer matching
 * - RFC 8628             Device authorization grant
 * - RFC 8693             Token exchange
 * - RFC 8707             Resource indicators
 * - RFC 9126             Pushed authorization requests
 * - RFC 9207             Authorization response `iss`
 * - RFC 9396             Rich authorization requests (`authorization_details`)
 * - RFC 9700             OAuth 2.0 security best current practice (baseline)
 * - RFC 9728             Protected resource metadata, path-insertion rules
 * - OpenID Connect Core 1.0 / Discovery 1.0 (errata set 2)
 * - draft-ietf-oauth-v2-1-16 (OAuth 2.1), observed 2026-09-17
 * - draft-ietf-oauth-client-id-metadata-document-03 (CIMD), observed 2026-09-17
 * - MCP 2026-07-28 authorization, and its enterprise-managed authorization
 *   extension (ID-JAG), which stays behind a negotiated profile flag
 *
 * The rules that hold across all of it: an issuer identifier is compared byte
 * for byte and never canonicalized for validation; an endpoint is contacted
 * only from the issuer's own verified metadata or from host policy; private
 * handoff material never leaves `HandoffIssue.private`; a browser message is
 * never completion; and every consequential token request is journaled before
 * it is sent, so a repeat is answered from the journal instead of the issuer.
 */

export {
  allowedScheme,
  assertIssuerIdentifier,
  clientAuthenticationMethods,
  clientRegistrationProfiles,
  isLoopbackHost,
  issuerPolicy,
  issuerPolicyFromBinding,
  issuerPolicySchema,
  tokenTypeIdentifiers,
  type ClientAuthenticationMethod,
  type ClientRegistrationProfile,
  type IssuerPolicy,
  type IssuerPolicyInput,
} from "./policy.js";

export {
  boundedSignal,
  joinScope,
  neverSent,
  requestOptions,
  splitScope,
  tokenErrorDetail,
  wireError,
  wireFetch,
  type WireOptions,
} from "./wire.js";

export {
  createMetadataCache,
  discoverAuthorizationServer,
  discoverProtectedResource,
  endpointRoles,
  metadataCacheKey,
  metadataCandidates,
  protectedResourceMetadataUrl,
  resolveAuthorizationServer,
  resourceMetadataFromChallenge,
  trustedEndpoint,
  type AuthorizationServerDiscovery,
  type CachedMetadata,
  type DiscoveryOptions,
  type EndpointDeclaration,
  type EndpointRole,
  type MetadataCache,
  type MetadataDocumentKind,
  type ProtectedResourceDiscovery,
  type ResolvedAuthorizationServer,
  type UnavailableReason,
} from "./discovery.js";

export {
  connectorClientMetadata,
  registrationKey,
  resolveClientRegistration,
  selectClientRegistrationProfile,
  storedClientRegistrationSchema,
  type ClientMetadataArtifact,
  type ClientRegistrationStorePort,
  type ClientSource,
  type ProfileFeasibility,
  type ProfileSelection,
  type ResolveClientInput,
  type ResolvedClient,
  type StoredClientRegistration,
} from "./client.js";

export {
  assertHandoffCurrent,
  connectWidgetHandoff,
  humanHandoffPresentation,
  inputRequiredHandoff,
  issueHandoff,
  popupCompletionMessageType,
  privateCollectorHandoff,
  validatePopupCompletion,
  type HandoffTarget,
  type PopupCompletionDecision,
  type PopupCompletionExpectation,
  type PopupCompletionMessage,
} from "./handoff.js";

export {
  accountIdentityClaim,
  authorizationDetailsParameter,
  credentialAcceptedClaim,
  OAUTH_VERIFIER_VERSION,
  permissionRecord,
  reportedAuthorizationDetails,
  resourceParameters,
  reviewPermissionEscalation,
  scopeEnforcement,
  type EscalationReview,
  type PermissionRecord,
  type PermissionSource,
  type ScopeEnforcement,
} from "./permissions.js";

export {
  AUTHORIZATION_CODE_INTENT,
  beginAuthorizationCode,
  callbackUri,
  completeAuthorizationCode,
  credentialScopeFor,
  DEFAULT_HANDOFF_TTL_MS,
  OAUTH_CODE_EXCHANGE_OPERATION,
  OAUTH_REFRESH_OPERATION,
  refreshAccessToken,
  type BeginAuthorizationCodeInput,
  type CompleteAuthorizationCodeInput,
  type RefreshAccessTokenInput,
  type RefreshOutcome,
} from "./authorization-code.js";

export {
  acquireClientCredentials,
  CLIENT_CREDENTIALS_GRANT,
  grantClientCredentials,
  OAUTH_CLIENT_CREDENTIALS_OPERATION,
  renewClientCredentials,
  type ClientCredentialsGrant,
  type ClientCredentialsInput,
} from "./client-credentials.js";

export {
  OAUTH_REVOKE_OPERATION,
  revokeUpstreamGrant,
  type RevokeUpstreamInput,
} from "./revocation.js";

export {
  connectionCredentialScope,
  missingClientConfiguration,
  optionalIssuerPolicy,
  resolveConnectorOAuth,
  type ConnectorOAuth,
  type ConnectorOAuthOptions,
} from "./connector-oauth.js";

export {
  beginDeviceAuthorization,
  DEVICE_CODE_INTENT,
  OAUTH_DEVICE_EXCHANGE_OPERATION,
  pollDeviceAuthorization,
  type BeginDeviceAuthorizationInput,
  type DevicePollState,
  type PollDeviceAuthorizationInput,
} from "./device.js";

export {
  exchangeToken,
  hostAuthorizedTokenExchange,
  OAUTH_EXCHANGE_OPERATION,
  TOKEN_EXCHANGE_GRANT,
  type TokenExchangeOutcome,
  type TokenExchangePort,
  type TokenExchangeRequest,
  type VerifiedExchange,
} from "./token-exchange.js";
