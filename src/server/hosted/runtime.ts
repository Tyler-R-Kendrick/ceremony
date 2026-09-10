import { z } from "zod";
import { PostgresCeremonyStore } from "../persistence/index.js";
import {
  createOidcIdentity,
  persistentIdentityStore,
} from "../oidc-identity.js";
import { createGitHubRuntime } from "../github-runtime.js";
import type { TeachingRuntime } from "../teaching-runtime.js";
import { hostedContinuation } from "./continuations.js";
import { AsyncCeremonyEnvironment } from "../async-environment.js";
import { configuredKeyring } from "../persistence/maintenance.js";

let instance: Promise<TeachingRuntime> | undefined;
/** Process cache holds clients only. Shared database and current policy remain authoritative. */
export function getHostedRuntime(): Promise<TeachingRuntime> {
  return (instance ??= createHostedRuntime().catch(() => {
    instance = undefined;
    throw new Error("Hosted configuration unavailable");
  }));
}
export async function createHostedRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TeachingRuntime> {
  if (env.CEREMONY_TEST_PROFILE === "true" && env.NODE_ENV !== "test")
    throw new Error("Test hosting requires the test runtime");
  const testProfile =
    env.NODE_ENV === "test" && env.CEREMONY_TEST_PROFILE === "true";
  const config = z
    .strictObject({
      origin: z.url(),
      database: z.string().min(1),
      key: z.string().regex(/^[a-fA-F0-9]{64}$/),
      keyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      issuer: z.url(),
      clientId: z.string().min(1),
      tenant: z.string().min(1).max(100),
      account: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
      configurationVersion: z.string().min(1).max(100),
    })
    .safeParse({
      origin: env.CEREMONY_PUBLIC_ORIGIN,
      database: env.CEREMONY_DATABASE_URL,
      key: env.CEREMONY_VAULT_KEY,
      keyId: env.CEREMONY_VAULT_KEY_ID,
      issuer: env.CEREMONY_OIDC_ISSUER,
      clientId: env.CEREMONY_OIDC_CLIENT_ID,
      tenant: env.CEREMONY_TENANT_ID,
      account: env.CEREMONY_GITHUB_ACCOUNT,
      configurationVersion: env.CEREMONY_CONFIGURATION_VERSION,
    });
  if (!config.success)
    throw new Error("Missing or invalid hosted configuration");
  const c = config.data;
  const continuation = hostedContinuation(env);
  if (
    new URL(c.origin).origin !== c.origin ||
    (!c.origin.startsWith("https://") &&
      !(
        testProfile &&
        new URL(c.origin).protocol === "http:" &&
        new URL(c.origin).hostname === "127.0.0.1"
      ))
  )
    throw new Error("Exact production HTTPS origin is required");
  let database: URL;
  try {
    database = new URL(c.database);
  } catch {
    throw new Error("Invalid hosted database configuration");
  }
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    (!testProfile &&
      (database.searchParams.getAll("sslmode").length !== 1 ||
        database.searchParams.get("sslmode") !== "verify-full"))
  )
    throw new Error("Production PostgreSQL requires verified TLS");
  const store = new PostgresCeremonyStore(
    { connectionString: c.database },
    configuredKeyring(env),
  );
  const environment = new AsyncCeremonyEnvironment(store);
  try {
    await store.migrate();
    const identity = await createOidcIdentity(
      {
        origin: c.origin,
        issuer: c.issuer,
        clientId: c.clientId,
        ...(testProfile ? { development: true } : {}),
        ...(env.CEREMONY_OIDC_CLIENT_SECRET
          ? { clientSecret: env.CEREMONY_OIDC_CLIENT_SECRET }
          : {}),
        mapClaims: async (claims) => {
          const roles = z
            .array(
              z.enum(["author", "reviewer", "publisher", "executor", "admin"]),
            )
            .max(5)
            .parse(claims.ceremony_roles ?? ["executor"]);
          return {
            tenantId: c.tenant,
            subjectId: claims.sub,
            capabilities: roles,
          };
        },
      },
      persistentIdentityStore(store),
    );
    return createGitHubRuntime({
      store,
      identity,
      origin: c.origin,
      environment: "production",
      configurationVersion: c.configurationVersion,
      stripe: {
        configuration: (actor) =>
          environment.resolveStripe(actor, c.configurationVersion),
      },
      configuration: (actor) =>
        environment.resolveGitHub(actor, c.configurationVersion),
      expectedAccount: c.account,
      ...(continuation ? { continuation } : {}),
      modelConfiguration: {
        ...(env.CEREMONY_MODEL ? { model: env.CEREMONY_MODEL } : {}),
        ...(env.CEREMONY_MODEL_URL ? { endpoint: env.CEREMONY_MODEL_URL } : {}),
        ...(env.CEREMONY_MODEL_KEY ? { apiKey: env.CEREMONY_MODEL_KEY } : {}),
        ...(env.CEREMONY_MODEL_GATEWAY === "true" ? { gateway: true } : {}),
      },
      authorize: async (actor, run, operationId) =>
        actor.tenantId === c.tenant &&
        actor.subjectId === run.subjectId &&
        actor.capabilities.includes("executor") &&
        (operationId === "continuation" ||
          run.configurationVersion ===
            (run.provider === "stripe"
              ? (await environment.resolveStripe(actor, c.configurationVersion))
                  .version
              : (await environment.resolveGitHub(actor, c.configurationVersion))
                  .configurationVersion)) &&
        run.origin === c.origin &&
        (run.provider === "stripe"
          ? run.target === "self"
          : run.provider === "github" && run.target === c.account),
    });
  } catch {
    await store.close();
    throw new Error("Hosted identity initialization failed");
  }
}
