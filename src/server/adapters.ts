import { randomUUID } from "node:crypto";
import * as oauth from "oauth4webapi";
import { z } from "zod";
import type { AuthMethod, AuthOutcome } from "../core/index.js";
import {
  CeremonyError,
  type AdapterUpdate,
  type AuthAdapter,
} from "./controller.js";

export interface CredentialStore {
  put(
    secret: Readonly<Record<string, string>>,
    existingRef?: string,
  ): Promise<string>;
}
export class MemoryCredentialStore implements CredentialStore {
  // ponytail: process-local credentials; supply an encrypted vault for durable hosting.
  private entries = new Map<
    string,
    { secret: Readonly<Record<string, string>>; expiresAt: number }
  >();
  async put(
    secret: Readonly<Record<string, string>>,
    existingRef = randomUUID(),
  ): Promise<string> {
    for (const [id, entry] of this.entries)
      if (entry.expiresAt <= Date.now()) this.entries.delete(id);
    this.entries.set(existingRef, {
      secret: structuredClone(secret),
      expiresAt: Date.now() + 3_600_000,
    });
    return existingRef;
  }
  get(ref: string): Readonly<Record<string, string>> | undefined {
    const entry = this.entries.get(ref);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.entries.delete(ref);
      return undefined;
    }
    return structuredClone(entry.secret);
  }
}
export interface ProtocolConfig {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceEndpoint: string;
  resource: string;
  clientId: string;
  callbackUrl: string;
  credentialEndpoint: string;
  identityEndpoint: string;
  claimEndpoint: string;
  /** Only for local reference/test services; never relax HTTPS for remote hosts. */
  allowLoopbackHttp?: boolean;
}
export function trustedUrl(
  value: string,
  config: Pick<ProtocolConfig, "issuer" | "allowLoopbackHttp">,
  sameOrigin = true,
): URL {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(config.allowLoopbackHttp && loopback && url.protocol === "http:"))
  )
    throw new CeremonyError("Provider URL is not permitted");
  if (sameOrigin && url.origin !== new URL(config.issuer).origin)
    throw new CeremonyError(
      "Provider origin does not match connector configuration",
    );
  return url;
}
const registrationSchema = z.object({
  identity_assertion: z.string().min(1),
  claim_token: z.string().min(1),
  claim_token_expires: z.iso.datetime(),
});
const claimSchema = z.object({
  claim_attempt: z.object({
    user_code: z.string().min(1),
    verification_uri: z.url(),
    expires_in: z.number().positive().optional(),
    interval: z.number().positive().optional(),
  }),
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  scope: z.string().default(""),
  refresh_token: z.string().optional(),
});

export function createProtocolAdapter(
  method: AuthMethod,
  config: ProtocolConfig,
  store: CredentialStore,
  now = Date.now,
): AuthAdapter {
  if (method.kind === "github-app")
    throw new CeremonyError(
      "GitHub App authentication requires its registration and installation adapter",
    );
  trustedUrl(config.issuer, config);
  const as: oauth.AuthorizationServer = {
    issuer: config.issuer,
    authorization_endpoint: trustedUrl(config.authorizationEndpoint, config)
      .href,
    token_endpoint: trustedUrl(config.tokenEndpoint, config).href,
    device_authorization_endpoint: trustedUrl(config.deviceEndpoint, config)
      .href,
  };
  const client: oauth.Client = {
    client_id: config.clientId,
    token_endpoint_auth_method: "none",
  };
  const options = {
    [oauth.allowInsecureRequests]: config.allowLoopbackHttp === true,
    signal: () => AbortSignal.timeout(10_000),
  };
  let verifier = "";
  let state = "";
  let deviceCode = "";
  let claimToken = "";
  let claimExpires = 0;
  let claiming = false;
  let nextPoll = 0;
  let interval = 5000;
  let stopped = false;
  let outcome: AuthOutcome | undefined;
  const request = async (url: string, init: RequestInit): Promise<Response> => {
    const response = await fetch(trustedUrl(url, config), {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    return response;
  };
  const save = async (
    token: {
      access_token: string;
      scope?: string | undefined;
      refresh_token?: string | undefined;
    },
    ownership: AuthOutcome["ownership"],
  ): Promise<AuthOutcome> => {
    if (stopped) throw new CeremonyError("Attempt cancelled");
    const connectionRef = await store.put(
      {
        access_token: token.access_token,
        ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
      },
      outcome?.connectionRef,
    );
    outcome = {
      connectionRef,
      ownership,
      scopes: (token.scope ?? "").split(" ").filter(Boolean),
    };
    return outcome;
  };
  const postToken = async (parameters: URLSearchParams): Promise<Response> =>
    request(as.token_endpoint!, { method: "POST", body: parameters });
  const failResponse = async (response: Response): Promise<never> => {
    // Provider response bodies can contain credentials or attacker-controlled descriptions.
    await response.body?.cancel();
    throw new CeremonyError(
      response.status === 401
        ? "The credentials were rejected."
        : "The provider could not complete this request.",
    );
  };
  return {
    async begin() {
      stopped = false;
      if (method.kind === "oauth-code") {
        verifier = oauth.generateRandomCodeVerifier();
        state = oauth.generateRandomState();
        const url = trustedUrl(as.authorization_endpoint!, config);
        url.search = new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: config.callbackUrl,
          response_type: "code",
          scope: method.scopes.join(" "),
          state,
          code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
          code_challenge_method: "S256",
        }).toString();
        return { step: "redirect", authorizationUrl: url.href };
      }
      if (method.kind === "device") {
        const response = await oauth.deviceAuthorizationRequest(
          as,
          client,
          oauth.None(),
          { scope: method.scopes.join(" ") },
          options,
        );
        const data = await oauth.processDeviceAuthorizationResponse(
          as,
          client,
          response,
        );
        deviceCode = data.device_code;
        interval = (data.interval ?? 5) * 1000;
        nextPoll = now() + interval;
        return {
          step: "waiting",
          verificationUri: trustedUrl(data.verification_uri, config).href,
          userCode: data.user_code,
          expiresAt: now() + data.expires_in * 1000,
        };
      }
      if (method.kind === "authmd-anonymous") {
        const response = await request(config.identityEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "anonymous" }),
        });
        if (!response.ok) return failResponse(response);
        const registration = registrationSchema.parse(await response.json());
        claimToken = registration.claim_token;
        claimExpires = Date.parse(registration.claim_token_expires);
        if (claimExpires <= now())
          throw new CeremonyError("Registration claim window has expired.");
        const tokenResponse = await postToken(
          new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: registration.identity_assertion,
            resource: config.resource,
          }),
        );
        if (!tokenResponse.ok) return failResponse(tokenResponse);
        return {
          step: "anonymous",
          outcome: await save(
            tokenSchema.parse(await tokenResponse.json()),
            "anonymous",
          ),
          expiresAt: claimExpires,
        };
      }
      return { step: "input" };
    },
    async submit(values, isClaim) {
      if (isClaim && method.kind === "authmd-anonymous") {
        if (!claimToken || claimExpires <= now())
          throw new CeremonyError(
            "The account claim window has expired. Anonymous access is unchanged.",
          );
        stopped = false;
        const response = await request(config.claimEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            claim_token: claimToken,
            email: values.email,
          }),
        });
        if (!response.ok) return failResponse(response);
        const { claim_attempt: attempt } = claimSchema.parse(
          await response.json(),
        );
        claiming = true;
        interval = (attempt.interval ?? 5) * 1000;
        nextPoll = now() + interval;
        return {
          step: "waiting",
          verificationUri: trustedUrl(attempt.verification_uri, config).href,
          userCode: attempt.user_code,
          expiresAt: Math.min(
            claimExpires,
            now() + (attempt.expires_in ?? 600) * 1000,
          ),
        };
      }
      if (!["basic", "api-key", "form"].includes(method.kind))
        throw new CeremonyError("Unexpected credential submission");
      const headers = new Headers();
      let body: URLSearchParams | undefined;
      if (method.kind === "basic") {
        if (values.username?.includes(":"))
          throw new CeremonyError(
            "Basic auth usernames cannot contain a colon.",
          );
        headers.set(
          "authorization",
          `Basic ${Buffer.from(`${values.username}:${values.password}`, "utf8").toString("base64")}`,
        );
      } else if (method.kind === "api-key")
        headers.set("authorization", `Bearer ${values.token}`);
      else body = new URLSearchParams(values);
      const response = await request(config.credentialEndpoint, {
        method: "POST",
        headers,
        ...(body ? { body } : {}),
      });
      if (!response.ok) return failResponse(response);
      if (stopped) throw new CeremonyError("Attempt cancelled");
      if (method.kind === "form")
        return {
          step: "complete",
          outcome: await save(
            tokenSchema.parse(await response.json()),
            "authenticated",
          ),
        };
      await response.body?.cancel();
      outcome = {
        connectionRef: await store.put(values),
        ownership: "authenticated",
        scopes: method.scopes,
      };
      return { step: "complete", outcome };
    },
    async callback(url) {
      if (stopped || !state || !verifier)
        throw new CeremonyError("Callback is no longer valid");
      const savedState = state;
      const savedVerifier = verifier;
      state = "";
      verifier = "";
      const parameters = oauth.validateAuthResponse(
        as,
        client,
        url,
        savedState,
      );
      const response = await oauth.authorizationCodeGrantRequest(
        as,
        client,
        oauth.None(),
        parameters,
        config.callbackUrl,
        savedVerifier,
        options,
      );
      const token = await oauth.processAuthorizationCodeResponse(
        as,
        client,
        response,
      );
      return { step: "complete", outcome: await save(token, "authenticated") };
    },
    async poll(): Promise<AdapterUpdate | undefined> {
      if (stopped || now() < nextPoll) return undefined;
      nextPoll = now() + interval;
      try {
        if (claiming) {
          const response = await postToken(
            new URLSearchParams({
              grant_type: "urn:workos:agent-auth:grant-type:claim",
              claim_token: claimToken,
            }),
          );
          if (!response.ok) {
            const error = z
              .object({ error: z.string() })
              .parse(await response.json());
            if (error.error === "authorization_pending") return undefined;
            if (error.error === "slow_down") {
              interval += 5000;
              nextPoll = now() + interval;
              return undefined;
            }
            throw new CeremonyError(
              error.error === "expired_token"
                ? "The claim attempt expired. Anonymous access is unchanged."
                : "The claim was not approved. Anonymous access is unchanged.",
            );
          }
          claiming = false;
          return {
            step: "complete",
            outcome: await save(
              tokenSchema.parse(await response.json()),
              "claimed",
            ),
          };
        }
        const response = await oauth.deviceCodeGrantRequest(
          as,
          client,
          oauth.None(),
          deviceCode,
          options,
        );
        const token = await oauth.processDeviceCodeResponse(
          as,
          client,
          response,
        );
        return {
          step: "complete",
          outcome: await save(token, "authenticated"),
        };
      } catch (error) {
        if (error instanceof oauth.ResponseBodyError) {
          if (error.error === "authorization_pending") return undefined;
          if (error.error === "slow_down") {
            interval += 5000;
            nextPoll = now() + interval;
            return undefined;
          }
          throw new CeremonyError(
            error.error === "expired_token"
              ? "The approval window expired."
              : "The authorization request was denied.",
          );
        }
        throw error;
      }
    },
    cancel() {
      stopped = true;
      state = "";
      verifier = "";
      deviceCode = "";
      claiming = false;
    },
  };
}
