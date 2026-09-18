import { importJWK } from "jose";
import * as oauth from "oauth4webapi";
import { z } from "zod";
import type { ActorContext } from "../../../core/operation-contracts.js";
import { clientMetadataDocument } from "../../authored-oauth.js";
import { AuthorizationError, requireCapability } from "../../identity.js";
import { publicNativeClients } from "../../oauth-public-clients.js";
import { ConnectorError } from "../errors.js";
import type { ConfigurationPort, EffectJournalPort } from "../ports.js";
import type { ResolvedAuthorizationServer } from "./discovery.js";
import {
  allowedScheme,
  clientAuthenticationMethods,
  type ClientAuthenticationMethod,
  type ClientRegistrationProfile,
  type IssuerPolicy,
} from "./policy.js";
import { requestOptions, sha256Hex, wireError } from "./wire.js";

/*
 * Three ways a client can exist at an issuer, chosen by host policy rather
 * than by whatever the issuer advertises:
 *
 * - pre-registered: the host holds a client id (and secret or key) it obtained
 *   from the provider console; values come from the configuration port.
 * - client-id-metadata-document (CIMD, draft-ietf-oauth-client-id-metadata-
 *   document-03 as implemented here): the client id is an HTTPS URL under the
 *   host's own origin, and the host serves the document at that URL.
 * - dynamic (RFC 7591): the host registers once per issuer and tenant, only
 *   when policy allows it for that issuer, only at a registration endpoint on
 *   the issuer's own origin or a listed one, requesting only what discovery
 *   says the issuer supports; the registration is persisted and reused.
 *
 * Registering a client is an owner's act, not an end user's: it needs the
 * author capability. Executors use clients; they do not create them.
 */

export const storedClientRegistrationSchema = z.strictObject({
  issuer: z.string().min(1).max(2048),
  clientId: z.string().min(1).max(2048),
  clientSecret: z.string().min(1).max(4096).optional(),
  /** Seconds since the epoch, 0 for never (RFC 7591 §3.2.1). */
  clientSecretExpiresAt: z.number().int().nonnegative().optional(),
  tokenEndpointAuthMethod: z.enum(clientAuthenticationMethods),
  redirectUris: z.array(z.string().max(2048)).min(1).max(8),
  grantTypes: z.array(z.string().max(120)).min(1).max(8),
  registrationEndpoint: z.string().max(2048),
  registeredAt: z.number().int().nonnegative(),
  registrationAccessToken: z.string().max(4096).optional(),
  registrationClientUri: z.string().max(2048).optional(),
});
export type StoredClientRegistration = z.infer<
  typeof storedClientRegistrationSchema
>;

/**
 * Persistence for dynamic registrations, scoped by tenant. The state layer
 * implements it over the encrypted store; `create` is insert-only so a race
 * between two workers or a replayed command cannot overwrite the client the
 * issuer already knows.
 */
export interface ClientRegistrationStorePort {
  get(
    tenantId: string,
    key: string,
  ): Promise<StoredClientRegistration | undefined>;
  /** Returns false when a record already existed; the existing record wins. */
  create(
    tenantId: string,
    key: string,
    record: StoredClientRegistration,
  ): Promise<boolean>;
}

export type ClientSource =
  | "configuration"
  | "public-native-client"
  | "stored-registration"
  | "new-registration"
  | "metadata-document";

export type ClientMetadataArtifact = {
  clientId: string;
  document: Record<string, unknown>;
  /** Where the existing `/api/v1/teaching/oauth-clients/*` route reads the document from. */
  storageKey: { tenant: "public"; kind: "artifact"; id: string };
};

export type ResolvedClient = {
  profile: ClientRegistrationProfile;
  source: ClientSource;
  client: oauth.Client;
  method: ClientAuthenticationMethod;
  redirectUri: string;
  /** Builds the client authentication for one request; secret material stays in this closure. */
  authentication(): oauth.ClientAuth;
  /** CIMD only: the document the host must serve at `clientId` before authorization begins. */
  metadataDocument?: ClientMetadataArtifact;
};

export type ProfileFeasibility = {
  profile: ClientRegistrationProfile;
  feasible: boolean;
  reason:
    | "configured"
    | "public-native-client"
    | "client-not-configured"
    | "issuer-supports-cimd"
    | "cimd-support-unknown"
    | "issuer-does-not-support-cimd"
    | "registration-endpoint"
    | "registration-endpoint-untrusted"
    | "no-registration-endpoint";
};

export type ProfileSelection = {
  profile: ClientRegistrationProfile;
  selectedBy: "requested" | "policy-order";
  considered: ProfileFeasibility[];
};

function feasibility(
  profile: ClientRegistrationProfile,
  policy: IssuerPolicy,
  server: ResolvedAuthorizationServer,
  present: ReadonlySet<string>,
): ProfileFeasibility {
  switch (profile) {
    case "pre-registered": {
      const name = policy.registration.clientIdConfiguration;
      if (name && present.has(name))
        return { profile, feasible: true, reason: "configured" };
      if (
        policy.registration.publicNativeClient &&
        publicNativeClients[new URL(policy.issuer).origin]
      )
        return { profile, feasible: true, reason: "public-native-client" };
      return { profile, feasible: false, reason: "client-not-configured" };
    }
    case "client-id-metadata-document": {
      const flag = server.metadata["client_id_metadata_document_supported"];
      if (flag === true)
        return { profile, feasible: true, reason: "issuer-supports-cimd" };
      if (server.source === "configured" && flag === undefined)
        return { profile, feasible: false, reason: "cimd-support-unknown" };
      return {
        profile,
        feasible: false,
        reason: "issuer-does-not-support-cimd",
      };
    }
    case "dynamic": {
      if (typeof server.metadata.registration_endpoint === "string")
        return { profile, feasible: true, reason: "registration-endpoint" };
      if (server.refused.some((item) => item.role === "registration"))
        return {
          profile,
          feasible: false,
          reason: "registration-endpoint-untrusted",
        };
      return { profile, feasible: false, reason: "no-registration-endpoint" };
    }
  }
}

function infeasible(item: ProfileFeasibility): ConnectorError {
  switch (item.reason) {
    case "client-not-configured":
      return new ConnectorError("configuration-required", {
        detail: "oauth.client.missing",
      });
    case "cimd-support-unknown":
    case "issuer-does-not-support-cimd":
      return new ConnectorError("unsupported", {
        detail: "oauth.registration.cimd-unsupported",
      });
    case "registration-endpoint-untrusted":
      return new ConnectorError("network-policy", {
        detail: "oauth.registration.endpoint-untrusted",
      });
    case "no-registration-endpoint":
      return new ConnectorError("unsupported", {
        detail: "oauth.registration.dcr-unsupported",
      });
    default:
      return new ConnectorError("configuration-required", {
        detail: "oauth.registration.unavailable",
      });
  }
}

/**
 * Which registration profile applies for this issuer: the requested one when
 * policy allows it, otherwise the first allowed profile that is feasible with
 * what the host holds and what the issuer verifiably offers. A provider that
 * documents legacy dynamic registration keeps working through an explicit
 * policy entry even when a newer profile exists elsewhere (AC-AUTH-18); no
 * profile is ever advertised as universal.
 */
export function selectClientRegistrationProfile(input: {
  policy: IssuerPolicy;
  server: ResolvedAuthorizationServer;
  present: ReadonlySet<string>;
  requested?: ClientRegistrationProfile | undefined;
}): ProfileSelection {
  const allowed = input.policy.registration.allowed;
  if (input.requested !== undefined) {
    if (!allowed.includes(input.requested))
      throw new ConnectorError("denied", {
        detail: "oauth.registration.profile-not-allowed",
      });
    const item = feasibility(
      input.requested,
      input.policy,
      input.server,
      input.present,
    );
    if (!item.feasible) throw infeasible(item);
    return { profile: item.profile, selectedBy: "requested", considered: [item] };
  }
  const considered = allowed.map((profile) =>
    feasibility(profile, input.policy, input.server, input.present),
  );
  const chosen = considered.find((item) => item.feasible);
  if (!chosen) throw infeasible(considered[0]!);
  return { profile: chosen.profile, selectedBy: "policy-order", considered };
}

const privateJwkSchema = z
  .object({
    kty: z.enum(["EC", "RSA", "OKP"]),
    alg: z.enum([
      "ES256",
      "ES384",
      "ES512",
      "RS256",
      "RS384",
      "RS512",
      "PS256",
      "PS384",
      "PS512",
      "EdDSA",
      "Ed25519",
    ]),
    kid: z.string().min(1).max(200).optional(),
    d: z.string().min(1),
  })
  .passthrough();

async function privateKeyFromConfiguration(
  configuration: ConfigurationPort,
  name: string | undefined,
): Promise<oauth.PrivateKey> {
  if (!name)
    throw new ConnectorError("configuration-required", {
      detail: "oauth.client.private-key-missing",
    });
  const raw = await configuration.read(name);
  if (raw === undefined)
    throw new ConnectorError("configuration-required", {
      detail: "oauth.client.private-key-missing",
    });
  let parsed: z.infer<typeof privateJwkSchema>;
  try {
    parsed = privateJwkSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new ConnectorError("configuration-required", {
      detail: "oauth.client.private-key-invalid",
      cause: error,
    });
  }
  const { kid, ...jwk } = parsed;
  const key = await importJWK(
    { ...jwk, ...(kid !== undefined ? { kid } : {}) },
    parsed.alg,
  );
  if (key instanceof Uint8Array)
    throw new ConnectorError("configuration-required", {
      detail: "oauth.client.private-key-invalid",
    });
  return kid !== undefined ? { key, kid } : { key };
}

/** Client id and storage location for a CIMD document, on the route the host already serves. */
export function connectorClientMetadata(input: {
  hostOrigin: string;
  redirectUri: string;
  scope: string;
  name: string;
  /** Route segment; defaults to "connector". Matches the existing route's `[a-z0-9-]{1,64}` rule. */
  connectorId?: string | undefined;
  /** Stable per-binding key; digested so the URL carries no tenant or binding spelling. */
  key: string;
}): ClientMetadataArtifact {
  const connectorId = input.connectorId ?? "connector";
  if (!/^[a-z0-9-]{1,64}$/.test(connectorId))
    throw new ConnectorError("invalid-request", {
      detail: "oauth.cimd.connector-id",
    });
  const origin = new URL(input.hostOrigin).origin;
  const runId = sha256Hex(input.key).slice(0, 32);
  const clientId = `${origin}/api/v1/teaching/oauth-clients/${connectorId}/${runId}`;
  return {
    clientId,
    document: clientMetadataDocument({
      clientId,
      redirectUri: input.redirectUri,
      scope: input.scope,
      name: input.name,
      dpopRequired: false,
    }),
    storageKey: {
      tenant: "public",
      kind: "artifact",
      id: `oauth-client:${connectorId}:${runId}`,
    },
  };
}

/** The persistence key of a dynamic registration: one per tenant, issuer, redirect URI and host origin. */
export function registrationKey(input: {
  issuer: string;
  redirectUri: string;
  hostOrigin: string;
}): string {
  return `registration:${sha256Hex(input.issuer, input.redirectUri, input.hostOrigin)}`;
}

export type ResolveClientInput = {
  actor: ActorContext;
  policy: IssuerPolicy;
  server: ResolvedAuthorizationServer;
  /** Exact redirect URI the client is (or will be) registered with. */
  redirectUri: string;
  /** Exact host origin; the CIMD client id lives under it. */
  hostOrigin: string;
  configuration: ConfigurationPort;
  fetch: typeof fetch;
  requested?: ClientRegistrationProfile | undefined;
  grantTypes?: readonly string[] | undefined;
  scope?: string | undefined;
  registrations?: ClientRegistrationStorePort | undefined;
  effects?: EffectJournalPort | undefined;
  signal?: AbortSignal | undefined;
  now?: (() => number) | undefined;
  connectorId?: string | undefined;
  clientName?: string | undefined;
};

/** Resolves the client Ceremony acts as at this issuer, under the selected profile. */
export async function resolveClientRegistration(
  input: ResolveClientInput,
): Promise<ResolvedClient> {
  const hostOrigin = new URL(input.hostOrigin);
  if (
    hostOrigin.origin !== input.hostOrigin ||
    !allowedScheme(hostOrigin, input.policy.allowLoopbackHttp)
  )
    throw new ConnectorError("configuration-required", {
      detail: "oauth.host-origin.invalid",
    });
  if (
    !URL.canParse(input.redirectUri) ||
    new URL(input.redirectUri).origin !== hostOrigin.origin
  )
    throw new ConnectorError("invalid-request", {
      detail: "oauth.redirect-uri.origin",
    });
  const names = [
    input.policy.registration.clientIdConfiguration,
    input.policy.registration.clientSecretConfiguration,
    input.policy.registration.privateKeyConfiguration,
  ].filter((name): name is string => name !== undefined);
  const present = await input.configuration.present(names);
  const selection = selectClientRegistrationProfile({
    policy: input.policy,
    server: input.server,
    present,
    requested: input.requested,
  });
  switch (selection.profile) {
    case "pre-registered":
      return preRegisteredClient(input, present);
    case "client-id-metadata-document":
      return metadataDocumentClient(input);
    case "dynamic":
      return dynamicClient(input);
  }
}

async function preRegisteredClient(
  input: ResolveClientInput,
  present: ReadonlySet<string>,
): Promise<ResolvedClient> {
  const registration = input.policy.registration;
  let clientId: string | undefined;
  let source: ClientSource = "configuration";
  if (
    registration.clientIdConfiguration &&
    present.has(registration.clientIdConfiguration)
  )
    clientId = await input.configuration.read(
      registration.clientIdConfiguration,
    );
  if (clientId === undefined && registration.publicNativeClient) {
    clientId = publicNativeClients[new URL(input.policy.issuer).origin]?.clientId;
    source = "public-native-client";
  }
  if (!clientId)
    throw new ConnectorError("configuration-required", {
      detail: "oauth.client.missing",
    });
  const secret = registration.clientSecretConfiguration
    ? await input.configuration.read(registration.clientSecretConfiguration)
    : undefined;
  const method: ClientAuthenticationMethod =
    registration.clientAuthentication ??
    (secret !== undefined
      ? "client_secret_basic"
      : registration.privateKeyConfiguration
        ? "private_key_jwt"
        : "none");
  if (
    (method === "client_secret_basic" || method === "client_secret_post") &&
    secret === undefined
  )
    throw new ConnectorError("configuration-required", {
      detail: "oauth.client.secret-missing",
    });
  const privateKey =
    method === "private_key_jwt"
      ? await privateKeyFromConfiguration(
          input.configuration,
          registration.privateKeyConfiguration,
        )
      : undefined;
  return {
    profile: "pre-registered",
    source,
    client: { client_id: clientId, token_endpoint_auth_method: method },
    method,
    redirectUri: input.redirectUri,
    authentication: () => clientAuthentication(method, secret, privateKey),
  };
}

function clientAuthentication(
  method: ClientAuthenticationMethod,
  secret: string | undefined,
  privateKey: oauth.PrivateKey | undefined,
): oauth.ClientAuth {
  switch (method) {
    case "none":
      return oauth.None();
    case "client_secret_basic":
      return oauth.ClientSecretBasic(secret ?? "");
    case "client_secret_post":
      return oauth.ClientSecretPost(secret ?? "");
    case "private_key_jwt":
      if (!privateKey)
        throw new ConnectorError("configuration-required", {
          detail: "oauth.client.private-key-missing",
        });
      return oauth.PrivateKeyJwt(privateKey);
  }
}

async function metadataDocumentClient(
  input: ResolveClientInput,
): Promise<ResolvedClient> {
  const scope = input.scope ?? "";
  const artifact = connectorClientMetadata({
    hostOrigin: input.hostOrigin,
    redirectUri: input.redirectUri,
    scope,
    name: input.clientName ?? input.policy.registration.clientName ?? "Ceremony",
    connectorId: input.connectorId,
    key: registrationKey({
      issuer: input.policy.issuer,
      redirectUri: input.redirectUri,
      hostOrigin: input.hostOrigin,
    }),
  });
  if (!artifact.clientId.startsWith(`${new URL(input.hostOrigin).origin}/`))
    throw new ConnectorError("configuration-required", {
      detail: "oauth.cimd.client-id-origin",
    });
  return {
    profile: "client-id-metadata-document",
    source: "metadata-document",
    client: {
      client_id: artifact.clientId,
      token_endpoint_auth_method: "none",
    },
    method: "none",
    redirectUri: input.redirectUri,
    authentication: () => oauth.None(),
    metadataDocument: artifact,
  };
}

const registrationResponseSchema = z
  .object({
    client_id: z.string().min(1).max(2048),
    client_secret: z.string().min(1).max(4096).optional(),
    client_secret_expires_at: z.number().int().nonnegative().optional(),
    redirect_uris: z.array(z.string().max(2048)).max(32).optional(),
    grant_types: z.array(z.string().max(120)).max(32).optional(),
    token_endpoint_auth_method: z.string().max(64).optional(),
    registration_access_token: z.string().max(4096).optional(),
    registration_client_uri: z.string().max(2048).optional(),
  })
  .passthrough();

function clientFromStored(
  stored: StoredClientRegistration,
  redirectUri: string,
  source: ClientSource,
): ResolvedClient {
  const method = stored.tokenEndpointAuthMethod;
  const secret = stored.clientSecret;
  return {
    profile: "dynamic",
    source,
    client: {
      client_id: stored.clientId,
      token_endpoint_auth_method: method,
    },
    method,
    redirectUri,
    authentication: () => clientAuthentication(method, secret, undefined),
  };
}

async function dynamicClient(input: ResolveClientInput): Promise<ResolvedClient> {
  try {
    requireCapability(input.actor, "author");
  } catch (error) {
    if (error instanceof AuthorizationError)
      throw new ConnectorError("denied", {
        detail: "oauth.registration.owner-required",
        cause: error,
      });
    throw error;
  }
  if (!input.registrations)
    throw new ConnectorError("configuration-required", {
      detail: "oauth.registration.store-missing",
    });
  const endpoint = input.server.metadata.registration_endpoint;
  if (typeof endpoint !== "string")
    throw new ConnectorError("unsupported", {
      detail: "oauth.registration.dcr-unsupported",
    });
  const tenantId = input.actor.tenantId;
  const key = registrationKey({
    issuer: input.policy.issuer,
    redirectUri: input.redirectUri,
    hostOrigin: input.hostOrigin,
  });
  const stored = await input.registrations.get(tenantId, key);
  if (stored) {
    if (stored.issuer !== input.policy.issuer)
      throw new ConnectorError("conflict", {
        detail: "oauth.registration.issuer-conflict",
      });
    return clientFromStored(stored, input.redirectUri, "stored-registration");
  }
  const supportedGrants = input.server.metadata.grant_types_supported ?? [
    "authorization_code",
  ];
  const grantTypes = (
    input.grantTypes ?? ["authorization_code", "refresh_token"]
  ).filter((grant) => supportedGrants.includes(grant));
  if (!grantTypes.length)
    throw new ConnectorError("unsupported", {
      detail: "oauth.registration.grant-types",
    });
  const supportedMethods = input.server.metadata
    .token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
  const preferred: ClientAuthenticationMethod[] = input.policy.registration
    .clientAuthentication
    ? [input.policy.registration.clientAuthentication]
    : ["client_secret_basic", "client_secret_post", "none"];
  const method = preferred.find(
    (candidate) =>
      candidate !== "private_key_jwt" && supportedMethods.includes(candidate),
  );
  if (!method)
    throw new ConnectorError("unsupported", {
      detail: "oauth.registration.auth-method",
    });
  // Intent first: a lost response must not lead to a second client at the
  // issuer, which is exactly the uncontrolled client creation to avoid.
  let effectRef: string | undefined;
  if (input.effects) {
    const begun = await input.effects.begin({
      actor: input.actor,
      operation: "oauth.client.register",
      digest: sha256Hex(tenantId, key),
    });
    if (
      begun.prior &&
      (begun.prior.status === "applied" ||
        begun.prior.status === "indeterminate")
    ) {
      const again = await input.registrations.get(tenantId, key);
      if (again)
        return clientFromStored(again, input.redirectUri, "stored-registration");
      throw new ConnectorError("indeterminate", {
        detail: "oauth.registration.indeterminate",
      });
    }
    effectRef = begun.effectRef;
  }
  const now = input.now ?? Date.now;
  let registered: z.infer<typeof registrationResponseSchema>;
  try {
    const response = await oauth.dynamicClientRegistrationRequest(
      input.server.metadata,
      {
        client_name:
          input.clientName ??
          input.policy.registration.clientName ??
          "Ceremony connection",
        redirect_uris: [input.redirectUri],
        grant_types: grantTypes,
        response_types: grantTypes.includes("authorization_code")
          ? ["code"]
          : [],
        token_endpoint_auth_method: method,
        application_type: "web",
        ...(input.scope ? { scope: input.scope } : {}),
      },
      {
        ...requestOptions({
          fetch: input.fetch,
          signal: input.signal,
          allowLoopbackHttp: input.policy.allowLoopbackHttp,
        }),
        signal: input.signal ?? AbortSignal.timeout(10_000),
      },
    );
    registered = registrationResponseSchema.parse(
      await oauth.processDynamicClientRegistrationResponse(response),
    );
  } catch (error) {
    if (effectRef && input.effects)
      await input.effects.complete(effectRef, {
        status: "indeterminate",
        code: "oauth.registration.indeterminate",
        at: now(),
      });
    throw wireError(error, "oauth.registration");
  }
  const returnedMethod = registered.token_endpoint_auth_method ?? method;
  const consistent =
    (registered.redirect_uris === undefined ||
      registered.redirect_uris.includes(input.redirectUri)) &&
    (clientAuthenticationMethods as readonly string[]).includes(
      returnedMethod,
    ) &&
    returnedMethod !== "private_key_jwt" &&
    (returnedMethod === "none" || registered.client_secret !== undefined);
  if (!consistent) {
    if (effectRef && input.effects)
      await input.effects.complete(effectRef, {
        status: "failed",
        code: "oauth.registration.inconsistent",
        at: now(),
      });
    throw new ConnectorError("upstream-rejected", {
      detail: "oauth.registration.inconsistent",
    });
  }
  const record: StoredClientRegistration = {
    issuer: input.policy.issuer,
    clientId: registered.client_id,
    ...(registered.client_secret !== undefined
      ? { clientSecret: registered.client_secret }
      : {}),
    ...(registered.client_secret_expires_at !== undefined
      ? { clientSecretExpiresAt: registered.client_secret_expires_at }
      : {}),
    tokenEndpointAuthMethod: returnedMethod as ClientAuthenticationMethod,
    redirectUris: [input.redirectUri],
    grantTypes:
      registered.grant_types?.filter((grant) => grantTypes.includes(grant)) ??
      grantTypes,
    registrationEndpoint: endpoint,
    registeredAt: now(),
    ...(registered.registration_access_token !== undefined
      ? { registrationAccessToken: registered.registration_access_token }
      : {}),
    ...(registered.registration_client_uri !== undefined
      ? { registrationClientUri: registered.registration_client_uri }
      : {}),
  };
  const created = await input.registrations.create(tenantId, key, record);
  if (effectRef && input.effects)
    await input.effects.complete(effectRef, {
      status: created ? "applied" : "reconciled",
      at: now(),
    });
  if (!created) {
    // Another worker registered first; its record is the one the issuer's
    // other state refers to, so it wins and the newer client goes unused.
    const winner = await input.registrations.get(tenantId, key);
    if (winner)
      return clientFromStored(winner, input.redirectUri, "stored-registration");
  }
  return clientFromStored(record, input.redirectUri, "new-registration");
}
