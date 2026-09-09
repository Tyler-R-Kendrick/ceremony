import { createServer, type Server } from "node:http";
import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { generateKeyPair, jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { escapeHtml, json, page, readBody } from "./http.js";

interface Attempt {
  kind: "oauth" | "device" | "claim" | "neon-claim";
  expires: number;
  interval: number;
  lastPoll: number;
  approved: boolean;
  denied: boolean;
  clientId: string;
  scope: string;
  code: string;
  redirectUri?: string;
  challenge?: string;
  state?: string;
  registration?: string;
  email?: string;
}
interface Registration {
  neon?: boolean;
  expires: number;
  email?: string;
  claimed: boolean;
  attempt?: string;
}
export interface ProviderOptions {
  issuer: string;
  appOrigin: string;
  interval?: number;
  ttl?: number;
  now?: () => number;
  slowDownFirstPoll?: boolean;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
const secret = () => randomBytes(32).toString("base64url");
export async function createReferenceProvider(
  options: ProviderOptions,
): Promise<Server> {
  const now = options.now ?? Date.now;
  const interval = options.interval ?? 1;
  const ttl = options.ttl ?? 300;
  const attempts = new Map<string, Attempt>();
  const deviceCodes = new Map<string, string>();
  const authCodes = new Map<string, Attempt>();
  const claims = new Map<string, Registration>();
  const tokens = new Map<
    string,
    { scope: string; expires: number; registration?: string }
  >();
  const formTokens = new Map<string, { attempt: string; expires: number }>();
  const keys = await generateKeyPair("ES256");
  const issue = (scope: string, registration?: string) => {
    const token = secret();
    tokens.set(token, {
      scope,
      expires: now() + 3_600_000,
      ...(registration ? { registration } : {}),
    });
    return {
      access_token: token,
      token_type: "Bearer",
      expires_in: 3600,
      scope,
    };
  };
  const assertion = async (registration: string) =>
    new SignJWT({ version: claims.get(registration)?.claimed ? 2 : 1 })
      .setProtectedHeader({ alg: "ES256", typ: "oauth-id-jag+jwt" })
      .setIssuer(options.issuer)
      .setAudience(options.issuer)
      .setSubject(registration)
      .setJti(randomUUID())
      .setIssuedAt(Math.floor(now() / 1000))
      .setExpirationTime(Math.floor(now() / 1000) + 300)
      .sign(keys.privateKey);
  const makeAttempt = (kind: Attempt["kind"], scope: string): Attempt => ({
    kind,
    expires: now() + ttl * 1000,
    interval: interval * 1000,
    lastPoll: 0,
    approved: false,
    denied: false,
    clientId: "ceremony-local",
    scope,
    code: String(randomInt(100000, 1000000)),
  });
  const showForm = (
    response: Parameters<typeof page>[0],
    id: string,
    attempt: Attempt,
  ) => {
    const formToken = secret();
    formTokens.set(formToken, { attempt: id, expires: attempt.expires });
    page(
      response,
      attempt.kind === "neon-claim"
        ? "Transfer project ownership"
        : attempt.kind === "claim"
          ? "Claim this account"
          : "Approve connection",
      `<p>Local simulation, not the real service. Requested access: <strong>${escapeHtml(attempt.scope)}</strong>.</p><p>Test account: <strong>demo@example.com</strong><br>Password: <strong>ceremony-demo</strong></p><form method="post" action="/approve"><input type="hidden" name="csrf" value="${formToken}"><label>Email<input type="email" name="email" required></label><label>Password<input type="password" name="password" required></label>${attempt.kind === "neon-claim" ? `<input type="hidden" name="user_code" value="${attempt.code}"><label>Destination organization<select name="organization" required><option value="">Choose an organization</option><option value="demo-org">Demo organization</option></select></label>` : attempt.kind === "oauth" ? "" : '<label>Verification code<input name="user_code" required inputmode="numeric" maxlength="6"></label>'}<button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form>`,
      attempt.kind === "oauth" ? options.appOrigin : undefined,
    );
  };
  return createServer(async (request, response) => {
    const fail = (error: string, status = 400) =>
      json(response, { error }, status);
    try {
      for (const [key, entry] of tokens)
        if (entry.expires < now()) tokens.delete(key);
      for (const [key, entry] of attempts)
        if (entry.expires + 600_000 < now()) attempts.delete(key);
      for (const [key, entry] of claims)
        if (entry.expires + 600_000 < now()) claims.delete(key);
      for (const [key, entry] of formTokens)
        if (entry.expires < now()) formTokens.delete(key);
      const url = new URL(request.url ?? "/", options.issuer);
      if (request.headers.host !== new URL(options.issuer).host)
        return fail("invalid_host", 403);
      if (request.method === "GET" && url.pathname === "/health")
        return json(response, { ok: true });
      if (request.method === "GET" && url.pathname === "/authorize") {
        if (
          url.searchParams.get("client_id") !== "ceremony-local" ||
          url.searchParams.get("response_type") !== "code" ||
          url.searchParams.get("code_challenge_method") !== "S256"
        )
          return fail("invalid_request");
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const redirect = new URL(redirectUri);
        if (
          redirect.origin !== options.appOrigin ||
          !/^\/api\/callback\/[a-f0-9-]{36}$/.test(redirect.pathname) ||
          redirect.search ||
          redirect.hash
        )
          return fail("invalid_redirect_uri");
        const challenge = url.searchParams.get("code_challenge") ?? "";
        const state = url.searchParams.get("state") ?? "";
        if (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || !state)
          return fail("invalid_request");
        const attempt = {
          ...makeAttempt("oauth", url.searchParams.get("scope") ?? ""),
          redirectUri,
          challenge,
          state,
        };
        const id = secret();
        attempts.set(id, attempt);
        return showForm(response, id, attempt);
      }
      if (request.method === "GET" && url.pathname === "/verify") {
        const id = url.searchParams.get("attempt") ?? "";
        const attempt = attempts.get(id);
        if (!attempt || attempt.expires <= now()) return fail("expired_token");
        return showForm(response, id, attempt);
      }
      if (request.method === "POST" && url.pathname === "/approve") {
        if (request.headers.origin !== options.issuer)
          return fail("invalid_origin", 403);
        const form = new URLSearchParams(await readBody(request));
        const csrf = form.get("csrf") ?? "";
        const view = formTokens.get(csrf);
        formTokens.delete(csrf);
        const attempt = view && attempts.get(view.attempt);
        if (
          !view ||
          !attempt ||
          attempt.expires <= now() ||
          attempt.approved ||
          attempt.denied
        )
          return fail("expired_token");
        if (
          form.get("email") !== "demo@example.com" ||
          form.get("password") !== "ceremony-demo"
        )
          return fail("invalid_credentials", 401);
        if (attempt.kind !== "oauth" && form.get("user_code") !== attempt.code)
          return fail("invalid_user_code");
        if (attempt.email && attempt.email !== form.get("email"))
          return fail("account_mismatch", 403);
        if (
          attempt.kind === "neon-claim" &&
          form.get("organization") !== "demo-org"
        )
          return fail("organization_required");
        attempt.denied = form.get("decision") === "deny";
        attempt.approved = !attempt.denied;
        if (attempt.kind === "oauth" && attempt.redirectUri) {
          const redirect = new URL(attempt.redirectUri);
          redirect.searchParams.set("state", attempt.state ?? "");
          redirect.searchParams.set("iss", options.issuer);
          if (attempt.denied)
            redirect.searchParams.set("error", "access_denied");
          else {
            const code = secret();
            authCodes.set(hash(code), attempt);
            redirect.searchParams.set("code", code);
          }
          response.writeHead(303, {
            location: redirect.href,
            "cache-control": "no-store",
          });
          return response.end();
        }
        if (attempt.registration && attempt.approved) {
          const registration = claims.get(attempt.registration);
          if (registration) {
            registration.claimed = true;
            registration.email = form.get("email")!;
          }
          for (const [key, token] of tokens)
            if (token.registration === attempt.registration) tokens.delete(key);
        }
        return page(
          response,
          attempt.denied ? "Request denied" : "Connection approved",
          "<p>You can close this tab and return to Ceremony.</p>",
        );
      }
      if (request.method === "POST" && url.pathname === "/credentials") {
        const auth = request.headers.authorization;
        const basic = `Basic ${Buffer.from("demo:ceremony-demo").toString("base64")}`;
        const jira = `Basic ${Buffer.from("demo@example.com:ceremony-demo").toString("base64")}`;
        if (auth === basic || auth === jira || auth === "Bearer demo-api-key")
          return json(response, { valid: true });
        const form = new URLSearchParams(await readBody(request));
        if (
          !auth &&
          form.get("email") === "demo@example.com" &&
          form.get("password") === "ceremony-demo"
        )
          return json(response, issue(""));
        return fail("invalid_credentials", 401);
      }
      if (request.method === "POST" && url.pathname === "/device") {
        const form = new URLSearchParams(await readBody(request));
        if (form.get("client_id") !== "ceremony-local")
          return fail("invalid_client");
        const id = secret();
        const code = secret();
        const attempt = makeAttempt("device", form.get("scope") ?? "api.read");
        attempts.set(id, attempt);
        deviceCodes.set(hash(code), id);
        return json(response, {
          device_code: code,
          user_code: attempt.code,
          verification_uri: `${options.issuer}/verify?attempt=${id}`,
          expires_in: ttl,
          interval,
        });
      }
      if (
        request.method === "POST" &&
        ["/agent/identity", "/v1/agent/identity"].includes(url.pathname)
      ) {
        const neon = url.pathname.startsWith("/v1/");
        if (
          !(
            neon
              ? z.object({
                  type: z.literal("anonymous"),
                  capabilities: z.tuple([z.literal("postgres")]),
                  source: z.string().min(1).max(100),
                })
              : z.object({ type: z.literal("anonymous") })
          )
            .strict()
            .safeParse(JSON.parse(await readBody(request))).success
        )
          return fail("invalid_request");
        const token = secret();
        const id = hash(token);
        const expires = now() + ttl * 1000;
        claims.set(id, { expires, claimed: false, neon });
        if (neon)
          return json(
            response,
            {
              identity_assertion: await assertion(id),
              project: {
                id,
                branch_id: "local-branch",
                expires_at: new Date(expires).toISOString(),
              },
              capabilities: [{ capability: "postgres", granted: true }],
            },
            201,
          );
        return json(response, {
          registration_id: id,
          registration_type: "anonymous",
          identity_assertion: await assertion(id),
          assertion_expires: new Date(now() + 300_000).toISOString(),
          claim_token: token,
          claim_token_expires: new Date(expires).toISOString(),
          pre_claim_scopes: ["api.read"],
          post_claim_scopes: ["api.read", "api.write"],
        });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/agent/identity/claim"
      ) {
        const input = z
          .object({ claim_token: z.string(), email: z.email() })
          .strict()
          .parse(JSON.parse(await readBody(request)));
        const registrationId = hash(input.claim_token);
        const registration = claims.get(registrationId);
        if (
          !registration ||
          registration.expires <= now() ||
          registration.claimed
        )
          return fail("expired_token");
        if (registration.attempt) attempts.delete(registration.attempt);
        const id = secret();
        const attempt = {
          ...makeAttempt("claim", "api.read api.write"),
          registration: registrationId,
          email: input.email,
        };
        attempts.set(id, attempt);
        registration.attempt = id;
        return json(response, {
          claim_attempt: {
            user_code: attempt.code,
            verification_uri: `${options.issuer}/verify?attempt=${id}`,
            expires_in: ttl,
            interval,
          },
        });
      }
      const neonClaim = /^\/v1\/projects\/([A-Za-z0-9_-]+)\/claim$/.exec(
        url.pathname,
      );
      if (neonClaim && ["GET", "POST"].includes(request.method ?? "")) {
        const id = neonClaim[1]!;
        const registration = claims.get(id);
        const token = tokens.get(
          (request.headers.authorization ?? "").replace(/^Bearer /, ""),
        );
        if (!registration?.neon || !token || token.registration !== id)
          return fail("invalid_token", 401);
        if (registration.expires <= now()) return fail("expired_token");
        if (request.method === "GET") {
          const attempt = registration.attempt
            ? attempts.get(registration.attempt)
            : undefined;
          if (attempt?.denied) return fail("access_denied", 403);
          return json(response, {
            state: registration.claimed ? "claimed" : "pending",
            reconciled: registration.claimed,
          });
        }
        if (registration.claimed) return fail("already_claimed");
        if (registration.attempt) attempts.delete(registration.attempt);
        const attemptId = secret();
        const attempt = {
          ...makeAttempt(
            "neon-claim",
            "Transfer local project to your organization",
          ),
          registration: id,
        };
        attempts.set(attemptId, attempt);
        registration.attempt = attemptId;
        return json(response, {
          verification_uri_complete: `${options.issuer}/verify?attempt=${attemptId}`,
          user_code: attempt.code,
          expires_in: ttl,
          interval,
        });
      }
      if (
        request.method === "POST" &&
        ["/oauth2/token", "/v1/oauth2/token"].includes(url.pathname)
      ) {
        const form = new URLSearchParams(await readBody(request));
        const grant = form.get("grant_type");
        if (grant === "authorization_code") {
          const key = hash(form.get("code") ?? "");
          const attempt = authCodes.get(key);
          authCodes.delete(key);
          if (
            !attempt ||
            attempt.expires <= now() ||
            form.get("client_id") !== attempt.clientId ||
            form.get("redirect_uri") !== attempt.redirectUri
          )
            return fail("invalid_grant");
          const challenge = hash(form.get("code_verifier") ?? "");
          if (
            !attempt.challenge ||
            challenge.length !== attempt.challenge.length ||
            !timingSafeEqual(
              Buffer.from(challenge),
              Buffer.from(attempt.challenge),
            )
          )
            return fail("invalid_grant");
          return json(response, issue(attempt.scope));
        }
        if (
          grant === "urn:ietf:params:oauth:grant-type:device_code" ||
          grant === "urn:workos:agent-auth:grant-type:claim"
        ) {
          const claiming = grant.endsWith(":claim");
          const registrationId = hash(form.get("claim_token") ?? "");
          const registration = claiming
            ? claims.get(registrationId)
            : undefined;
          const id = claiming
            ? registration?.attempt
            : deviceCodes.get(hash(form.get("device_code") ?? ""));
          const attempt = id ? attempts.get(id) : undefined;
          if (
            !attempt ||
            attempt.expires <= now() ||
            (claiming && (!registration || registration.expires <= now()))
          )
            return fail("expired_token");
          if (!claiming && form.get("client_id") !== attempt.clientId)
            return fail("invalid_client");
          if (
            (options.slowDownFirstPoll && attempt.lastPoll === 0) ||
            now() - attempt.lastPoll < attempt.interval
          ) {
            attempt.interval += 5000;
            attempt.lastPoll = now();
            return fail("slow_down");
          }
          attempt.lastPoll = now();
          if (attempt.denied) return fail("access_denied");
          if (!attempt.approved) return fail("authorization_pending");
          if (!claiming)
            deviceCodes.delete(hash(form.get("device_code") ?? ""));
          return json(response, {
            ...issue(attempt.scope, claiming ? registrationId : undefined),
            ...(claiming
              ? {
                  identity_assertion: await assertion(registrationId),
                  assertion_expires: new Date(now() + 300_000).toISOString(),
                }
              : {}),
          });
        }
        if (grant === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
          const { payload } = await jwtVerify(
            form.get("assertion") ?? "",
            keys.publicKey,
            {
              issuer: options.issuer,
              audience: options.issuer,
              algorithms: ["ES256"],
              typ: "oauth-id-jag+jwt",
              currentDate: new Date(now()),
              requiredClaims: ["sub", "jti", "iat", "exp"],
            },
          );
          const registration = payload.sub
            ? claims.get(payload.sub)
            : undefined;
          if (
            !registration ||
            registration.expires <= now() ||
            !payload.jti ||
            form.get("resource") !==
              (registration.neon
                ? `${options.issuer}/`
                : `${options.issuer}/resource`)
          )
            return fail("invalid_grant");
          return json(
            response,
            issue(
              registration.claimed ? "api.read api.write" : "api.read",
              payload.sub,
            ),
          );
        }
        return fail("unsupported_grant_type");
      }
      if (request.method === "GET" && url.pathname === "/resource") {
        const token = tokens.get(
          (request.headers.authorization ?? "").replace(/^Bearer /, ""),
        );
        return token
          ? json(response, { scope: token.scope })
          : fail("invalid_token", 401);
      }
      return fail("not_found", 404);
    } catch {
      if (!response.headersSent) fail("invalid_request");
      else response.end();
    }
  });
}
