import { createServer } from "node:http";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { PostgresCeremonyStore } from "../../src/server/persistence/index.js";
import { createGitHubRuntime } from "../../src/server/github-runtime.js";
import { startReferenceApp } from "../../examples/server.js";
import { postgresFixture } from "./postgres.js";
import { mountTeachingHost } from "./teaching-hosted.js";
import {
  hostedContinuation,
  dispatchHostedContinuations,
} from "../../src/server/hosted/continuations.js";
import type { BrowserContext } from "@playwright/test";

/** Synthetic provider pages only; SDK requests cross real HTTP and app JWTs are verified. */
export async function teachingGitHubFixture(
  port: number,
  options: {
    loseConversionResponse?: boolean;
    hostContinuation?: boolean;
    loseContinuationAcknowledgment?: boolean;
    returnPath?: string;
    stripe?: boolean;
    supabase?: "aal1" | "aal2";
    jira?: "configured" | "owner-setup";
  } = {},
) {
  const database = await postgresFixture();
  const store = new PostgresCeremonyStore(database.config, {
    current: "fixture",
    keys: { fixture: randomBytes(32) },
  });
  await store.migrate();
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = keys.privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();
  const effects = {
    conversions: 0,
    tokens: 0,
    verifiedSignatures: 0,
    repositoryReads: 0,
    continuationRequests: 0,
    continuationEffects: 0,
    stripeReads: 0,
    supabaseSignups: 0,
    supabaseSignins: 0,
    supabaseReads: 0,
    supabaseMfa: 0,
    supabaseMfaAttempts: 0,
    jiraConsents: 0,
    jiraExchanges: 0,
    jiraReads: 0,
    jiraCallbackStatus: 0,
  };
  const supabaseKey = randomBytes(32),
    factorId = randomUUID(),
    challengeId = randomUUID();
  const supabaseToken = (aal: string) =>
    new SignJWT({ aal })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("fixture-project-user")
      .setExpirationTime("1h")
      .sign(supabaseKey);
  let supabaseConfirmed = false;
  const stripeKey = `rk_test_${randomBytes(24).toString("hex")}`;
  const continuationToken = randomBytes(32).toString("hex");
  const workerToken = randomBytes(32).toString("hex");
  const delivered = new Set<string>();
  const jiraCredentials = {
    clientId: "synthetic-jira-client",
    clientSecret: randomBytes(32).toString("hex"),
  };
  const jiraToken = randomBytes(32).toString("hex");
  const jiraCloud = "8594f221-9797-5f78-1fa4-485e198d7cd0";
  const jiraStates = new Set<string>();
  const jiraCodes = new Set<string>();
  const consumed = new Set<string>();
  let registeredSetupUrl = "";
  const provider = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://fixture");
      if (options.jira && url.pathname === "/jira/authorize") {
        const state = url.searchParams.get("state") ?? "";
        if (
          !/^[A-Za-z0-9_-]{43}$/.test(state) ||
          url.searchParams.get("client_id") !== jiraCredentials.clientId ||
          url.searchParams.get("redirect_uri") !==
            `${origin}/api/v1/teaching/jira/authorization-return` ||
          url.searchParams.get("scope") !== "read:jira-user" ||
          url.searchParams.get("prompt") !== "consent"
        )
          throw new Error("Invalid Jira fixture authorization");
        jiraStates.add(state);
        const listening = provider.address();
        if (!listening || typeof listening === "string")
          throw new Error("Fixture unavailable");
        res
          .writeHead(200, {
            "content-type": "text/html",
            "cache-control": "no-store",
          })
          .end(
            `<!doctype html><html lang="en"><title>Local Atlassian consent fixture</title><h1>Authorize the fixture Jira site</h1><form action="http://127.0.0.1:${listening.port}/jira/consent"><input type="hidden" name="state" value="${state}"><button>Allow fixture access</button></form></html>`,
          );
        return;
      }
      if (options.jira && url.pathname === "/jira/consent") {
        const state = url.searchParams.get("state") ?? "";
        if (!jiraStates.delete(state))
          throw new Error("Invalid Jira fixture consent");
        const code = randomUUID();
        jiraCodes.add(code);
        effects.jiraConsents++;
        res
          .writeHead(303, {
            location: `${origin}/api/v1/teaching/jira/authorization-return?state=${state}&code=${code}`,
            "cache-control": "no-store",
          })
          .end();
        return;
      }
      if (options.jira && url.pathname === "/oauth/token") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        if (
          req.method !== "POST" ||
          body.client_id !== jiraCredentials.clientId ||
          body.client_secret !== jiraCredentials.clientSecret ||
          body.redirect_uri !==
            `${origin}/api/v1/teaching/jira/authorization-return` ||
          !jiraCodes.delete(body.code)
        )
          throw new Error("Invalid Jira fixture exchange");
        effects.jiraExchanges++;
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            access_token: jiraToken,
            token_type: "Bearer",
            expires_in: 3600,
            scope: "read:jira-user",
          }),
        );
        return;
      }
      if (
        options.jira &&
        [
          "/oauth/token/accessible-resources",
          `/ex/jira/${jiraCloud}/rest/api/3/myself`,
        ].includes(url.pathname)
      ) {
        if (
          req.method !== "GET" ||
          req.headers.authorization !== `Bearer ${jiraToken}`
        )
          throw new Error("Invalid Jira fixture access");
        const sites = url.pathname === "/oauth/token/accessible-resources";
        if (!sites) effects.jiraReads++;
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify(
            sites
              ? [
                  {
                    id: jiraCloud,
                    url: "https://synthetic.atlassian.net",
                    scopes: ["read:jira-user"],
                  },
                ]
              : {
                  accountId: "synthetic-jira-user",
                  active: true,
                  accountType: "atlassian",
                },
          ),
        );
        return;
      }
      if (options.supabase && url.pathname === "/confirm-project-user") {
        supabaseConfirmed = true;
        res
          .writeHead(200, {
            "content-type": "text/html",
            "cache-control": "no-store",
          })
          .end(
            "<!doctype html><title>Local confirmation fixture</title><p>Fixture email confirmed. Return to the connection.</p>",
          );
        return;
      }
      if (options.supabase && url.pathname.startsWith("/auth/v1/")) {
        res.setHeader("content-type", "application/json");
        const user = {
          id: "fixture-project-user",
          factors: [{ id: factorId, factor_type: "totp", status: "verified" }],
        };
        if (url.pathname === "/auth/v1/user") {
          await jwtVerify(
            (req.headers.authorization ?? "").slice(7),
            supabaseKey,
            { subject: user.id },
          );
          effects.supabaseReads++;
          res.end(JSON.stringify(user));
          return;
        }
        if (req.method !== "POST") throw new Error();
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        if (url.pathname === "/auth/v1/signup") {
          if (
            body.email !== "project-user@example.com" ||
            body.password !== "synthetic-project-password"
          )
            throw new Error();
          effects.supabaseSignups++;
          res.end(JSON.stringify({ id: user.id }));
          return;
        }
        let aal = "aal1";
        if (url.pathname === "/auth/v1/token") {
          effects.supabaseSignins++;
          if (
            !supabaseConfirmed ||
            body.email !== "project-user@example.com" ||
            body.password !== "synthetic-project-password"
          ) {
            res.statusCode = 400;
            res.end(
              JSON.stringify({
                code: "email_not_confirmed",
                message: "fixture-rejected",
              }),
            );
            return;
          }
        } else {
          await jwtVerify(
            (req.headers.authorization ?? "").slice(7),
            supabaseKey,
            { subject: user.id },
          );
          if (url.pathname === `/auth/v1/factors/${factorId}/challenge`) {
            res.end(
              JSON.stringify({
                id: challengeId,
                type: "totp",
                expires_at: Math.floor(Date.now() / 1000) + 300,
              }),
            );
            return;
          }
          if (url.pathname === `/auth/v1/factors/${factorId}/verify`)
            effects.supabaseMfaAttempts++;
          if (
            url.pathname !== `/auth/v1/factors/${factorId}/verify` ||
            body.challenge_id !== challengeId ||
            body.code !== "123456"
          )
            throw new Error();
          effects.supabaseMfa++;
          aal = "aal2";
        }
        res.end(
          JSON.stringify({
            access_token: await supabaseToken(aal),
            refresh_token: "synthetic-project-refresh",
            token_type: "bearer",
            expires_in: 3600,
            user,
          }),
        );
        return;
      }
      if (options.stripe && url.pathname === "/v1/balance") {
        if (
          req.method !== "GET" ||
          req.headers.authorization !== `Bearer ${stripeKey}`
        )
          throw new Error("Invalid Stripe fixture request");
        effects.stripeReads++;
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            object: "balance",
            livemode: false,
            available: [],
            pending: [],
          }),
        );
        return;
      }
      if (url.pathname === "/users/fixture-owner") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ login: "fixture-owner", type: "User" }));
        return;
      }
      if (url.pathname === "/host/continue") {
        if (
          req.headers.authorization !== `Bearer ${continuationToken}` ||
          req.method !== "POST"
        )
          throw new Error();
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const input = JSON.parse(raw);
        if (
          typeof input.deliveryId !== "string" ||
          req.headers["idempotency-key"] !== input.deliveryId
        )
          throw new Error();
        effects.continuationRequests++;
        if (!delivered.has(input.deliveryId)) {
          delivered.add(input.deliveryId);
          effects.continuationEffects++;
        }
        if (
          options.loseContinuationAcknowledgment &&
          effects.continuationRequests === 1
        ) {
          req.socket.destroy();
          return;
        }
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(
            JSON.stringify({ deliveryId: input.deliveryId, completed: true }),
          );
        return;
      }
      let body: unknown;
      if (/^\/app-manifests\/[^/]+\/conversions$/.test(url.pathname)) {
        if (consumed.has(url.pathname)) {
          res.writeHead(422).end();
          return;
        }
        consumed.add(url.pathname);
        effects.conversions++;
        if (options.loseConversionResponse) {
          req.socket.destroy();
          return;
        }
        body = {
          id: 42,
          slug: "teaching-fixture",
          pem,
          owner: { login: "fixture-owner" },
        };
      } else if (url.pathname === "/installation/repositories") {
        if (req.headers.authorization !== "Bearer fixture-installation-token")
          throw new Error();
        effects.repositoryReads++;
        body = { total_count: 1, repositories: [{ id: 9 }] };
      } else {
        await jwtVerify(
          (req.headers.authorization ?? "").replace(/^Bearer /i, ""),
          keys.publicKey,
          { algorithms: ["RS256"], issuer: "42" },
        );
        effects.verifiedSignatures++;
        if (url.pathname === "/app")
          body = {
            id: 42,
            slug: "teaching-fixture",
            owner: { login: "fixture-owner" },
            permissions: { contents: "read" },
          };
        else if (url.pathname === "/app/installations/7")
          body = {
            id: 7,
            app_id: 42,
            account: { login: "fixture-owner" },
            suspended_at: null,
            permissions: { contents: "read" },
          };
        else if (url.pathname === "/app/installations/7/access_tokens") {
          effects.tokens++;
          body = {
            token: "fixture-installation-token",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            permissions: { contents: "read" },
          };
        } else throw new Error();
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(body));
    } catch {
      res
        .writeHead(401, { "content-type": "application/json" })
        .end('{"error":"fixture-rejected"}');
    }
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture unavailable");
  const origin = `http://127.0.0.1:${port}`;
  const sessions = new Map<string, string>();
  const runtime = createGitHubRuntime({
    store,
    origin,
    environment: "local-e2e",
    configurationVersion: "fixture-v1",
    ...(options.jira
      ? {
          jira: {
            configuration: async () => ({
              version: "fixture-v1",
              ...(options.jira === "configured"
                ? {
                    ...jiraCredentials,
                    siteUrl: "https://synthetic.atlassian.net",
                  }
                : {}),
            }),
            allowTarget: async (_actor, target) =>
              target === "https://synthetic.atlassian.net",
            allowLoopbackHttp: true,
            fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
              const url = new URL(String(input));
              if (
                ![
                  "https://auth.atlassian.com",
                  "https://api.atlassian.com",
                ].includes(url.origin)
              )
                throw new Error("Unexpected Jira fixture origin");
              return fetch(
                `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
                init,
              );
            },
          },
        }
      : {}),
    ...(options.supabase
      ? {
          supabase: {
            configuration: async () => ({ version: "fixture-v1" }),
            requiredAssurance: options.supabase,
            fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
              const url = new URL(String(input));
              if (url.origin !== "https://synthetic.supabase.co")
                throw new Error("Unexpected Supabase fixture origin");
              return fetch(
                `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
                init,
              );
            },
          },
        }
      : {}),
    ...(options.stripe
      ? {
          stripe: {
            configuration: async () => ({ version: "fixture-v1" }),
            fetch: async (
              input: Parameters<typeof fetch>[0],
              init?: RequestInit,
            ) => {
              const requested = new URL(String(input));
              if (requested.origin !== "https://api.stripe.com")
                throw new Error("Unexpected Stripe fixture origin");
              return fetch(
                `http://127.0.0.1:${address.port}${requested.pathname}${requested.search}`,
                init,
              );
            },
          },
        }
      : {}),
    ...(options.returnPath ? { returnPath: options.returnPath } : {}),
    expectedAccount: "fixture-owner",
    identity: {
      authenticate: async (request) => {
        const cookie = /(?:^|; )teaching-fixture=([^;]+)/.exec(
          request.headers.get("cookie") ?? "",
        )?.[1];
        const subjectId = cookie && sessions.get(cookie);
        return subjectId
          ? {
              tenantId: "teaching-fixture",
              subjectId,
              sessionId: cookie!,
              actorKind: "human",
              capabilities: [
                "author",
                "reviewer",
                "publisher",
                "executor",
                ...(options.jira === "owner-setup" ? ["admin" as const] : []),
              ],
            }
          : null;
      },
    },
    authorize: async () => true,
    ...(options.hostContinuation
      ? {
          continuation: hostedContinuation(
            {
              CEREMONY_CONTINUATION_URL:
                "https://continuation.fixture/host/continue",
              CEREMONY_CONTINUATION_TOKEN: continuationToken,
            },
            async (input, init) => {
              if (
                String(input) !== "https://continuation.fixture/host/continue"
              )
                throw new Error("Unexpected continuation endpoint");
              return fetch(
                `http://127.0.0.1:${address.port}/host/continue`,
                init,
              );
            },
          )!,
        }
      : {}),
    github: {
      fetch: async (input, init) => {
        const requested = new URL(String(input));
        if (requested.origin !== "https://api.github.com")
          throw new Error("Unexpected fixture origin");
        return fetch(
          `http://127.0.0.1:${address.port}${requested.pathname}${requested.search}`,
          init,
        );
      },
    },
  });
  const humanReturn = runtime.humanReturn;
  if (options.jira && humanReturn)
    runtime.humanReturn = async (actor, request) => {
      const response = await humanReturn(actor, request);
      effects.jiraCallbackStatus = response.status;
      return response;
    };
  let app: { close(): Promise<void> };
  let staticRevision = 1;
  try {
    app = options.hostContinuation
      ? await mountTeachingHost(
          () => runtime,
          {
            secret: workerToken,
            dispatch: () =>
              dispatchHostedContinuations(runtime, "teaching-fixture"),
          },
          port,
          () => staticRevision,
        )
      : await startReferenceApp({
          port,
          providerPort: port + 1,
          teaching: runtime,
        });
  } catch (error) {
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await store.close();
    await database.close();
    throw error;
  }
  function sessionCookie(subject: string) {
    const token = randomBytes(24).toString("hex");
    sessions.set(token, subject);
    return `teaching-fixture=${token}`;
  }
  return {
    origin,
    store,
    effects,
    runtime,
    privateRecovery: { appId: 42, pem },
    stripeKey,
    supabaseConfirmationUrl: `http://127.0.0.1:${address.port}/confirm-project-user`,
    supabaseFactorId: factorId,
    jiraCredentials,
    async jiraProviderPages(context: BrowserContext) {
      await context.route(
        `${origin}/api/v1/teaching/jira/*/human`,
        async (route) => {
          if (route.request().method() !== "GET") return route.continue();
          const response = await route.fetch({ maxRedirects: 0 });
          if (response.status() !== 303) return route.fulfill({ response });
          const url = new URL(response.headers().location!);
          if (
            url.origin !== "https://auth.atlassian.com" ||
            url.pathname !== "/authorize"
          )
            throw new Error("Unexpected Jira handoff");
          // Playwright routes the initial request, and WebKit cannot fulfill a redirect status.
          // Render the real HTTP fixture consent response here; its form navigates to the provider fixture.
          // No app command, callback, token exchange or verification response is replaced.
          const consent = await context.request.get(
            `http://127.0.0.1:${address.port}/jira/authorize${url.search}`,
          );
          if (consent.status() !== 200)
            throw new Error("Invalid fixture consent response");
          await route.fulfill({ response: consent });
        },
      );
    },
    workerAuthorization: `Bearer ${workerToken}`,
    sessionCookie,
    updateStaticRelease() {
      staticRevision++;
    },
    async login(context: BrowserContext, subject: string) {
      const token = sessionCookie(subject).slice("teaching-fixture=".length);
      await context.addCookies([
        {
          name: "teaching-fixture",
          value: token,
          url: origin,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
    },
    async providerPages(context: BrowserContext) {
      await context.route(
        `${origin}/api/v1/teaching/github/*/human`,
        async (route) => {
          const response = await route.fetch({ maxRedirects: 0 });
          if (response.status() !== 303) {
            await route.fulfill({ response });
            return;
          }
          const location = new URL(response.headers().location!);
          if (
            location.origin !== "https://github.com" ||
            location.pathname !== "/apps/teaching-fixture/installations/new"
          )
            throw new Error("Unexpected handoff");
          if (!registeredSetupUrl)
            throw new Error("App has no registered setup URL");
          await route.fulfill({
            contentType: "text/html",
            body: `<a href="${registeredSetupUrl}?state=${location.searchParams.get("state")}&installation_id=7">Approve fixture installation</a>`,
          });
        },
      );
      await context.route(
        "https://github.com/settings/apps/new?**",
        async (route) => {
          const manifest = JSON.parse(
            new URLSearchParams(route.request().postData()!).get("manifest")!,
          );
          if (
            manifest.url !== origin ||
            "hook_attributes" in manifest ||
            manifest.default_permissions.contents !== "read"
          )
            throw new Error("Invalid manifest");
          registeredSetupUrl = manifest.setup_url ?? "";
          const state = new URL(route.request().url()).searchParams.get(
            "state",
          )!;
          await route.fulfill({
            contentType: "text/html",
            body: `<a href="${manifest.redirect_url}?state=${state}&code=${randomBytes(12).toString("hex")}">Approve fixture app</a>`,
          });
        },
      );
      // Browser navigation is synthetic; callback and all backend effects remain real.
      await context.route(
        "https://github.com/apps/teaching-fixture/installations/new?**",
        async (route) => {
          const state = new URL(route.request().url()).searchParams.get(
            "state",
          )!;
          if (!registeredSetupUrl)
            throw new Error("App has no registered setup URL");
          await route.fulfill({
            contentType: "text/html",
            body: `<a href="${registeredSetupUrl}?state=${state}&installation_id=7">Approve fixture installation</a>`,
          });
        },
      );
    },
    async close() {
      await app.close();
      await store.close();
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      );
      await database.close();
    },
  };
}
