import { createServer, type Server } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { createServer as createViteServer } from "vite";
import {
  CeremonyController,
  CeremonyError,
  MemoryCredentialStore,
  createProtocolAdapter,
  createNeonAdapter,
  CeremonyDatabase,
  CeremonyEnvironment,
  PrivateCredentialBroker,
  GitHubAppCeremonies,
  githubAppManifest,
  githubWorkflows,
  serviceRegistrations,
  type GitHubOptions,
  CloudflareHumanBrowser,
  Agent2Human,
  type A2HOptions,
} from "../src/server/index.js";
import { flowKindSchema, entryContextSchema } from "../src/core/index.js";
import { authoringPrompt, validateTemplate } from "../src/react/templates.js";
import { manifests } from "./manifests.js";
import { createReferenceProvider } from "./provider.js";
import { json, readBody, escapeHtml } from "./http.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import { createGitHubRuntime } from "../src/server/github-runtime.js";
import { teachingHttp } from "../src/server/teaching-http.js";
import type { TeachingRuntime } from "../src/server/teaching-runtime.js";

export interface ReferenceOptions {
  teaching?: TeachingRuntime | true;
  port?: number;
  providerPort?: number;
  modelUrl?: string;
  modelName?: string;
  modelKey?: string;
  publicOrigin?: string;
  live?: {
    databasePath: string;
    vaultKey: Uint8Array;
    github?: Omit<GitHubOptions, "origin">;
    services?: Parameters<typeof serviceRegistrations>[2];
    cloudflare?: { accountId: string; apiToken: string };
    a2h?: A2HOptions;
  };
}
export async function startReferenceApp(options: ReferenceOptions = {}) {
  if (process.env.NODE_ENV === "production")
    throw new Error("Use the authenticated hosted entry point in production");
  const port = options.port ?? 4173;
  const providerPort = options.providerPort ?? 4174;
  const origin = options.publicOrigin ?? `http://127.0.0.1:${port}`;
  const issuer = `http://127.0.0.1:${providerPort}`;
  const provider = await createReferenceProvider({ issuer, appOrigin: origin });
  const credentials = new MemoryCredentialStore();
  const demoDatabase = new CeremonyDatabase(":memory:", randomBytes(32));
  const broker = new PrivateCredentialBroker(demoDatabase);
  const liveDatabase = options.live
    ? new CeremonyDatabase(options.live.databasePath, options.live.vaultKey)
    : undefined;
  const humanBrowser =
    liveDatabase && options.live?.cloudflare
      ? new CloudflareHumanBrowser(liveDatabase, {
          origin,
          ...options.live.cloudflare,
        })
      : undefined;
  const environment = new CeremonyEnvironment(liveDatabase ?? demoDatabase);
  const a2h =
    liveDatabase && options.live?.a2h
      ? new Agent2Human(liveDatabase, options.live.a2h)
      : undefined;
  const github = liveDatabase
    ? new GitHubAppCeremonies(liveDatabase, {
        origin,
        ...options.live?.github,
        resolveApp: (owner) => {
          const values = environment.read(owner);
          const names = [
            "GITHUB_APP_ID",
            "GITHUB_APP_SLUG",
            "GITHUB_APP_OWNER",
            "GITHUB_APP_PRIVATE_KEY",
          ];
          if (!names.some((name) => values[name] !== undefined))
            return options.live?.github?.resolveApp?.(owner);
          if (!names.every((name) => values[name]?.trim()))
            throw new CeremonyError(
              "Complete all four GitHub App variables in Environment, or remove them to use guided registration.",
              409,
            );
          const id = z.coerce
            .number()
            .int()
            .positive()
            .safeParse(values.GITHUB_APP_ID);
          if (!id.success || !/^[a-zA-Z0-9-]+$/.test(values.GITHUB_APP_SLUG!))
            throw new CeremonyError(
              "Check the GitHub App ID and slug in Environment.",
              400,
            );
          const pem = values
            .GITHUB_APP_PRIVATE_KEY!.replace(
              /(-----BEGIN (?:RSA )?PRIVATE KEY-----)\s*/,
              "$1\n",
            )
            .replace(/\s*(-----END (?:RSA )?PRIVATE KEY-----)/, "\n$1");
          return {
            id: id.data,
            slug: values.GITHUB_APP_SLUG!,
            owner: { login: values.GITHUB_APP_OWNER! },
            pem,
          };
        },
        ...(humanBrowser
          ? { cancelHuman: (id: string) => humanBrowser.cancel(id) }
          : {}),
        ...(humanBrowser || a2h
          ? {
              requestHuman: async ({
                owner,
                instanceId,
                url,
              }: {
                owner: string;
                instanceId: string;
                url: string;
              }) => {
                const useRemote = humanBrowser && url.endsWith("/human");
                if (!useRemote && !a2h)
                  throw new CeremonyError(
                    "Use the private collector in your own browser",
                    409,
                  );
                if (useRemote) {
                  const token = randomUUID();
                  liveDatabase.put(`human:${token}`, {
                    owner,
                    id: instanceId,
                    expiresAt: Date.now() + 600_000,
                  });
                  await humanBrowser.request(owner, instanceId, token);
                }
                if (a2h)
                  await a2h.authorize(
                    owner,
                    instanceId,
                    useRemote
                      ? `${origin}/api/live/github/${instanceId}/remote`
                      : url,
                  );
              },
            }
          : {}),
      })
    : undefined;
  const liveController =
    liveDatabase && github
      ? new CeremonyController(
          [
            {
              manifest: githubAppManifest,
              recoverable: true,
              createAdapter: (context) => github.createAdapter(context),
              resume: (owner) => github.resume(owner),
            },
            ...serviceRegistrations(
              liveDatabase,
              environment,
              options.live?.services,
            ),
          ],
          new Map(),
          Date.now,
          {
            database: liveDatabase,
            broker: new PrivateCredentialBroker(liveDatabase),
          },
        )
      : undefined;
  const controller = new CeremonyController(
    manifests.map((manifest) => ({
      manifest,
      createAdapter: ({ instanceId, method }) =>
        manifest.id === "neon"
          ? createNeonAdapter(credentials, {
              issuer,
              claimOrigins: [issuer],
              allowLoopbackHttp: true,
            })
          : createProtocolAdapter(
              method,
              {
                issuer,
                clientId: "ceremony-local",
                authorizationEndpoint: `${issuer}/authorize`,
                tokenEndpoint: `${issuer}/oauth2/token`,
                deviceEndpoint: `${issuer}/device`,
                resource: `${issuer}/resource`,
                callbackUrl: `${origin}/api/callback/${instanceId}`,
                credentialEndpoint: `${issuer}/credentials`,
                identityEndpoint: `${issuer}/agent/identity`,
                claimEndpoint: `${issuer}/agent/identity/claim`,
                allowLoopbackHttp: true,
              },
              credentials,
            ),
    })),
    new Map(),
    Date.now,
    { broker },
  );
  const sessions = new Map<
    string,
    { expires: number; lastGeneration: number; generating: boolean }
  >();
  const teachingStore =
    options.teaching === true
      ? new SQLiteCeremonyStore(
          options.live ? `${options.live.databasePath}.teaching` : ":memory:",
          {
            current: "development",
            keys: { development: options.live?.vaultKey ?? randomBytes(32) },
          },
        )
      : undefined;
  const teaching =
    options.teaching === true
      ? createGitHubRuntime({
          store: teachingStore!,
          origin,
          environment: "development",
          configurationVersion: "v1",
          identity: {
            authenticate: async (request) => {
              const owner =
                /(?:^|;\s*)ceremony-session=([a-f0-9-]{36})(?:;|$)/.exec(
                  request.headers.get("cookie") ?? "",
                )?.[1];
              if (!owner || !sessions.has(owner)) return null;
              return {
                tenantId: "development",
                subjectId: owner,
                sessionId: owner,
                actorKind: "human",
                capabilities: ["executor", "author", "reviewer", "publisher"],
              };
            },
          },
          allowTarget: async () => true,
          authorize: async (actor, run) =>
            actor.tenantId === "development" &&
            actor.subjectId === run.subjectId &&
            sessions.has(actor.sessionId),
          configuration: async (actor) =>
            environment.githubConfiguration(
              actor.subjectId,
              actor.sessionId,
              "v1",
            ),
          modelConfiguration: {
            ...(options.modelUrl ? { endpoint: options.modelUrl } : {}),
            ...(options.modelName ? { model: options.modelName } : {}),
            ...(options.modelKey ? { apiKey: options.modelKey } : {}),
          },
        })
      : options.teaching;
  const server = createServer(async (request, response) => {
    try {
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("x-frame-options", "DENY");
      if (request.headers.host !== new URL(origin).host)
        throw new CeremonyError("Unrecognized host", 403);
      const url = new URL(request.url ?? "/", origin);
      if (!url.pathname.startsWith("/api/")) {
        vite.middlewares(request, response, () =>
          json(response, { error: "Not found" }, 404),
        );
        return;
      }
      for (const [key, session] of sessions)
        if (session.expires < Date.now()) sessions.delete(key);
      let owner = /(?:^|;\s*)ceremony-session=([a-f0-9-]{36})(?:;|$)/.exec(
        request.headers.cookie ?? "",
      )?.[1];
      if (!owner || !sessions.has(owner)) {
        const persisted =
          owner &&
          liveDatabase?.get(
            `session:${owner}`,
            z.object({
              expires: z.number(),
              lastGeneration: z.number(),
              generating: z.boolean(),
            }),
          );
        if (owner && persisted && persisted.expires > Date.now())
          sessions.set(owner, { ...persisted, generating: false });
      }
      if (!owner || !sessions.has(owner)) {
        owner = randomUUID();
        sessions.set(owner, {
          expires: Date.now() + 3_600_000,
          lastGeneration: 0,
          generating: false,
        });
        liveDatabase?.put(`session:${owner}`, sessions.get(owner));
        response.setHeader(
          "set-cookie",
          `ceremony-session=${owner}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600${origin.startsWith("https:") ? "; Secure" : ""}`,
        );
      }
      const session = sessions.get(owner)!;
      if (url.pathname.startsWith("/api/v1/teaching")) {
        if (!teaching) return json(response, { error: "unavailable" }, 503);
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers))
          if (typeof value === "string") headers.set(name, value);
        // The development-only anonymous session is derived server-side, never from request JSON.
        if (options.teaching === true)
          headers.set("cookie", `ceremony-session=${owner}`);
        const incoming = new Request(url, {
          method: request.method ?? "GET",
          headers,
          ...(request.method === "POST"
            ? { body: await readBody(request) }
            : {}),
        });
        const result = await teachingHttp(incoming, teaching);
        response.statusCode = result.status;
        result.headers.forEach((value, name) =>
          response.setHeader(name, value),
        );
        if (result.body) {
          const reader = result.body.getReader();
          await pipeline(
            Readable.from(
              (async function* () {
                try {
                  for (;;) {
                    const chunk = await reader.read();
                    if (chunk.done) return;
                    yield chunk.value;
                  }
                } finally {
                  await reader.cancel();
                }
              })(),
            ),
            response,
          );
        } else response.end();
        return;
      }
      const a2hCallback = /^\/api\/live\/a2h\/([a-f0-9-]{36})$/.exec(
        url.pathname,
      );
      if (
        request.method === "POST" &&
        a2hCallback?.[1] &&
        a2h &&
        liveController
      ) {
        const result = await a2h.receive(
          a2hCallback[1],
          JSON.parse(await readBody(request)),
        );
        // A signed decision never substitutes for provider evidence. Denial fences the run.
        if (result === "deny") {
          const record = liveDatabase!.get(
            `instance:${a2hCallback[1]}`,
            z.object({ owner: z.string() }),
          );
          if (record) {
            const snapshot = await liveController.read(
              record.owner,
              a2hCallback[1],
            );
            if (snapshot.actions.includes("cancel"))
              await liveController.act(record.owner, snapshot.id, {
                action: "cancel",
                revision: snapshot.revision,
              });
          }
        }
        return json(response, {
          accepted: true,
          status:
            result === "verify" ? "awaiting-provider-verification" : "denied",
        });
      }
      if (
        request.method === "POST" &&
        (request.headers.origin !== origin ||
          !request.headers["content-type"]?.startsWith("application/json"))
      )
        throw new CeremonyError("Invalid request origin or content type", 403);
      if (request.method === "GET" && url.pathname === "/api/config")
        return json(response, {
          manifests: controller.manifests(),
          liveManifests: liveController?.manifests() ?? [githubAppManifest],
          liveAvailable: Boolean(liveController),
          teachingAvailable: Boolean(teaching),
          generationAvailable: Boolean(options.modelUrl && options.modelName),
        });
      if (request.method === "GET" && url.pathname === "/api/workflows/github")
        return json(response, githubWorkflows);
      const environmentRoute = /^\/api\/environment(?:\/([a-z0-9-]+))?$/.exec(
        url.pathname,
      );
      if (environmentRoute) {
        const connector = environmentRoute[1]!;
        if (connector && !manifests.some((item) => item.id === connector))
          throw new CeremonyError("Unknown connector", 404);
        if (request.method === "GET")
          return json(response, environment.describe(owner));
        if (request.method === "POST") {
          let input: unknown;
          try {
            input = JSON.parse(await readBody(request));
          } catch {
            throw new CeremonyError("Invalid environment upload", 400);
          }
          return json(response, environment.update(owner, input));
        }
        throw new CeremonyError("Method not allowed", 405);
      }
      const githubRoute =
        /^\/api\/live\/github\/([a-f0-9-]{36})\/(human|callback|remote)$/.exec(
          url.pathname,
        );
      if (
        githubRoute?.[1] &&
        github &&
        liveController &&
        request.method === "GET"
      ) {
        const id = githubRoute[1];
        if (githubRoute[2] === "callback") {
          const callbackOwner = github.callbackOwner(
            id,
            url.searchParams.get("state") ?? "",
          );
          const snapshot = await liveController.callback(
            callbackOwner,
            id,
            url,
          );
          if (snapshot.step === "redirect") {
            // A narrowly scoped continuation works across remote browsers/devices without granting the owner's app session.
            const token = randomUUID();
            liveDatabase!.put(`human:${token}`, {
              owner: callbackOwner,
              id,
              expiresAt: Date.now() + 600_000,
            });
            response.setHeader(
              "set-cookie",
              `ceremony-human=${token}; HttpOnly; SameSite=Lax; Path=/api/live/github/${id}; Max-Age=600${origin.startsWith("https:") ? "; Secure" : ""}`,
            );
            response.writeHead(303, {
              location: `/api/live/github/${id}/human`,
              "cache-control": "no-store",
            });
          } else if (callbackOwner === owner) {
            response.writeHead(303, {
              location: `/?mode=live&connector=github&ceremony=${id}`,
              "cache-control": "no-store",
            });
          } else {
            response.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "content-security-policy":
                "default-src 'none'; frame-ancestors 'none'",
            });
            response.end(
              `<h1>${snapshot.step === "complete" ? "GitHub access verified" : "GitHub access was not verified"}</h1><p>Return to the original ceremony for its status.</p>`,
            );
            return;
          }
          response.end();
          return;
        }
        let humanOwner = owner;
        const token = /(?:^|;\s*)ceremony-human=([a-f0-9-]{36})(?:;|$)/.exec(
          request.headers.cookie ?? "",
        )?.[1];
        const handoffSession =
          token &&
          liveDatabase!.get(
            `human:${token}`,
            z.object({
              owner: z.string(),
              id: z.string(),
              expiresAt: z.number(),
            }),
          );
        if (
          handoffSession &&
          handoffSession.id === id &&
          handoffSession.expiresAt > Date.now()
        )
          humanOwner = handoffSession.owner;
        if (githubRoute[2] === "remote") {
          if (!humanBrowser)
            throw new CeremonyError("Remote browser unavailable", 503);
          response.writeHead(303, {
            location: humanBrowser.humanUrl(humanOwner, id),
            "cache-control": "no-store",
          });
          response.end();
          return;
        }
        const destination = github.destination(humanOwner, id);
        if (destination.kind === "installation") {
          response.writeHead(303, {
            location: destination.url,
            "cache-control": "no-store",
          });
          response.end();
          return;
        }
        const scriptNonce = randomUUID();
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": `default-src 'none'; script-src 'nonce-${scriptNonce}'; form-action https://github.com; frame-ancestors 'none'; base-uri 'none'`,
        });
        response.end(
          `<!doctype html><html lang="en"><meta charset="utf-8"><title>Continuing to GitHub</title><main><p role="status">Continuing to GitHub for app registration…</p><form method="post" action="${escapeHtml(destination.url)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(destination.manifest))}"><noscript><button>Continue to GitHub</button></noscript></form></main><script nonce="${scriptNonce}">document.querySelector('form').submit()</script></html>`,
        );
        return;
      }
      if (url.pathname.startsWith("/api/live/ceremonies")) {
        if (!liveController)
          throw new CeremonyError(
            "Live mode needs a persistent vault and callback configuration. Configure CEREMONY_DATABASE and CEREMONY_VAULT_KEY outside chat.",
            503,
          );
        if (
          request.method === "POST" &&
          url.pathname === "/api/live/ceremonies"
        ) {
          const input = z
            .object({
              connectorId: z.string(),
              methodId: z.string().optional(),
              context: entryContextSchema.optional(),
            })
            .strict()
            .parse(JSON.parse(await readBody(request)));
          return json(
            response,
            input.methodId
              ? liveController.start(owner, input.connectorId, input.methodId)
              : liveController.connect(owner, input.connectorId, input.context),
          );
        }
        const match =
          /^\/api\/live\/ceremonies\/([a-f0-9-]{36})(\/actions|\/collect)?$/.exec(
            url.pathname,
          );
        if (match?.[1]) {
          if (request.method === "GET" && !match[2])
            return json(response, await liveController.read(owner, match[1]));
          if (request.method === "POST" && match[2] === "/actions")
            return json(
              response,
              await liveController.act(
                owner,
                match[1],
                JSON.parse(await readBody(request)),
              ),
            );
          if (request.method === "POST" && match[2] === "/collect") {
            const input = z
              .object({
                revision: z.number(),
                values: z.record(z.string(), z.string().max(4096)),
              })
              .strict()
              .parse(JSON.parse(await readBody(request)));
            return json(response, {
              secretRef: liveController.collect(
                owner,
                match[1],
                input.revision,
                input.values,
              ),
            });
          }
        }
      }
      if (request.method === "POST" && url.pathname === "/api/ceremonies") {
        const input = z
          .object({
            connectorId: z.string(),
            methodId: z.string().optional(),
            context: entryContextSchema.optional(),
          })
          .strict()
          .parse(JSON.parse(await readBody(request)));
        return json(
          response,
          input.methodId
            ? controller.start(owner, input.connectorId, input.methodId)
            : controller.connect(owner, input.connectorId, input.context),
        );
      }
      const privateCollector =
        /^\/api\/(live\/)?ceremonies\/([a-f0-9-]{36})\/collector$/.exec(
          url.pathname,
        );
      if (request.method === "GET" && privateCollector?.[2]) {
        const runtime = privateCollector[1] ? liveController : controller;
        if (!runtime)
          throw new CeremonyError("Live private collection unavailable", 503);
        const snapshot = await runtime.read(owner, privateCollector[2]);
        if (!snapshot.fields.length || !snapshot.actions.includes("submit"))
          throw new CeremonyError("No private input is pending", 409);
        const base = `/api/${privateCollector[1] ?? ""}ceremonies/${snapshot.id}`;
        const nonce = randomBytes(24).toString("base64");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
        });
        response.end(
          `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Private credential entry</title><style>body{font:1rem system-ui;color:#17212d;background:#f4f6f8;max-width:32rem;margin:8vh auto;padding:24px}label{display:block;margin:20px 0}input{display:block;box-sizing:border-box;width:100%;font:inherit;padding:12px;margin-top:8px}button{padding:12px 18px;background:#1749c7;color:white;border:0;border-radius:6px;font:inherit}p{line-height:1.6}</style><main><h1>Private credential entry</h1><p>${privateCollector[1] ? "Values go directly to the credential broker, not through assistant tools." : "Local simulation: enter test credentials only."}</p><form>${snapshot.fields.map((field) => `<label>${escapeHtml(field.label)}<input name="${escapeHtml(field.name)}" type="${field.type}" maxlength="4096" autocomplete="off" ${field.required ? "required" : ""}></label>`).join("")}<button>Submit privately</button></form><p role="status"></p></main><script nonce="${nonce}">const form=document.querySelector('form'),status=document.querySelector('[role=status]');form.addEventListener('submit',async event=>{event.preventDefault();form.querySelector('button').disabled=true;try{const pending=fetch(${JSON.stringify(base + "/collect")},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:${snapshot.revision},values:Object.fromEntries(new FormData(form))})});form.reset();const collected=await pending;if(!collected.ok)throw Error();const {secretRef}=await collected.json();const submitted=await fetch(${JSON.stringify(base + "/actions")},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'submit',revision:${snapshot.revision},secretRef})});if(!submitted.ok)throw Error();const result=await submitted.json();status.textContent=result.step==='error'?'Verification failed. Return to the ceremony to retry.':'Private input submitted. Return to the ceremony for its status.';}catch{status.textContent='Private collection failed. Return to the ceremony and request a new collector.';}form.remove();});</script></html>`,
        );
        return;
      }
      const ceremony =
        /^\/api\/ceremonies\/([a-f0-9-]{36})(\/actions|\/collect)?$/.exec(
          url.pathname,
        );
      if (ceremony?.[1]) {
        if (request.method === "GET" && !ceremony[2])
          return json(response, await controller.read(owner, ceremony[1]));
        if (request.method === "POST" && ceremony[2] === "/collect") {
          const input = z
            .object({
              revision: z.number(),
              values: z.record(z.string(), z.string().max(4096)),
            })
            .strict()
            .parse(JSON.parse(await readBody(request)));
          return json(response, {
            secretRef: controller.collect(
              owner,
              ceremony[1],
              input.revision,
              input.values,
            ),
          });
        }
        if (request.method === "POST" && ceremony[2] === "/actions")
          return json(
            response,
            await controller.act(
              owner,
              ceremony[1],
              JSON.parse(await readBody(request)),
            ),
          );
      }
      const callback = /^\/api\/callback\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (request.method === "GET" && callback?.[1]) {
        const snapshot = await controller.callback(owner, callback[1], url);
        response.writeHead(303, {
          location: `/?mode=test&connector=${encodeURIComponent(snapshot.connectorId)}&ceremony=${snapshot.id}`,
          "cache-control": "no-store",
        });
        return response.end();
      }
      if (request.method === "POST" && url.pathname === "/api/generate") {
        if (!options.modelUrl || !options.modelName)
          throw new CeremonyError(
            "Configure CEREMONY_MODEL_URL and CEREMONY_MODEL before generating.",
            503,
          );
        if (session.generating || Date.now() - session.lastGeneration < 5000)
          throw new CeremonyError(
            "Wait before generating another template.",
            429,
          );
        const input = z
          .object({
            kind: flowKindSchema,
            connectorId: z.string(),
            instruction: z.string().max(2000).default(""),
          })
          .strict()
          .parse(JSON.parse(await readBody(request)));
        const manifest = manifests.find(
          (value) => value.id === input.connectorId,
        );
        if (!manifest) throw new CeremonyError("Unknown connector");
        session.generating = true;
        session.lastGeneration = Date.now();
        try {
          const endpoint = new URL(options.modelUrl);
          if (
            endpoint.protocol !== "https:" &&
            !(
              endpoint.protocol === "http:" &&
              ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
            )
          )
            throw new CeremonyError(
              "Model endpoint must use HTTPS or loopback HTTP.",
            );
          const result = await fetch(endpoint, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(60_000),
            headers: {
              "content-type": "application/json",
              ...(options.modelKey
                ? { authorization: `Bearer ${options.modelKey}` }
                : {}),
            },
            body: JSON.stringify({
              model: options.modelName,
              temperature: 0,
              messages: [
                { role: "system", content: authoringPrompt() },
                {
                  role: "user",
                  content: JSON.stringify({
                    kind: input.kind,
                    id: input.kind,
                    connector: {
                      name: manifest.name,
                      description: manifest.description,
                    },
                    presentation: input.instruction,
                  }),
                },
              ],
            }),
          });
          if (!result.ok)
            throw new CeremonyError(
              "The model endpoint rejected generation.",
              502,
            );
          const output = z
            .object({
              choices: z
                .array(
                  z.object({
                    message: z.object({ content: z.string().max(220_000) }),
                  }),
                )
                .min(1),
            })
            .parse(await result.json());
          let candidate: unknown;
          try {
            candidate = JSON.parse(
              output.choices[0]!.message.content.replace(
                /^```(?:json)?\s*|\s*```$/g,
                "",
              ),
            );
          } catch {
            throw new CeremonyError(
              "The model did not return a JSON template. Try again.",
              422,
            );
          }
          const checked = validateTemplate(candidate);
          if (
            !checked.template ||
            checked.template.kind !== input.kind ||
            checked.template.id !== input.kind
          )
            throw new CeremonyError(
              `Generated template was rejected: ${checked.errors.join("; ") || "flow or template ID mismatch"}`,
              422,
            );
          return json(response, checked.template);
        } finally {
          session.generating = false;
        }
      }
      json(response, { error: "Not found" }, 404);
    } catch (error) {
      if (!response.headersSent)
        json(
          response,
          {
            error:
              error instanceof CeremonyError
                ? error.message
                : "Invalid request or unavailable service",
          },
          error instanceof CeremonyError ? error.status : 400,
        );
      else response.end();
    }
  });
  const vite = await createViteServer({
    server: {
      middlewareMode: true,
      hmr: { server, clientPort: port, host: "127.0.0.1" },
      fs: {
        deny: [
          ".env",
          ".env.*",
          "**/.git/**",
          "**/.ceremony/**",
          "**/*.{crt,pem,key,sqlite,sqlite3,db}",
          "**/*.secret.json",
          ...(options.live ? [resolve(options.live.databasePath)] : []),
        ],
      },
    },
    appType: "spa",
  });
  const listen = (instance: Server, listenPort: number) =>
    new Promise<void>((done, reject) => {
      instance.once("error", reject);
      instance.listen(listenPort, "127.0.0.1", done);
    });
  await listen(provider, providerPort);
  try {
    await listen(server, port);
  } catch (error) {
    provider.close();
    await vite.close();
    throw error;
  }
  return {
    origin,
    issuer,
    controller,
    credentials,
    async close() {
      await humanBrowser?.close();
      await vite.close();
      await Promise.all(
        [server, provider].map(
          (instance) =>
            new Promise<void>((done, reject) => {
              instance.closeAllConnections();
              instance.close((error) => (error ? reject(error) : done()));
            }),
        ),
      );
      demoDatabase.close();
      liveDatabase?.close();
      await teachingStore?.close();
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const number = z.coerce.number().int().min(1024).max(65535);
  // Local development provisions a private vault automatically; production supplies its own key and path.
  let live: ReferenceOptions["live"];
  if (process.env.CEREMONY_DATABASE || process.env.CEREMONY_VAULT_KEY) {
    live = {
      databasePath: z.string().min(1).parse(process.env.CEREMONY_DATABASE),
      vaultKey: Buffer.from(
        z
          .string()
          .regex(/^[a-fA-F0-9]{64}$/)
          .parse(process.env.CEREMONY_VAULT_KEY),
        "hex",
      ),
    };
  } else {
    mkdirSync(".ceremony", { recursive: true, mode: 0o700 });
    try {
      writeFileSync(".ceremony/vault.key", randomBytes(32), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
    }
    live = {
      databasePath: ".ceremony/state.sqlite",
      vaultKey: readFileSync(".ceremony/vault.key"),
    };
  }
  if (process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_API_TOKEN)
    live.cloudflare = {
      accountId: z.string().min(1).parse(process.env.CLOUDFLARE_ACCOUNT_ID),
      apiToken: z.string().min(1).parse(process.env.CLOUDFLARE_API_TOKEN),
    };
  const app = await startReferenceApp({
    teaching: true,
    port: number.parse(process.env.CEREMONY_PORT ?? 4173),
    providerPort: number.parse(process.env.CEREMONY_PROVIDER_PORT ?? 4174),
    live,
    ...(process.env.CEREMONY_ORIGIN
      ? { publicOrigin: process.env.CEREMONY_ORIGIN }
      : {}),
    ...(process.env.CEREMONY_MODEL_URL
      ? { modelUrl: process.env.CEREMONY_MODEL_URL }
      : {}),
    ...(process.env.CEREMONY_MODEL
      ? { modelName: process.env.CEREMONY_MODEL }
      : {}),
    ...(process.env.CEREMONY_MODEL_KEY
      ? { modelKey: process.env.CEREMONY_MODEL_KEY }
      : {}),
  });
  console.log(`Ceremony: ${app.origin}\nLocal test provider: ${app.issuer}`);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void app.close().finally(() => process.exit(0));
    });
}
