import { createHash } from "node:crypto";
import { parseEnv } from "node:util";
import { z } from "zod";
import {
  type ActorContext,
  requireCapability,
  AuthorizationError,
} from "./identity.js";
import {
  environmentEditSchema,
  environmentValuesSchema,
} from "./environment-schema.js";
import {
  PersistenceConflict,
  type AsyncCeremonyStore,
} from "./persistence/index.js";
import type { GitHubAppConfiguration } from "./github.js";

const githubNames = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_OWNER",
] as const;
const jiraNames = [
  "JIRA_CLIENT_ID",
  "JIRA_CLIENT_SECRET",
  "JIRA_SITE_URL",
] as const;
const supabaseNames = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY",
] as const;
const stripeNames = ["STRIPE_SECRET_KEY"] as const;

/** The session facts a provider's resolver may read; values stay server-side. */
export type EnvironmentSnapshot = {
  revision: number;
  values: Record<string, string>;
  sessionId: string;
};

type RevisionField =
  "githubRevision" | "stripeRevision" | "supabaseRevision" | "jiraRevision";

/**
 * One provider's slice of the shared session environment, keyed by connector
 * id in `environmentProviders`.
 *
 * `names` are the variables whose change advances this provider's own
 * revision, so editing an unrelated connector's variables never invalidates
 * this one's runs. `field` is where that revision is kept in the stored
 * record; it is part of the stored format and fixed for compatibility with
 * environments written before this table existed.
 */
export interface EnvironmentProvider<Resolved> {
  readonly names: readonly string[];
  readonly field: RevisionField;
  resolve(record: EnvironmentSnapshot, baseVersion: string): Resolved;
}

function nextRevision(
  names: readonly string[],
  previous: Record<string, string>,
  values: Record<string, string>,
  revision: number,
): number {
  return names.some((name) => previous[name] !== values[name])
    ? revision + 1
    : revision;
}
export function nextGitHubEnvironmentRevision(
  previous: Record<string, string>,
  values: Record<string, string>,
  revision: number,
): number {
  return nextRevision(githubNames, previous, values, revision);
}
type EnvironmentRecord = {
  values: Record<string, string>;
} & Partial<Record<RevisionField, number>>;
export function nextJiraEnvironmentRevision(
  previous: Record<string, string>,
  values: Record<string, string>,
  revision: number,
) {
  return nextRevision(jiraNames, previous, values, revision);
}
export function nextSupabaseEnvironmentRevision(
  previous: Record<string, string>,
  values: Record<string, string>,
  revision: number,
) {
  return nextRevision(supabaseNames, previous, values, revision);
}

/** Native user-session environment shared by every connector; read is a trusted server-only operation. */
export class AsyncCeremonyEnvironment {
  constructor(private readonly store: AsyncCeremonyStore) {}
  private key(actor: ActorContext) {
    return {
      tenant: actor.tenantId,
      kind: "session" as const,
      id: `environment:${createHash("sha256")
        .update(JSON.stringify([actor.subjectId, actor.sessionId]))
        .digest("hex")}`,
    };
  }
  async read(actor: ActorContext): Promise<{
    revision: number;
    githubRevision: number;
    stripeRevision: number;
    supabaseRevision: number;
    jiraRevision: number;
    values: Record<string, string>;
  }> {
    requireCapability(actor, "executor");
    const record = await this.store.transaction((tx) =>
      tx.get<EnvironmentRecord>(this.key(actor)),
    );
    return {
      revision: record?.revision ?? 0,
      githubRevision: record?.value.githubRevision ?? record?.revision ?? 0,
      stripeRevision: record?.value.stripeRevision ?? record?.revision ?? 0,
      supabaseRevision: record?.value.supabaseRevision ?? record?.revision ?? 0,
      jiraRevision: record?.value.jiraRevision ?? record?.revision ?? 0,
      values: record?.value.values ?? {},
    };
  }
  async describe(actor: ActorContext) {
    const record = await this.read(actor);
    return {
      revision: record.revision,
      names: Object.keys(record.values).sort(),
    };
  }
  async update(actor: ActorContext, input: unknown) {
    requireCapability(actor, "executor");
    if (actor.actorKind !== "human") throw new AuthorizationError("denied");
    const parsed = environmentEditSchema.safeParse(input);
    if (!parsed.success) throw new AuthorizationError("invalid_request");
    const edit = parsed.data;
    let imported: Record<string, string> = {};
    if (edit.dotenv !== undefined) {
      try {
        imported = environmentValuesSchema.parse(parseEnv(edit.dotenv));
        if (!Object.keys(imported).length) throw new Error();
      } catch {
        throw new AuthorizationError("invalid_request");
      }
    }
    return this.store.transaction(async (tx) => {
      const key = this.key(actor);
      const record = await tx.get<EnvironmentRecord>(key);
      const previousRevision = record?.revision ?? 0;
      if (previousRevision !== edit.revision) throw new PersistenceConflict();
      const previousValues = record?.value.values ?? {};
      const values = { ...previousValues, ...imported, ...edit.values };
      for (const name of edit.remove) delete values[name];
      if (
        Object.keys(values).length > 100 ||
        Buffer.byteLength(JSON.stringify(values)) > 64000
      )
        throw new AuthorizationError("invalid_request");
      // Each provider's revision advances only when its own names change.
      const revisions = Object.fromEntries(
        Object.values(environmentProviders).map((provider) => [
          provider.field,
          nextRevision(
            provider.names,
            previousValues,
            values,
            record?.value[provider.field] ?? previousRevision,
          ),
        ]),
      );
      const revision = await tx.put(
        key,
        { values, ...revisions },
        record?.revision ?? null,
      );
      return { revision, names: Object.keys(values).sort() };
    });
  }
  /** Resolves one provider's configuration candidate from this actor's session. */
  async resolve<Id extends EnvironmentProviderId>(
    id: Id,
    actor: ActorContext,
    baseVersion: string,
  ): Promise<ReturnType<(typeof environmentProviders)[Id]["resolve"]>> {
    const provider: EnvironmentProvider<unknown> = environmentProviders[id];
    const record = await this.read(actor);
    return provider.resolve(
      {
        revision: record[provider.field],
        values: record.values,
        sessionId: actor.sessionId,
      },
      baseVersion,
    ) as ReturnType<(typeof environmentProviders)[Id]["resolve"]>;
  }
  resolveGitHub(actor: ActorContext, baseVersion: string) {
    return this.resolve("github", actor, baseVersion);
  }
  resolveStripe(actor: ActorContext, baseVersion: string) {
    return this.resolve("stripe", actor, baseVersion);
  }
  resolveSupabase(actor: ActorContext, baseVersion: string) {
    return this.resolve("supabase", actor, baseVersion);
  }
  resolveJira(actor: ActorContext, baseVersion: string) {
    return this.resolve("jira", actor, baseVersion);
  }
}

/** Private configuration candidate only. The runtime binds target/callback/scopes and the provider adapter validates before effects. */
export function resolveJiraEnvironment(
  record: {
    revision: number;
    values: Record<string, string>;
    sessionId: string;
  },
  baseVersion: string,
): {
  version: string;
  clientId?: string;
  clientSecret?: string;
  siteUrl?: string;
} {
  return {
    version: createHash("sha256")
      .update(JSON.stringify([baseVersion, record.sessionId, record.revision]))
      .digest("hex"),
    ...(record.values.JIRA_CLIENT_ID
      ? { clientId: record.values.JIRA_CLIENT_ID }
      : {}),
    ...(record.values.JIRA_CLIENT_SECRET
      ? { clientSecret: record.values.JIRA_CLIENT_SECRET }
      : {}),
    ...(record.values.JIRA_SITE_URL
      ? { siteUrl: record.values.JIRA_SITE_URL }
      : {}),
  };
}

/** A configuration candidate, not verification or permission to provision a project. */
export function resolveSupabaseEnvironment(
  record: {
    revision: number;
    values: Record<string, string>;
    sessionId: string;
  },
  baseVersion: string,
): { version: string; projectUrl?: string; publishableKey?: string } {
  const publishableKey =
    record.values.SUPABASE_PUBLISHABLE_KEY || record.values.SUPABASE_ANON_KEY;
  return {
    version: createHash("sha256")
      .update(JSON.stringify([baseVersion, record.sessionId, record.revision]))
      .digest("hex"),
    ...(record.values.SUPABASE_URL
      ? { projectUrl: record.values.SUPABASE_URL }
      : {}),
    ...(publishableKey ? { publishableKey } : {}),
  };
}

export function resolveStripeEnvironment(
  record: {
    revision: number;
    values: Record<string, string>;
    sessionId: string;
  },
  baseVersion: string,
): { version: string; token?: string } {
  return {
    version: createHash("sha256")
      .update(JSON.stringify([baseVersion, record.sessionId, record.revision]))
      .digest("hex"),
    ...(record.values.STRIPE_SECRET_KEY
      ? { token: record.values.STRIPE_SECRET_KEY }
      : {}),
  };
}

/** Shared by async hosted and legacy local adapters. Only session/revision metadata enters the version digest. */
export function resolveGitHubEnvironment(
  record: {
    revision: number;
    values: Record<string, string>;
    sessionId: string;
  },
  baseVersion: string,
): { configurationVersion: string; app?: GitHubAppConfiguration } {
  const { revision, values, sessionId } = record;
  const configurationVersion =
    revision === 0 && !githubNames.some((name) => Boolean(values[name]))
      ? baseVersion
      : createHash("sha256")
          .update(JSON.stringify([baseVersion, sessionId, revision]))
          .digest("hex");
  const names = githubNames;
  if (!names.some((name) => Boolean(values[name])))
    return { configurationVersion };
  const missing = names.filter((name) => !values[name]);
  if (missing.length) throw new Error("incomplete-github-configuration");
  const parsed = z
    .object({
      id: z.coerce.number().int().positive(),
      pem: z.string().min(1).max(30000),
      slug: z.string().regex(/^[a-zA-Z0-9-]+$/),
      owner: z.object({ login: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/) }),
    })
    .safeParse({
      id: values.GITHUB_APP_ID,
      pem: values.GITHUB_APP_PRIVATE_KEY?.replace(
        /(-----BEGIN (?:RSA )?PRIVATE KEY-----)\s*/,
        "$1\n",
      ).replace(/\s*(-----END (?:RSA )?PRIVATE KEY-----)/, "\n$1"),
      slug: values.GITHUB_APP_SLUG,
      owner: { login: values.GITHUB_APP_OWNER },
    });
  if (!parsed.success) throw new AuthorizationError("invalid_request");
  return { configurationVersion, app: parsed.data };
}

/**
 * The providers whose configuration lives in the session environment, keyed by
 * connector id. The runtime's provider registry reads through this table; the
 * `resolve*Environment` functions above remain each provider's rules.
 */
export const environmentProviders = {
  github: {
    names: githubNames,
    field: "githubRevision",
    resolve: resolveGitHubEnvironment,
  },
  stripe: {
    names: stripeNames,
    field: "stripeRevision",
    resolve: resolveStripeEnvironment,
  },
  supabase: {
    names: supabaseNames,
    field: "supabaseRevision",
    resolve: resolveSupabaseEnvironment,
  },
  jira: {
    names: jiraNames,
    field: "jiraRevision",
    resolve: resolveJiraEnvironment,
  },
} as const satisfies Record<string, EnvironmentProvider<unknown>>;
export type EnvironmentProviderId = keyof typeof environmentProviders;
