import * as oauth from "oauth4webapi";
import { z } from "zod";
import { boundedJson } from "./authorization.js";

const secret = z
  .string()
  .min(1)
  .max(16384)
  .regex(/^[\x21-\x7e]+$/);
const site = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      /^[a-z0-9-]+\.atlassian\.net$/.test(url.hostname) &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
    );
  });
const scopes = z
  .array(z.enum(["read:jira-user", "read:jira-work"]))
  .min(1)
  .max(2)
  .refine(
    (values) =>
      values.includes("read:jira-user") &&
      new Set(values).size === values.length,
  );
const configurationSchema = z.strictObject({
  clientId: secret,
  clientSecret: secret,
  callbackUrl: z.string().max(2048).url(),
  siteUrl: site,
  scopes,
});
export type JiraOAuthConfiguration = z.infer<typeof configurationSchema>;
const sessionSchema = z.strictObject({
  accessToken: secret,
  expiresAt: z.number().int().positive(),
  scopes,
});
export type JiraPrivateSession = z.infer<typeof sessionSchema>;
const as = {
  issuer: "https://auth.atlassian.com",
  authorization_endpoint: "https://auth.atlassian.com/authorize",
  token_endpoint: "https://auth.atlassian.com/oauth/token",
};
export class JiraAuthFailure extends Error {
  constructor(
    readonly code:
      "invalid-input" | "verification-rejected" | "provider-unavailable",
  ) {
    super(code);
  }
}

/** Server-only protocol boundary. The caller owns actor binding, durable code admission and effect reconciliation. */
export function jiraAuth(
  configuration: JiraOAuthConfiguration,
  options: {
    signal: AbortSignal;
    fetch?: typeof fetch;
    now?: () => number;
    allowLoopbackHttp?: boolean;
  },
) {
  const parsed = configurationSchema.safeParse(configuration);
  if (!parsed.success) throw new JiraAuthFailure("invalid-input");
  const config = parsed.data,
    callback = new URL(config.callbackUrl);
  if (
    callback.username ||
    callback.password ||
    callback.hash ||
    callback.search ||
    (callback.protocol !== "https:" &&
      !(
        options.allowLoopbackHttp &&
        callback.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(callback.hostname)
      ))
  )
    throw new JiraAuthFailure("invalid-input");
  const now = options.now ?? Date.now;
  const client = { client_id: config.clientId };
  const request = async (url: string, init: RequestInit) => {
    options.signal.throwIfAborted();
    try {
      const response = await (options.fetch ?? fetch)(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(15000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new JiraAuthFailure(
          response.status >= 500 || response.status === 429
            ? "provider-unavailable"
            : "verification-rejected",
        );
      }
      return await boundedJson(response, 65536);
    } catch (error) {
      if (error instanceof JiraAuthFailure) throw error;
      throw new JiraAuthFailure("provider-unavailable");
    }
  };
  const validSession = (value: JiraPrivateSession) => {
    const parsed = sessionSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.expiresAt <= now() ||
      parsed.data.scopes.length !== config.scopes.length ||
      !config.scopes.every((scope) => parsed.data.scopes.includes(scope))
    )
      throw new JiraAuthFailure("verification-rejected");
    return parsed.data;
  };
  return {
    /** State and resulting authorization URL are private human-handoff material, never agent context. */
    authorizationUrl(state: string) {
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(state))
        throw new JiraAuthFailure("invalid-input");
      const url = new URL(as.authorization_endpoint);
      url.search = new URLSearchParams({
        audience: "api.atlassian.com",
        client_id: config.clientId,
        scope: config.scopes.join(" "),
        redirect_uri: config.callbackUrl,
        state,
        response_type: "code",
        prompt: "consent",
      }).toString();
      return url.href;
    },
    /** Invoke once per durably admitted callback. Never retry a lost one-use-code response blindly. */
    async exchange(
      returnedUrl: string,
      expectedState: string,
    ): Promise<JiraPrivateSession> {
      let parameters: URLSearchParams;
      try {
        if (returnedUrl.length > 8192) throw new Error();
        const url = new URL(returnedUrl);
        if (
          url.origin !== callback.origin ||
          url.pathname !== callback.pathname ||
          url.hash ||
          url.username ||
          url.password ||
          !/^[A-Za-z0-9_-]{32,128}$/.test(expectedState)
        )
          throw new Error();
        parameters = oauth.validateAuthResponse(as, client, url, expectedState);
        if (!secret.safeParse(parameters.get("code")).success)
          throw new Error();
      } catch {
        throw new JiraAuthFailure("verification-rejected");
      }
      try {
        const response = await oauth.authorizationCodeGrantRequest(
          as,
          client,
          oauth.ClientSecretPost(config.clientSecret),
          parameters,
          config.callbackUrl,
          // Atlassian's documented confidential 3LO profile uses client authentication, not an invented PKCE capability.
          oauth.nopkce,
          {
            [oauth.customFetch]: async (url, init) => {
              if (
                String(url) !== as.token_endpoint ||
                !(init?.body instanceof URLSearchParams)
              )
                throw new JiraAuthFailure("invalid-input");
              const body = await request(as.token_endpoint, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  accept: "application/json",
                },
                body: JSON.stringify(Object.fromEntries(init.body)),
              });
              return Response.json(body);
            },
          },
        );
        const token = await oauth.processAuthorizationCodeResponse(
          as,
          client,
          response,
        );
        options.signal.throwIfAborted();
        if (
          token.token_type.toLowerCase() !== "bearer" ||
          !token.expires_in ||
          token.expires_in > 86400 ||
          !Number.isInteger(token.expires_in)
        )
          throw new JiraAuthFailure("verification-rejected");
        return validSession({
          accessToken: token.access_token,
          expiresAt: now() + token.expires_in * 1000,
          scopes: scopes.parse(
            (token.scope ?? config.scopes.join(" ")).split(" "),
          ),
        });
      } catch (error) {
        if (error instanceof JiraAuthFailure) throw error;
        throw new JiraAuthFailure("verification-rejected");
      }
    },
    /** Select only the host-bound site; a grant/resource listing alone is not verified Jira access. */
    async verify(value: JiraPrivateSession, expectedAccountId?: string) {
      const session = validSession(value);
      const headers = {
        authorization: `Bearer ${session.accessToken}`,
        accept: "application/json",
      };
      try {
        const resources = z
          .array(
            z.object({
              // Atlassian cloud IDs are GUID-shaped but documented values need not use RFC UUID variant bits.
              id: z.guid(),
              url: z.string().max(2048),
              scopes: z.array(z.string().max(100)).max(256),
            }),
          )
          .max(256)
          .parse(
            await request(
              "https://api.atlassian.com/oauth/token/accessible-resources",
              { headers },
            ),
          );
        const matches = resources.filter(
          (resource) =>
            site.safeParse(resource.url).success &&
            new URL(resource.url).origin === new URL(config.siteUrl).origin &&
            config.scopes.every((scope) => resource.scopes.includes(scope)),
        );
        const ids = new Set(matches.map((resource) => resource.id));
        if (ids.size !== 1) throw new JiraAuthFailure("verification-rejected");
        const cloudId = matches[0]!.id;
        const user = z
          .object({
            accountId: z.string().min(1).max(128),
            active: z.literal(true),
            accountType: z.literal("atlassian"),
          })
          .parse(
            await request(
              `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`,
              { headers },
            ),
          );
        if (
          user.accountId === "unknown" ||
          (expectedAccountId !== undefined &&
            user.accountId !== expectedAccountId)
        )
          throw new JiraAuthFailure("verification-rejected");
        validSession(session);
        options.signal.throwIfAborted();
        return {
          cloudId,
          accountId: user.accountId,
          expiresAt: session.expiresAt,
        };
      } catch (error) {
        if (error instanceof JiraAuthFailure) throw error;
        throw new JiraAuthFailure("verification-rejected");
      }
    },
  };
}
