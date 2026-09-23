import { createHash } from "node:crypto";
import {
  authenticationProfileSchema,
  type AuthenticationProfile,
} from "../../../../core/connectors/index.js";
import { IssueCollector, safeText, token } from "./issues.js";
import type {
  OpenApiProfile,
  OperationSecurity,
  ReadOperation,
  ReadSecurityScheme,
  SecurityRequirement,
} from "./model.js";
import { entriesOf, isRecord } from "./refs.js";

/*
 * Security semantics are copied, not interpreted. A Security Requirement
 * Object is a conjunction (every named scheme must be satisfied); the list of
 * them is a disjunction (any one alternative suffices); an empty object is an
 * anonymous alternative; an operation-level list replaces the document
 * default, and an empty operation-level list removes it. Schemes the runtime
 * cannot execute are preserved as `unsupported` profiles so the operations
 * that need them are blocked with a precise reason instead of being handed a
 * login method the source never described.
 */

/** Profile kinds the OpenAPI HTTP adapter can present credentials for. */
export const EXECUTABLE_PROFILE_KINDS: ReadonlySet<
  AuthenticationProfile["kind"]
> = new Set<AuthenticationProfile["kind"]>([
  "api-key",
  "http-basic",
  "http-bearer",
  "oauth-authorization-code",
  "oauth-client-credentials",
  "oauth-device",
  "openid-connect",
  "none",
]);

const identifierPattern = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/;
const reserved = new Set(["__proto__", "prototype", "constructor"]);

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * A stable profile id for a native scheme name. Names that already satisfy
 * the identifier grammar are kept verbatim; anything else is replaced by a
 * digest-derived id, and collisions get a numeric suffix. The native spelling
 * always survives in the profile label and in the read model.
 */
export function profileIdFor(candidate: string, used: Set<string>): string {
  let id =
    identifierPattern.test(candidate) && !reserved.has(candidate)
      ? candidate
      : `scheme-${shortHash(candidate)}`;
  let attempt = 1;
  while (used.has(id)) {
    attempt++;
    const base = id.replace(/-\d+$/, "");
    id = `${base.slice(0, 90)}-${attempt}`;
  }
  used.add(id);
  return id;
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.username || url.password || url.hash) return undefined;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback))
    return url.href;
  return undefined;
}

function scopesOf(
  value: unknown,
  pointer: string,
  issues: IssueCollector,
): { list: string[]; map: Record<string, string> } {
  const map: Record<string, string> = {};
  const list: string[] = [];
  if (!isRecord(value)) return { list, map };
  for (const [name, description] of entriesOf(value)) {
    if (name.length === 0 || name.length > 200 || /\p{Cc}/u.test(name))
      continue;
    if (list.length >= 64) {
      issues.add({
        code: "security.scopes-truncated",
        category: "security",
        pointer,
        dimension: "authorize",
        severity: "warning",
        disposition: "adapted",
        message:
          "The scheme declares more scopes than a profile can carry; later scopes are not listed on the profile.",
      });
      break;
    }
    list.push(name);
    map[name] = safeText(description, 200);
  }
  return { list, map };
}

function unsupportedProfile(
  id: string,
  label: string,
  native: string,
): AuthenticationProfile {
  return authenticationProfileSchema.parse({
    id,
    label,
    kind: "unsupported",
    native: safeText(native, 120) || "unknown",
  });
}

type FlowName =
  | "implicit"
  | "password"
  | "clientCredentials"
  | "authorizationCode"
  | "deviceAuthorization";

const flowKinds: Record<OpenApiProfile, readonly string[]> = {
  "swagger-2.0": ["implicit", "password", "application", "accessCode"],
  "openapi-3.0": [
    "implicit",
    "password",
    "clientCredentials",
    "authorizationCode",
  ],
  "openapi-3.1": [
    "implicit",
    "password",
    "clientCredentials",
    "authorizationCode",
  ],
  "openapi-3.2": [
    "implicit",
    "password",
    "clientCredentials",
    "authorizationCode",
    "deviceAuthorization",
  ],
};

/** 2.0 flow names in 3.x spelling; unknown names stay as written. */
function canonicalFlow(name: string): FlowName | string {
  if (name === "application") return "clientCredentials";
  if (name === "accessCode") return "authorizationCode";
  return name;
}

function endpoint(
  value: unknown,
  pointer: string,
  issues: IssueCollector,
): string | undefined {
  if (value === undefined) return undefined;
  const url = safeUrl(value);
  if (!url)
    issues.add({
      code: "security.endpoint-not-https",
      category: "security",
      pointer,
      dimension: "authorize",
      severity: "warning",
      disposition: "adapted",
      message:
        "An OAuth endpoint is not an HTTPS URL without credentials; it is not carried on the profile and must be supplied by reviewed configuration.",
    });
  return url;
}

function oauthFlowProfile(input: {
  id: string;
  label: string;
  flow: string;
  raw: Record<string, unknown>;
  profile: OpenApiProfile;
  pointer: string;
  issues: IssueCollector;
}): {
  profile: AuthenticationProfile;
  native: NonNullable<ReadSecurityScheme["native"]["flows"]>[string];
} {
  const { id, label, raw, pointer, issues } = input;
  const flow = canonicalFlow(input.flow);
  const scopes = scopesOf(raw.scopes, `${pointer}/scopes`, issues);
  const native = {
    ...(typeof raw.authorizationUrl === "string"
      ? { authorizationUrl: safeText(raw.authorizationUrl, 2048) }
      : {}),
    ...(typeof raw.tokenUrl === "string"
      ? { tokenUrl: safeText(raw.tokenUrl, 2048) }
      : {}),
    ...(typeof raw.refreshUrl === "string"
      ? { refreshUrl: safeText(raw.refreshUrl, 2048) }
      : {}),
    ...(typeof raw.deviceAuthorizationUrl === "string"
      ? { deviceAuthorizationUrl: safeText(raw.deviceAuthorizationUrl, 2048) }
      : {}),
    scopes: scopes.map,
  };
  const defined = flowKinds[input.profile].includes(input.flow);
  if (!defined) {
    issues.add({
      code: "security.unknown-flow",
      category: "security",
      pointer,
      dimension: "authorize",
      severity: "blocking",
      disposition: "unsupported",
      executionImpact: "blocks-authorization",
      message: `The OAuth flow "${token(input.flow, 40)}" is not defined by this OpenAPI version; operations that require only this scheme cannot execute.`,
    });
    return {
      profile: unsupportedProfile(id, label, `oauth2:${input.flow}`),
      native,
    };
  }
  if (flow === "authorizationCode") {
    const authorizationEndpoint = endpoint(
      raw.authorizationUrl,
      `${pointer}/authorizationUrl`,
      issues,
    );
    const tokenEndpoint = endpoint(raw.tokenUrl, `${pointer}/tokenUrl`, issues);
    return {
      profile: authenticationProfileSchema.parse({
        id,
        label,
        kind: "oauth-authorization-code",
        pkce: "unknown",
        ...(authorizationEndpoint ? { authorizationEndpoint } : {}),
        ...(tokenEndpoint ? { tokenEndpoint } : {}),
        scopes: scopes.list,
        scopeSemantics: "provider-scopes",
        clientRegistration: "unknown",
        clientAuthentication: "unknown",
        refresh: typeof raw.refreshUrl === "string" ? "supported" : "unknown",
      }),
      native,
    };
  }
  if (flow === "clientCredentials") {
    const tokenEndpoint = endpoint(raw.tokenUrl, `${pointer}/tokenUrl`, issues);
    return {
      profile: authenticationProfileSchema.parse({
        id,
        label,
        kind: "oauth-client-credentials",
        ...(tokenEndpoint ? { tokenEndpoint } : {}),
        scopes: scopes.list,
        clientAuthentication: "unknown",
      }),
      native,
    };
  }
  if (flow === "deviceAuthorization") {
    const deviceAuthorizationEndpoint = endpoint(
      raw.deviceAuthorizationUrl,
      `${pointer}/deviceAuthorizationUrl`,
      issues,
    );
    const tokenEndpoint = endpoint(raw.tokenUrl, `${pointer}/tokenUrl`, issues);
    return {
      profile: authenticationProfileSchema.parse({
        id,
        label,
        kind: "oauth-device",
        ...(deviceAuthorizationEndpoint ? { deviceAuthorizationEndpoint } : {}),
        ...(tokenEndpoint ? { tokenEndpoint } : {}),
        scopes: scopes.list,
      }),
      native,
    };
  }
  issues.add({
    code: "security.unsupported-flow",
    category: "security",
    pointer,
    dimension: "authorize",
    severity: "blocking",
    disposition: "unsupported",
    executionImpact: "blocks-authorization",
    message: `The OAuth "${token(input.flow, 40)}" flow is not supported (RFC 9700 discourages it); operations that require only this scheme cannot execute.`,
  });
  return {
    profile: unsupportedProfile(id, label, `oauth2:${input.flow}`),
    native,
  };
}

function unsupportedScheme(
  issues: IssueCollector,
  pointer: string,
  code: string,
  message: string,
): void {
  issues.add({
    code,
    category: "security",
    pointer,
    dimension: "authorize",
    severity: "blocking",
    disposition: "unsupported",
    executionImpact: "blocks-authorization",
    message,
  });
}

/**
 * Keys whose values are sample data or credential material. An example has no
 * validation semantics, so nothing downstream needs it, and a source that
 * embeds a real key in an example must not have it copied into a description
 * that is later exported. Both are dropped at the import boundary rather than
 * filtered at each projection, because a projection added later would not know
 * to filter.
 */
const EXAMPLE_KEY = /example/i;
const CREDENTIAL_KEY =
  /(secret|password|passwd|credential|api[-_]?key|apikey|token|authorization|bearer|private[-_]?key)/i;

function sanitizeExtensionValue(value: unknown, depth = 0): unknown {
  if (depth > 16) return null;
  if (Array.isArray(value))
    return value
      .slice(0, 256)
      .map((item) => sanitizeExtensionValue(item, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of entriesOf(value)) {
      if (
        EXAMPLE_KEY.test(key) ||
        CREDENTIAL_KEY.test(key) ||
        key === "default"
      )
        continue;
      out[key] = sanitizeExtensionValue(item, depth + 1);
    }
    return out;
  }
  return value;
}

/** Extension keys (`x-*`) of an object, bounded, without examples or credential-named entries. */
export function extensionsOf(
  value: Record<string, unknown>,
  budget = 64,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, item] of entriesOf(value)) {
    if (!key.startsWith("x-")) continue;
    if (EXAMPLE_KEY.test(key) || CREDENTIAL_KEY.test(key)) continue;
    if (key.length > 120 || /\p{Cc}/u.test(key)) continue;
    if (count >= budget) break;
    const text = JSON.stringify(item);
    if (text === undefined || text.length > 16_384) continue;
    out[key] = sanitizeExtensionValue(JSON.parse(text));
    count++;
  }
  return out;
}

/**
 * Reads one security scheme into authentication profiles. A scheme yields
 * one profile per OAuth flow because each flow is a different way of obtaining
 * a credential; the runtime treats all of them as satisfying the same
 * requirement name.
 */
export function readSecurityScheme(input: {
  name: string;
  raw: unknown;
  profile: OpenApiProfile;
  pointer: string;
  issues: IssueCollector;
  usedIds: Set<string>;
}): ReadSecurityScheme {
  const { name, profile, pointer, issues, usedIds } = input;
  const label = safeText(name, 100) || "security scheme";
  const raw = isRecord(input.raw) ? input.raw : {};
  const type = typeof raw.type === "string" ? raw.type : "";
  const deprecated = raw.deprecated === true;
  const extensions = extensionsOf(raw);
  const base = (
    profiles: AuthenticationProfile[],
    native: ReadSecurityScheme["native"],
  ) => ({
    name,
    type,
    pointer,
    profiles,
    executable: profiles.some((item) =>
      EXECUTABLE_PROFILE_KINDS.has(item.kind),
    ),
    deprecated,
    extensions,
    native,
  });
  if (deprecated)
    issues.add({
      code: "security.scheme-deprecated",
      category: "security",
      pointer,
      dimension: "authorize",
      severity: "info",
      disposition: "exact",
      message:
        "The security scheme is declared deprecated by the source; consumers should prefer another alternative when one exists.",
    });

  if (type === "basic" && profile === "swagger-2.0") {
    const id = profileIdFor(name, usedIds);
    return base(
      [authenticationProfileSchema.parse({ id, label, kind: "http-basic" })],
      { scheme: "basic" },
    );
  }
  if (type === "apiKey") {
    const placement = raw.in;
    const allowed =
      profile === "swagger-2.0"
        ? ["query", "header"]
        : ["query", "header", "cookie"];
    const parameterName = typeof raw.name === "string" ? raw.name : "";
    const id = profileIdFor(name, usedIds);
    if (typeof placement !== "string" || !allowed.includes(placement)) {
      unsupportedScheme(
        issues,
        pointer,
        "security.api-key-location-invalid",
        "The API key scheme names a location this OpenAPI version does not define; operations that require only this scheme cannot execute.",
      );
      return base([unsupportedProfile(id, label, `apiKey:${placement}`)], {
        parameterName: safeText(parameterName, 120),
      });
    }
    if (
      !/^[^\p{Cc}\s]+$/u.test(parameterName) ||
      parameterName.length > 120 ||
      (placement === "header" &&
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(parameterName))
    ) {
      unsupportedScheme(
        issues,
        pointer,
        "security.api-key-name-invalid",
        "The API key scheme's parameter name is not a valid header or query name; operations that require only this scheme cannot execute.",
      );
      return base([unsupportedProfile(id, label, "apiKey")], {
        in: placement,
      });
    }
    return base(
      [
        authenticationProfileSchema.parse({
          id,
          label,
          kind: "api-key",
          placement,
          parameterName,
        }),
      ],
      { in: placement, parameterName },
    );
  }
  if (type === "http" && profile !== "swagger-2.0") {
    const scheme = typeof raw.scheme === "string" ? raw.scheme : "";
    const id = profileIdFor(name, usedIds);
    if (scheme.toLowerCase() === "basic")
      return base(
        [authenticationProfileSchema.parse({ id, label, kind: "http-basic" })],
        { scheme: "basic" },
      );
    if (scheme.toLowerCase() === "bearer") {
      const format =
        typeof raw.bearerFormat === "string"
          ? safeText(raw.bearerFormat, 64)
          : undefined;
      return base(
        [
          authenticationProfileSchema.parse({
            id,
            label,
            kind: "http-bearer",
            ...(format ? { format } : {}),
          }),
        ],
        { scheme: "bearer", ...(format ? { bearerFormat: format } : {}) },
      );
    }
    unsupportedScheme(
      issues,
      pointer,
      "security.unsupported-http-scheme",
      `The HTTP authentication scheme "${token(scheme, 32)}" is not supported; operations that require only this scheme cannot execute.`,
    );
    return base([unsupportedProfile(id, label, `http:${scheme}`)], {
      scheme: safeText(scheme, 64),
    });
  }
  if (type === "oauth2") {
    const flows: Array<{
      flow: string;
      raw: Record<string, unknown>;
      pointer: string;
    }> = [];
    if (profile === "swagger-2.0") {
      const flow = typeof raw.flow === "string" ? raw.flow : "";
      flows.push({ flow, raw, pointer });
    } else if (isRecord(raw.flows)) {
      for (const [flow, value] of entriesOf(raw.flows)) {
        if (flow.startsWith("x-")) continue;
        flows.push({
          flow,
          raw: isRecord(value) ? value : {},
          pointer: `${pointer}/flows/${flow}`,
        });
      }
    }
    const oauth2MetadataUrl =
      typeof raw.oauth2MetadataUrl === "string" && profile === "openapi-3.2"
        ? safeText(raw.oauth2MetadataUrl, 2048)
        : undefined;
    if (flows.length === 0) {
      const id = profileIdFor(name, usedIds);
      unsupportedScheme(
        issues,
        pointer,
        "security.no-flows",
        "The OAuth 2.0 scheme declares no flow; operations that require only this scheme cannot execute.",
      );
      return base([unsupportedProfile(id, label, "oauth2")], {
        flows: {},
        ...(oauth2MetadataUrl ? { oauth2MetadataUrl } : {}),
      });
    }
    const profiles: AuthenticationProfile[] = [];
    const nativeFlows: NonNullable<ReadSecurityScheme["native"]["flows"]> = {};
    for (const entry of flows) {
      const id = profileIdFor(
        flows.length === 1 ? name : `${name}.${entry.flow}`,
        usedIds,
      );
      const result = oauthFlowProfile({
        id,
        label:
          flows.length === 1 ? label : safeText(`${name} (${entry.flow})`, 100),
        flow: entry.flow,
        raw: entry.raw,
        profile,
        pointer: entry.pointer,
        issues,
      });
      profiles.push(result.profile);
      nativeFlows[entry.flow] = result.native;
    }
    return base(profiles, {
      flows: nativeFlows,
      ...(oauth2MetadataUrl ? { oauth2MetadataUrl } : {}),
    });
  }
  if (type === "openIdConnect" && profile !== "swagger-2.0") {
    const id = profileIdFor(name, usedIds);
    const url =
      typeof raw.openIdConnectUrl === "string" ? raw.openIdConnectUrl : "";
    const suffix = "/.well-known/openid-configuration";
    const issuer = url.endsWith(suffix)
      ? safeUrl(url.slice(0, -suffix.length))
      : undefined;
    if (!issuer) {
      unsupportedScheme(
        issues,
        pointer,
        "security.openid-issuer-underivable",
        "The OpenID Connect discovery URL does not name an HTTPS issuer in the standard well-known form; the issuer is not guessed and operations that require only this scheme cannot execute.",
      );
      return base([unsupportedProfile(id, label, "openIdConnect")], {
        openIdConnectUrl: safeText(url, 2048),
      });
    }
    return base(
      [
        authenticationProfileSchema.parse({
          id,
          label,
          kind: "openid-connect",
          issuer,
          scopes: [],
        }),
      ],
      { openIdConnectUrl: url },
    );
  }
  if (type === "mutualTLS" && profile !== "swagger-2.0") {
    const id = profileIdFor(name, usedIds);
    issues.add({
      code: "security.mutual-tls-not-executable",
      category: "security",
      pointer,
      dimension: "authorize",
      severity: "blocking",
      disposition: "unsupported",
      executionImpact: "blocks-authorization",
      message:
        "Mutual TLS is described but this runtime holds no client certificates; operations that require only this scheme cannot execute.",
    });
    return base(
      [authenticationProfileSchema.parse({ id, label, kind: "mutual-tls" })],
      {},
    );
  }
  const id = profileIdFor(name, usedIds);
  unsupportedScheme(
    issues,
    pointer,
    "security.unsupported-scheme",
    `The security scheme type "${token(type, 32)}" is not defined by this OpenAPI version or not supported; operations that require only this scheme cannot execute.`,
  );
  return base([unsupportedProfile(id, label, type || "unknown")], {});
}

/**
 * Normalizes a `security` list. Unknown names are preserved as unknown
 * entries (and reported) rather than dropped, because dropping a requirement
 * would widen access.
 */
export function normalizeRequirements(input: {
  raw: unknown;
  schemes: Record<string, ReadSecurityScheme>;
  pointer: string;
  issues: IssueCollector;
}): SecurityRequirement[] | undefined {
  const { raw, schemes, pointer, issues } = input;
  if (!Array.isArray(raw)) {
    issues.add({
      code: "structure.invalid-security",
      category: "structure",
      pointer,
      dimension: "import",
      severity: "warning",
      message:
        "The security field is not a list of requirement objects and was ignored; the effective requirements come from the enclosing scope.",
    });
    return undefined;
  }
  const alternatives: SecurityRequirement[] = [];
  raw.slice(0, 64).forEach((item, index) => {
    const itemPointer = `${pointer}/${index}`;
    if (!isRecord(item)) {
      issues.add({
        code: "structure.invalid-security",
        category: "structure",
        pointer: itemPointer,
        dimension: "import",
        severity: "warning",
        message:
          "A security requirement is not an object and was ignored as an alternative.",
      });
      return;
    }
    const requirement: SecurityRequirement = {
      schemes: [],
      pointer: itemPointer,
    };
    for (const [scheme, scopesRaw] of entriesOf(item)) {
      const scopes = Array.isArray(scopesRaw)
        ? scopesRaw
            .filter(
              (scope): scope is string =>
                typeof scope === "string" &&
                scope.length > 0 &&
                scope.length <= 200 &&
                !/\p{Cc}/u.test(scope),
            )
            .slice(0, 64)
        : [];
      const known = Object.hasOwn(schemes, scheme);
      if (!known)
        issues.add({
          code: "security.unknown-scheme",
          category: "security",
          pointer: `${itemPointer}/${scheme.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          dimension: "invoke",
          severity: "blocking",
          disposition: "rejected",
          executionImpact: "blocks-operation",
          message:
            "A security requirement names a scheme the document does not declare; this alternative cannot be satisfied.",
        });
      const declared = known ? schemes[scheme]! : undefined;
      requirement.schemes.push({
        scheme,
        scopes,
        profileIds: declared
          ? declared.profiles.map((profile) => profile.id)
          : [],
        known,
        executable: declared?.executable ?? false,
      });
    }
    alternatives.push(requirement);
  });
  return alternatives;
}

/** Effective requirements for an operation given the document default. */
export function effectiveSecurity(input: {
  operationRaw: Record<string, unknown>;
  documentSecurity: SecurityRequirement[] | undefined;
  schemes: Record<string, ReadSecurityScheme>;
  pointer: string;
  issues: IssueCollector;
}): OperationSecurity {
  const { operationRaw, documentSecurity, schemes, pointer, issues } = input;
  if (Object.hasOwn(operationRaw, "security")) {
    const own = normalizeRequirements({
      raw: operationRaw.security,
      schemes,
      pointer: `${pointer}/security`,
      issues,
    });
    if (own) return { source: "operation", alternatives: own };
  }
  if (documentSecurity)
    return { source: "document", alternatives: documentSecurity };
  return { source: "none", alternatives: [] };
}

export interface SecurityAlternatives extends OperationSecurity {
  /** True when at least one alternative is anonymous or no requirement applies. */
  anonymous: boolean;
  /** Indexes of alternatives whose every scheme is known and executable. */
  executableAlternatives: number[];
  /** Profile ids referenced by any alternative, in first-seen order. */
  profileIds: string[];
}

/** The normalized alternatives of one operation: OR across, AND within, `{}` anonymous. */
export function securityRequirementsFor(
  operation: Pick<ReadOperation, "security">,
): SecurityAlternatives {
  const { source, alternatives } = operation.security;
  const anonymous =
    alternatives.length === 0 ||
    alternatives.some((alternative) => alternative.schemes.length === 0);
  const executableAlternatives: number[] = [];
  alternatives.forEach((alternative, index) => {
    if (alternative.schemes.every((entry) => entry.known && entry.executable))
      executableAlternatives.push(index);
  });
  const profileIds: string[] = [];
  for (const alternative of alternatives)
    for (const entry of alternative.schemes)
      for (const id of entry.profileIds)
        if (!profileIds.includes(id)) profileIds.push(id);
  return {
    source,
    alternatives,
    anonymous,
    executableAlternatives,
    profileIds,
  };
}
