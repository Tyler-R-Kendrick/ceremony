import { randomUUID } from "node:crypto";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  type CryptoKey,
} from "jose";
import {
  startHttpFixture,
  type FixtureReply,
  type RecordedRequest,
} from "./http-fixture.js";

/*
 * An independent Auth0 tenant double: a JWKS, the `/oauth/token` endpoint with
 * the documented Token Vault exchange, and the My Account API's Connected
 * Accounts collection.
 *
 * It is written from the published contract rather than from the adapter. It
 * signs its own tokens, verifies the ones it is handed, and answers with the
 * documented OAuth error bodies, so an adapter that stops checking the tenant,
 * the subject, the audience or the connection is caught here rather than
 * agreed with.
 *
 * Contract sources, retrieved 2026-09-18:
 *   https://auth0.com/docs/secure/tokens/token-vault/refresh-token-exchange-with-token-vault
 *       grant_type urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token,
 *       subject_token_type urn:ietf:params:oauth:token-type:refresh_token,
 *       requested_token_type http://auth0.com/oauth/token-type/federated-connection-access-token,
 *       connection, scope, login_hint; response access_token/scope/expires_in/
 *       issued_token_type/token_type; 401 when the user or connected account is not found
 *   https://auth0.com/docs/secure/tokens/token-vault/access-token-exchange-with-token-vault
 *       subject_token_type urn:ietf:params:oauth:token-type:access_token
 *   https://auth0.com/docs/secure/tokens/token-vault/connected-accounts-for-token-vault
 *   https://auth0.com/docs/oas/myaccount/myaccount-api-oas.json  (My Account API 1.0:
 *       POST /me/v1/connected-accounts/connect, POST …/complete,
 *       GET …/accounts, GET …/connections, DELETE …/accounts/{id},
 *       scopes create|read|delete:me:connected_accounts)
 */

export const TOKEN_VAULT_GRANT =
  "urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token";
export const FEDERATED_TOKEN_TYPE =
  "http://auth0.com/oauth/token-type/federated-connection-access-token";
export const REFRESH_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:refresh_token";
export const ACCESS_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:access_token";

export type Auth0LinkedAccount = {
  /** `cac_…` in the live tenant. */
  id?: string;
  connection: string;
  subject: string;
  scopes?: string[];
  accessType?: "offline";
  /** The upstream token this account's exchange returns. */
  upstreamToken?: string;
  /** Simulates the documented "missing refresh token" state. */
  missingRefreshToken?: boolean;
  /** Distinguishes several accounts of one person on one connection. */
  loginHint?: string;
  createdAt?: string;
};

export type Auth0DoubleOptions = {
  clientId: string;
  clientSecret: string;
  /** API identifier a Token Vault access-token exchange must have been issued for. */
  apiAudience?: string;
  accounts?: Auth0LinkedAccount[];
  /** Connections the tenant offers, for the connections listing. */
  connections?: Array<{ name: string; strategy?: string; scopes?: string[] }>;
  /** Grant types enabled on the client; an absent Token Vault grant is the documented 400. */
  grantTypes?: string[];
  /** Force the exchange to answer with a documented error. */
  failWith?: { status: number; error: string; description?: string };
};

type Account = Required<
  Pick<Auth0LinkedAccount, "id" | "connection" | "subject">
> &
  Auth0LinkedAccount;

const json = (status: number, body: unknown): FixtureReply => ({
  status,
  body: body as Record<string, unknown>,
});

/*
 * Key generation is the slowest part of standing this up, and the keys carry
 * no state: each double serves its own JWKS at its own origin, so one tenant
 * pair and one foreign pair per test process are enough.
 */
type TenantKeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let tenantKeys: Promise<TenantKeyPair> | undefined;
let foreignKeys: Promise<TenantKeyPair> | undefined;
const tenantKeyPair = () =>
  (tenantKeys ??= generateKeyPair("RS256", { extractable: true }));
const foreignKeyPair = () =>
  (foreignKeys ??= generateKeyPair("RS256", { extractable: true }));

export async function startAuth0TokenVaultDouble(options: Auth0DoubleOptions) {
  const tenant = await tenantKeyPair();
  const foreign = await foreignKeyPair();
  const kid = "tenant-key-1";
  const jwk = { ...(await exportJWK(tenant.publicKey)), kid, alg: "RS256" };
  const grantTypes = new Set(
    options.grantTypes ?? [
      "authorization_code",
      "refresh_token",
      TOKEN_VAULT_GRANT,
    ],
  );
  const accounts = new Map<string, Account>();
  for (const seed of options.accounts ?? []) {
    const id = seed.id ?? `cac_${randomUUID().replace(/-/g, "").slice(0, 22)}`;
    accounts.set(id, {
      ...seed,
      id,
      connection: seed.connection,
      subject: seed.subject,
    });
  }
  /** Refresh tokens the tenant issued, mapped to their subject. */
  const refreshTokens = new Map<string, string>();
  const sessions = new Map<
    string,
    {
      subject: string;
      connection: string;
      redirectUri: string;
      scopes: string[];
    }
  >();
  const connectCodes = new Map<string, string>();

  let origin = "";
  const issuer = () => `${origin}/`;

  async function sign(
    key: CryptoKey,
    payload: Record<string, unknown>,
    claims: {
      subject: string;
      audience: string;
      issuer?: string;
      kid?: string;
    },
  ): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: claims.kid ?? kid })
      .setIssuedAt()
      .setIssuer(claims.issuer ?? issuer())
      .setAudience(claims.audience)
      .setSubject(claims.subject)
      .setExpirationTime("10m")
      .sign(key);
  }

  const fixture = await startHttpFixture(
    async (request: RecordedRequest): Promise<FixtureReply> => {
      const path = request.url.pathname;
      const bodyText = request.body.toString("utf8");

      if (path === "/.well-known/jwks.json" && request.method === "GET")
        return json(200, { keys: [jwk] });

      /* ---------------------------------------------------- token exchange */
      if (path === "/oauth/token" && request.method === "POST") {
        const contentType = request.headers["content-type"] ?? "";
        let values: Record<string, string> = {};
        if (contentType.includes("application/json")) {
          try {
            values = JSON.parse(bodyText) as Record<string, string>;
          } catch {
            return json(400, {
              error: "invalid_request",
              error_description: "Malformed body",
            });
          }
        } else {
          values = Object.fromEntries(new URLSearchParams(bodyText));
        }
        if (options.failWith)
          return json(options.failWith.status, {
            error: options.failWith.error,
            ...(options.failWith.description
              ? { error_description: options.failWith.description }
              : {}),
          });
        if (values.grant_type !== TOKEN_VAULT_GRANT)
          return json(400, {
            error: "unsupported_grant_type",
            error_description: "Grant type not supported",
          });
        if (!grantTypes.has(TOKEN_VAULT_GRANT))
          return json(400, {
            error: "unsupported_grant_type",
            error_description:
              "Grant type 'urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token' not allowed for the client.",
          });
        if (
          values.client_id !== options.clientId ||
          values.client_secret !== options.clientSecret
        )
          return json(401, {
            error: "invalid_client",
            error_description: "Client authentication failed",
          });
        if (
          values.subject_token_type !== REFRESH_TOKEN_TYPE &&
          values.subject_token_type !== ACCESS_TOKEN_TYPE
        )
          return json(400, {
            error: "invalid_request",
            error_description: "Unsupported subject_token_type",
          });
        if (values.requested_token_type !== FEDERATED_TOKEN_TYPE)
          return json(400, {
            error: "invalid_request",
            error_description: "Unsupported requested_token_type",
          });
        if (!values.subject_token)
          return json(400, {
            error: "invalid_request",
            error_description: "Missing required parameter: subject_token",
          });
        if (!values.connection)
          return json(400, {
            error: "invalid_request",
            error_description: "Missing required parameter: connection",
          });

        // Identify the user from the subject token exactly as the tenant
        // would: a refresh token it issued, or an access token it signed for
        // its own API audience.
        let subject: string | undefined;
        if (values.subject_token_type === REFRESH_TOKEN_TYPE) {
          subject = refreshTokens.get(values.subject_token);
          if (!subject)
            return json(401, {
              error: "invalid_grant",
              error_description: "Unknown or expired refresh token",
            });
        } else {
          try {
            const verified = await jwtVerify(
              values.subject_token,
              createLocalJWKSet({ keys: [jwk] }),
              { issuer: issuer() },
            );
            const audience = verified.payload.aud;
            const audiences = Array.isArray(audience)
              ? audience
              : audience
                ? [audience]
                : [];
            if (options.apiAudience && !audiences.includes(options.apiAudience))
              return json(403, {
                error: "access_denied",
                error_description:
                  "The access token was not issued for this API",
              });
            subject = verified.payload.sub;
          } catch {
            return json(401, {
              error: "invalid_grant",
              error_description: "Subject token could not be verified",
            });
          }
        }
        const candidates = [...accounts.values()].filter(
          (account) =>
            account.subject === subject &&
            account.connection === values.connection,
        );
        const chosen = values.login_hint
          ? candidates.find(
              (account) => account.loginHint === values.login_hint,
            )
          : candidates[0];
        if (!chosen)
          return json(401, {
            error: "invalid_grant",
            error_description:
              "No connected account for this user on the requested connection",
          });
        if (chosen.missingRefreshToken)
          return json(403, {
            error: "invalid_grant",
            error_description:
              "The connection does not have a refresh token; the user must re-consent.",
          });
        const granted = chosen.scopes ?? [];
        const requested = (values.scope ?? "").split(" ").filter(Boolean);
        const issuedScopes = requested.length
          ? requested.filter((item) => granted.includes(item))
          : granted;
        return json(200, {
          access_token: chosen.upstreamToken ?? `upstream_${chosen.id}`,
          scope: issuedScopes.join(" "),
          expires_in: 1377,
          issued_token_type: FEDERATED_TOKEN_TYPE,
          token_type: "Bearer",
        });
      }

      /* ------------------------------------------------- My Account API */
      if (path.startsWith("/me/v1/connected-accounts")) {
        const header = request.headers.authorization ?? "";
        if (!header.startsWith("Bearer "))
          return json(401, {
            type: "https://auth0.com/errors/unauthorized",
            status: 401,
            title: "Unauthorized",
            detail: "A bearer token is required.",
          });
        let scopes: string[] = [];
        let subject = "";
        try {
          const verified = await jwtVerify(
            header.slice(7),
            createLocalJWKSet({ keys: [jwk] }),
            { issuer: issuer(), audience: `${origin}/me/` },
          );
          scopes = String(verified.payload.scope ?? "")
            .split(" ")
            .filter(Boolean);
          subject = String(verified.payload.sub ?? "");
        } catch {
          return json(401, {
            type: "https://auth0.com/errors/unauthorized",
            status: 401,
            title: "Unauthorized",
            detail: "The access token is not valid for the My Account API.",
          });
        }
        const needs = (scope: string): FixtureReply | undefined =>
          scopes.includes(scope)
            ? undefined
            : json(403, {
                type: "https://auth0.com/errors/forbidden",
                status: 403,
                title: "Forbidden",
                detail: `Missing scope ${scope}`,
              });

        if (path === "/me/v1/connected-accounts/connections") {
          const denied = needs("read:me:connected_accounts");
          if (denied) return denied;
          return json(200, {
            connections: (options.connections ?? []).map((connection) => ({
              name: connection.name,
              strategy: connection.strategy ?? "oauth2",
              scopes: connection.scopes ?? [],
            })),
          });
        }

        if (path === "/me/v1/connected-accounts/accounts") {
          const denied = needs("read:me:connected_accounts");
          if (denied) return denied;
          const filter = request.url.searchParams.get("connection");
          return json(200, {
            accounts: [...accounts.values()]
              .filter(
                (account) =>
                  account.subject === subject &&
                  (!filter || account.connection === filter),
              )
              .map((account) => ({
                id: account.id,
                connection: account.connection,
                access_type: account.accessType ?? "offline",
                scopes: account.scopes ?? [],
                created_at: account.createdAt ?? "2026-09-01T00:00:00.000Z",
              })),
          });
        }

        if (path === "/me/v1/connected-accounts/connect") {
          const denied = needs("create:me:connected_accounts");
          if (denied) return denied;
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(bodyText) as Record<string, unknown>;
          } catch {
            return json(415, {
              type: "https://auth0.com/errors/unsupported-media-type",
              status: 415,
              title: "Unsupported Media Type",
              detail: "A JSON body is required.",
            });
          }
          if (
            typeof body.connection !== "string" ||
            typeof body.redirect_uri !== "string"
          )
            return json(400, {
              type: "https://auth0.com/errors/invalid-request",
              status: 400,
              title: "Bad Request",
              detail: "connection and redirect_uri are required.",
            });
          const authSession = randomUUID().replace(/-/g, "");
          sessions.set(authSession, {
            subject,
            connection: body.connection,
            redirectUri: body.redirect_uri,
            scopes: Array.isArray(body.scopes) ? (body.scopes as string[]) : [],
          });
          return json(200, {
            auth_session: authSession,
            connect_uri: `${origin}/connected-accounts/connect`,
            connect_params: { ticket: randomUUID() },
            expires_in: 300,
          });
        }

        if (path === "/me/v1/connected-accounts/complete") {
          const denied = needs("create:me:connected_accounts");
          if (denied) return denied;
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(bodyText) as Record<string, unknown>;
          } catch {
            return json(415, { status: 415, title: "Unsupported Media Type" });
          }
          const session =
            typeof body.auth_session === "string"
              ? sessions.get(body.auth_session)
              : undefined;
          const code =
            typeof body.connect_code === "string" ? body.connect_code : "";
          const codeSubject = connectCodes.get(code);
          if (!session || !codeSubject || codeSubject !== session.subject)
            return json(400, {
              type: "https://auth0.com/errors/invalid-request",
              status: 400,
              title: "Bad Request",
              detail: "The connect code or session is not valid.",
            });
          if (session.redirectUri !== body.redirect_uri)
            return json(400, {
              type: "https://auth0.com/errors/invalid-request",
              status: 400,
              title: "Bad Request",
              detail: "redirect_uri does not match the original request.",
            });
          // The connect code is single use.
          connectCodes.delete(code);
          const id = `cac_${randomUUID().replace(/-/g, "").slice(0, 22)}`;
          const account: Account = {
            id,
            connection: session.connection,
            subject: session.subject,
            scopes: session.scopes,
            accessType: "offline",
            createdAt: "2026-09-18T00:00:00.000Z",
          };
          accounts.set(id, account);
          return json(201, {
            id,
            connection: account.connection,
            access_type: "offline",
            scopes: account.scopes ?? [],
            created_at: account.createdAt,
          });
        }

        const deleteMatch =
          /^\/me\/v1\/connected-accounts\/accounts\/([^/]+)$/.exec(path);
        if (deleteMatch && request.method === "DELETE") {
          const denied = needs("delete:me:connected_accounts");
          if (denied) return denied;
          const id = decodeURIComponent(deleteMatch[1]!);
          const account = accounts.get(id);
          if (!account || account.subject !== subject)
            return json(404, {
              type: "https://auth0.com/errors/not-found",
              status: 404,
              title: "Not Found",
              detail: "No such connected account.",
            });
          accounts.delete(id);
          return { status: 204 };
        }
      }

      return json(404, {
        type: "https://auth0.com/errors/not-found",
        status: 404,
        title: "Not Found",
        detail: "Unknown endpoint",
      });
    },
  );
  origin = fixture.origin;

  return {
    origin: fixture.origin,
    /** The tenant domain as configuration spells it (host and port, no scheme). */
    domain: new URL(fixture.origin).host,
    issuer: () => issuer(),
    myAccountAudience: `${fixture.origin}/me/`,
    requests: fixture.requests,
    received: fixture.received,
    close: fixture.close,
    /** Issues a refresh token the tenant will accept for this subject. */
    refreshToken(subject: string): string {
      const token = `rt_${randomUUID().replace(/-/g, "")}`;
      refreshTokens.set(token, subject);
      return token;
    },
    /** Signs an Auth0 access token for an API audience. */
    accessToken(
      subject: string,
      audience: string,
      scope = "",
    ): Promise<string> {
      return sign(tenant.privateKey, scope ? { scope } : {}, {
        subject,
        audience,
      });
    },
    /** Signs a My Account API token with the Connected Accounts scopes. */
    myAccountToken(
      subject: string,
      scope = "create:me:connected_accounts read:me:connected_accounts delete:me:connected_accounts",
    ): Promise<string> {
      return sign(
        tenant.privateKey,
        { scope },
        {
          subject,
          audience: `${fixture.origin}/me/`,
        },
      );
    },
    /** A token signed by a different tenant's key, for the wrong-issuer case. */
    foreignToken(subject: string, audience: string): Promise<string> {
      return sign(
        foreign.privateKey,
        {},
        {
          subject,
          audience,
          issuer: "https://other-tenant.example/",
          kid: "other-key",
        },
      );
    },
    /** The single-use code the provider's redirect would deliver. */
    issueConnectCode(subject: string): string {
      const code = randomUUID();
      connectCodes.set(code, subject);
      return code;
    },
    accounts: () => [...accounts.values()],
    account: (id: string) => accounts.get(id),
    /** Removes a link the way a person revoking it in the dashboard would. */
    unlink(id: string) {
      accounts.delete(id);
    },
  };
}
