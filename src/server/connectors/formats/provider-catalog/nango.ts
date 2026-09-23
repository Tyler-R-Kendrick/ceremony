import type { CompatibilityIssue } from "../../../../core/connectors/index.js";
import { parseBoundedDocument } from "../../import/parse.js";
import { catalogIssue, pointer } from "./issues.js";
import {
  analyzeUrlTemplate,
  entrySchemaFor,
  firstCode,
  PROVIDER_CATALOG_LIMITS,
  RESERVED_AUTHORIZATION_PARAMETERS,
  RESERVED_PROXY_HEADERS,
  RESERVED_TOKEN_PARAMETERS,
  type ParseOptions,
  type ProviderCatalogEntry,
} from "./schema.js";

/*
 * Nango's `providers.yaml` read into catalog entries.
 *
 * The file is a map from provider key to a description: `auth_mode`,
 * `authorization_url`, `token_url`, `authorization_params`, `token_params`,
 * `refresh_params`, `scope_separator`, `default_scopes`, `proxy.base_url`,
 * `proxy.headers`, `connection_config`, `refresh_url`, `docs`, `categories`
 * and `alias`. Where an entry also names its OpenID issuer - an `issuer`, or
 * the discovery document at a `well_known_url` - that is kept too, and is
 * what lets the entry ask for `openid`.
 * Templates in it use `${connectionConfig.x}` for per-connection values and
 * `${apiKey}` (and friends) for where a credential goes.
 *
 * Three rules shape the mapping:
 *
 * - Nothing is dropped silently. A provider whose mode the runtime cannot
 *   execute (OAUTH1, APP, CUSTOM, TBA, JWT, SIGNATURE ...) is still imported,
 *   as a described-but-not-executable entry that carries its reason, and a
 *   key this reader does not map is reported as an info issue.
 * - A credential is placed by the auth mode, never by a header template. A
 *   header such as `authorization: Bearer ${apiKey}` becomes the entry's
 *   typed API-key placement, and a template that splices a credential in any
 *   other shape makes the provider non-executable rather than being guessed.
 * - What cannot be represented exactly is either adapted with an info issue
 *   (a redundant `response_type: code`) or refused with a blocking one (a
 *   `token_params` entry that would override a parameter the grant owns).
 *
 * Reading the file contacts nothing; every URL in it is a declaration that a
 * binding review may later approve.
 */

export const NANGO_IMPORTER_VERSION = "1.0.0";

export type NangoProviderImport = {
  /** The provider key exactly as the file spells it. */
  nangoKey: string;
  entry: ProviderCatalogEntry;
  /** False when the entry is described but its auth mode cannot execute. */
  executable: boolean;
  issues: CompatibilityIssue[];
};

export type NangoImportResult = {
  providers: NangoProviderImport[];
  issues: CompatibilityIssue[];
};

export type NangoImportOptions = ParseOptions & {
  mediaType?: string;
  /** Import only these provider keys; the rest of the file is not mapped. */
  only?: readonly string[];
};

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const unsupportedModes: Record<string, string> = {
  OAUTH1:
    "OAuth 1.0a request signing is not implemented by the catalog adapter.",
  APP: "Provider app installations (GitHub App style) need a provider-specific adapter.",
  APP_STORE: "App-store credential exchange needs a provider-specific adapter.",
  CUSTOM:
    "A custom auth flow is provider code in Nango and has no data description.",
  TBA: "Token-based authentication (OAuth 1.0a signing) is not implemented by the catalog adapter.",
  JWT: "Provider-specific JWT minting is not described by the catalog format.",
  SIGNATURE:
    "Request signing is not described by the catalog format; it needs a provider-specific adapter.",
  TWO_STEP:
    "A two-step token exchange is provider logic that the catalog format does not describe.",
  BILL: "A provider-specific session login is not described by the catalog format.",
  OAUTH2_CC_JWT:
    "Client credentials with a signed assertion is not described by the catalog format.",
  INSTALL_PLUGIN:
    "Plugin installation is a provider-specific flow the catalog format does not describe.",
  MCP_OAUTH2:
    "MCP authorization belongs to the MCP adapter, which discovers it from the server.",
};

/** Top-level keys this reader understands without mapping; each still yields an info issue. */
const knownIgnored = new Set([
  "webhook_routing_script",
  "post_connection_script",
  "pre_connection_deletion_script",
  "webhook_user_defined_secret",
  "token_response_metadata",
  "token_expiration_buffer",
  "authorization_url_replacements",
  "authorization_code_param_in_body",
  "authorization_url_encode",
  "body_format",
  "credentials",
  "installation",
  "setup_guide_url",
  "require_client_certificate",
  "connection_configuration",
  "auth_documentation",
  "interactive_auth",
]);

const mappedKeys = new Set([
  "display_name",
  "categories",
  "docs",
  "auth_mode",
  "authorization_url",
  "token_url",
  "refresh_url",
  "authorization_params",
  "token_params",
  "refresh_params",
  "scope_separator",
  "default_scopes",
  "token_request_auth_method",
  "disable_pkce",
  "proxy",
  "connection_config",
  "verification",
  "alias",
  "issuer",
  "well_known_url",
]);

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(
      /[\p{Cc}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200E}\u{200F}\u{061C}]/gu,
      " ",
    )
    .trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value))
    if (typeof item === "string") out[key] = item;
    else if (typeof item === "number" || typeof item === "boolean")
      out[key] = String(item);
  return out;
}

function sanitizeId(key: string): string | undefined {
  const id = key
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return /^[a-z][a-z0-9-]{0,62}$/.test(id) ? id : undefined;
}

function upperSnake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Resolves `alias` one hop at a time, bounded, with the aliasing entry's own keys winning. */
function withAlias(
  document: Raw,
  key: string,
  issues: CompatibilityIssue[],
): Raw | undefined {
  const start = document[key];
  if (!isRecord(start)) return undefined;
  let current: Raw = start;
  const seen = new Set([key]);
  let merged: Raw = { ...current };
  for (let hop = 0; hop < 4 && typeof current["alias"] === "string"; hop++) {
    const target = current["alias"] as string;
    const base = document[target];
    if (seen.has(target) || !isRecord(base)) {
      issues.push(
        catalogIssue({
          kind: "rejected",
          code: "catalog.nango.alias-unresolved",
          pointer: pointer(key, "alias"),
          message:
            "The alias names a provider that is missing or forms a cycle; the entry cannot be described.",
        }),
      );
      return undefined;
    }
    seen.add(target);
    merged = {
      ...base,
      ...merged,
      proxy: {
        ...(isRecord(base["proxy"]) ? base["proxy"] : {}),
        ...(isRecord(merged["proxy"]) ? merged["proxy"] : {}),
      },
      alias: base["alias"],
    };
    current = base;
    issues.push(
      catalogIssue({
        kind: "adapted",
        code: "catalog.nango.alias-resolved",
        pointer: pointer(key, "alias"),
        message:
          "The provider inherits another provider's description; the merged description was imported.",
      }),
    );
  }
  delete merged["alias"];
  return merged;
}

type Draft = {
  id: string;
  displayName: string;
  categories: string[];
  docsUrl?: string;
  auth: Record<string, unknown>;
  proxy?: {
    baseUrl: string;
    headers: Record<string, string>;
    verification?: { method: "GET" | "HEAD"; path: string };
  };
  connectionConfig: Array<{
    name: string;
    label: string;
    configuration: string;
    format: "dns-label" | "token";
  }>;
};

class Unsupported extends Error {
  constructor(
    readonly native: string,
    readonly reason: string,
    readonly code: string,
    readonly at: string,
  ) {
    super(reason);
  }
}

const credentialVariable =
  /\$\{(apiKey|username|password|accessToken|credentials\.[^}]*)\}/;
const anyVariable = /\$\{([^}]*)\}/g;

function nonConnectionVariables(value: string): string[] {
  return [...value.matchAll(anyVariable)]
    .map((match) => match[1] ?? "")
    .filter(
      (name) => !/^connectionConfig\.[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name),
    );
}

/** Splits a query string off an authorization URL into explicit parameters. */
function splitQuery(url: string): {
  base: string;
  params: Record<string, string>;
} {
  const index = url.indexOf("?");
  if (index < 0) return { base: url, params: {} };
  const params: Record<string, string> = {};
  for (const pair of url.slice(index + 1).split("&")) {
    if (!pair) continue;
    const [name, value = ""] = pair.split("=");
    try {
      params[decodeURIComponent(name!)] = decodeURIComponent(value);
    } catch {
      params[name!] = value;
    }
  }
  return { base: url.slice(0, index), params };
}

function mapScopes(
  raw: Raw,
  key: string,
  issues: CompatibilityIssue[],
): { scopes: string[]; scopeSeparator: " " | "," } {
  const separator = raw["scope_separator"];
  let scopeSeparator: " " | "," = " ";
  if (separator === "," || separator === " " || separator === undefined)
    scopeSeparator = (separator ?? " ") as " " | ",";
  else if (separator === "+" || separator === "%20") {
    scopeSeparator = " ";
    issues.push(
      catalogIssue({
        kind: "adapted",
        code: "catalog.nango.scope-separator-adapted",
        pointer: pointer(key, "scope_separator"),
        message:
          "The scope separator is a URL-encoded space; scopes are joined with a space and encoded on the wire.",
      }),
    );
  } else
    throw new Unsupported(
      String(raw["auth_mode"]),
      "The scope separator is not one the catalog format can reproduce.",
      "catalog.nango.scope-separator",
      pointer(key, "scope_separator"),
    );
  const scopes = Array.isArray(raw["default_scopes"])
    ? raw["default_scopes"].filter(
        (item): item is string =>
          typeof item === "string" && /^[^\s\p{Cc},]{1,200}$/u.test(item),
      )
    : [];
  if (
    Array.isArray(raw["default_scopes"]) &&
    scopes.length !== raw["default_scopes"].length
  )
    issues.push(
      catalogIssue({
        kind: "warning",
        code: "catalog.nango.scope-dropped",
        pointer: pointer(key, "default_scopes"),
        message:
          "A default scope was not a single token and was left out; review the requested scopes.",
      }),
    );
  return {
    scopes: scopes.slice(0, PROVIDER_CATALOG_LIMITS.scopes),
    scopeSeparator,
  };
}

function mapAuthorizationParams(
  raw: Raw,
  key: string,
  query: Record<string, string>,
  issues: CompatibilityIssue[],
): { params: Record<string, string>; scopes: string[] } {
  const params: Record<string, string> = {};
  const scopes: string[] = [];
  const entries = [
    ...Object.entries(query).map(([name, value]) => ({
      name,
      value,
      from: "authorization_url",
    })),
    ...Object.entries(stringRecord(raw["authorization_params"])).map(
      ([name, value]) => ({ name, value, from: "authorization_params" }),
    ),
  ];
  for (const { name, value, from } of entries) {
    const at = pointer(key, from, name);
    if (name === "response_type" && value === "code") {
      issues.push(
        catalogIssue({
          kind: "adapted",
          code: "catalog.nango.parameter-redundant",
          pointer: at,
          message:
            "The parameter repeats what the authorization-code flow always sends and was not copied.",
        }),
      );
      continue;
    }
    if (name === "scope") {
      scopes.push(...value.split(/[\s,+]+/).filter(Boolean));
      issues.push(
        catalogIssue({
          kind: "adapted",
          code: "catalog.nango.scope-parameter",
          pointer: at,
          message:
            "A fixed scope parameter was imported as default scopes, which the flow sends itself.",
        }),
      );
      continue;
    }
    if (RESERVED_AUTHORIZATION_PARAMETERS.has(name))
      throw new Unsupported(
        "OAUTH2",
        "An authorization parameter overrides a value the OAuth engine must own.",
        "catalog.nango.parameter-reserved",
        at,
      );
    if (nonConnectionVariables(value).length)
      throw new Unsupported(
        "OAUTH2",
        "An authorization parameter references a value the catalog cannot supply.",
        "catalog.nango.template-unsupported",
        at,
      );
    if (from === "authorization_url")
      issues.push(
        catalogIssue({
          kind: "adapted",
          code: "catalog.nango.query-to-parameter",
          pointer: at,
          message:
            "A query parameter on the authorization URL became an explicit authorization parameter.",
        }),
      );
    params[name] = value;
  }
  return { params, scopes };
}

/**
 * `token_params`, or `refresh_params` for the refresh grant: static extras
 * for one kind of token request. A parameter the grant sends itself is
 * dropped when it only repeats it, and refused when it would change it.
 */
function tokenParameters(
  raw: Raw,
  key: string,
  grant: "authorization_code" | "client_credentials" | "refresh_token",
  issues: CompatibilityIssue[],
): Record<string, string> {
  const from = grant === "refresh_token" ? "refresh_params" : "token_params";
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(stringRecord(raw[from]))) {
    const at = pointer(key, from, name);
    if (name === "grant_type" && value === grant) {
      issues.push(
        catalogIssue({
          kind: "adapted",
          code: "catalog.nango.parameter-redundant",
          pointer: at,
          message:
            "The parameter repeats what the grant always sends and was not copied.",
        }),
      );
      continue;
    }
    if (
      RESERVED_TOKEN_PARAMETERS.has(name) ||
      nonConnectionVariables(value).length
    )
      throw new Unsupported(
        grant === "client_credentials" ? "OAUTH2_CC" : "OAUTH2",
        "A token parameter overrides the grant or references a value the catalog cannot supply.",
        grant === "refresh_token"
          ? "catalog.nango.refresh-params-unsupported"
          : "catalog.nango.token-params-unsupported",
        at,
      );
    params[name] = value;
  }
  return params;
}

/**
 * The issuer an OAUTH2 entry names, or nothing.
 *
 * An ID token names the account, so `openid` is only ever asked for an entry
 * whose issuer is known, and the adapter then reads that issuer's own metadata
 * and requires it to agree byte for byte. Nothing is guessed here: an entry
 * that names no issuer keeps refusing `openid`, and so does one whose issuer
 * cannot be an issuer identifier (RFC 8414 section 2: an HTTPS URL with no
 * query or fragment) or is templated per connection - whose keys verify an ID
 * token is never a per-connection choice. A `well_known_url` yields its issuer
 * by the discovery rules in reverse: the OpenID Connect suffix removed, or the
 * RFC 8414 well-known segment taken back out of the path.
 */
function mapIssuer(
  raw: Raw,
  key: string,
  issues: CompatibilityIssue[],
  options: ParseOptions,
): string | undefined {
  const identifier = (value: string): URL | undefined => {
    if (value.includes("${") || value.includes("?") || !URL.canParse(value))
      return undefined;
    const url = new URL(value);
    const loopback =
      url.protocol === "http:" &&
      options.allowLoopbackHttp === true &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    if (
      (url.protocol !== "https:" && !loopback) ||
      url.hash ||
      url.username ||
      url.password
    )
      return undefined;
    return url;
  };
  const dropped = (at: string, message: string) => {
    issues.push(
      catalogIssue({
        kind: "warning",
        code: "catalog.nango.issuer-dropped",
        pointer: pointer(key, at),
        message,
      }),
    );
    return undefined;
  };
  if (raw["issuer"] !== undefined) {
    const url =
      typeof raw["issuer"] === "string" ? identifier(raw["issuer"]) : undefined;
    if (!url)
      return dropped(
        "issuer",
        "The issuer is not a fixed HTTPS URL without a query or fragment, so it was left out; the entry cannot ask for openid.",
      );
    // Kept exactly as written: the metadata has to name it byte for byte.
    return raw["issuer"] as string;
  }
  if (raw["well_known_url"] === undefined) return undefined;
  const url =
    typeof raw["well_known_url"] === "string"
      ? identifier(raw["well_known_url"])
      : undefined;
  const path = url?.pathname ?? "";
  const suffix = "/.well-known/openid-configuration";
  const derived = !url
    ? undefined
    : path.endsWith(suffix)
      ? `${url.origin}${path.slice(0, -suffix.length)}`
      : /^\/\.well-known\/(oauth-authorization-server|openid-configuration)(\/|$)/.test(
            path,
          )
        ? `${url.origin}${path.replace(/^\/\.well-known\/[a-z-]+/, "")}`
        : undefined;
  if (derived === undefined)
    return dropped(
      "well_known_url",
      "The discovery URL is not an OpenID Connect or RFC 8414 metadata address, so no issuer could be read from it; the entry cannot ask for openid.",
    );
  issues.push(
    catalogIssue({
      kind: "adapted",
      code: "catalog.nango.issuer-from-discovery",
      pointer: pointer(key, "well_known_url"),
      message:
        "The issuer was read from the discovery URL. Its metadata must name the same issuer before any ID token is accepted.",
    }),
  );
  return derived;
}

function clientAuth(
  raw: Raw,
  key: string,
  fallback: "client_secret_basic" | "client_secret_post",
): "client_secret_basic" | "client_secret_post" {
  const method = raw["token_request_auth_method"];
  if (method === undefined) return fallback;
  if (method === "basic") return "client_secret_basic";
  if (method === "post" || method === "body") return "client_secret_post";
  throw new Unsupported(
    String(raw["auth_mode"]),
    "The token request authentication method is not one the catalog adapter implements.",
    "catalog.nango.token-auth-method",
    pointer(key, "token_request_auth_method"),
  );
}

/** Pulls the credential placement out of `proxy.headers` / `proxy.query`. */
function apiKeyPlacement(
  key: string,
  headers: Record<string, string>,
  query: Record<string, string>,
): Record<string, unknown> {
  const found: Array<{
    placement: "header" | "query";
    name: string;
    value: string;
  }> = [];
  for (const [name, value] of Object.entries(headers))
    if (credentialVariable.test(value))
      found.push({ placement: "header", name, value });
  for (const [name, value] of Object.entries(query))
    if (credentialVariable.test(value))
      found.push({ placement: "query", name, value });
  if (found.length !== 1)
    throw new Unsupported(
      "API_KEY",
      found.length
        ? "The API key is placed in more than one header or parameter."
        : "The description does not say where the API key goes.",
      "catalog.nango.api-key-placement",
      pointer(key, "proxy"),
    );
  const only = found[0]!;
  const shape = /^([\x21-\x7e]*(?: [\x21-\x7e]*)?)\$\{apiKey\}$/.exec(
    only.value,
  );
  if (!shape || shape[1]!.includes("${") || shape[1]!.length > 32)
    throw new Unsupported(
      "API_KEY",
      "The API key is transformed or combined with other values before it is sent.",
      "catalog.nango.api-key-placement",
      pointer(
        key,
        "proxy",
        only.placement === "header" ? "headers" : "query",
        only.name,
      ),
    );
  const prefix = shape[1]!;
  const name =
    only.placement === "header" ? only.name.toLowerCase() : only.name;
  if (only.placement === "header") delete headers[only.name];
  else delete query[only.name];
  if (
    only.placement === "header" &&
    name === "authorization" &&
    prefix === "Bearer "
  )
    return { mode: "bearer" };
  return { mode: "api-key", placement: only.placement, name, prefix };
}

function mapProvider(
  key: string,
  raw: Raw,
  id: string,
  issues: CompatibilityIssue[],
  options: ParseOptions,
): Draft {
  const displayName = text(raw["display_name"], 120) ?? key.slice(0, 120);
  const categories: string[] = [];
  if (Array.isArray(raw["categories"]))
    for (const item of raw["categories"]) {
      const category =
        typeof item === "string"
          ? item
              .toLowerCase()
              .replace(/[^a-z0-9-]+/g, "-")
              .replace(/^-+|-+$/g, "")
          : "";
      if (/^[a-z][a-z0-9-]{0,39}$/.test(category)) categories.push(category);
      else
        issues.push(
          catalogIssue({
            kind: "warning",
            code: "catalog.nango.category-dropped",
            pointer: pointer(key, "categories"),
            message: "A category was not a simple token and was left out.",
          }),
        );
    }
  const docs = raw["docs"];
  const docsUrl =
    typeof docs === "string" &&
    docs.startsWith("https://") &&
    URL.canParse(docs)
      ? docs.slice(0, 2048)
      : undefined;
  if (docs !== undefined && !docsUrl)
    issues.push(
      catalogIssue({
        kind: "warning",
        code: "catalog.nango.docs-dropped",
        pointer: pointer(key, "docs"),
        message: "The documentation link is not an HTTPS URL and was left out.",
      }),
    );

  for (const name of Object.keys(raw))
    if (!mappedKeys.has(name))
      issues.push(
        catalogIssue({
          kind: "info",
          code: knownIgnored.has(name)
            ? "catalog.nango.key-not-mapped"
            : "catalog.nango.key-unknown",
          pointer: pointer(key, name),
          message: knownIgnored.has(name)
            ? "This Nango feature has no catalog equivalent and was not imported."
            : "This key is not part of the provider description this reader knows.",
        }),
      );

  const proxyRaw = isRecord(raw["proxy"]) ? raw["proxy"] : {};
  const proxyHeaders = stringRecord(proxyRaw["headers"]);
  const proxyQuery = stringRecord(proxyRaw["query"]);
  for (const name of Object.keys(proxyRaw))
    if (!["base_url", "headers", "query", "verification"].includes(name))
      issues.push(
        catalogIssue({
          kind: "info",
          code: "catalog.nango.key-not-mapped",
          pointer: pointer(key, "proxy", name),
          message:
            "This proxy option (retries, pagination, decompression) is not part of the catalog proxy and was not imported.",
        }),
      );

  const mode = typeof raw["auth_mode"] === "string" ? raw["auth_mode"] : "";
  let auth: Record<string, unknown>;
  switch (mode) {
    case "OAUTH2": {
      const authorization =
        typeof raw["authorization_url"] === "string"
          ? splitQuery(raw["authorization_url"])
          : undefined;
      if (!authorization || typeof raw["token_url"] !== "string")
        throw new Unsupported(
          mode,
          "The OAuth endpoints are not declared.",
          "catalog.nango.endpoints-missing",
          pointer(key),
        );
      const { scopes, scopeSeparator } = mapScopes(raw, key, issues);
      const mapped = mapAuthorizationParams(
        raw,
        key,
        authorization.params,
        issues,
      );
      // Sent on the code exchange only; Nango keeps refresh-time extras in
      // `refresh_params`, which ride on refresh requests only.
      const tokenParams = tokenParameters(
        raw,
        key,
        "authorization_code",
        issues,
      );
      const refreshParams = tokenParameters(raw, key, "refresh_token", issues);
      const issuer = mapIssuer(raw, key, issues, options);
      if (raw["disable_pkce"] === true)
        issues.push(
          catalogIssue({
            kind: "adapted",
            code: "catalog.nango.pkce-not-verified",
            pointer: pointer(key, "disable_pkce"),
            message:
              "The provider does not verify PKCE; S256 is still sent, as OAuth security guidance recommends.",
          }),
        );
      auth = {
        mode: "oauth2-authorization-code",
        authorizationUrl: authorization.base,
        tokenUrl: raw["token_url"],
        ...(typeof raw["refresh_url"] === "string"
          ? { refreshUrl: raw["refresh_url"] }
          : {}),
        pkce: raw["disable_pkce"] !== true,
        scopes: [...new Set([...scopes, ...mapped.scopes])].slice(
          0,
          PROVIDER_CATALOG_LIMITS.scopes,
        ),
        scopeSeparator,
        authorizationParams: mapped.params,
        tokenParams,
        ...(Object.keys(refreshParams).length ? { refreshParams } : {}),
        tokenRequestAuth: clientAuth(raw, key, "client_secret_post"),
        refresh: true,
        ...(issuer !== undefined ? { issuer } : {}),
      };
      break;
    }
    case "OAUTH2_CC": {
      if (typeof raw["token_url"] !== "string")
        throw new Unsupported(
          mode,
          "The token endpoint is not declared.",
          "catalog.nango.endpoints-missing",
          pointer(key),
        );
      const { scopes, scopeSeparator } = mapScopes(raw, key, issues);
      auth = {
        mode: "oauth2-client-credentials",
        tokenUrl: raw["token_url"],
        scopes,
        scopeSeparator,
        tokenParams: tokenParameters(raw, key, "client_credentials", issues),
        tokenRequestAuth: clientAuth(raw, key, "client_secret_post"),
      };
      break;
    }
    case "API_KEY":
      auth = apiKeyPlacement(key, proxyHeaders, proxyQuery);
      break;
    case "BASIC": {
      auth = { mode: "basic" };
      for (const [name, value] of Object.entries(proxyHeaders))
        if (credentialVariable.test(value)) {
          delete proxyHeaders[name];
          issues.push(
            catalogIssue({
              kind: "adapted",
              code: "catalog.nango.basic-header",
              pointer: pointer(key, "proxy", "headers", name),
              message:
                "The header carried the Basic credential, which the basic mode places itself.",
            }),
          );
        }
      break;
    }
    case "NONE":
      auth = { mode: "none" };
      break;
    default:
      throw new Unsupported(
        mode || "unknown",
        unsupportedModes[mode] ??
          "This auth mode is not one the catalog adapter implements.",
        "catalog.nango.auth-mode-unsupported",
        pointer(key, "auth_mode"),
      );
  }

  // Whatever credential templates remain are placements this reader could
  // not type; guessing would put a secret somewhere nobody reviewed.
  for (const [name, value] of Object.entries(proxyHeaders))
    if (nonConnectionVariables(value).length)
      throw new Unsupported(
        mode,
        "A proxy header references a value the catalog cannot supply.",
        "catalog.nango.template-unsupported",
        pointer(key, "proxy", "headers", name),
      );
  for (const [name, value] of Object.entries(proxyHeaders))
    if (RESERVED_PROXY_HEADERS.has(name.toLowerCase())) {
      delete proxyHeaders[name];
      issues.push(
        catalogIssue({
          kind: "warning",
          code: "catalog.nango.header-reserved",
          pointer: pointer(key, "proxy", "headers", name),
          message:
            "The header is owned by the transport or the auth mode and was not imported as a default.",
        }),
      );
      void value;
    }
  for (const name of Object.keys(proxyQuery))
    issues.push(
      catalogIssue({
        kind: "warning",
        code: "catalog.nango.proxy-query-not-mapped",
        pointer: pointer(key, "proxy", "query", name),
        message:
          "Default query parameters are not part of the catalog proxy; callers pass them per request.",
      }),
    );

  // Fields: declared ones first, then any a template uses without declaring.
  const declared = isRecord(raw["connection_config"])
    ? raw["connection_config"]
    : {};
  const templates = [
    auth["authorizationUrl"],
    auth["tokenUrl"],
    auth["refreshUrl"],
    typeof proxyRaw["base_url"] === "string" ? proxyRaw["base_url"] : undefined,
    ...Object.values(
      (auth["authorizationParams"] as Record<string, string>) ?? {},
    ),
    ...Object.values((auth["tokenParams"] as Record<string, string>) ?? {}),
    ...Object.values((auth["refreshParams"] as Record<string, string>) ?? {}),
    ...Object.values(proxyHeaders),
  ].filter((value): value is string => typeof value === "string");
  const used = new Set<string>();
  const hostUsed = new Set<string>();
  for (const template of templates)
    for (const match of template.matchAll(
      /\$\{connectionConfig\.([a-zA-Z][a-zA-Z0-9_]{0,63})\}/g,
    )) {
      used.add(match[1]!);
      const host = /^https?:\/\/([^/?]*)/.exec(template)?.[1] ?? "";
      if (host.includes(match[0])) hostUsed.add(match[1]!);
    }
  const connectionConfig: Draft["connectionConfig"] = [];
  const names = [...new Set([...Object.keys(declared), ...used])];
  for (const name of names) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)) {
      issues.push(
        catalogIssue({
          kind: "warning",
          code: "catalog.nango.connection-config-dropped",
          pointer: pointer(key, "connection_config", name),
          message:
            "The connection field name is not a simple identifier and was left out.",
        }),
      );
      continue;
    }
    const spec = isRecord(declared[name]) ? declared[name] : {};
    if (!Object.hasOwn(declared, name))
      issues.push(
        catalogIssue({
          kind: "adapted",
          code: "catalog.nango.connection-config-implied",
          pointer: pointer(key),
          message:
            "A template uses a connection field the provider does not declare; it was declared from the template.",
        }),
      );
    if (
      Object.keys(spec).some((field) =>
        ["pattern", "prefix", "suffix", "format"].includes(field),
      )
    )
      issues.push(
        catalogIssue({
          kind: "adapted",
          code: "catalog.nango.connection-config-format",
          pointer: pointer(key, "connection_config", name),
          message:
            "The field's own pattern was replaced by the catalog's fixed value formats (DNS label or URL token).",
        }),
      );
    connectionConfig.push({
      name,
      label: text(spec["title"], 80) ?? name,
      configuration: `${upperSnake(id)}_${upperSnake(name)}`.slice(0, 96),
      format: hostUsed.has(name) ? "dns-label" : "token",
    });
  }

  let proxy: Draft["proxy"];
  if (typeof proxyRaw["base_url"] === "string") {
    const verificationRaw = isRecord(proxyRaw["verification"])
      ? proxyRaw["verification"]
      : isRecord(raw["verification"])
        ? raw["verification"]
        : undefined;
    const endpoints = verificationRaw?.["endpoints"];
    const path =
      typeof verificationRaw?.["endpoint"] === "string"
        ? verificationRaw["endpoint"]
        : Array.isArray(endpoints) && typeof endpoints[0] === "string"
          ? endpoints[0]
          : undefined;
    const method = verificationRaw?.["method"] ?? "GET";
    proxy = {
      baseUrl: proxyRaw["base_url"],
      headers: Object.fromEntries(
        Object.entries(proxyHeaders).map(([name, value]) => [
          name.toLowerCase(),
          value,
        ]),
      ),
      ...(path &&
      (method === "GET" || method === "HEAD") &&
      !path.includes("${")
        ? { verification: { method, path } }
        : {}),
    };
  } else
    issues.push(
      catalogIssue({
        kind: "warning",
        code: "catalog.nango.proxy-missing",
        pointer: pointer(key, "proxy"),
        executionImpact: "blocks-operation",
        message:
          "The provider declares no proxy base URL, so no API call can be approved for it.",
      }),
    );

  // Loopback is decided by the caller's option; report the URL problem precisely.
  const urls = [
    auth["authorizationUrl"],
    auth["tokenUrl"],
    auth["refreshUrl"],
    proxy?.baseUrl,
  ].filter((value): value is string => typeof value === "string");
  for (const template of urls) {
    const analysis = analyzeUrlTemplate(template, options);
    if ("error" in analysis)
      throw new Unsupported(
        mode,
        "An endpoint URL is not an HTTPS URL of the shape the catalog admits.",
        analysis.error,
        pointer(key),
      );
  }

  return {
    id,
    displayName,
    categories: [...new Set(categories)].slice(
      0,
      PROVIDER_CATALOG_LIMITS.categories,
    ),
    ...(docsUrl ? { docsUrl } : {}),
    auth,
    ...(proxy ? { proxy } : {}),
    connectionConfig,
  };
}

function describedOnly(
  draft: Pick<Draft, "id" | "displayName" | "categories" | "docsUrl">,
  native: string,
  reason: string,
): Record<string, unknown> {
  return {
    id: draft.id,
    displayName: draft.displayName,
    categories: draft.categories,
    ...(draft.docsUrl ? { docsUrl: draft.docsUrl } : {}),
    auth: {
      mode: "unsupported",
      native: /^[A-Za-z0-9_.-]{1,64}$/.test(native) ? native : "unknown",
      reason,
    },
  };
}

/**
 * Imports a Nango `providers.yaml` (or its JSON form). Every provider key in
 * scope yields exactly one result: an executable entry, or a described entry
 * whose auth mode is `unsupported` with the reason and a blocking issue.
 */
export function importNangoProviders(
  input: string | Uint8Array | Record<string, unknown>,
  options: NangoImportOptions = {},
): NangoImportResult {
  let document: unknown;
  if (typeof input === "string" || input instanceof Uint8Array)
    document = parseBoundedDocument(
      typeof input === "string" ? new TextEncoder().encode(input) : input,
      { mediaType: options.mediaType ?? "application/yaml" },
    ).value;
  else document = input;
  const issues: CompatibilityIssue[] = [];
  if (!isRecord(document))
    return {
      providers: [],
      issues: [
        catalogIssue({
          kind: "rejected",
          code: "catalog.nango.not-a-map",
          pointer: "",
          executionImpact: "blocks-definition",
          message:
            "A Nango providers file is a map from provider key to description.",
        }),
      ],
    };
  const keys = Object.keys(document).filter(
    (key) => !options.only || options.only.includes(key),
  );
  if (keys.length > PROVIDER_CATALOG_LIMITS.providers)
    return {
      providers: [],
      issues: [
        catalogIssue({
          kind: "rejected",
          code: "catalog.nango.too-many-providers",
          pointer: "",
          executionImpact: "blocks-definition",
          message:
            "The file describes more providers than one import admits; import a selection.",
        }),
      ],
    };
  const schema = entrySchemaFor(options);
  const providers: NangoProviderImport[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const local: CompatibilityIssue[] = [];
    const id = sanitizeId(key);
    if (!id || seen.has(id)) {
      issues.push(
        catalogIssue({
          kind: "rejected",
          code: id ? "catalog.nango.id-duplicate" : "catalog.nango.id-invalid",
          pointer: pointer(key),
          message: id
            ? "Two provider keys normalize to the same catalog id; the later one was not imported."
            : "The provider key cannot be turned into a catalog id.",
        }),
      );
      continue;
    }
    seen.add(id);
    if (id !== key)
      local.push(
        catalogIssue({
          kind: "adapted",
          code: "catalog.nango.id-normalized",
          pointer: pointer(key),
          message: "The provider key was normalized to a lowercase catalog id.",
        }),
      );
    const raw = withAlias(document, key, local);
    const fallback = {
      id,
      displayName: (raw && text(raw["display_name"], 120)) ?? key.slice(0, 120),
      categories: [] as string[],
    };
    let candidate: Record<string, unknown>;
    let executable = true;
    if (!raw) {
      candidate = describedOnly(
        fallback,
        "unknown",
        "The provider description could not be read.",
      );
      executable = false;
    } else
      try {
        candidate = mapProvider(
          key,
          raw,
          id,
          local,
          options,
        ) as unknown as Record<string, unknown>;
      } catch (error) {
        if (!(error instanceof Unsupported)) throw error;
        local.push(
          catalogIssue({
            kind: "unsupported",
            code: error.code,
            pointer: error.at,
            category: "security",
            dimension: "authorize",
            message: error.reason,
            remediation:
              "The provider stays in the catalog as a description; executing it needs a provider-specific adapter or a corrected entry.",
          }),
        );
        candidate = describedOnly(fallback, error.native, error.reason);
        executable = false;
      }
    let parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      const code = firstCode(parsed.error) ?? "catalog.entry.invalid";
      local.push(
        catalogIssue({
          kind: "unsupported",
          code,
          pointer: pointer(key),
          category: "security",
          dimension: "authorize",
          message:
            "The imported description does not satisfy the catalog's bounds, so it is kept as a description only.",
        }),
      );
      parsed = schema.safeParse(
        describedOnly(
          {
            id,
            displayName: fallback.displayName,
            categories: (candidate["categories"] as string[] | undefined) ?? [],
          },
          typeof raw?.["auth_mode"] === "string" ? raw["auth_mode"] : "unknown",
          "The imported description does not satisfy the catalog's bounds.",
        ),
      );
      executable = false;
      // A described-only entry carries nothing but bounded text, so it always
      // parses; failing here is a bug in this reader, not in the file.
      if (!parsed.success)
        throw new Error("Described-only catalog entry failed validation");
    }
    providers.push({
      nangoKey: key,
      entry: parsed.data,
      executable,
      issues: local,
    });
  }
  return { providers, issues };
}
