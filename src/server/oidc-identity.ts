import { createHash, randomBytes } from "node:crypto";
import * as oauth from "oauth4webapi";
import { z } from "zod";
import {
  actorContextSchema,
  AuthorizationError,
  type ActorContext,
  type HostIdentityAdapter,
} from "./identity.js";
import { assertRequestBoundary, exactOrigin } from "./authorization.js";
import type { AsyncCeremonyStore } from "./persistence/index.js";

/** Must be backed by encrypted shared persistence. take is an atomic get-and-delete. */
export interface IdentityStore {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, value: unknown, expiresAt: number): Promise<void>;
  take(key: string): Promise<unknown | undefined>;
  delete(key: string): Promise<void>;
}
export function persistentIdentityStore(
  store: AsyncCeremonyStore,
): IdentityStore {
  const recordKey = (id: string) => ({
    tenant: "identity",
    kind: "session" as const,
    id,
  });
  const read = (id: string, consume: boolean) =>
    store.transaction(async (tx) => {
      const record = await tx.get<{ value: unknown; expiresAt: number }>(
        recordKey(id),
      );
      if (!record) return undefined;
      const expired = record.value.expiresAt <= (await tx.now());
      if (consume || expired) await tx.delete(recordKey(id), record.revision);
      return expired ? undefined : record.value.value;
    });
  return {
    get: (id) => read(id, false),
    take: (id) => read(id, true),
    put: (id, value, expiresAt) =>
      store.transaction(async (tx) => {
        await tx.put(recordKey(id), { value, expiresAt }, null);
      }),
    delete: (id) =>
      store.transaction(async (tx) => {
        const record = await tx.get(recordKey(id));
        if (record) await tx.delete(recordKey(id), record.revision);
      }),
  };
}
export interface OidcIdentityConfig {
  origin: string;
  issuer: string;
  /**
   * A pre-provisioned client id. Omit it and the identity registers its own
   * client with the provider (RFC 7591) at startup: registering the client is
   * the ceremony's own work, not something an operator wires up out of band and
   * passes in through the environment.
   */
  clientId?: string;
  /** Name shown to the provider when the client is registered dynamically. */
  clientName?: string;
  clientSecret?: string;
  development?: boolean;
  sessionSeconds?: number;
  /** Host-controlled mapping of validated ID token claims; never request headers. */
  mapClaims(
    claims: oauth.IDToken,
  ): Promise<Pick<ActorContext, "tenantId" | "subjectId" | "capabilities">>;
}
const pendingSchema = z.strictObject({
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  expiresAt: z.number(),
});
const sessionSchema = z.strictObject({
  actor: actorContextSchema,
  expiresAt: z.number(),
});
/** A client the identity registered for itself, persisted so a restart or a
 * second instance reuses the one registration instead of making another. */
const registeredClientSchema = z.strictObject({ client_id: z.string().min(1) });
const token = () => randomBytes(32).toString("base64url");
const key = (kind: string, value: string) =>
  `${kind}:${createHash("sha256").update(value).digest("hex")}`;
function cookie(request: Request, name: string): string | undefined {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  const value = values[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
export async function createOidcIdentity(
  config: OidcIdentityConfig,
  store: IdentityStore,
): Promise<
  HostIdentityAdapter & {
    login(request: Request): Promise<Response>;
    callback(request: Request): Promise<Response>;
    logout(request: Request): Promise<Response>;
  }
> {
  const origin = exactOrigin(config.origin, config.development);
  const redirect = `${origin}/api/auth/callback`;
  const issuer = new URL(config.issuer);
  const safeEndpoint = (endpoint: string | undefined): URL => {
    if (!endpoint) throw new AuthorizationError("invalid_request");
    const url = new URL(endpoint);
    if (
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          config.development &&
          url.protocol === "http:" &&
          url.hostname === "127.0.0.1"
        ))
    )
      throw new AuthorizationError("invalid_request");
    return url;
  };
  if (
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    (issuer.protocol !== "https:" &&
      !(
        config.development &&
        issuer.protocol === "http:" &&
        issuer.hostname === "127.0.0.1"
      ))
  )
    throw new AuthorizationError("invalid_request");
  if (
    config.sessionSeconds !== undefined &&
    (!Number.isInteger(config.sessionSeconds) ||
      config.sessionSeconds < 60 ||
      config.sessionSeconds > 86400)
  )
    throw new AuthorizationError("invalid_request");
  const options = {
    [oauth.allowInsecureRequests]: config.development === true,
  };
  const as = await oauth.processDiscoveryResponse(
    issuer,
    await oauth.discoveryRequest(issuer, options),
  );
  for (const endpoint of [
    as.authorization_endpoint,
    as.token_endpoint,
    as.jwks_uri,
  ])
    safeEndpoint(endpoint);
  // The client the ceremony authenticates as. When none was configured it
  // registers one with the provider now (RFC 7591), rather than relying on a
  // client somebody provisioned out of band. The registration is persisted, so
  // a restart or a second instance reuses it instead of registering again.
  let client: oauth.Client;
  if (config.clientId) {
    client = { client_id: config.clientId };
  } else {
    safeEndpoint(as.registration_endpoint);
    const registrationKey = key(
      "identity-client",
      `${issuer.href}|${redirect}`,
    );
    const cached = registeredClientSchema.safeParse(
      await store.get(registrationKey),
    );
    if (cached.success) {
      client = { client_id: cached.data.client_id };
    } else {
      const registered = await oauth.processDynamicClientRegistrationResponse(
        await oauth.dynamicClientRegistrationRequest(
          as,
          {
            client_name: config.clientName ?? "Ceremony connection",
            redirect_uris: [redirect],
            grant_types: ["authorization_code"],
            response_types: ["code"],
            token_endpoint_auth_method: config.clientSecret
              ? "client_secret_post"
              : "none",
            application_type: "web",
          },
          options,
        ),
      );
      if (!registered.client_id)
        throw new AuthorizationError("invalid_request");
      client = { client_id: registered.client_id };
      await store.put(
        registrationKey,
        { client_id: registered.client_id },
        Date.now() + 365 * 24 * 60 * 60 * 1000,
      );
    }
  }
  const prefix = config.development ? "ceremony_" : "__Host-ceremony_";
  const sessionName = `${prefix}session`;
  const stateName = `${prefix}login`;
  const seconds = config.sessionSeconds ?? 3600;
  const setCookie = (name: string, value: string, age: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${config.development ? "" : "; Secure"}`;
  const response = (location: string, cookies: string[]) => {
    const headers = new Headers({
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    for (const value of cookies) headers.append("set-cookie", value);
    return new Response(null, { status: 303, headers });
  };
  return {
    async authenticate(request) {
      const id = cookie(request, sessionName);
      if (!id) return null;
      const parsed = sessionSchema.safeParse(
        await store.get(key("identity-session", id)),
      );
      if (!parsed.success || parsed.data.expiresAt <= Date.now()) return null;
      return parsed.data.actor;
    },
    async login(request) {
      assertRequestBoundary(request, { origin });
      if (request.method !== "POST")
        throw new AuthorizationError("invalid_request");
      const binding = token();
      const pending = {
        state: oauth.generateRandomState(),
        nonce: oauth.generateRandomNonce(),
        verifier: oauth.generateRandomCodeVerifier(),
        expiresAt: Date.now() + 600000,
      };
      await store.put(
        key("identity-login", binding),
        pending,
        pending.expiresAt,
      );
      const url = new URL(as.authorization_endpoint!);
      url.search = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirect,
        response_type: "code",
        scope: "openid",
        state: pending.state,
        nonce: pending.nonce,
        code_challenge: await oauth.calculatePKCECodeChallenge(
          pending.verifier,
        ),
        code_challenge_method: "S256",
      }).toString();
      return response(url.href, [setCookie(stateName, binding, 600)]);
    },
    async callback(request) {
      try {
        if (
          request.method !== "GET" ||
          new URL(request.url).origin !== origin ||
          new URL(request.url).pathname !== "/api/auth/callback"
        )
          throw new AuthorizationError("denied");
        const binding = cookie(request, stateName);
        if (!binding) throw new AuthorizationError("denied");
        const pending = pendingSchema.parse(
          await store.take(key("identity-login", binding)),
        );
        if (pending.expiresAt <= Date.now())
          throw new AuthorizationError("denied");
        const params = oauth.validateAuthResponse(
          as,
          client,
          new URL(request.url),
          pending.state,
        );
        const result = await oauth.authorizationCodeGrantRequest(
          as,
          client,
          config.clientSecret
            ? oauth.ClientSecretPost(config.clientSecret)
            : oauth.None(),
          params,
          redirect,
          pending.verifier,
          options,
        );
        const tokens = await oauth.processAuthorizationCodeResponse(
          as,
          client,
          result,
          { expectedNonce: pending.nonce, requireIdToken: true },
        );
        await oauth.validateApplicationLevelSignature(as, result, options);
        const claims = oauth.getValidatedIdTokenClaims(tokens);
        if (!claims) throw new AuthorizationError("denied");
        const actor = actorContextSchema.parse({
          ...(await config.mapClaims(claims)),
          sessionId: token(),
          actorKind: "human",
        });
        const old = cookie(request, sessionName);
        if (old) await store.delete(key("identity-session", old));
        const id = token();
        const expiresAt = Math.min(
          Date.now() + seconds * 1000,
          claims.exp * 1000,
        );
        if (expiresAt <= Date.now()) throw new AuthorizationError("denied");
        await store.put(
          key("identity-session", id),
          { actor, expiresAt },
          expiresAt,
        );
        return response(origin, [
          setCookie(
            sessionName,
            id,
            Math.floor((expiresAt - Date.now()) / 1000),
          ),
          setCookie(stateName, "", 0),
        ]);
      } catch {
        throw new AuthorizationError("denied");
      }
    },
    async logout(request) {
      assertRequestBoundary(request, { origin });
      if (request.method !== "POST")
        throw new AuthorizationError("invalid_request");
      const id = cookie(request, sessionName);
      if (id) await store.delete(key("identity-session", id));
      return response(origin, [setCookie(sessionName, "", 0)]);
    },
  };
}
