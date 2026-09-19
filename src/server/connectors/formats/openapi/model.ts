import type {
  AuthenticationProfile,
  CompatibilityIssue,
  NormalizedDefinition,
} from "../../../../core/connectors/index.js";
import type { ReferenceResolver } from "./refs.js";

/*
 * The read model sits between the untrusted document and the normalized
 * definition. It keeps what the definition cannot carry (parameters, bodies,
 * responses, exact security alternatives, servers per operation) so that the
 * compiler, the exporter and other readers built on this one (Microsoft-style
 * connectors) work from one bounded, already-resolved structure instead of
 * walking the document again. Nothing in it is executable.
 */

export type OpenApiProfile =
  "swagger-2.0" | "openapi-3.0" | "openapi-3.1" | "openapi-3.2";

export const OPENAPI_PROFILES: readonly OpenApiProfile[] = [
  "swagger-2.0",
  "openapi-3.0",
  "openapi-3.1",
  "openapi-3.2",
];

export const READER_ID = "openapi-http-reader";
export const READER_VERSION = "1.0.0";

export type ParameterLocation =
  "path" | "query" | "header" | "cookie" | "querystring" | "formData" | "body";

export interface ReadServer {
  url: string;
  description?: string;
  variables: Record<string, { default: string; enum?: string[] }>;
  pointer: string;
}

export interface ReadParameter {
  name: string;
  in: ParameterLocation;
  required: boolean;
  /** Serialization style as written or defaulted per location (3.x); 2.0 collectionFormat is translated. */
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
  deprecated: boolean;
  description?: string;
  /** Raw schema (already `$ref`-resolvable through the read result's resolver); never copied into a definition. */
  schema?: unknown;
  /** Media types when the parameter is described by `content` instead of `schema`. */
  content?: string[];
  /** Swagger 2.0 `collectionFormat` as written, for exact diagnostics. */
  collectionFormat?: string;
  pointer: string;
  extensions: Record<string, unknown>;
}

export interface ReadMediaType {
  mediaType: string;
  schema?: unknown;
  pointer: string;
}

export interface ReadRequestBody {
  required: boolean;
  description?: string;
  content: ReadMediaType[];
  pointer: string;
}

export interface ReadResponse {
  status: string;
  description?: string;
  content: ReadMediaType[];
  headers: string[];
  pointer: string;
}

/** One Security Requirement Object: every entry must be satisfied (AND); an empty list is anonymous access. */
export interface SecurityRequirement {
  schemes: Array<{
    /** Native scheme name as written in the requirement. */
    scheme: string;
    scopes: string[];
    /** Authentication profile ids that can satisfy this scheme; empty when the scheme is unknown or unsupported. */
    profileIds: string[];
    known: boolean;
    executable: boolean;
  }>;
  pointer: string;
}

export interface OperationSecurity {
  /** Where the effective requirements came from: the operation, the document default, or nowhere. */
  source: "operation" | "document" | "none";
  /** Alternatives (OR). An alternative with zero schemes is anonymous access. */
  alternatives: SecurityRequirement[];
}

export interface ReadOperation {
  nativeId: string;
  identity: "operationId" | "method-path";
  method: string;
  path: string;
  pointer: string;
  source: "paths" | "webhooks";
  summary?: string;
  description?: string;
  deprecated: boolean;
  tags: string[];
  /** Effective servers: operation, then path item, then document. */
  servers: ReadServer[];
  parameters: ReadParameter[];
  requestBody?: ReadRequestBody;
  responses: ReadResponse[];
  security: OperationSecurity;
  callbacks: string[];
  /** 2.0 `consumes`/`produces` as effective for this operation. */
  consumes?: string[];
  produces?: string[];
  extensions: Record<string, unknown>;
}

export interface ReadSecurityScheme {
  name: string;
  type: string;
  pointer: string;
  /** Profiles derived from this scheme; an oauth2 scheme with several flows yields several. */
  profiles: AuthenticationProfile[];
  /** Whether at least one derived profile is one the HTTP adapter can execute. */
  executable: boolean;
  deprecated: boolean;
  extensions: Record<string, unknown>;
  /** Inert scheme facts kept for export: flow URLs and metadata URLs as written. */
  native: {
    scheme?: string;
    bearerFormat?: string;
    in?: string;
    parameterName?: string;
    openIdConnectUrl?: string;
    oauth2MetadataUrl?: string;
    flows?: Record<
      string,
      {
        authorizationUrl?: string;
        tokenUrl?: string;
        refreshUrl?: string;
        deviceAuthorizationUrl?: string;
        scopes: Record<string, string>;
      }
    >;
  };
}

export interface ReadInfo {
  title: string;
  version: string;
  description?: string;
}

export interface ReadResult {
  profile: OpenApiProfile;
  /** Exact version string as written, e.g. "3.1.0". */
  version: string;
  /** Schema dialect the document's Schema Objects use. */
  dialect: string;
  info: ReadInfo;
  servers: ReadServer[];
  operations: ReadOperation[];
  webhooks: ReadOperation[];
  securitySchemes: Record<string, ReadSecurityScheme>;
  /** Native scheme name to profile ids. */
  schemeProfiles: Record<string, string[]>;
  documentSecurity: SecurityRequirement[] | undefined;
  extensions: Record<string, unknown>;
  definition: NormalizedDefinition;
  issues: CompatibilityIssue[];
  resolver: ReferenceResolver;
  document: unknown;
}

/** A read that could not establish a version yields no definition and one blocking issue. */
export interface ReadFailure {
  profile: undefined;
  issues: CompatibilityIssue[];
  definition: undefined;
}

export const isReadResult = (
  value: ReadResult | ReadFailure,
): value is ReadResult => value.profile !== undefined;
