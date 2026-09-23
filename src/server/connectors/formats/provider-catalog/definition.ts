import { createHash } from "node:crypto";
import {
  canonicalConnectorJson,
  completeDimensions,
  normalizedDefinitionSchema,
  normalizedDigestOf,
  type AuthenticationProfile,
  type CompatibilityIssue,
  type ConfigurationRequirement,
  type NativeCapability,
  type NormalizedDefinition,
} from "../../../../core/connectors/index.js";
import type { BindingReview, BindingReviewResult } from "../../adapter.js";
import {
  boundOperationSchema,
  type BoundOperation,
  type RuntimeBinding,
} from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import {
  analyzeUrlTemplate,
  clientConfigurationNames,
  entryDigest,
  entrySchemaFor,
  firstCode,
  type ParseOptions,
  type ProviderCatalogEntry,
} from "./schema.js";

/*
 * A catalog entry as a normalized definition -- the draft a reviewer sees --
 * and as the inert binding settings the adapter executes once approved.
 *
 * The definition is not executable. It declares the proxy base URL as a
 * server and offers one HTTP capability per method; a reviewer approves the
 * destination (an exact origin, host policy deciding its network class), the
 * methods, their output classification and consent, exactly as for any other
 * imported description. The entry itself travels in the definition's native
 * extensions for review, and binding review copies it from there into the
 * binding's settings (`reviewCatalogBinding`), where the review digest covers
 * it like every other approved setting. A reviewer's free-form settings never
 * carry it: its endpoints and client-secret names are the imported ones, and
 * its OAuth origins go through host issuer policy like any reviewed issuer.
 */

export const CATALOG_ECOSYSTEM = "provider-catalog";
export const CATALOG_EXTENSION = "x-ceremony-provider-catalog";
export const CATALOG_IMPORTER_VERSION = "1.0.0";

/** Settings keys, split so each stays within the approval route's depth bound of four. */
export const CATALOG_SETTINGS = Object.freeze({
  entry: "provider-catalog/entry",
  auth: "provider-catalog/auth",
  proxy: "provider-catalog/proxy",
  connectionConfig: "provider-catalog/connection-config",
  digest: "provider-catalog/digest",
});

export const PROXY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type ProxyMethod = (typeof PROXY_METHODS)[number];

/** The capability native id a reviewer approves for one proxy method. */
export function proxyNativeId(method: ProxyMethod): string {
  return `proxy.${method.toLowerCase()}`;
}

const profileIds: Record<ProviderCatalogEntry["auth"]["mode"], string> = {
  "oauth2-authorization-code": "oauth2",
  "oauth2-client-credentials": "client-credentials",
  "api-key": "api-key",
  basic: "basic",
  bearer: "bearer",
  none: "none",
  unsupported: "unsupported",
};

/** The one authentication profile id an entry's definition declares. */
export function profileIdFor(
  entry: Pick<ProviderCatalogEntry, "auth">,
): string {
  return profileIds[entry.auth.mode];
}

/** A declared endpoint only when it needs no per-connection value; templates stay in the extension. */
function declared(url: string | undefined): string | undefined {
  if (!url || url.includes("${") || url.includes("?") || !URL.canParse(url))
    return undefined;
  return url;
}

function profileFor(entry: ProviderCatalogEntry): AuthenticationProfile {
  const id = profileIdFor(entry);
  const auth = entry.auth;
  switch (auth.mode) {
    case "oauth2-authorization-code": {
      const authorizationEndpoint = declared(auth.authorizationUrl);
      const tokenEndpoint = declared(auth.tokenUrl);
      return {
        id,
        label: "OAuth 2.0 authorization code",
        kind: "oauth-authorization-code",
        pkce: "S256",
        ...(auth.issuer ? { issuer: auth.issuer } : {}),
        ...(authorizationEndpoint ? { authorizationEndpoint } : {}),
        ...(tokenEndpoint ? { tokenEndpoint } : {}),
        scopes: auth.scopes,
        scopeSemantics: "provider-scopes",
        clientRegistration: "pre-registered",
        clientAuthentication: auth.tokenRequestAuth,
        refresh: auth.refresh ? "supported" : "unsupported",
      };
    }
    case "oauth2-client-credentials": {
      const tokenEndpoint = declared(auth.tokenUrl);
      return {
        id,
        label: "OAuth 2.0 client credentials",
        kind: "oauth-client-credentials",
        ...(tokenEndpoint ? { tokenEndpoint } : {}),
        scopes: auth.scopes,
        clientAuthentication: auth.tokenRequestAuth,
      };
    }
    case "api-key":
      return {
        id,
        label: "API key",
        kind: "api-key",
        placement: auth.placement,
        parameterName: auth.name,
      };
    case "basic":
      return { id, label: "HTTP Basic", kind: "http-basic" };
    case "bearer":
      return { id, label: "Bearer token", kind: "http-bearer" };
    case "none":
      return { id, label: "No credential", kind: "none", reason: "public" };
    case "unsupported":
      return {
        id,
        label: "Not executable",
        kind: "unsupported",
        native: auth.native,
      };
  }
}

/** Configuration an entry needs: the OAuth client, then each per-connection field. */
export function configurationFor(
  entry: ProviderCatalogEntry,
): ConfigurationRequirement[] {
  const names = clientConfigurationNames(entry);
  return [
    ...(names.clientId
      ? [
          {
            name: names.clientId,
            source: "provider-console" as const,
            classification: "public" as const,
            required: true,
            description: "OAuth client id registered with the provider.",
          },
        ]
      : []),
    ...(names.clientSecret
      ? [
          {
            name: names.clientSecret,
            source: "provider-console" as const,
            classification: "secret" as const,
            required: true,
            description: "OAuth client secret registered with the provider.",
          },
        ]
      : []),
    ...entry.connectionConfig.map((field) => ({
      name: field.configuration,
      source: "session-environment" as const,
      classification: "public" as const,
      required: true,
      description: `${field.label} for this connection.`.slice(0, 500),
    })),
  ];
}

/** The path every proxy operation is pinned under: the base URL's path, or "/". */
export function proxyBasePath(entry: ProviderCatalogEntry): string {
  const url = entry.proxy?.baseUrl;
  if (!url) return "/";
  const path = /^https?:\/\/[^/?]+(\/[^?]*)?/.exec(url)?.[1] ?? "";
  const trimmed = path.replace(/\/+$/, "");
  return trimmed || "/";
}

function capabilitiesFor(entry: ProviderCatalogEntry): NativeCapability[] {
  if (!entry.proxy) return [];
  const profile = profileIdFor(entry);
  const basePath = proxyBasePath(entry);
  // A templated base path cannot be a transport template; the adapter joins
  // the resolved base path itself and the destination prefix bounds it.
  const pathTemplate = basePath.includes("${") ? "/" : basePath;
  return PROXY_METHODS.map((method) => ({
    kind: "http-operation" as const,
    nativeId: proxyNativeId(method),
    label: `${method} through the ${entry.displayName} proxy`.slice(0, 200),
    summary:
      "An authenticated request to a path under the provider's declared API base URL.",
    effect: method === "GET" ? ("read" as const) : ("write" as const),
    // A proxy reaches arbitrary provider endpoints; nothing about the output
    // is known until a reviewer classifies it.
    dataClassification: "unknown" as const,
    cost: "unknown" as const,
    authentication: entry.auth.mode === "none" ? [] : [profile],
    nativeExtensions: {
      "x-ceremony-transport": { kind: "http", method, pathTemplate },
      "x-ceremony-server": 1,
    },
  }));
}

/** The draft definition for one entry; `definitionRef` and `sourceRef` are placeholders the command layer replaces. */
export async function definitionFor(
  entry: ProviderCatalogEntry,
  input: {
    authorityNamespace: string;
    issues?: readonly CompatibilityIssue[];
  },
): Promise<NormalizedDefinition> {
  const executable = entry.auth.mode !== "unsupported";
  const digest = entryDigest(entry);
  const body = {
    schemaVersion: 1 as const,
    definitionRef: "definition:pending",
    sourceRef: "source:pending",
    identity: {
      ecosystem: CATALOG_ECOSYSTEM,
      authorityNamespace: input.authorityNamespace,
      nativeId: entry.id,
      nativeVersion: `sha256:${digest.slice(0, 16)}`,
    },
    importer: {
      id: "provider-catalog",
      version: CATALOG_IMPORTER_VERSION,
    },
    display: {
      name: entry.displayName,
      description: (executable
        ? `${entry.displayName}: a data-defined provider (${entry.auth.mode}). Declared endpoints are contacted only after binding review.`
        : `${entry.displayName}: described only. ${entry.auth.mode === "unsupported" ? entry.auth.reason : ""}`
      ).slice(0, 500),
      ecosystem: CATALOG_ECOSYSTEM,
      service: entry.id,
    },
    authentication: [profileFor(entry)],
    configuration: configurationFor(entry),
    capabilities: capabilitiesFor(entry),
    events: [],
    declaredServers: entry.proxy
      ? [{ url: entry.proxy.baseUrl, status: "declared" as const }]
      : [],
    compatibility: {
      issues: [...(input.issues ?? [])],
      dimensions: completeDimensions({
        import: "exact",
        configure: "requires-configuration",
        authorize: executable ? "requires-configuration" : "unsupported",
        verify: executable ? "requires-configuration" : "unsupported",
        invoke:
          executable && entry.proxy ? "requires-configuration" : "unsupported",
        reconnect: executable ? "requires-configuration" : "unsupported",
        disconnect: "adapted",
      }),
    },
    nativeExtensions: { [CATALOG_EXTENSION]: entry },
  };
  return normalizedDefinitionSchema.parse({
    ...body,
    normalizedDigest: await normalizedDigestOf(body),
  });
}

/**
 * The inert settings a reviewer approves for an entry. The entry is split by
 * section so the approval route's structural bound (depth four) holds; the
 * digest lets the adapter prove the reassembled entry is the reviewed one.
 */
export function providerCatalogBindingSettings(
  source: ProviderCatalogEntry | NormalizedDefinition,
): Record<string, unknown> {
  const entry =
    "schemaVersion" in source
      ? parseEntryFromDefinition(source)
      : entrySchemaFor({ allowLoopbackHttp: true }).parse(source);
  const { auth, proxy, connectionConfig, ...rest } = entry;
  return {
    [CATALOG_SETTINGS.entry]: rest,
    [CATALOG_SETTINGS.auth]: auth,
    ...(proxy ? { [CATALOG_SETTINGS.proxy]: proxy } : {}),
    [CATALOG_SETTINGS.connectionConfig]: connectionConfig,
    [CATALOG_SETTINGS.digest]: entryDigest(entry),
  };
}

function parseEntryFromDefinition(
  definition: NormalizedDefinition,
  options: ParseOptions = { allowLoopbackHttp: true },
): ProviderCatalogEntry {
  const raw = definition.nativeExtensions[CATALOG_EXTENSION];
  const parsed = entrySchemaFor(options).safeParse(raw);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "catalog.definition.entry-missing",
    });
  return parsed.data;
}

/**
 * The entry an approved binding carries, reassembled and validated again at
 * use. Absent settings mean the binding was approved without an entry, which
 * is a configuration fault, not a reason to guess one.
 */
export function entryFromBinding(
  binding: RuntimeBinding,
  options: ParseOptions,
): ProviderCatalogEntry | undefined {
  const settings = binding.settings;
  const head = settings[CATALOG_SETTINGS.entry];
  if (head === undefined) return undefined;
  const candidate = {
    ...(typeof head === "object" && head !== null ? head : {}),
    auth: settings[CATALOG_SETTINGS.auth],
    ...(settings[CATALOG_SETTINGS.proxy] !== undefined
      ? { proxy: settings[CATALOG_SETTINGS.proxy] }
      : {}),
    connectionConfig: settings[CATALOG_SETTINGS.connectionConfig] ?? [],
  };
  const parsed = entrySchemaFor(options).safeParse(candidate);
  if (!parsed.success)
    throw new ConnectorError("configuration-required", {
      detail: firstCode(parsed.error) ?? "catalog.binding.entry-invalid",
    });
  if (settings[CATALOG_SETTINGS.digest] !== entryDigest(parsed.data))
    throw new ConnectorError("configuration-required", {
      detail: "catalog.binding.entry-digest",
    });
  return parsed.data;
}

/**
 * The origin a URL template reaches. A host label a connection fills is
 * written `*`, so `https://*.example.com` is a family of origins no exact
 * origin matches: only a host policy that names it admits it.
 */
function templateOrigin(template: string, options: ParseOptions): string {
  const analysis = analyzeUrlTemplate(template, options);
  if ("error" in analysis)
    throw new ConnectorError("invalid-request", { detail: analysis.error });
  if (!analysis.hostFields.length) return new URL(template).origin;
  const host = [...analysis.hostFields.map(() => "*"), analysis.hostSuffix];
  const defaultPort = analysis.scheme === "https" ? "443" : "80";
  const port =
    analysis.port && analysis.port !== defaultPort ? `:${analysis.port}` : "";
  return `${analysis.scheme}://${host.join(".")}${port}`;
}

/** The issuer and every origin an entry's OAuth grants contact; absent for other modes. */
function oauthOrigins(
  entry: ProviderCatalogEntry,
  options: ParseOptions,
): BindingReviewResult["issuer"] {
  const auth = entry.auth;
  if (
    auth.mode !== "oauth2-authorization-code" &&
    auth.mode !== "oauth2-client-credentials"
  )
    return undefined;
  const token = templateOrigin(auth.tokenUrl, options);
  const endpoints =
    auth.mode === "oauth2-authorization-code"
      ? // The key set an openid authorization verifies ID tokens with is
        // contacted too, so host policy judges its origin with the rest.
        [auth.authorizationUrl, auth.tokenUrl, auth.refreshUrl, auth.jwksUrl]
      : [auth.tokenUrl];
  const issuer =
    auth.mode === "oauth2-authorization-code" && auth.issuer
      ? auth.issuer
      : token;
  const origins = new Set<string>([
    auth.mode === "oauth2-authorization-code" && auth.issuer
      ? new URL(auth.issuer).origin
      : token,
  ]);
  for (const url of endpoints)
    if (url) origins.add(templateOrigin(url, options));
  return { issuer, origins: [...origins] };
}

/**
 * Binding review for a catalog definition. The entry comes from the
 * definition the reviewer is approving, never from their settings, so the
 * endpoints and client-secret names a binding executes are the ones that were
 * imported and shown for review. The operations are the declared proxy
 * methods under the reviewer's decisions. A pinned adapter executes the
 * host's entry, so a definition carrying another one is refused here rather
 * than bound and refused at use; an unpinned one hands its OAuth origins back
 * for host issuer policy.
 */
export function reviewCatalogBinding(
  input: BindingReview,
  options: ParseOptions & { pinned?: ProviderCatalogEntry },
): BindingReviewResult {
  const entry = parseEntryFromDefinition(input.definition, options);
  if (options.pinned && entryDigest(entry) !== entryDigest(options.pinned))
    throw new ConnectorError("configuration-required", {
      detail: "catalog.binding.entry-differs",
    });
  if (input.verifier)
    throw new ConnectorError("unsupported", {
      detail: "verifier.adapter-unsupported",
    });
  const operations = input.operations.map((reviewed, index): BoundOperation => {
    const capability = input.definition.capabilities.find(
      (item) => item.nativeId === reviewed.nativeId,
    );
    const transport = boundOperationSchema.shape.transport.safeParse(
      capability?.nativeExtensions?.["x-ceremony-transport"],
    );
    if (
      !capability ||
      !transport.success ||
      transport.data.kind !== "http" ||
      !(PROXY_METHODS as readonly string[]).includes(transport.data.method)
    )
      throw new ConnectorError("invalid-request", {
        detail: "operation.transport-unknown",
      });
    const authenticationProfile =
      reviewed.authenticationProfile ??
      (input.profileId &&
      (capability.authentication ?? []).includes(input.profileId)
        ? input.profileId
        : undefined);
    const { authenticationProfile: _explicit, ...decisions } = reviewed;
    void _explicit;
    return {
      ...decisions,
      operationRef: `operation:${createHash("sha256")
        .update(canonicalConnectorJson([reviewed.nativeId, index]))
        .digest("hex")
        .slice(0, 32)}`,
      transport: transport.data,
      ...(authenticationProfile ? { authenticationProfile } : {}),
      ...(capability.label ? { description: capability.label } : {}),
    };
  });
  const issuer = options.pinned ? undefined : oauthOrigins(entry, options);
  return {
    operations,
    settings: providerCatalogBindingSettings(entry),
    ...(issuer ? { issuer } : {}),
  };
}
