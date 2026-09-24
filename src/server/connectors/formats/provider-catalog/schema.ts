import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalConnectorJson,
  safeTextSchema,
} from "../../../../core/connectors/index.js";
import { ConnectorError } from "../../errors.js";

/*
 * A provider described as data rather than as a hand-written adapter: where
 * its authorization and token endpoints are, which credential it takes and
 * where that credential goes, which base URL its API lives under, and which
 * values a person must supply per connection (a subdomain, a region).
 *
 * An entry *declares* endpoints. Declaring is not approving: nothing in an
 * entry is contacted until a reviewer approves a runtime binding for it, and
 * even then the proxy reaches only the exact origin the reviewer approved.
 * That is the replacement for the manifest's blanket endpoint ban -- declared
 * endpoints, approved at binding review.
 *
 * Because an entry is the one place a URL can come from, its URLs are held to
 * a grammar rather than to "anything `new URL` accepts":
 *
 * - HTTPS only. Loopback HTTP is admitted only when the host constructing the
 *   parser says so, which is the same opt-in the OAuth issuer policy uses
 *   (`allowLoopbackHttp`), and the adapter additionally requires the binding's
 *   destination to have been admitted as a `loopback-fixture` by host policy.
 * - One template form, `${connectionConfig.<field>}`, and only for fields the
 *   entry declares. Anything else inside `${...}` is refused, so a secret or an
 *   arbitrary expression cannot be spliced into a URL.
 * - A template may fill a whole host label, and only the leftmost labels, with
 *   at least two fixed labels to its right. A value can therefore choose which
 *   tenant of `zendesk.com` to reach, never which domain.
 * - No userinfo, no fragment, no port or scheme templating, no `..`, `//` or
 *   encoded slash in a path, and no query string on any URL except where an
 *   importer moved it into explicit parameters.
 */

export const PROVIDER_CATALOG_FORMAT = "ceremony.provider-catalog/v1";

export const PROVIDER_CATALOG_LIMITS = Object.freeze({
  providers: 2048,
  categories: 16,
  scopes: 64,
  parameters: 16,
  headers: 16,
  connectionConfig: 8,
  urlLength: 2048,
  valueLength: 512,
  fieldValueLength: 200,
});

const providerIdPattern = /^[a-z][a-z0-9-]{0,62}$/;
const configurationNamePattern = /^[A-Z][A-Z0-9_]{0,95}$/;
const fieldNamePattern = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const placeholderPattern = /\$\{([^}]*)\}/g;
const fieldReference = /^connectionConfig\.([a-zA-Z][a-zA-Z0-9_]{0,63})$/;
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const tokenValue = /^[A-Za-z0-9_~.-]{1,200}$/;
const loopbackHosts = new Set(["127.0.0.1", "localhost"]);

/** Authorization request parameters the OAuth engine owns; an entry cannot set them. */
export const RESERVED_AUTHORIZATION_PARAMETERS: ReadonlySet<string> = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "nonce",
  "resource",
  "authorization_details",
  "request_uri",
  "request",
]);

/**
 * Token request parameters either grant owns: the grant type and what binds
 * the request to one attempt (code, verifier, redirect URI), client
 * authentication, and scope, resource and refresh token, which come from the
 * request itself or host policy. An entry's `tokenParams` may name none.
 */
export const RESERVED_TOKEN_PARAMETERS: ReadonlySet<string> = new Set([
  "grant_type",
  "client_id",
  "client_secret",
  "client_assertion",
  "client_assertion_type",
  "scope",
  "resource",
  "code",
  "code_verifier",
  "redirect_uri",
  "refresh_token",
]);

/**
 * Headers an entry may never set as a default. Credentials are placed only by
 * the auth mode, and framing, routing and forwarding headers belong to the
 * transport.
 */
export const RESERVED_PROXY_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "expect",
  "via",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

/** Headers an API key can never be placed in, whatever its name. */
const FORBIDDEN_CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(
  [...RESERVED_PROXY_HEADERS].filter((name) => name !== "authorization"),
);

export type UrlPart = "host" | "path" | "query";

export type UrlTemplateAnalysis = {
  scheme: "https" | "http";
  /** Fixed labels to the right of any templated ones, lowercased. */
  hostSuffix: string;
  /** Fields referenced in the host; they must be DNS labels. */
  hostFields: string[];
  fields: string[];
  port: string;
};

export type ParseOptions = {
  /**
   * Admit `http://127.0.0.1` / `http://localhost` endpoints. For loopback
   * fixtures only; the adapter still refuses to contact one unless host policy
   * admitted the binding's destination as a loopback fixture.
   */
  allowLoopbackHttp?: boolean;
};

function referencedFields(template: string): {
  fields: string[];
  invalid: boolean;
} {
  const fields: string[] = [];
  let invalid = false;
  for (const match of template.matchAll(placeholderPattern)) {
    const name = fieldReference.exec(match[1] ?? "")?.[1];
    if (name === undefined) invalid = true;
    else fields.push(name);
  }
  // A `${` that never closes, or a stray `}` pairing, would otherwise leave
  // template syntax in the URL that a later reader might interpret.
  const stripped = template.replace(placeholderPattern, "");
  if (stripped.includes("${") || stripped.includes("$}")) invalid = true;
  return { fields, invalid };
}

/**
 * Checks one URL template against the grammar in the module comment and says
 * which parts reference which fields. Returns a reason code instead of
 * throwing so a schema and an importer can both report it.
 */
export function analyzeUrlTemplate(
  template: string,
  options: ParseOptions & { query?: boolean } = {},
): UrlTemplateAnalysis | { error: string } {
  if (template.length > PROVIDER_CATALOG_LIMITS.urlLength)
    return { error: "catalog.url.too-long" };
  if (/[\s\p{Cc}\\#@]/u.test(template))
    return { error: "catalog.url.characters" };
  const shape = /^(https?):\/\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(template);
  if (!shape) return { error: "catalog.url.shape" };
  const scheme = shape[1] as "https" | "http";
  const authority = shape[2]!;
  const path = shape[3] ?? "";
  const query = shape[4];
  if (query !== undefined && !options.query)
    return { error: "catalog.url.query" };
  const { fields, invalid } = referencedFields(template);
  if (invalid) return { error: "catalog.template.variable" };

  const portMatch = /^(.*?)(?::(\d{1,5}))?$/.exec(authority)!;
  const host = portMatch[1]!;
  const port = portMatch[2] ?? "";
  if (host.includes(":") || host.includes("["))
    return { error: "catalog.url.host" };
  // Split on dots outside `${...}`; a field reference has its own dot.
  const labels = host.split(/\.(?![^{]*\})/);
  const hostFields: string[] = [];
  let fixedStarted = false;
  for (const label of labels) {
    const whole = /^\$\{connectionConfig\.([a-zA-Z][a-zA-Z0-9_]{0,63})\}$/.exec(
      label,
    );
    if (whole) {
      // Templated labels only on the left: a value picks a tenant, never the
      // registrable domain it lives under.
      if (fixedStarted) return { error: "catalog.template.host-position" };
      hostFields.push(whole[1]!);
      continue;
    }
    if (label.includes("${")) return { error: "catalog.template.host-partial" };
    if (!dnsLabel.test(label)) return { error: "catalog.url.host" };
    fixedStarted = true;
  }
  const fixed = labels.filter((label) => !label.includes("${"));
  if (hostFields.length && fixed.length < 2)
    return { error: "catalog.template.host-suffix" };
  const hostSuffix = fixed.join(".").toLowerCase();
  if (port && port.includes("${")) return { error: "catalog.template.port" };

  if (scheme === "http") {
    if (!options.allowLoopbackHttp) return { error: "catalog.url.scheme" };
    if (hostFields.length || !loopbackHosts.has(hostSuffix))
      return { error: "catalog.url.scheme" };
  }
  if (
    path.includes("//") ||
    /%2f|%5c|%2e/i.test(path) ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  )
    return { error: "catalog.url.path" };

  // Probe with inert values: the parser must agree with our reading of the
  // template, so nothing it would normalize can slip past the checks above.
  const probeHost = [
    ...hostFields.map(() => "probe"),
    ...fixed.map((label) => label.toLowerCase()),
  ].join(".");
  const probe = `${scheme}://${probeHost}${port ? `:${port}` : ""}${path.replace(
    placeholderPattern,
    "p",
  )}${(query ?? "").replace(placeholderPattern, "p")}`;
  if (!URL.canParse(probe)) return { error: "catalog.url.shape" };
  const parsed = new URL(probe);
  if (
    parsed.hostname !== probeHost ||
    parsed.username ||
    parsed.password ||
    (path && parsed.pathname !== path.replace(placeholderPattern, "p"))
  )
    return { error: "catalog.url.normalized" };
  return { scheme, hostSuffix, hostFields, fields, port };
}

function urlTemplateSchema(options: ParseOptions & { query?: boolean }) {
  return z
    .string()
    .min(1)
    .max(PROVIDER_CATALOG_LIMITS.urlLength)
    .superRefine((value, ctx) => {
      const analysis = analyzeUrlTemplate(value, options);
      if ("error" in analysis)
        ctx.addIssue({ code: "custom", message: analysis.error });
    });
}

/** A parameter or header value: bounded text that may reference declared fields and nothing else. */
const valueTemplateSchema = z
  .string()
  .max(PROVIDER_CATALOG_LIMITS.valueLength)
  .regex(/^[^\p{Cc}]*$/u)
  .superRefine((value, ctx) => {
    if (referencedFields(value).invalid)
      ctx.addIssue({ code: "custom", message: "catalog.template.variable" });
  });

const parameterNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/);
const headerNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, "Header names are lowercase tokens");
const configurationNameSchema = z.string().regex(configurationNamePattern);
const scopeSchema = z.string().regex(/^[^\s\p{Cc},]{1,200}$/u);

const parameterRecord = (reserved: ReadonlySet<string>) =>
  z
    .record(parameterNameSchema, valueTemplateSchema)
    .refine(
      (value) =>
        Object.keys(value).length <= PROVIDER_CATALOG_LIMITS.parameters,
      "Too many parameters",
    )
    .refine(
      (value) => Object.keys(value).every((name) => !reserved.has(name)),
      "catalog.parameter.reserved",
    );

const clientConfiguration = {
  /** Configuration name holding the client id; defaults to `<ID>_CLIENT_ID`. */
  clientIdConfiguration: configurationNameSchema.optional(),
  /** Configuration name holding the client secret; defaults to `<ID>_CLIENT_SECRET`. */
  clientSecretConfiguration: configurationNameSchema.optional(),
};

function authSchema(options: ParseOptions) {
  const url = urlTemplateSchema(options);
  return z.discriminatedUnion("mode", [
    z.strictObject({
      mode: z.literal("oauth2-authorization-code"),
      authorizationUrl: url,
      tokenUrl: url,
      /** Where refresh requests go when the provider separates them from the token endpoint. */
      refreshUrl: url.optional(),
      /**
       * The issuer identifier for RFC 9207 `iss` checks, when the provider has
       * one. Defaults to the token endpoint's origin.
       */
      issuer: url.optional(),
      /**
       * Where the issuer publishes its signing keys, when that is not on the
       * issuer's origin. Needed only for `openid`; discovery must agree.
       */
      jwksUrl: url.optional(),
      /**
       * Whether the provider is known to verify PKCE. S256 is sent either way
       * (RFC 9700); this records what the provider enforces, for review.
       */
      pkce: z.boolean().default(true),
      scopes: z
        .array(scopeSchema)
        .max(PROVIDER_CATALOG_LIMITS.scopes)
        .default([]),
      scopeSeparator: z.enum([" ", ","]).default(" "),
      authorizationParams: parameterRecord(
        RESERVED_AUTHORIZATION_PARAMETERS,
      ).default({}),
      /**
       * Static extra parameters for the code exchange (not refresh), such as
       * an `audience`. Values may fill declared connection fields only.
       */
      tokenParams: parameterRecord(RESERVED_TOKEN_PARAMETERS).default({}),
      tokenRequestAuth: z
        .enum(["client_secret_basic", "client_secret_post", "none"])
        .default("client_secret_post"),
      refresh: z.boolean().default(true),
      ...clientConfiguration,
    }),
    z.strictObject({
      mode: z.literal("oauth2-client-credentials"),
      tokenUrl: url,
      scopes: z
        .array(scopeSchema)
        .max(PROVIDER_CATALOG_LIMITS.scopes)
        .default([]),
      scopeSeparator: z.enum([" ", ","]).default(" "),
      tokenParams: parameterRecord(RESERVED_TOKEN_PARAMETERS).default({}),
      tokenRequestAuth: z
        .enum(["client_secret_basic", "client_secret_post"])
        .default("client_secret_basic"),
      ...clientConfiguration,
    }),
    z.strictObject({
      mode: z.literal("api-key"),
      placement: z.enum(["header", "query"]),
      /** Header (lowercase) or query parameter name the key is sent under. */
      name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/),
      /** Literal text before the key, such as "Bearer " or "Token token=". */
      prefix: z
        .string()
        .max(32)
        .regex(/^[\x21-\x7e]*(?: [\x21-\x7e]*)?$/)
        .default(""),
    }),
    z.strictObject({
      mode: z.literal("basic"),
      /** Some providers take a key as the username and no password. */
      passwordOptional: z.boolean().default(false),
    }),
    z.strictObject({ mode: z.literal("bearer") }),
    z.strictObject({ mode: z.literal("none") }),
    z.strictObject({
      /** Described, not executable: kept so review sees it instead of losing it. */
      mode: z.literal("unsupported"),
      native: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
      reason: safeTextSchema.min(1).max(300),
    }),
  ]);
}

function proxySchema(options: ParseOptions) {
  return z.strictObject({
    /** The only origin (and path prefix) the authenticated proxy may reach. */
    baseUrl: urlTemplateSchema(options),
    headers: z
      .record(headerNameSchema, valueTemplateSchema)
      .refine(
        (value) => Object.keys(value).length <= PROVIDER_CATALOG_LIMITS.headers,
        "Too many headers",
      )
      .refine(
        (value) =>
          Object.keys(value).every((name) => !RESERVED_PROXY_HEADERS.has(name)),
        "catalog.header.reserved",
      )
      .default({}),
    /** A read the adapter may use to check a collected credential. */
    verification: z
      .strictObject({
        method: z.enum(["GET", "HEAD"]).default("GET"),
        path: z
          .string()
          .max(512)
          .regex(/^\/(?!\/)[A-Za-z0-9_~.\-/:@!$&'()*+,;=%]*$/)
          .refine(
            (value) =>
              !/%2f|%5c|%2e/i.test(value) &&
              !value.includes("//") &&
              !value.split("/").some((part) => part === "." || part === ".."),
            "catalog.url.path",
          ),
      })
      .optional(),
  });
}

const connectionFieldSchema = z.strictObject({
  name: z.string().regex(fieldNamePattern),
  label: safeTextSchema.min(1).max(80),
  /** Where the host keeps the value; per actor, never in the entry. */
  configuration: configurationNameSchema,
  /** `dns-label` is required for a field used in a host; `token` is a safe URL token. */
  format: z.enum(["dns-label", "token"]).default("token"),
});

export function entrySchemaFor(options: ParseOptions = {}) {
  return z
    .strictObject({
      id: z.string().regex(providerIdPattern),
      displayName: safeTextSchema.min(1).max(120),
      categories: z
        .array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/))
        .max(PROVIDER_CATALOG_LIMITS.categories)
        .default([]),
      /** Shown to a reviewer; never fetched. */
      docsUrl: z
        .url()
        .max(2048)
        .refine((value) => value.startsWith("https://"), "catalog.url.scheme")
        .optional(),
      auth: authSchema(options),
      proxy: proxySchema(options).optional(),
      connectionConfig: z
        .array(connectionFieldSchema)
        .max(PROVIDER_CATALOG_LIMITS.connectionConfig)
        .default([]),
    })
    .superRefine((entry, ctx) => {
      const fail = (message: string) =>
        ctx.addIssue({ code: "custom", message });
      const fields = new Map(entry.connectionConfig.map((f) => [f.name, f]));
      if (fields.size !== entry.connectionConfig.length)
        fail("catalog.connection-config.duplicate");
      const names = [
        ...entry.connectionConfig.map((field) => field.configuration),
        ...Object.values(clientConfigurationNames(entry)),
      ];
      if (new Set(names).size !== names.length)
        fail("catalog.configuration.duplicate");

      const urls: string[] = [];
      const values: string[] = [];
      const auth = entry.auth;
      if (auth.mode === "oauth2-authorization-code") {
        urls.push(auth.authorizationUrl, auth.tokenUrl);
        if (auth.refreshUrl) urls.push(auth.refreshUrl);
        values.push(
          ...Object.values(auth.authorizationParams),
          ...Object.values(auth.tokenParams),
        );
        if (auth.issuer && referencedFields(auth.issuer).fields.length)
          fail("catalog.issuer.templated");
        // Keys decide whose identity an ID token proves: never per connection.
        if (auth.jwksUrl && referencedFields(auth.jwksUrl).fields.length)
          fail("catalog.jwks.templated");
      }
      if (auth.mode === "oauth2-client-credentials") {
        urls.push(auth.tokenUrl);
        values.push(...Object.values(auth.tokenParams));
      }
      if (auth.mode === "api-key") {
        if (
          auth.placement === "header" &&
          (auth.name !== auth.name.toLowerCase() ||
            FORBIDDEN_CREDENTIAL_HEADERS.has(auth.name))
        )
          fail("catalog.api-key.header");
        if (
          auth.placement === "header" &&
          entry.proxy &&
          Object.hasOwn(entry.proxy.headers, auth.name)
        )
          fail("catalog.api-key.header-collision");
      }
      if (entry.proxy) {
        urls.push(entry.proxy.baseUrl);
        values.push(...Object.values(entry.proxy.headers));
      }
      for (const template of urls) {
        const analysis = analyzeUrlTemplate(template, options);
        if ("error" in analysis) continue; // reported by the field schema
        for (const name of analysis.fields)
          if (!fields.has(name)) fail("catalog.template.undeclared-field");
        for (const name of analysis.hostFields)
          if (fields.get(name)?.format !== "dns-label")
            fail("catalog.template.host-field-format");
      }
      for (const value of values)
        for (const name of referencedFields(value).fields)
          if (!fields.has(name)) fail("catalog.template.undeclared-field");
    });
}

export const providerCatalogEntrySchema = entrySchemaFor();
export type ProviderCatalogEntry = z.infer<typeof providerCatalogEntrySchema>;
export type ProviderCatalogEntryInput = z.input<
  typeof providerCatalogEntrySchema
>;
export type ProviderAuth = ProviderCatalogEntry["auth"];
export type ProviderAuthMode = ProviderAuth["mode"];

export function catalogDocumentSchemaFor(options: ParseOptions = {}) {
  return z
    .strictObject({
      catalog: z.literal(PROVIDER_CATALOG_FORMAT),
      providers: z
        .array(entrySchemaFor(options))
        .max(PROVIDER_CATALOG_LIMITS.providers),
    })
    .refine(
      (document) =>
        new Set(document.providers.map((entry) => entry.id)).size ===
        document.providers.length,
      "catalog.provider.duplicate",
    );
}

/** Validates one entry; the reason is a bounded code, never the input echoed back. */
export function parseProviderCatalogEntry(
  input: unknown,
  options: ParseOptions = {},
): ProviderCatalogEntry {
  const parsed = entrySchemaFor(options).safeParse(input);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: firstCode(parsed.error) ?? "catalog.entry.invalid",
      cause: parsed.error,
    });
  return parsed.data;
}

/** The first `catalog.*` reason in a Zod error, for a precise public detail. */
export function firstCode(error: z.ZodError): string | undefined {
  for (const issue of error.issues)
    if (/^catalog(?:\.[a-z0-9-]+){1,6}$/.test(issue.message))
      return issue.message;
  return undefined;
}

/** Canonical digest of an entry; the identity a binding and a host registration agree on. */
export function entryDigest(entry: ProviderCatalogEntry): string {
  return createHash("sha256")
    .update(canonicalConnectorJson(entry))
    .digest("hex");
}

/** A catalog document for the given entries, in the form `import` reads back. */
export function providerCatalogDocument(
  entries: readonly ProviderCatalogEntry[],
): string {
  return JSON.stringify({
    catalog: PROVIDER_CATALOG_FORMAT,
    providers: entries,
  });
}

function upperSnake(id: string): string {
  return id.toUpperCase().replace(/-/g, "_");
}

/** The configuration names holding the OAuth client for an entry; empty for other modes. */
export function clientConfigurationNames(
  entry: Pick<ProviderCatalogEntry, "id" | "auth">,
): { clientId?: string; clientSecret?: string } {
  const auth = entry.auth;
  if (
    auth.mode !== "oauth2-authorization-code" &&
    auth.mode !== "oauth2-client-credentials"
  )
    return {};
  const clientId =
    auth.clientIdConfiguration ?? `${upperSnake(entry.id)}_CLIENT_ID`;
  const needsSecret =
    auth.mode === "oauth2-client-credentials" ||
    auth.tokenRequestAuth !== "none";
  return {
    clientId,
    ...(needsSecret
      ? {
          clientSecret:
            auth.clientSecretConfiguration ??
            `${upperSnake(entry.id)}_CLIENT_SECRET`,
        }
      : {}),
  };
}

// ------------------------------------------------------------- resolution

export type ResolvedUrl = { url: URL; analysis: UrlTemplateAnalysis };

function fieldValue(
  entry: ProviderCatalogEntry,
  values: Readonly<Record<string, string>>,
  name: string,
  part: UrlPart | "value",
): string {
  const field = entry.connectionConfig.find((item) => item.name === name);
  if (!field)
    throw new ConnectorError("invalid-request", {
      detail: "catalog.template.undeclared-field",
    });
  const value = values[name];
  if (value === undefined || value === "")
    throw new ConnectorError("configuration-required", {
      detail: "catalog.connection-config.missing",
    });
  if (value.length > PROVIDER_CATALOG_LIMITS.fieldValueLength)
    throw new ConnectorError("invalid-request", {
      detail: "catalog.connection-config.value",
    });
  const pattern =
    part === "host" || field.format === "dns-label" ? dnsLabel : tokenValue;
  // A dot segment survives encoding unchanged and the URL parser would then
  // normalize it away, so it is refused as a value outright.
  if (!pattern.test(value) || value === "." || value === "..")
    throw new ConnectorError("invalid-request", {
      detail: "catalog.connection-config.value",
    });
  return part === "host" ? value.toLowerCase() : value;
}

/**
 * Fills a URL template with per-connection values and proves the result is
 * the URL the template described: same scheme, a host under the fixed suffix,
 * the port as written, no userinfo, and a path the parser did not rewrite.
 */
export function resolveUrlTemplate(
  entry: ProviderCatalogEntry,
  template: string,
  values: Readonly<Record<string, string>>,
  options: ParseOptions & { query?: boolean } = {},
): ResolvedUrl {
  const analysis = analyzeUrlTemplate(template, options);
  if ("error" in analysis)
    throw new ConnectorError("invalid-request", { detail: analysis.error });
  const shape = /^(https?:\/\/)([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(template)!;
  const [host, port] = shape[2]!.split(/:(?=\d+$)/);
  const resolvedHost = host!.replace(placeholderPattern, (_, reference) =>
    fieldValue(entry, values, fieldReference.exec(reference)![1]!, "host"),
  );
  const resolvedPath = (shape[3] ?? "").replace(
    placeholderPattern,
    (_, reference) =>
      encodeURIComponent(
        fieldValue(entry, values, fieldReference.exec(reference)![1]!, "path"),
      ),
  );
  const resolvedQuery = (shape[4] ?? "").replace(
    placeholderPattern,
    (_, reference) =>
      encodeURIComponent(
        fieldValue(entry, values, fieldReference.exec(reference)![1]!, "query"),
      ),
  );
  const text = `${shape[1]}${resolvedHost}${port ? `:${port}` : ""}${resolvedPath}${resolvedQuery}`;
  if (!URL.canParse(text))
    throw new ConnectorError("invalid-request", {
      detail: "catalog.template.resolved",
    });
  const url = new URL(text);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== `${analysis.scheme}:` ||
    url.username ||
    url.password ||
    url.hash ||
    url.port !== analysis.port ||
    !(
      hostname === analysis.hostSuffix ||
      (analysis.hostFields.length > 0 &&
        hostname.endsWith(`.${analysis.hostSuffix}`) &&
        hostname.split(".").length ===
          analysis.hostSuffix.split(".").length + analysis.hostFields.length)
    ) ||
    (resolvedPath !== "" && url.pathname !== resolvedPath)
  )
    throw new ConnectorError("network-policy", {
      detail: "catalog.template.escaped",
    });
  return { url, analysis };
}

/** Fills a parameter or header value; the result is a single line of bounded text. */
export function resolveValueTemplate(
  entry: ProviderCatalogEntry,
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  const resolved = template.replace(placeholderPattern, (_, reference) => {
    const name = fieldReference.exec(reference)?.[1];
    if (!name)
      throw new ConnectorError("invalid-request", {
        detail: "catalog.template.variable",
      });
    return fieldValue(entry, values, name, "value");
  });
  if (/[\p{Cc}]/u.test(resolved) || resolved.length > 1024)
    throw new ConnectorError("invalid-request", {
      detail: "catalog.template.resolved",
    });
  return resolved;
}

/** Every field an entry's templates need a value for. */
export function requiredFields(entry: ProviderCatalogEntry): string[] {
  const templates: string[] = [];
  const auth = entry.auth;
  if (auth.mode === "oauth2-authorization-code") {
    templates.push(auth.authorizationUrl, auth.tokenUrl);
    if (auth.refreshUrl) templates.push(auth.refreshUrl);
    templates.push(
      ...Object.values(auth.authorizationParams),
      ...Object.values(auth.tokenParams),
    );
  }
  if (auth.mode === "oauth2-client-credentials")
    templates.push(auth.tokenUrl, ...Object.values(auth.tokenParams));
  if (entry.proxy)
    templates.push(entry.proxy.baseUrl, ...Object.values(entry.proxy.headers));
  return [
    ...new Set(templates.flatMap((value) => referencedFields(value).fields)),
  ];
}
