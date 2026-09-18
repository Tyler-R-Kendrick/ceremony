import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  capabilityStatus,
  ConnectorError,
  destinationFor,
  destinationUrl,
  type AdapterCallContext,
  type AuthorizationIntent,
  type AuthorizationStart,
  type CompletionInput,
  type CompletionResult,
  type ConnectorAdapter,
  type DisconnectResult,
  type InvokeRequest,
  type InvokeResult,
} from "../../../src/server/connectors/index.js";
import {
  startHttpFixture,
  type RecordedRequest,
} from "./http-fixture.js";

/*
 * A real connector adapter over real HTTP.
 *
 * It implements two authentication profiles against the provider fixture
 * below: an API key submitted through a private handoff, and an OAuth 2.0
 * authorization-code flow with S256 PKCE, exact state correlation and a
 * token exchange. Both reach the same two bound operations — one read, one
 * write — through the command layer's binding, so every command in the
 * service is exercised end to end against production wire code: the adapter
 * never fabricates a response, never persists a connection, never reads a
 * header or cookie, never derives an actor from its arguments and never
 * reaches a destination its binding does not approve.
 */

export const FIXTURE_ADAPTER_ID = "fixture-http";
export const FIXTURE_ADAPTER_VERSION = "1.0.0";

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  scope: z.string().default(""),
  account: z.string().min(1).optional(),
  refresh_token: z.string().optional(),
});
const accountSchema = z.object({
  account: z.string().min(1),
  scopes: z.array(z.string()).default([]),
});
const listSchema = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string() })),
});
const writeSchema = z.object({ id: z.string(), status: z.string() });

export type FixtureProviderOptions = {
  /** The API key the provider accepts; anything else is rejected. */
  apiKey?: string;
  /** Accounts the OAuth authorization endpoint may return, by authorization code. */
  account?: string;
  /** Force the consent step to require a second human interaction. */
  requireConsent?: boolean;
  /** Truncate the next write's response after applying it upstream: the effect happened, the answer did not arrive. */
  dropWriteResponse?: boolean;
};

export type FixtureProvider = Awaited<ReturnType<typeof startFixtureProvider>>;

/**
 * The provider side. It validates what the documented contract says it
 * validates — bearer or api-key header, PKCE verifier against the stored
 * challenge, exact redirect URI, one-use codes — so an adapter cannot pass
 * by sending something the real provider would refuse.
 */
export async function startFixtureProvider(
  options: FixtureProviderOptions = {},
) {
  const apiKey = options.apiKey ?? "fixture-api-key";
  const account = options.account ?? "acct-primary";
  const codes = new Map<
    string,
    { challenge: string; redirectUri: string; account: string; used: boolean }
  >();
  const tokens = new Map<string, { account: string; scopes: string[] }>();
  const writes = new Map<string, number>();
  const state = {
    account,
    apiKey,
    requireConsent: options.requireConsent ?? false,
    dropWriteResponse: options.dropWriteResponse ?? false,
    /** Authorization requests the fixture served, for assertions. */
    authorizations: [] as RecordedRequest[],
  };

  const authenticated = (request: RecordedRequest) => {
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "");
    if (bearer) return tokens.get(bearer[1]!);
    const key = request.headers["x-api-key"];
    if (key && key === state.apiKey)
      return { account: state.account, scopes: ["read", "write"] };
    return undefined;
  };

  const server = await startHttpFixture((request) => {
    const path = request.url.pathname;
    if (path === "/oauth/authorize" && request.method === "GET") {
      state.authorizations.push(request);
      const challenge = request.url.searchParams.get("code_challenge");
      const method = request.url.searchParams.get("code_challenge_method");
      const redirectUri = request.url.searchParams.get("redirect_uri") ?? "";
      const clientState = request.url.searchParams.get("state") ?? "";
      if (!challenge || method !== "S256" || !redirectUri || !clientState)
        return { status: 400, body: { error: "invalid_request" } };
      const code = randomBytes(12).toString("hex");
      codes.set(code, {
        challenge,
        redirectUri,
        account: state.account,
        used: false,
      });
      const location = new URL(redirectUri);
      location.searchParams.set("code", code);
      location.searchParams.set("state", clientState);
      return { status: 302, headers: { location: location.href }, body: "" };
    }
    if (path === "/oauth/token" && request.method === "POST") {
      const form = new URLSearchParams(request.body.toString("utf8"));
      const grant = codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const digest = createHash("sha256").update(verifier).digest("base64url");
      if (
        form.get("grant_type") !== "authorization_code" ||
        !grant ||
        grant.used ||
        digest !== grant.challenge ||
        form.get("redirect_uri") !== grant.redirectUri
      )
        return { status: 400, body: { error: "invalid_grant" } };
      grant.used = true;
      const token = `at_${randomBytes(12).toString("hex")}`;
      tokens.set(token, { account: grant.account, scopes: ["read", "write"] });
      return {
        body: {
          access_token: token,
          token_type: "Bearer",
          scope: "read write",
          account: grant.account,
        },
      };
    }
    if (path === "/v1/account" && request.method === "GET") {
      const session = authenticated(request);
      if (!session) return { status: 401, body: { error: "unauthorized" } };
      return { body: { account: session.account, scopes: session.scopes } };
    }
    if (path === "/v1/items" && request.method === "GET") {
      const session = authenticated(request);
      if (!session) return { status: 401, body: { error: "unauthorized" } };
      const project = request.url.searchParams.get("project");
      return {
        body: {
          items: [
            { id: "item-1", name: `${session.account}:${project ?? "all"}` },
          ],
        },
      };
    }
    if (path === "/v1/items" && request.method === "POST") {
      const session = authenticated(request);
      if (!session) return { status: 401, body: { error: "unauthorized" } };
      const payload = z
        .object({ name: z.string(), project: z.string().optional() })
        .safeParse(JSON.parse(request.body.toString("utf8") || "{}"));
      if (!payload.success)
        return { status: 400, body: { error: "invalid_request" } };
      const key = request.headers["idempotency-key"] ?? payload.data.name;
      writes.set(key, (writes.get(key) ?? 0) + 1);
      if (state.dropWriteResponse) {
        state.dropWriteResponse = false;
        // The write was applied upstream and the answer was cut off in
        // transit. The client cannot tell whether it happened.
        return {
          status: 201,
          headers: { "content-type": "application/json" },
          body: '{"id":"item-1","stat',
        };
      }
      return { status: 201, body: { id: `item-${writes.size}`, status: "created" } };
    }
    if (path === "/v1/revoke" && request.method === "POST") {
      const session = authenticated(request);
      if (!session) return { status: 401, body: { error: "unauthorized" } };
      for (const [token, value] of tokens)
        if (value.account === session.account) tokens.delete(token);
      return { body: { revoked: true } };
    }
    return undefined;
  });

  return {
    ...server,
    state,
    /** How many times a write with this idempotency key or name reached the provider. */
    writeCount: (key: string) => writes.get(key) ?? 0,
    tokenCount: () => tokens.size,
  };
}

export type FixtureAdapterOptions = {
  /** The oauth profile id in the definition this adapter drives. */
  oauthProfileId?: string;
  apiKeyProfileId?: string;
  clientId?: string;
  support?: ConnectorAdapter["support"];
};

type OauthPrivate = { verifier: string; url: string; redirectUri: string };

const claimAt = (ctx: AdapterCallContext) =>
  new Date(ctx.environment.now()).toISOString();

/** Evidence the adapter can honestly report; nothing is inferred from a 200. */
function accountClaim(
  ctx: AdapterCallContext,
  account: string,
  requested: string[],
  reported: string[],
) {
  const observedAt = claimAt(ctx);
  return [
    {
      kind: "credential-accepted" as const,
      evidenceRef: "evidence:pending",
      issuer: "provider" as const,
      target: { kind: "account", id: account },
      observedAt,
      verifierVersion: FIXTURE_ADAPTER_VERSION,
      bindingRevision: ctx.binding.revision,
      policyRevision: ctx.binding.policyRevision,
      limitations: [],
    },
    {
      kind: "account-identity" as const,
      evidenceRef: "evidence:pending",
      issuer: "provider" as const,
      target: { kind: "account", id: account },
      observedAt,
      verifierVersion: FIXTURE_ADAPTER_VERSION,
      bindingRevision: ctx.binding.revision,
      policyRevision: ctx.binding.policyRevision,
      permissions: {
        requested,
        reported,
        observed: [],
        semantics: "provider-scopes" as const,
      },
      limitations: [],
    },
  ];
}

export function createFixtureAdapter(
  options: FixtureAdapterOptions = {},
): ConnectorAdapter {
  const oauthProfileId = options.oauthProfileId ?? "oauth";
  const apiKeyProfileId = options.apiKeyProfileId ?? "api-key";
  const clientId = options.clientId ?? "fixture-client";

  /** Every outbound call is pinned to an approved destination by its operation. */
  const endpoint = (ctx: AdapterCallContext, path: string) => {
    const destination = ctx.binding.destinations[0];
    if (!destination)
      throw new ConnectorError("network-policy", {
        detail: "destination.missing",
      });
    return destinationUrl(destination, path);
  };

  const use = async <T>(
    ctx: AdapterCallContext,
    work: (headers: Headers) => Promise<T>,
  ): Promise<T> => {
    const connection = ctx.connection;
    if (!connection?.credentialRef)
      throw new ConnectorError("denied", { detail: "credential.missing" });
    return ctx.environment.credentials.use(
      {
        tenantId: connection.tenantId,
        ownerKind: connection.ownerKind,
        ownerId: connection.ownerId,
        connectionRef: connection.connectionRef,
        bindingRef: connection.bindingRef,
        custody: connection.custody,
      },
      connection.credentialRef,
      async (material) => {
        const headers = new Headers();
        if (material.access_token)
          headers.set("authorization", `Bearer ${material.access_token}`);
        else if (material.api_key) headers.set("x-api-key", material.api_key);
        else
          throw new ConnectorError("denied", { detail: "credential.unusable" });
        return work(headers);
      },
    );
  };

  const store = async (
    ctx: AdapterCallContext,
    material: Record<string, string>,
  ): Promise<string> => {
    const connection = ctx.connection;
    if (!connection)
      throw new ConnectorError("invalid-request", {
        detail: "connection.missing",
      });
    return ctx.environment.credentials.store(
      {
        tenantId: connection.tenantId,
        ownerKind: connection.ownerKind,
        ownerId: connection.ownerId,
        connectionRef: connection.connectionRef,
        bindingRef: connection.bindingRef,
        custody: connection.custody,
      },
      material,
    );
  };

  const verifyAccount = async (
    ctx: AdapterCallContext,
    requested: string[],
  ): Promise<{ account: string; scopes: string[] }> => {
    const response = await use(ctx, (headers) =>
      ctx.environment.fetch(endpoint(ctx, "/v1/account"), {
        headers,
        redirect: "error",
        signal: ctx.signal,
      }),
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ConnectorError(
        response.status === 401 ? "denied" : "upstream-rejected",
        { detail: "verify.rejected" },
      );
    }
    const parsed = accountSchema.parse(await response.json());
    void requested;
    return { account: parsed.account, scopes: parsed.scopes };
  };

  return {
    id: FIXTURE_ADAPTER_ID,
    ecosystem: "openapi",
    adapterVersion: FIXTURE_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "Fixture HTTP service",
    description:
      "A loopback protocol fixture exercising api-key and OAuth authorization-code profiles.",
    service: "fixture",
    support: options.support ?? "fixture",
    custody: ["host-owned"],
    configuration: [],
    profiles: ["oauth-authorization-code", "api-key"],
    capabilities: () =>
      (
        [
          "import",
          "configure",
          "authorize",
          "verify",
          "invoke",
          "reconnect",
          "disconnect",
          "revoke",
        ] as const
      ).map((dimension) =>
        capabilityStatus(
          { adapterVersion: FIXTURE_ADAPTER_VERSION, runtime: "hosted-server" },
          { dimension, profile: "fixture-http-1", evidence: "protocol-fixture" },
        ),
      ),

    async authorize(
      ctx: AdapterCallContext,
      intent: AuthorizationIntent,
    ): Promise<AuthorizationStart> {
      const profileId = intent.profileId ?? ctx.binding.profileId;
      if (profileId === apiKeyProfileId)
        return {
          kind: "handoff",
          handoff: {
            kind: "private-collector",
            presentation: "in-app",
            expiresAt: ctx.environment.now() + 600_000,
            intent: "collect.api-key",
            private: {
              instructions: "Enter the API key issued by the fixture service.",
            },
          },
        };
      if (profileId !== oauthProfileId)
        return { kind: "unsupported", code: "profile.unsupported" };
      const verifier = Buffer.from(ctx.environment.random.bytes(32)).toString(
        "base64url",
      );
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      const state = Buffer.from(ctx.environment.random.bytes(32)).toString(
        "base64url",
      );
      // The return route is the deployment's own callback, built from the
      // trusted origin the environment supplies. Nothing here is caller input.
      const redirectUri = `${ctx.environment.origin}/api/v1/connectors/callback`;
      const url = endpoint(ctx, "/oauth/authorize");
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: intent.requestedPermissions.join(" "),
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      return {
        kind: "handoff",
        handoff: {
          kind: "provider-browser",
          presentation: "popup",
          expiresAt: ctx.environment.now() + 600_000,
          intent: "authorize.oauth-code",
          correlationKey: state,
          private: {
            verifier,
            url: url.href,
            redirectUri,
          } satisfies OauthPrivate,
        },
      };
    },

    async complete(
      ctx: AdapterCallContext,
      input: CompletionInput,
    ): Promise<CompletionResult> {
      const handoff = ctx.handoff;
      if (!handoff)
        return { state: "pending", claims: [], code: "handoff.unavailable" };
      const requested =
        ctx.connection && Array.isArray(ctx.connection.state.requested)
          ? (ctx.connection.state.requested as string[])
          : [];
      if (input.kind === "input") {
        const key = input.values.apiKey ?? input.values.token;
        if (!key)
          return { state: "denied", claims: [], code: "credential.missing" };
        const credentialRef = await store(ctx, { api_key: key });
        const probe = await ctx.environment.fetch(
          endpoint(ctx, "/v1/account"),
          {
            headers: { "x-api-key": key },
            redirect: "error",
            signal: ctx.signal,
          },
        );
        if (!probe.ok) {
          await probe.body?.cancel().catch(() => {});
          return { state: "denied", claims: [], code: "credential.rejected" };
        }
        const parsed = accountSchema.parse(await probe.json());
        return {
          state: "complete",
          claims: accountClaim(ctx, parsed.account, requested, parsed.scopes),
          credentialRef,
          externalIds: { account: parsed.account },
          target: { kind: "account", id: parsed.account },
        };
      }
      if (input.kind === "poll")
        return { state: "pending", claims: [], code: "authorization.pending" };
      if (input.kind === "event")
        return { state: "pending", claims: [], code: "event.ignored" };

      const private_ = handoff.private as Partial<OauthPrivate>;
      if (!private_.verifier || !private_.redirectUri)
        return { state: "denied", claims: [], code: "handoff.incomplete" };
      const url = input.url;
      if (url.searchParams.get("error"))
        return { state: "denied", claims: [], code: "authorization.denied" };
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      if (!code || returnedState !== handoff.correlationKey)
        return { state: "denied", claims: [], code: "callback.mismatch" };
      const response = await ctx.environment.fetch(
        endpoint(ctx, "/oauth/token"),
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: private_.redirectUri,
            code_verifier: private_.verifier,
            client_id: clientId,
          }),
          redirect: "error",
          signal: ctx.signal,
        },
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { state: "denied", claims: [], code: "token.rejected" };
      }
      const token = tokenResponseSchema.parse(await response.json());
      const credentialRef = await store(ctx, {
        access_token: token.access_token,
        ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
      });
      const account = token.account;
      if (!account)
        // The provider returned a usable token but named no account. That is
        // recorded as what it is; it is never relabelled as exact-account proof.
        return {
          state: "complete",
          claims: [
            {
              kind: "credential-accepted",
              evidenceRef: "evidence:pending",
              issuer: "provider",
              target: { kind: "authority", id: ctx.binding.authorityInstance || "fixture" },
              observedAt: claimAt(ctx),
              verifierVersion: FIXTURE_ADAPTER_VERSION,
              bindingRevision: ctx.binding.revision,
              policyRevision: ctx.binding.policyRevision,
              limitations: ["The provider did not identify an account."],
            },
          ],
          credentialRef,
        };
      return {
        state: "complete",
        claims: accountClaim(
          ctx,
          account,
          requested,
          token.scope.split(" ").filter(Boolean),
        ),
        credentialRef,
        externalIds: { account },
        target: { kind: "account", id: account },
      };
    },

    async verify(ctx: AdapterCallContext): Promise<CompletionResult> {
      const observed = await verifyAccount(ctx, []);
      return {
        state: "complete",
        claims: accountClaim(ctx, observed.account, [], observed.scopes),
        externalIds: { account: observed.account },
        target: { kind: "account", id: observed.account },
      };
    },

    async invoke(
      ctx: AdapterCallContext,
      request: InvokeRequest,
    ): Promise<InvokeResult> {
      const operation = ctx.binding.operations.find(
        (item) => item.operationRef === request.operationRef,
      );
      if (!operation || operation.transport.kind !== "http")
        throw new ConnectorError("denied", { detail: "operation.unapproved" });
      const destination = destinationFor(ctx.binding, operation);
      const url = destinationUrl(destination, operation.transport.pathTemplate);
      const input = z
        .object({
          project: z.string().max(200).optional(),
          name: z.string().max(200).optional(),
        })
        .parse(request.input ?? {});
      if (operation.transport.method === "GET" && input.project)
        url.searchParams.set("project", input.project);
      const response = await use(ctx, (headers) => {
        if (operation.transport.kind !== "http")
          throw new ConnectorError("unsupported", {
            detail: "transport.unsupported",
          });
        if (operation.transport.method !== "GET") {
          headers.set("content-type", "application/json");
          if (request.idempotencyKey)
            headers.set("idempotency-key", request.idempotencyKey);
        }
        return ctx.environment.fetch(url, {
          method: operation.transport.method,
          headers,
          ...(operation.transport.method === "GET"
            ? {}
            : { body: JSON.stringify(input) }),
          redirect: "error",
          signal: ctx.signal,
        });
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return {
          state: "failed",
          outputClassification: operation.outputClassification,
          effect: operation.effect,
          code: response.status === 401 ? "credential.rejected" : "upstream.rejected",
        };
      }
      const body: unknown = await response.json();
      return {
        state: "complete",
        output:
          operation.effect === "read"
            ? listSchema.parse(body)
            : writeSchema.parse(body),
        outputClassification: operation.outputClassification,
        effect: operation.effect,
      };
    },

    async reconnect(
      ctx: AdapterCallContext,
      intent: AuthorizationIntent,
    ): Promise<AuthorizationStart> {
      return this.authorize!(ctx, intent);
    },

    async disconnect(
      ctx: AdapterCallContext,
      scope: "local" | "broker" | "upstream",
    ): Promise<DisconnectResult> {
      if (scope === "local")
        return {
          local: "applied",
          broker: "not-attempted",
          upstream: "not-attempted",
        };
      if (scope === "broker")
        // The fixture holds no broker-side record; saying so is the honest answer.
        return {
          local: "not-attempted",
          broker: "unsupported",
          upstream: "not-attempted",
        };
      const response = await use(ctx, (headers) =>
        ctx.environment.fetch(endpoint(ctx, "/v1/revoke"), {
          method: "POST",
          headers,
          redirect: "error",
          signal: ctx.signal,
        }),
      );
      await response.body?.cancel().catch(() => {});
      return {
        local: "not-attempted",
        broker: "not-attempted",
        upstream: response.ok ? "applied" : "failed",
      };
    },

    async revoke(ctx: AdapterCallContext): Promise<DisconnectResult> {
      return this.disconnect!(ctx, "upstream");
    },
  };
}
