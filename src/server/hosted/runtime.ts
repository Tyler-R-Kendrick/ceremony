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
import type { ActorContext } from "../identity.js";
import { actorIdentifierSchema } from "../../core/operation-contracts.js";
import type { RunRecord } from "../commands.js";
import { hostedJiraOwnerDelivery } from "./a2h.js";
import { modelConfigurationFromEnvironment } from "../agent/model.js";
import { hostedTenancy, type HostedTenancy } from "./tenancy.js";
import { createHostedConnectors, type HostedConnectors } from "./connectors.js";

/** The teaching runtime plus what only the hosted carrier composes around it. */
export type HostedRuntime = TeachingRuntime & {
  hosted: {
    tenancy: HostedTenancy;
    /** Absent when the operator disabled connectors. */
    connectors?: HostedConnectors;
  };
};

let instance: Promise<HostedRuntime> | undefined;
/** Process cache holds clients only. Shared database and current policy remain authoritative. */
export function getHostedRuntime(): Promise<HostedRuntime> {
  return (instance ??= createHostedRuntime().catch(() => {
    instance = undefined;
    throw new Error("Hosted configuration unavailable");
  }));
}

/**
 * Host policy for one run, after the provider registry has checked that the
 * run still matches its provider's current configuration.
 *
 * The run must belong to this actor, in a tenant this deployment serves, on
 * this origin, and its target must be one the host allows for its provider.
 * The target rules are data keyed by provider rather than a chain of name
 * comparisons: a provider absent here has no admissible target and is
 * refused. An authored run's target is its own connector id, which is what
 * `context` records for it; anything else is a tampered record.
 */
export function hostedRunPolicy(policy: {
  origin: string;
  tenancy: Pick<HostedTenancy, "accepts">;
  /** GitHub's authorized account; GitHub runs are refused without one. */
  account?: string;
}) {
  const targets: Readonly<Record<string, (run: RunRecord) => boolean>> = {
    stripe: (run) => run.target === "self",
    supabase: (run) => run.target === "self",
    // A chosen site is checked by the provider entry against the host's
    // allowTarget; a configured one against the configuration itself.
    jira: () => true,
    ...(policy.account
      ? { github: (run: RunRecord) => run.target === policy.account }
      : {}),
  };
  return (actor: ActorContext, run: RunRecord): boolean =>
    // Runs are stored under the actor's tenant, so a run from another tenant
    // is never found; this refuses an actor from a tenant not served at all.
    policy.tenancy.accepts(actor.tenantId) &&
    actor.subjectId === run.subjectId &&
    actor.capabilities.includes("executor") &&
    run.origin === policy.origin &&
    (run.profile === "authored"
      ? run.target === run.provider
      : Object.hasOwn(targets, run.provider) && targets[run.provider]!(run));
}

export async function createHostedRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HostedRuntime> {
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
      clientId: z.string().min(1).optional(),
      account: z
        .string()
        .regex(/^[A-Za-z0-9-]{1,100}$/)
        .optional(),
      configurationVersion: z.string().min(1).max(100),
      jiraSetupOwner: actorIdentifierSchema.optional(),
    })
    .safeParse({
      origin: env.CEREMONY_PUBLIC_ORIGIN,
      database: env.CEREMONY_DATABASE_URL,
      key: env.CEREMONY_VAULT_KEY,
      keyId: env.CEREMONY_VAULT_KEY_ID,
      issuer: env.CEREMONY_OIDC_ISSUER,
      clientId: env.CEREMONY_OIDC_CLIENT_ID,
      ...(env.CEREMONY_GITHUB_ACCOUNT
        ? { account: env.CEREMONY_GITHUB_ACCOUNT }
        : {}),
      configurationVersion: env.CEREMONY_CONFIGURATION_VERSION,
      ...(env.CEREMONY_JIRA_SETUP_OWNER_SUBJECT
        ? { jiraSetupOwner: env.CEREMONY_JIRA_SETUP_OWNER_SUBJECT }
        : {}),
    });
  let tenancy: HostedTenancy;
  try {
    tenancy = hostedTenancy(env);
  } catch {
    throw new Error("Missing or invalid hosted configuration");
  }
  if (!config.success)
    throw new Error("Missing or invalid hosted configuration");
  const c = config.data;
  // Tenant-wide operator settings name one tenant; with claim tenancy they
  // apply only to the configured home tenant, and without one they are off.
  const home = tenancy.home;
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
  const jiraConfiguration = async (actor: ActorContext) => {
    const session = await environment.resolveJira(
      actor,
      c.configurationVersion,
    );
    // A partial session pair needs owner setup; never mix credentials from two different apps.
    const credentials =
      session.clientId || session.clientSecret
        ? {}
        : {
            ...(env.JIRA_CLIENT_ID ? { clientId: env.JIRA_CLIENT_ID } : {}),
            ...(env.JIRA_CLIENT_SECRET
              ? { clientSecret: env.JIRA_CLIENT_SECRET }
              : {}),
          };
    return {
      ...session,
      ...credentials,
      ...(!session.siteUrl && env.JIRA_SITE_URL
        ? { siteUrl: env.JIRA_SITE_URL }
        : {}),
    };
  };
  const admits = hostedRunPolicy({
    origin: c.origin,
    tenancy,
    ...(c.account ? { account: c.account } : {}),
  });
  try {
    await store.migrate();
    const identity = await createOidcIdentity(
      {
        origin: c.origin,
        issuer: c.issuer,
        ...(c.clientId ? { clientId: c.clientId } : {}),
        clientName: home ? `Ceremony · ${home}` : "Ceremony",
        ...(testProfile ? { development: true } : {}),
        ...(env.CEREMONY_OIDC_CLIENT_SECRET
          ? { clientSecret: env.CEREMONY_OIDC_CLIENT_SECRET }
          : {}),
        mapClaims: async (claims) => {
          const tenantId = tenancy.tenantFor(claims);
          const capabilities = tenancy.capabilitiesFor(claims);
          await tenancy.remember(store, tenantId);
          return { tenantId, subjectId: claims.sub, capabilities };
        },
      },
      persistentIdentityStore(store),
    );
    const deliverOwnerSetup = home
      ? await hostedJiraOwnerDelivery(env, store, c.origin, home, [
          "read:jira-user",
        ])
      : undefined;
    const connectors = createHostedConnectors({
      env,
      origin: c.origin,
      store,
      configurationVersion: c.configurationVersion,
      testProfile,
    });
    const runtime = createGitHubRuntime({
      store,
      identity,
      origin: c.origin,
      environment: "production",
      configurationVersion: c.configurationVersion,
      jira: {
        configuration: jiraConfiguration,
        ...(c.jiraSetupOwner && home
          ? {
              setupOwner: async (actor: ActorContext) =>
                actor.tenantId === home ? c.jiraSetupOwner : undefined,
            }
          : {}),
        ...(deliverOwnerSetup ? { deliverOwnerSetup } : {}),
        allowTarget: async (actor) =>
          tenancy.accepts(actor.tenantId) &&
          actor.capabilities.includes("executor"),
        ...(testProfile ? { allowLoopbackHttp: true } : {}),
      },
      stripe: {
        configuration: (actor) =>
          environment.resolveStripe(actor, c.configurationVersion),
      },
      supabase: {
        configuration: (actor) =>
          environment.resolveSupabase(actor, c.configurationVersion),
      },
      configuration: (actor) =>
        environment.resolveGitHub(actor, c.configurationVersion),
      // GitHub acts on one authorized account. Without one it is not offered,
      // rather than the whole deployment refusing to start.
      ...(c.account
        ? { expectedAccount: c.account }
        : { githubEnabled: false }),
      ...(continuation ? { continuation } : {}),
      modelConfiguration: modelConfigurationFromEnvironment(env),
      // The provider registry has already matched the run to its provider's
      // current configuration; this is the host's own policy on top.
      authorize: async (actor, run) => admits(actor, run),
    });
    return Object.assign(runtime, {
      hosted: { tenancy, ...(connectors ? { connectors } : {}) },
    });
  } catch {
    await store.close();
    throw new Error("Hosted identity initialization failed");
  }
}
