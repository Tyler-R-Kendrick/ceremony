import { createHash, randomUUID, randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { escapeHtml } from "./http.js";

/**
 * A development identity provider for the reference application.
 *
 * The reference *provider* is what ceremonies authenticate against; this is the
 * separate thing that says who is using the application, which the browser has
 * never needed locally (it uses an anonymous cookie session) and which a chat
 * client cannot do without — an MCP endpoint authenticates a bearer token, and
 * a bearer token has to be minted by somebody.
 *
 * It implements the parts a chat client actually exercises: discovery, a JWKS,
 * dynamic client registration, an authorization code flow with PKCE, and RFC
 * 9068 JWT access tokens carrying the audience the client asked for.
 *
 * **It is a development issuer and refuses to pretend otherwise.** It approves
 * whoever clicks the button; there is no account, no password and no session
 * to steal, because there is nothing behind it. Run it behind a tunnel so
 * origins are HTTPS, point a chat client at it, and use it to exercise the
 * ceremony surface — never to protect anything real.
 */

export interface DevIssuerOptions {
  /** Public origin this issuer is reachable at; also its `iss`. */
  origin: string;
  /** Who the issued tokens say is present. */
  subject?: string;
  /** Roles stamped into the token, mapped to capabilities by the server. */
  roles?: string[];
  /** Audiences a client may request. A request for anything else is refused. */
  audiences: string[];
}

interface Client {
  id: string;
  redirectUris: string[];
  name: string;
}
interface Grant {
  clientId: string;
  challenge: string;
  redirectUri: string;
  audience: string;
  expiresAt: number;
}

const FIVE_MINUTES = 300_000;
const token = () => randomBytes(32).toString("base64url");
const s256 = (value: string) =>
  createHash("sha256").update(value).digest("base64url");

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });

export async function createDevIssuer(options: DevIssuerOptions) {
  const origin = new URL(options.origin).origin;
  const keys = await generateKeyPair("ES256", { extractable: true });
  const kid = randomUUID();
  const publicJwk: JWK = {
    ...(await exportJWK(keys.publicKey)),
    kid,
    use: "sig",
    alg: "ES256",
  };
  const clients = new Map<string, Client>();
  const grants = new Map<string, Grant>();
  const subject = options.subject ?? "local-developer";
  const roles = options.roles ?? ["executor"];

  const sweep = () => {
    const now = Date.now();
    for (const [code, grant] of grants)
      if (grant.expiresAt <= now) grants.delete(code);
  };

  const discovery = {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    jwks_uri: `${origin}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["executor", "author", "reviewer", "publisher", "admin"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["ES256"],
  };

  async function accessToken(grant: Grant): Promise<string> {
    const issuedAt = Math.floor(Date.now() / 1000);
    return await new SignJWT({
      client_id: grant.clientId,
      ceremony_roles: roles,
      scope: roles.join(" "),
    })
      // RFC 9068: the type distinguishes an access token from an ID token, so a
      // resource server cannot be handed one where it expects the other.
      .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid })
      .setIssuer(origin)
      .setAudience(grant.audience)
      .setSubject(subject)
      .setJti(randomUUID())
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 3600)
      .sign(keys.privateKey);
  }

  return {
    discovery,
    /** Answers this issuer's own paths; undefined leaves the request alone. */
    async handle(request: Request): Promise<Response | undefined> {
      sweep();
      const url = new URL(request.url);
      const path = url.pathname;

      if (
        request.method === "GET" &&
        [
          "/.well-known/openid-configuration",
          "/.well-known/oauth-authorization-server",
        ].includes(path)
      )
        return json(discovery);

      if (request.method === "GET" && path === "/.well-known/jwks.json")
        return json({ keys: [publicJwk] });

      // RFC 7591. A chat client registers itself rather than being configured
      // in advance, so without this there is no client id to authorize with.
      if (request.method === "POST" && path === "/oauth/register") {
        const body = (await request.json().catch(() => ({}))) as {
          redirect_uris?: unknown;
          client_name?: unknown;
        };
        const redirectUris = Array.isArray(body.redirect_uris)
          ? body.redirect_uris.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
        if (!redirectUris.length)
          return json(
            {
              error: "invalid_redirect_uri",
              error_description: "At least one redirect_uri is required.",
            },
            400,
          );
        const client: Client = {
          id: `dev-${randomUUID()}`,
          redirectUris,
          name:
            typeof body.client_name === "string"
              ? body.client_name
              : "Unnamed client",
        };
        clients.set(client.id, client);
        return json(
          {
            client_id: client.id,
            client_name: client.name,
            redirect_uris: client.redirectUris,
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code"],
            response_types: ["code"],
          },
          201,
        );
      }

      if (request.method === "GET" && path === "/oauth/authorize") {
        const clientId = url.searchParams.get("client_id") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const challenge = url.searchParams.get("code_challenge") ?? "";
        const state = url.searchParams.get("state") ?? "";
        // RFC 8707. The audience is what the client says it wants a token for,
        // and it must be one this issuer is willing to mint for — otherwise a
        // token for one resource would be usable against another.
        const audience =
          url.searchParams.get("resource") ?? options.audiences[0] ?? "";
        const client = clients.get(clientId);
        if (!client || !client.redirectUris.includes(redirectUri))
          return new Response("Unknown client or redirect_uri", {
            status: 400,
          });
        if (
          url.searchParams.get("code_challenge_method") !== "S256" ||
          !challenge
        )
          return new Response("PKCE with S256 is required", { status: 400 });
        if (!options.audiences.includes(audience))
          return new Response("Unsupported resource", { status: 400 });

        const code = token();
        grants.set(code, {
          clientId,
          challenge,
          redirectUri,
          audience,
          expiresAt: Date.now() + FIVE_MINUTES,
        });
        const target = new URL(redirectUri);
        target.searchParams.set("code", code);
        if (state) target.searchParams.set("state", state);
        // One click, and the page says plainly what it is. A development issuer
        // that silently redirected would be indistinguishable from a real one.
        return new Response(
          `<!doctype html><meta charset="utf-8"><title>Development sign-in</title>` +
            `<body style="font:16px system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem">` +
            `<h1>Development sign-in</h1>` +
            `<p><strong>${escapeHtml(client.name)}</strong> is asking to act as <strong>${escapeHtml(subject)}</strong> against <code>${escapeHtml(audience)}</code>.</p>` +
            `<p>This issuer approves whoever clicks. There is no account behind it and it protects nothing — it exists so a chat client has a token to present.</p>` +
            `<p><a href="${escapeHtml(target.href)}" style="display:inline-block;padding:.6rem 1.2rem;background:#1749c7;color:#fff;border-radius:8px;text-decoration:none">Continue as ${escapeHtml(subject)}</a></p>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }

      if (request.method === "POST" && path === "/oauth/token") {
        const form = new URLSearchParams(await request.text());
        const code = form.get("code") ?? "";
        const grant = grants.get(code);
        // Consumed on first use, whether or not the rest of the request is
        // valid: a code that survived a failed exchange could be replayed.
        grants.delete(code);
        const verifier = form.get("code_verifier") ?? "";
        if (
          !grant ||
          grant.expiresAt <= Date.now() ||
          form.get("grant_type") !== "authorization_code" ||
          form.get("client_id") !== grant.clientId ||
          form.get("redirect_uri") !== grant.redirectUri ||
          !verifier ||
          s256(verifier) !== grant.challenge
        )
          return json({ error: "invalid_grant" }, 400);
        return json({
          access_token: await accessToken(grant),
          token_type: "Bearer",
          expires_in: 3600,
          scope: roles.join(" "),
        });
      }

      if (request.method === "OPTIONS" && path.startsWith("/oauth/"))
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "content-type",
          },
        });

      return undefined;
    },
  };
}
