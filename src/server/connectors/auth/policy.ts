import { z } from "zod";
import type { RuntimeBinding } from "../binding.js";
import { ConnectorError } from "../errors.js";

/*
 * Host policy for one OAuth issuer. Nothing here is learned from a provider:
 * the host writes it, reviews it and pins it under the approved runtime
 * binding's inert settings (`settings.oauth`). Discovery may fill in endpoints
 * the policy leaves open, but it can never widen what the policy allows: which
 * registration profiles may be used, which origins endpoints may live on,
 * whether token exchange exists at all and for which audiences, and whether an
 * enterprise extension such as ID-JAG has been negotiated.
 */

export const clientRegistrationProfiles = [
  "pre-registered",
  "client-id-metadata-document",
  "dynamic",
] as const;
export type ClientRegistrationProfile =
  (typeof clientRegistrationProfiles)[number];

export const clientAuthenticationMethods = [
  "none",
  "client_secret_basic",
  "client_secret_post",
  "private_key_jwt",
] as const;
export type ClientAuthenticationMethod =
  (typeof clientAuthenticationMethods)[number];

/** RFC 8693 token type identifiers this module knows how to name. */
export const tokenTypeIdentifiers = Object.freeze({
  accessToken: "urn:ietf:params:oauth:token-type:access_token",
  refreshToken: "urn:ietf:params:oauth:token-type:refresh_token",
  idToken: "urn:ietf:params:oauth:token-type:id_token",
  jwt: "urn:ietf:params:oauth:token-type:jwt",
  /** Identity Assertion JWT Authorization Grant (MCP enterprise-managed authorization); opt-in only. */
  idJag: "urn:ietf:params:oauth:token-type:id-jag",
});

const configurationName = z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/);
const endpointUrl = z.url().max(2048);
const exactOriginString = z.string().refine((value) => {
  if (!URL.canParse(value)) return false;
  return new URL(value).origin === value;
}, "Trusted origins are exact origins");

export const issuerPolicySchema = z.strictObject({
  /** The issuer identifier, compared byte for byte with metadata and tokens. */
  issuer: z.string().min(1).max(2048),
  /** Origins other than the issuer's own on which endpoints may live, listed by the host. */
  trustedOrigins: z.array(exactOriginString).max(16).default([]),
  /**
   * Whether an endpoint the issuer's own verified metadata places on another
   * origin is accepted for that association. The registration endpoint is
   * never covered by this: it needs the issuer's origin or a listed one.
   */
  acceptIssuerDeclaredOrigins: z.boolean().default(true),
  discovery: z.enum(["required", "preferred", "disabled"]).default("required"),
  /** Host-configured endpoints, used when discovery is disabled or unavailable. */
  endpoints: z
    .strictObject({
      authorization: endpointUrl.optional(),
      token: endpointUrl.optional(),
      deviceAuthorization: endpointUrl.optional(),
      jwks: endpointUrl.optional(),
      registration: endpointUrl.optional(),
      pushedAuthorization: endpointUrl.optional(),
      introspection: endpointUrl.optional(),
      revocation: endpointUrl.optional(),
    })
    .prefault({}),
  registration: z
    .strictObject({
      /** Profiles this host permits for the issuer, in order of preference. */
      allowed: z
        .array(z.enum(clientRegistrationProfiles))
        .min(1)
        .max(3)
        .default(["pre-registered"]),
      clientIdConfiguration: configurationName.optional(),
      clientSecretConfiguration: configurationName.optional(),
      /** Configuration holding a private JWK (JSON) for private_key_jwt. */
      privateKeyConfiguration: configurationName.optional(),
      clientAuthentication: z.enum(clientAuthenticationMethods).optional(),
      /** Consult the published native public client table for this issuer origin. */
      publicNativeClient: z.boolean().default(false),
      clientName: z.string().max(80).optional(),
    })
    .prefault({}),
  /** RFC 8707 resource indicator sent on authorization and token requests. */
  resource: endpointUrl.optional(),
  /** RFC 9207: require `iss` on every callback, or only when the issuer advertises it. */
  responseIssuerParameter: z
    .enum(["if-advertised", "required"])
    .default("if-advertised"),
  pushedAuthorization: z.enum(["if-required", "prefer"]).default("if-required"),
  /** Loopback HTTP is for fixtures only; a remote issuer is always HTTPS. */
  allowLoopbackHttp: z.boolean().default(false),
  /**
   * RFC 7009: whether an upstream disconnect or an administrative revoke
   * presents the held tokens to the issuer's advertised revocation endpoint.
   * Off unless the host turns it on; a local disconnect never does.
   */
  revocation: z
    .enum(["disabled", "on-upstream-disconnect"])
    .default("disabled"),
  tokenExchange: z
    .strictObject({
      enabled: z.boolean().default(false),
      audiences: z.array(z.string().min(1).max(2048)).max(32).default([]),
      resources: z.array(endpointUrl).max(32).default([]),
      subjectTokenTypes: z
        .array(z.string().min(1).max(200))
        .max(8)
        .default([tokenTypeIdentifiers.accessToken]),
      requestedTokenTypes: z
        .array(z.string().min(1).max(200))
        .max(8)
        .default([tokenTypeIdentifiers.accessToken]),
      actorTokens: z.boolean().default(false),
      /** ID-JAG / enterprise-managed authorization is a separately negotiated profile. */
      idJag: z.boolean().default(false),
      subjectCheck: z.enum(["required", "none"]).default("required"),
    })
    .prefault({}),
});
export type IssuerPolicy = z.infer<typeof issuerPolicySchema>;
export type IssuerPolicyInput = z.input<typeof issuerPolicySchema>;

/** Parses and validates a host-written policy; issuer syntax is checked here once. */
export function issuerPolicy(input: IssuerPolicyInput): IssuerPolicy {
  const parsed = issuerPolicySchema.safeParse(input);
  if (!parsed.success)
    throw new ConnectorError("configuration-required", {
      detail: "oauth.policy.invalid",
      cause: parsed.error,
    });
  assertIssuerIdentifier(parsed.data.issuer, parsed.data.allowLoopbackHttp);
  if (parsed.data.tokenExchange.idJag) {
    // Negotiating the extension is what makes the token type requestable.
    if (
      !parsed.data.tokenExchange.requestedTokenTypes.includes(
        tokenTypeIdentifiers.idJag,
      )
    )
      parsed.data.tokenExchange.requestedTokenTypes.push(
        tokenTypeIdentifiers.idJag,
      );
  }
  return parsed.data;
}

/**
 * Every origin a policy lets the grants contact without discovery widening
 * it: the issuer's, the listed trusted origins and each configured endpoint's.
 * What host policy judges when a person pins the policy at binding review.
 */
export function issuerPolicyOrigins(policy: IssuerPolicy): string[] {
  const origins = new Set<string>([new URL(policy.issuer).origin]);
  for (const origin of policy.trustedOrigins) origins.add(origin);
  for (const endpoint of Object.values(policy.endpoints))
    if (endpoint) origins.add(new URL(endpoint).origin);
  if (policy.resource) origins.add(new URL(policy.resource).origin);
  return [...origins];
}

/**
 * Where per-profile issuer policies are pinned under an approved binding's
 * settings: a map from authentication profile id to a policy. Written only by
 * the reviewed approval path, like `settings.oauth`, which stays the
 * binding-wide fallback for a profile without its own entry.
 */
export const PROFILE_ISSUER_POLICIES_SETTING = "oauth-profiles";

/** The policy pinned under an approved binding's inert settings; never caller-supplied. */
export function issuerPolicyFromBinding(binding: RuntimeBinding): IssuerPolicy {
  const raw = binding.settings["oauth"];
  if (raw === undefined)
    throw new ConnectorError("configuration-required", {
      detail: "oauth.policy.missing",
    });
  return issuerPolicy(raw as IssuerPolicyInput);
}

/**
 * Issuer identifiers are URLs with a scheme, host and optional path, and no
 * query, fragment or credentials (RFC 8414 §2). The string is kept verbatim
 * for comparison; this only decides whether it may be used at all.
 */
export function assertIssuerIdentifier(
  issuer: string,
  allowLoopbackHttp: boolean,
): URL {
  if (!URL.canParse(issuer))
    throw new ConnectorError("configuration-required", {
      detail: "oauth.issuer.invalid",
    });
  const url = new URL(issuer);
  if (url.username || url.password || url.search || url.hash)
    throw new ConnectorError("configuration-required", {
      detail: "oauth.issuer.invalid",
    });
  if (!allowedScheme(url, allowLoopbackHttp))
    throw new ConnectorError("network-policy", {
      detail: "oauth.issuer.scheme",
    });
  return url;
}

export function isLoopbackHost(hostname: string): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
}

export function allowedScheme(url: URL, allowLoopbackHttp: boolean): boolean {
  return (
    url.protocol === "https:" ||
    (allowLoopbackHttp &&
      url.protocol === "http:" &&
      isLoopbackHost(url.hostname))
  );
}
