import { createServer } from "node:http";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { jwtVerify } from "jose";
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
  };
  const stripeKey = `rk_test_${randomBytes(24).toString("hex")}`;
  const continuationToken = randomBytes(32).toString("hex");
  const workerToken = randomBytes(32).toString("hex");
  const delivered = new Set<string>();
  const consumed = new Set<string>();
  let registeredSetupUrl = "";
  const provider = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://fixture");
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
              capabilities: ["author", "reviewer", "publisher", "executor"],
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
