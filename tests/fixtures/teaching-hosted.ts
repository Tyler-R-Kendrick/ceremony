import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer as createViteServer } from "vite";
import { teachingIdentityFixture } from "./teaching-identity.js";
import { postgresFixture } from "./postgres.js";
import { PostgresCeremonyStore } from "../../src/server/persistence/index.js";
import {
  createOidcIdentity,
  persistentIdentityStore,
} from "../../src/server/oidc-identity.js";
import {
  createTeachingRuntime,
  type TeachingRuntime,
} from "../../src/server/teaching-runtime.js";
import { OperationRegistry } from "../../src/server/recipes/registry.js";
import { hostedHttp } from "../../src/server/hosted/http.js";

/** Same mounted hosted handler for identity and durable-worker browser fixtures. */
export async function mountTeachingHost(
  getRuntime: () => TeachingRuntime,
  worker?: Parameters<typeof hostedHttp>[3],
  port = 0,
  staticRevision?: () => number,
) {
  const vite = await createViteServer({
    server: { middlewareMode: true, hmr: false },
    appType: "spa",
  });
  let origin = "";
  const server = createServer(async (req, res) => {
    if (req.url === "/sw.js" && staticRevision) {
      res.setHeader("content-type", "text/javascript");
      res.setHeader("cache-control", "no-store");
      res.end(
        `${await readFile(new URL("../../examples/web/public/sw.js", import.meta.url), "utf8")}\n// fixture static release ${staticRevision()}\n`,
      );
      return;
    }
    if (!req.url?.startsWith("/api/")) {
      vite.middlewares(req, res, () => {
        res.statusCode = 404;
        res.end();
      });
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value !== undefined)
        headers.set(key, Array.isArray(value) ? value.join(",") : value);
    try {
      const result = await hostedHttp(
        new Request(`${origin}${req.url}`, {
          method: req.method!,
          headers,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        }),
        getRuntime(),
        async () => {},
        worker,
      );
      res.statusCode = result.status;
      result.headers.forEach((value, key) => {
        if (key !== "set-cookie") res.setHeader(key, value);
      });
      const cookies = result.headers.getSetCookie();
      if (cookies.length) res.setHeader("set-cookie", cookies);
      res.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      res.statusCode = 500;
      res.end("{}");
    }
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await vite.close();
    },
  };
}

/** Actual reference UI and hosted routes; only identity-provider behavior is synthetic. */
export async function teachingHostedFixture() {
  const provider = await teachingIdentityFixture();
  const database = await postgresFixture();
  const store = new PostgresCeremonyStore(database.config, {
    current: "fixture",
    keys: { fixture: randomBytes(32) },
  });
  await store.migrate();
  let runtime: TeachingRuntime;
  const app = await mountTeachingHost(() => runtime);
  const { origin } = app;
  const identity = await createOidcIdentity(
    {
      origin,
      issuer: provider.issuer,
      clientId: "client",
      development: true,
      mapClaims: async (claims) => ({
        tenantId: "tenant",
        subjectId: claims.sub,
        capabilities: ["executor", "author", "reviewer", "publisher"],
      }),
    },
    persistentIdentityStore(store),
  );
  runtime = createTeachingRuntime({
    store,
    identity,
    origin,
    registry: new OperationRegistry(),
    authorize: async () => true,
    context: async () => ({
      provider: "github",
      profile: "github-app",
      target: "fixture",
      environment: "local-integration",
      origin,
      configurationVersion: "v1",
    }),
  });
  return {
    origin,
    store,
    provider,
    async close() {
      await app.close();
      await store.close();
      await database.close();
      await provider.close();
    },
  };
}
