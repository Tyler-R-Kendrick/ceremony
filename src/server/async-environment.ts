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
export function nextGitHubEnvironmentRevision(
  previous: Record<string, string>,
  values: Record<string, string>,
  revision: number,
): number {
  return githubNames.some((name) => previous[name] !== values[name])
    ? revision + 1
    : revision;
}
type EnvironmentRecord = {
  values: Record<string, string>;
  githubRevision?: number;
};

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
    values: Record<string, string>;
  }> {
    requireCapability(actor, "executor");
    const record = await this.store.transaction((tx) =>
      tx.get<EnvironmentRecord>(this.key(actor)),
    );
    return {
      revision: record?.revision ?? 0,
      githubRevision: record?.value.githubRevision ?? record?.revision ?? 0,
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
      if ((record?.revision ?? 0) !== edit.revision)
        throw new PersistenceConflict();
      const values = { ...record?.value.values, ...imported, ...edit.values };
      for (const name of edit.remove) delete values[name];
      if (
        Object.keys(values).length > 100 ||
        Buffer.byteLength(JSON.stringify(values)) > 64000
      )
        throw new AuthorizationError("invalid_request");
      const githubRevision = nextGitHubEnvironmentRevision(
        record?.value.values ?? {},
        values,
        record?.value.githubRevision ?? record?.revision ?? 0,
      );
      const revision = await tx.put(
        key,
        { values, githubRevision },
        record?.revision ?? null,
      );
      return { revision, names: Object.keys(values).sort() };
    });
  }
  async resolveGitHub(
    actor: ActorContext,
    baseVersion: string,
  ): Promise<{ configurationVersion: string; app?: GitHubAppConfiguration }> {
    const record = await this.read(actor);
    return resolveGitHubEnvironment(
      {
        revision: record.githubRevision,
        values: record.values,
        sessionId: actor.sessionId,
      },
      baseVersion,
    );
  }
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
