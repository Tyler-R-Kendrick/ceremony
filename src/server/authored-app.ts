import { createHash } from "node:crypto";
import { z } from "zod";
import type { ActorContext } from "../core/operation-contracts.js";
import type { OperationContext } from "./recipes/registry.js";
import type { AsyncCeremonyStore } from "./persistence/index.js";
import {
  clientMetadataDocument,
  metadataDocumentClientId,
  requestedScopes,
  useDpop,
  type ClientAuthentication,
  type TokenEndpointAuthMethod,
} from "./authored-oauth.js";
import { SYSTEM_TENANT } from "./system-tenants.js";

export type AuthoredApp = {
  clientId: string;
  redirectRegistered: boolean;
  flows: string[];
  redirectUri?: string;
  scope?: string;
  dpopRequired?: boolean;
  /** How the token endpoint authenticates this client; the secret itself is in custody, never here. */
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
};

const appSchema = z.object({
  clientId: z.string().min(1).max(2048),
  redirectRegistered: z.boolean(),
  flows: z.array(z.string()).max(16),
  redirectUri: z.string().url().optional(),
  scope: z.string().max(400).optional(),
  dpopRequired: z.boolean().optional(),
  tokenEndpointAuthMethod: z
    .enum(["none", "client_secret_basic", "client_secret_post"])
    .optional(),
});

type DiscoveryView = {
  clientId?: string | undefined;
  registrationEndpoint?: string | undefined;
  authorizationEndpoint?: string | undefined;
  deviceAuthorizationEndpoint?: string | undefined;
  clientIdMetadataDocumentSupported?: boolean | undefined;
  scopes?: string[] | undefined;
  methods: string[];
  tokenEndpoint?: string | undefined;
  codeChallengeMethods?: string[] | undefined;
  grantTypes?: string[] | undefined;
  dpopRequired?: boolean | undefined;
  dpopSigningAlgorithms?: string[] | undefined;
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod | undefined;
};

const confidential = (method: TokenEndpointAuthMethod | undefined) =>
  method === "client_secret_basic" || method === "client_secret_post";

/**
 * Custody for a confidential client's secret. A person who registered the
 * integration at the provider supplies it once through the native
 * app-registration page; it is bound to the author's subject, the connector
 * and the exact client ID it was issued with, so a changed client ID cannot
 * borrow it. It is read only to authenticate one token-endpoint request.
 */
export function authoredClientSecretKey(
  actor: ActorContext,
  connectorId: string,
) {
  return {
    tenant: actor.tenantId,
    kind: "handoff" as const,
    id: `authored-client-secret:${createHash("sha256")
      .update(JSON.stringify([actor.subjectId, connectorId]))
      .digest("hex")
      .slice(0, 32)}`,
  };
}

const clientSecretSchema = z.strictObject({
  clientId: z.string().min(1).max(2048),
  secret: z.string().min(1).max(2048),
});

export async function saveAuthoredClientSecret(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  connectorId: string,
  value: { clientId: string; secret: string },
) {
  const parsed = clientSecretSchema.parse(value);
  const key = authoredClientSecretKey(actor, connectorId);
  await store.transaction(async (tx) => {
    const current = await tx.get(key);
    await tx.put(key, parsed, current?.revision ?? null);
  });
}

/**
 * The token-endpoint authentication for one client. Undefined means a
 * confidential client whose secret is not in custody (or was issued for a
 * different client ID); the caller must not fall back to a public request.
 */
export async function authoredClientAuthentication(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  connectorId: string,
  clientId: string,
  method: TokenEndpointAuthMethod | undefined,
): Promise<ClientAuthentication | undefined> {
  if (!confidential(method)) return { method: "none" };
  const record = await store.transaction((tx) =>
    tx.get(authoredClientSecretKey(actor, connectorId)),
  );
  const parsed = clientSecretSchema.safeParse(record?.value);
  if (!parsed.success || parsed.data.clientId !== clientId) return undefined;
  return {
    method: method as "client_secret_basic" | "client_secret_post",
    secret: parsed.data.secret,
  };
}

/** Whether this discovery names a confidential client that still needs its secret. */
export async function authoredClientSecretNeeded(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  connectorId: string,
  discovery: DiscoveryView | undefined,
) {
  return Boolean(
    discovery?.clientId &&
    confidential(discovery.tokenEndpointAuthMethod) &&
    !(await authoredClientAuthentication(
      store,
      actor,
      connectorId,
      discovery.clientId,
      discovery.tokenEndpointAuthMethod,
    )),
  );
}

export function availableAuthFlows(discovery: DiscoveryView) {
  const flows: string[] = [];
  if (discovery.registrationEndpoint) flows.push("dcr");
  if (discovery.authorizationEndpoint) flows.push("oauth-code");
  if (discovery.deviceAuthorizationEndpoint) flows.push("device");
  if (discovery.methods.includes("api-key")) flows.push("api-key");
  return flows;
}

export function authoredAppKey(actor: ActorContext, runId: string) {
  return {
    tenant: actor.tenantId,
    kind: "artifact" as const,
    id: `authored-app:${runId}`,
  };
}

export async function readAuthoredApp(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
) {
  const record = await store.transaction((tx) =>
    tx.get(authoredAppKey(actor, runId)),
  );
  const parsed = appSchema.safeParse(record?.value);
  return parsed.success ? parsed.data : undefined;
}

export async function writeAuthoredApp(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
  app: AuthoredApp,
) {
  const key = authoredAppKey(actor, runId);
  await store.transaction(async (tx) => {
    const current = await tx.get(key);
    await tx.put(key, app, current?.revision ?? null);
  });
}

export async function registerDynamicClient(
  endpoint: string,
  redirectUri: string,
  name: string,
  fetcher: typeof fetch,
  grantTypes: string[],
  dpopRequired = false,
) {
  const response = await fetcher(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_name: name.slice(0, 80),
      redirect_uris: [redirectUri],
      grant_types: grantTypes,
      ...(grantTypes.includes("authorization_code")
        ? { response_types: ["code"] }
        : {}),
      token_endpoint_auth_method: "none",
      application_type: "web",
      ...(dpopRequired ? { dpop_bound_access_tokens: true } : {}),
    }),
  });
  if (!response.ok) return;
  const json = z
    .object({
      client_id: z.string().min(1).max(512),
      dpop_bound_access_tokens: z.boolean().optional(),
    })
    .passthrough()
    .safeParse(await response.json());
  if (
    !json.success ||
    json.data.client_secret !== undefined ||
    (json.data.token_endpoint_auth_method !== undefined &&
      json.data.token_endpoint_auth_method !== "none") ||
    (Array.isArray(json.data.redirect_uris) &&
      !json.data.redirect_uris.includes(redirectUri))
  )
    return;
  return {
    clientId: json.data.client_id,
    dpopRequired: json.data.dpop_bound_access_tokens === true,
  };
}

export function humanRedirectUri(
  origin: string,
  connectorId: string,
  runId: string,
) {
  return `${origin.replace(/\/$/, "")}/api/v1/teaching/${encodeURIComponent(connectorId)}/${encodeURIComponent(runId)}/human`;
}

/**
 * Register or reuse a client. A public client needs nothing from a person. A
 * declared confidential client is usable only once its secret is in custody;
 * until then this returns nothing and the app-registration page asks the
 * integration owner for it in a native private form.
 */
export async function ensureAuthoredApp(
  store: AsyncCeremonyStore,
  context: OperationContext,
  discovery: DiscoveryView | undefined,
  fetcher: typeof fetch,
) {
  const existing = await readAuthoredApp(store, context.actor, context.runId);
  if (existing?.clientId) return existing;
  if (!discovery) return;
  const redirectUri = humanRedirectUri(
    context.origin,
    context.target,
    context.runId,
  );
  const scope = requestedScopes(discovery.scopes).join(" ");
  const dpop = useDpop(discovery);
  let dpopRequired = discovery.dpopRequired ?? false;
  let redirectRegistered = false;
  let clientId = discovery.clientId;
  const confidentialClient =
    Boolean(clientId) && confidential(discovery.tokenEndpointAuthMethod);
  if (confidentialClient) {
    if (
      await authoredClientSecretNeeded(
        store,
        context.actor,
        context.target,
        discovery,
      )
    )
      return;
    // The owner registered this client for the redirect URI the page showed.
    redirectRegistered = true;
  }
  if (discovery.registrationEndpoint && !confidentialClient) {
    // Registration is not idempotent. A lost response requires reconciliation,
    // not another client registration on every refresh of the human handoff.
    const attemptKey = {
      tenant: context.actor.tenantId,
      kind: "handoff" as const,
      id: `authored-client-attempt:${context.runId}`,
    };
    const reserved = await store.transaction(async (tx) => {
      if (await tx.get(attemptKey)) return false;
      await tx.put(
        attemptKey,
        { endpoint: discovery.registrationEndpoint },
        null,
      );
      return true;
    });
    const registered = reserved
      ? await registerDynamicClient(
          discovery.registrationEndpoint,
          redirectUri,
          context.target,
          fetcher,
          [
            ...(discovery.authorizationEndpoint ? ["authorization_code"] : []),
            ...(discovery.deviceAuthorizationEndpoint
              ? ["urn:ietf:params:oauth:grant-type:device_code"]
              : []),
            ...(discovery.grantTypes?.includes("refresh_token")
              ? ["refresh_token"]
              : []),
          ],
          dpopRequired,
        ).catch(() => undefined)
      : undefined;
    if (registered) {
      if (registered.dpopRequired && !dpop) return;
      clientId = registered.clientId;
      dpopRequired ||= registered.dpopRequired;
      redirectRegistered = true;
    }
  }
  if (!clientId && discovery.clientIdMetadataDocumentSupported) {
    dpopRequired = dpop;
    clientId = metadataDocumentClientId(
      context.origin,
      redirectUri,
      scope,
      context.target,
      context.runId,
    );
    redirectRegistered = true;
  }
  if (!clientId) return;
  const app = {
    clientId,
    redirectRegistered,
    flows: availableAuthFlows(discovery),
    redirectUri,
    scope,
    ...(dpopRequired ? { dpopRequired: true } : {}),
    ...(confidentialClient
      ? { tokenEndpointAuthMethod: discovery.tokenEndpointAuthMethod }
      : {}),
  };
  await store.transaction(async (tx) => {
    const key = authoredAppKey(context.actor, context.runId);
    const current = await tx.get(key);
    await tx.put(key, app, current?.revision ?? null);
    // The client is unusable until its public metadata exists. Commit both or neither.
    if (clientId.includes("/oauth-clients/")) {
      const publicKey = {
        tenant: SYSTEM_TENANT.public,
        kind: "artifact" as const,
        id: `oauth-client:${context.target}:${context.runId}`,
      };
      const current = await tx.get(publicKey);
      await tx.put(
        publicKey,
        clientMetadataDocument({
          clientId,
          redirectUri,
          scope,
          name: context.target,
          dpopRequired,
        }),
        current?.revision ?? null,
      );
    }
  });
  return app;
}
